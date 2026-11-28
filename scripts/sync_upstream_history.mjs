#!/usr/bin/env node
/*
 * How each extension got into Linux (#649): the commit that brought it, the
 * patch series behind that commit, its versions and review, and the release.
 *
 *   node scripts/sync_upstream_history.mjs <linux>            # every extension Linux supports
 *   node scripts/sync_upstream_history.mjs <linux> Zawrs V    # just these (data for others is kept)
 *
 * <linux> is a clone of the kernel; a blobless one is enough and quick:
 *   git clone --filter=blob:none --no-checkout \
 *     https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git ../linux
 *
 * Sources, all public:
 *   - The kernel clone (scripts/kernel-git.mjs): the commits that touch the
 *     kernel's extension table (arch/riscv/kernel/cpufeature.c, earlier
 *     cpu.c), their trailers, and the first release tag that contains each.
 *   - lore.kernel.org: every patch posted whose subject names the extension,
 *     or the landing patch's own title, grouped into series
 *     (scripts/upstream-history-lib.mjs), and each version's thread.
 *   - scripts/upstream-curated.mjs for extensions the table cannot date.
 *
 * Writes src/upstream-history.json (loaded when a dialog opens) and
 * src/upstream-history-index.json (a few numbers per extension, in the
 * bundle). AI summaries already in the data are kept; adding and refreshing
 * them is scripts/summarize_upstream_history.mjs's job.
 *
 * Lore's answers are cached in .cache/upstream-history/, so a local rerun is
 * fast and a summary run that follows reads the same threads. The weekly
 * workflow starts with an empty cache, so it always sees the latest.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { commitAt, currentTable, firstRelease, tableCommits } from './kernel-git.mjs';
import { CURATED, LISTED_NOTES, SERIES_ALIASES } from './upstream-curated.mjs';
import {
  BOT,
  coverOf,
  groupSeries,
  isBulk,
  joinRenamed,
  iso,
  loreId,
  parseAtom,
  parseMbox,
  personName,
  earlierAttempts,
  reviewReplies,
  selectLanded,
  seriesFor,
  title,
  trailers,
} from './upstream-history-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = path.join(ROOT, 'src', 'upstream-history.json');
export const INDEX = path.join(ROOT, 'src', 'upstream-history-index.json');
export const CACHE = path.join(ROOT, '.cache', 'upstream-history');
const USER_AGENT = 'riscv-isa-explorer upstream-history sync';
const LORE_PAUSE_MS = 600; // lore is a shared, volunteer-run service

const safeName = (s) =>
  s.length > 120
    ? `${s.slice(0, 80).replace(/[^\w.-]+/g, '_')}-${crypto.createHash('sha1').update(s).digest('hex')}`
    : s.replace(/[^\w.-]+/g, '_');

/**
 * A fetch that survives a dropped connection: null (try again) after a short
 * wait, until the fourth attempt, which lets the error through.
 */
async function retrying(attempt, request) {
  try {
    return await request();
  } catch (error) {
    if (attempt >= 3) throw error;
    await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    return null;
  }
}

/** Cached text from lore; null when lore has nothing there. */
export async function lore(url, { gz = false, fetchImpl = fetch } = {}) {
  const file = path.join(
    CACHE,
    `lore-${safeName(url.replace(/^https:\/\/lore\.kernel\.org\//, ''))}`,
  );
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  for (let attempt = 0; ; attempt += 1) {
    const res = await retrying(attempt, () =>
      fetchImpl(url, { headers: { 'user-agent': USER_AGENT } }),
    );
    await new Promise((r) => setTimeout(r, LORE_PAUSE_MS));
    if (!res) continue;
    if (res.status === 404) return null;
    if (res.ok) {
      let buf = Buffer.from(await res.arrayBuffer());
      if (gz) buf = zlib.gunzipSync(buf);
      fs.mkdirSync(CACHE, { recursive: true });
      fs.writeFileSync(file, buf);
      return buf.toString('utf8');
    }
    if (attempt >= 3) throw new Error(`lore ${url}: HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
  }
}

/** The messages of the thread a lore link is in. */
export async function thread(href) {
  const id = loreId(href);
  if (!id) return [];
  const text = await lore(`https://lore.kernel.org/all/${encodeURIComponent(id)}/t.mbox.gz`, {
    gz: true,
  });
  return text ? parseMbox(text) : [];
}

/** Patches posted before `until` whose subject matches the lore query. */
async function postings(query, until, list = 'linux-riscv') {
  const out = [];
  for (let offset = 0; ; offset += 200) {
    const url = `https://lore.kernel.org/${list}/?q=${encodeURIComponent(query)}&x=A&o=${offset}`;
    const entries = parseAtom(await lore(url));
    out.push(...entries.filter((e) => e.date <= until && !BOT.test(e.author)));
    if (entries.length < 200) break;
  }
  return out;
}

/**
 * The cover-letter title of the series a commit came from, read from the
 * thread its Link: trailer points at; null without a lore link.
 */
async function linkedCoverTitle(message) {
  const link = trailers(message, 'Link').find((l) =>
    /lore\.kernel\.org|patch\.msgid\.link/.test(l),
  );
  const id = link?.match(/(?:lore\.kernel\.org\/[\w-]+|patch\.msgid\.link)\/([^\s/]+)/)?.[1];
  if (!id) return null;
  const messages = await thread(`https://lore.kernel.org/all/${id}/`);
  const cover = coverOf(messages, decodeURIComponent(id));
  return cover ? title(cover.subject) : null;
}

/**
 * An extension Linux does not support yet: the series posted for it that has
 * not landed, with its versions, authors and review (#665). Null when none
 * was posted.
 */
async function pendingHistory(id) {
  const now = new Date();
  const aliases = SERIES_ALIASES[id] ?? [];
  const pooled = new Map();
  for (const q of [`s:${id}`, ...aliases.map((a) => `s:"${a}"`)])
    for (const p of await postings(q, now)) pooled.set(p.href, p);
  const posts = [...pooled.values()].sort((a, b) => a.date - b.date);
  const groups = groupSeries(posts);
  const [group, ...older] = seriesFor(groups, id, aliases);
  if (!group) return null;
  const authors = new Set(group.postings.map((p) => p.author));
  const threads = [];
  for (const p of group.postings) threads.push(await thread(p.href));
  const replies = reviewReplies(threads, authors);
  return {
    title: group.title,
    authors: [...authors],
    versions: group.postings.map((p) => ({
      version: `${p.rfc ? 'RFC ' : ''}v${p.version}`,
      date: iso(p.date),
      author: p.author,
      resends: p.resends,
      href: p.href,
    })),
    firstPatch: iso(
      [group, ...older]
        .flatMap((g) => g.postings.map((p) => p.date))
        .reduce((a, b) => (a < b ? a : b)),
    ),
    lastPosted: iso(group.postings.at(-1).date),
    review: {
      replies: replies.length,
      people: new Set(replies.map((m) => personName(m.from))).size,
    },
    earlier: older.map((g) => ({
      date: iso(g.postings[0].date),
      title: g.title,
      authors: [...new Set(g.postings.map((p) => p.author))],
      postings: g.postings.length,
    })),
  };
}

/**
 * A summary written for a series is kept only while the series has the same
 * postings: its citations number that series' messages, so on another set
 * they would point at the wrong ones. The summarizer writes a new one.
 */
export function keptSummary(before, now) {
  if (!before?.ai) return null;
  const hrefs = (s) => JSON.stringify(s.versions.map((v) => v.href));
  return hrefs(before) === hrefs(now) ? before.ai : null;
}

/** Catalogue id for each lower-case kernel/-march name. */
function catalogueIds() {
  const catalogue = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'src', 'riscv_extensions.json'), 'utf8'),
  );
  return new Map(
    Object.values(catalogue)
      .flat()
      .filter(Boolean)
      .map((e) => [e.id.toLowerCase(), e.id]),
  );
}

/** The history of one commit's series. */
async function seriesHistory(commit, { curated = null, linux }) {
  const message = commit.commit.message;
  const subject = message.split('\n')[0];
  const applied = new Date(commit.commit.committer.date);
  const pooled = new Map();
  const add = (list) => list.forEach((p) => pooled.set(p.href, p));
  if (curated) add(await postings(`s:"${curated.title}"`, applied, 'all'));
  else
    for (const id of commit.adds.filter((x) => x.length > 1))
      add(await postings(`s:${id}`, applied));
  const ownTitle = title(subject)
    .replace(/^\s*(riscv|risc-v)\s*:\s*/i, '')
    .replace(/"/g, '');
  add(await postings(`s:"${ownTitle}"`, applied, curated ? 'all' : 'linux-riscv'));
  // The Link: trailer points into the thread that was applied, so its cover
  // letter names the series better than any search: a patch reposted inside a
  // larger series (scalar crypto, in "riscv: report more ISA extensions
  // through hwprobe") belongs to the series that carried it in (#665).
  const cover = curated ? null : await linkedCoverTitle(message);
  if (cover) add(await postings(`s:"${cover.replace(/"/g, '')}"`, applied));
  let posts = [...pooled.values()].sort((a, b) => a.date - b.date);
  let groups = groupSeries(posts);
  const byCover = cover ? selectLanded(groups, subject, cover) : null;
  let landed =
    byCover && !byCover.partial ? byCover : selectLanded(groups, subject, curated?.title);
  // Not found on linux-riscv: the series may have gone to another list (perf
  // work goes to linux-perf-users and lkml). Search everywhere.
  if (!landed && !curated) {
    add(await postings(`s:"${ownTitle}"`, applied, 'all'));
    if (cover) add(await postings(`s:"${cover.replace(/"/g, '')}"`, applied, 'all'));
    posts = [...pooled.values()].sort((a, b) => a.date - b.date);
    groups = groupSeries(posts);
    const again = cover ? selectLanded(groups, subject, cover) : null;
    landed = again && !again.partial ? again : selectLanded(groups, subject);
  }
  if (!landed)
    return {
      missing: `no posted series found for "${subject}" (${posts.length} postings searched)`,
    };
  const { partial } = landed;
  const joined = joinRenamed(groups, landed.group, subject);
  const group = joined.group;
  groups = joined.groups;

  const authors = new Set(group.postings.map((p) => p.author));
  const threads = [];
  for (const p of group.postings) threads.push(await thread(p.href));
  const replies = reviewReplies(threads, authors);
  const repliers = [...new Set(replies.map((m) => personName(m.from)))];
  const release = firstRelease(linux, commit.sha);
  if (!release) return { missing: 'applied, not in a release yet' };
  const earlier = earlierAttempts(groups, group);
  const firstPatch = [group, ...earlier]
    .flatMap((g) => g.postings.map((p) => p.date))
    .reduce((a, b) => (a < b ? a : b));
  return {
    commit: {
      sha: commit.sha.slice(0, 12),
      subject,
      applied: iso(applied),
      committer: commit.commit.committer.name,
    },
    release,
    title: partial ? curated.title : group.title,
    partial,
    curated: Boolean(curated),
    people: {
      author: commit.commit.author.name,
      coDevelopedBy: trailers(message, 'Co-developed-by'),
      reviewedBy: trailers(message, 'Reviewed-by'),
      ackedBy: trailers(message, 'Acked-by'),
      testedBy: trailers(message, 'Tested-by'),
      seriesAuthors: [...authors],
    },
    versions: group.postings.map((p) => ({
      version: `${p.rfc ? 'RFC ' : ''}v${p.version}`,
      date: iso(p.date),
      author: p.author,
      resends: p.resends,
      href: p.href,
    })),
    review: { replies: replies.length, people: repliers.length },
    earlier: earlier.map((g) => ({
      date: iso(g.postings[0].date),
      title: g.title,
      authors: [...new Set(g.postings.map((p) => p.author))],
      postings: g.postings.length,
    })),
    firstPatch: iso(firstPatch),
  };
}

export async function main([linux, ...argv] = process.argv.slice(2)) {
  if (!linux || !fs.existsSync(path.join(linux, '.git')))
    throw new Error(
      'usage: sync_upstream_history.mjs <path to a Linux kernel clone> [extension ...]',
    );
  const ids = catalogueIds();
  const support = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'src', 'toolchain-support.json'), 'utf8'),
  );
  const supported = Object.entries(support.extensions).filter(([, v]) => v.linux?.supported);
  const wanted = argv.length ? new Set(argv.map((a) => a.toLowerCase())) : null;
  const previous = fs.existsSync(DATA)
    ? JSON.parse(fs.readFileSync(DATA, 'utf8'))
    : { series: {}, extensions: {}, listed: {}, bundles: {}, pending: {} };
  const data = wanted
    ? previous
    : { series: {}, extensions: {}, listed: {}, bundles: {}, pending: {} };
  for (const key of ['series', 'extensions', 'listed', 'bundles', 'pending']) data[key] ??= {};

  const commits = tableCommits(linux);
  const firstCommit = new Map();
  for (const c of commits)
    for (const id of c.adds) if (!firstCommit.has(id)) firstCommit.set(id, c);

  const report = { collected: [], listed: [], bundles: [], missing: [], pending: [] };
  const doneThisRun = new Set();
  const failed = new Map(); // series key -> why it could not be collected
  // Hand-mapped extensions Linux supports without listing them in the table
  // (paging modes, Supm) are collected too.
  const tokens = new Set(supported.map(([token]) => token));
  const extra = Object.keys(CURATED)
    .filter((id) => !tokens.has(id.toLowerCase()))
    .map((id) => [id.toLowerCase(), { linux: { supported: true } }]);
  // In a Linux release already, though the toolchain data (refreshed monthly)
  // has not caught up: the kernel's own tags decide (#665).
  const listedNow = currentTable(linux);
  for (const [token, c] of firstCommit)
    if (
      !tokens.has(token) &&
      listedNow.has(token) &&
      !CURATED[ids.get(token)] &&
      ids.has(token) &&
      firstRelease(linux, c.sha)
    ) {
      console.warn(`${ids.get(token)}: released in Linux, not in the toolchain data yet`);
      extra.push([token, { linux: { supported: true } }]);
    }
  for (const [token, entry] of [...supported, ...extra]) {
    const id = ids.get(token);
    if (!id || (wanted && !wanted.has(token))) continue;
    // Supported now: whatever happens below, it is no longer in review.
    delete data.pending[id];
    // One form per extension: storing one removes the others, so a targeted
    // refresh cannot leave an extension both collected and a bundle.
    const only = (form) => {
      for (const key of ['extensions', 'listed', 'bundles', 'pending'])
        if (key !== form) delete data[key][id];
    };
    if (entry.linux.through) {
      only('bundles');
      data.bundles[id] = { parts: entry.linux.through.map((p) => ids.get(p.toLowerCase()) ?? p) };
      report.bundles.push(id);
      continue;
    }
    const curated = CURATED[id] ?? null;
    let commit = curated ? commitAt(linux, curated.sha) : firstCommit.get(token);
    if (!commit) {
      report.missing.push(id);
      continue;
    }
    // What this commit added first, and is in the catalogue: a commit that
    // also touches V's or C's entry, or a macro parameter (_name), did not
    // add those.
    const adds = curated
      ? curated.adds
      : commit.adds
          .filter((x) => ids.has(x) && firstCommit.get(x) === commit)
          .map((x) => ids.get(x));
    if (isBulk(commit.adds ?? [], Boolean(curated))) {
      const release = firstRelease(linux, commit.sha);
      only('listed');
      data.listed[id] = {
        release,
        others: commit.adds.length - 1,
        commit: commit.sha.slice(0, 12),
        ...(LISTED_NOTES[id] ? { note: LISTED_NOTES[id] } : {}),
      };
      delete data.extensions[id];
      report.listed.push(id);
      continue;
    }
    const key = commit.sha.slice(0, 12);
    if (failed.has(key)) {
      report.missing.push(`${id} (${failed.get(key)})`);
      continue;
    }
    if (!doneThisRun.has(key)) {
      doneThisRun.add(key);
      commit = {
        ...commit,
        adds: adds.map((x) => x.toLowerCase()),
      };
      const h = await seriesHistory(commit, { curated, linux });
      if (h.missing) {
        failed.set(key, h.missing);
        report.missing.push(`${id} (${h.missing})`);
        continue;
      }
      // Keep a summary already written for this series; the summarizer
      // decides whether its input changed.
      data.series[key] = { ...h, adds, ai: keptSummary(previous.series?.[key], h) };
    }
    only('extensions');
    data.extensions[id] = { series: key, landedWith: adds.filter((x) => x !== id) };
    report.collected.push({ id, key });
  }
  // Extensions Linux does not support: the series working towards them.
  // Everything collected as supported above, the kernel's own released table
  // entries included: one whose series could not be found is reported missing,
  // never shown as not in Linux.
  const supportedIds = new Set(
    [...supported, ...extra].map(([token]) => ids.get(token)).filter(Boolean),
  );
  for (const id of [...new Set(ids.values())].sort()) {
    if (supportedIds.has(id) || CURATED[id] || id.length < 2) continue;
    if (wanted && !wanted.has(id.toLowerCase())) continue;
    // Not supported (any more): a targeted run starts from the previous
    // file, so drop whatever supported form it had there.
    for (const key of ['extensions', 'listed', 'bundles']) delete data[key][id];
    // From the previous file: a full run starts from empty data.
    const before = previous.pending?.[id];
    const p = await pendingHistory(id);
    if (p) {
      // Merged into the kernel's table, not in a release yet (Zic64b in 7.4-rc1).
      const landed = firstCommit.get(id.toLowerCase());
      const merged =
        landed && listedNow.has(id.toLowerCase()) && !firstRelease(linux, landed.sha)
          ? { commit: landed.sha.slice(0, 12), applied: landed.commit.committer.date.slice(0, 10) }
          : null;
      data.pending[id] = { ...p, merged, ai: keptSummary(before, p) };
      report.pending.push(id);
    } else delete data.pending[id];
  }

  // "Landed with" names only extensions sharing this history: the 2024 commit
  // that added Zaamo and Zalrsc also re-listed A, whose history is the 2017 port.
  for (const e of Object.values(data.extensions))
    e.landedWith = e.landedWith.filter(
      (o) => !data.extensions[o] || data.extensions[o].series === e.series,
    );
  // An extension whose series could not be collected has no history this run.
  for (const [id, e] of Object.entries(data.extensions))
    if (!data.series[e.series]) delete data.extensions[id];
  // Drop series no extension points at any more.
  const used = new Set(Object.values(data.extensions).map((e) => e.series));
  for (const key of Object.keys(data.series)) if (!used.has(key)) delete data.series[key];

  writeData(data);
  console.log(
    `collected ${report.collected.length}, in review ${report.pending.length}, listed only ${report.listed.length}, bundles ${report.bundles.length}, not found ${report.missing.length}${report.missing.length ? `: ${report.missing.join(', ')}` : ''}`,
  );
  return report;
}

const sortedKeys = (obj) =>
  Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));

/**
 * The index the bundle carries: a few numbers per extension, enough for the
 * panel's Path line and the dialog's Previous and Next without loading the
 * full data. A bundle is listed only once one of its parts has a history.
 */
export function buildIndex(data) {
  const index = {};
  for (const [id, e] of Object.entries(data.extensions)) {
    const s = data.series[e.series];
    index[id] = {
      release: s.release.version,
      firstPatch: s.firstPatch,
      versions: s.versions.length,
      replies: s.review.replies,
      landedWith: e.landedWith,
    };
  }
  for (const [id, l] of Object.entries(data.listed))
    index[id] = {
      listed: { release: l.release?.version ?? null, others: l.others, note: l.note ?? null },
    };
  for (const [id, b] of Object.entries(data.bundles))
    if (b.parts.some((p) => data.extensions[p])) index[id] = { parts: b.parts };
  for (const [id, p] of Object.entries(data.pending ?? {}))
    index[id] = {
      pending: {
        title: p.title,
        versions: p.versions.length,
        lastPosted: p.lastPosted,
        merged: Boolean(p.merged),
      },
    };
  return sortedKeys(index);
}

/** Writes the data and the index the bundle carries. */
export function writeData(data) {
  const out = {
    series: sortedKeys(data.series),
    extensions: sortedKeys(data.extensions),
    listed: sortedKeys(data.listed),
    bundles: sortedKeys(data.bundles),
    pending: sortedKeys(data.pending ?? {}),
  };
  fs.writeFileSync(DATA, `${JSON.stringify(out, null, 1)}\n`);
  fs.writeFileSync(INDEX, `${JSON.stringify(buildIndex(out), null, 1)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(2);
  });
}
