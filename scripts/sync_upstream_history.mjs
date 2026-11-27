#!/usr/bin/env node
/*
 * How each extension got into Linux (#649): the commit that brought it, the
 * patch series behind that commit, its versions and review, and the release.
 *
 *   node scripts/sync_upstream_history.mjs              # every extension Linux supports
 *   node scripts/sync_upstream_history.mjs Zawrs V      # just these (data for others is kept)
 *
 * Sources, all public:
 *   - GitHub's API for torvalds/linux: the commits that touch the kernel's
 *     extension table (arch/riscv/kernel/cpufeature.c, earlier cpu.c), their
 *     trailers, and the first release tag that contains each.
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
 * Network responses are cached in .cache/upstream-history/, so a rerun is
 * fast and a summary run that follows reads the same threads. Set
 * GITHUB_TOKEN (or have `gh` logged in) for the GitHub API.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { CURATED } from './upstream-curated.mjs';
import {
  BOT,
  addedIds,
  groupSeries,
  isBulk,
  iso,
  loreId,
  parseAtom,
  parseMbox,
  personName,
  earlierAttempts,
  reviewReplies,
  selectLanded,
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

let token;
function githubToken() {
  if (token !== undefined) return token;
  token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
  if (!token)
    try {
      token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim() || null;
    } catch {
      token = null;
    }
  return token;
}

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

/**
 * How long to wait before asking GitHub again, or null when the answer is not
 * a rate limit. GitHub's secondary limits (an expensive query such as a
 * path's history in torvalds/linux) answer 429 or 403 with Retry-After; the
 * primary limit answers with x-ratelimit-remaining: 0 and the reset time. A
 * bare 429 backs off by minutes. A 403 with neither is a real refusal.
 */
export function rateLimitWait(status, headers, attempt = 0, now = Date.now()) {
  if (status !== 403 && status !== 429) return null;
  const header = (name) => headers?.get?.(name) ?? null;
  const retryAfter = Number(header('retry-after'));
  if (retryAfter > 0) return Math.min(retryAfter * 1000 + 1000, 3_600_000);
  const reset = Number(header('x-ratelimit-reset'));
  if (header('x-ratelimit-remaining') === '0' && reset) {
    const wait = reset * 1000 - now + 5000;
    return wait > 0 && wait < 3_600_000 ? wait : null;
  }
  if (status === 429) return Math.min(60_000 * 2 ** attempt, 900_000);
  return null;
}

/** Cached JSON from GitHub's API; null for a 404 or 422 (an unknown ref, a comparison it will not compute). */
export async function gh(endpoint, { fetchImpl = fetch } = {}) {
  const file = path.join(CACHE, `gh-${safeName(endpoint)}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  let limited = 0; // rate-limit waits so far, counted apart from failures
  for (let attempt = 0; ; attempt += 1) {
    const res = await retrying(attempt, () =>
      fetchImpl(`https://api.github.com/${endpoint}`, {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': USER_AGENT,
          ...(githubToken() ? { authorization: `Bearer ${githubToken()}` } : {}),
        },
      }),
    );
    if (!res) continue;
    if (res.status === 404 || res.status === 422) {
      // Cached too: a release tag not cut yet is asked about for every commit.
      fs.mkdirSync(CACHE, { recursive: true });
      fs.writeFileSync(file, 'null');
      return null;
    }
    const wait = rateLimitWait(res.status, res.headers, limited);
    if (wait !== null && limited < 6) {
      limited += 1;
      console.error(`GitHub rate limit (HTTP ${res.status}): waiting ${Math.ceil(wait / 1000)} s`);
      await new Promise((r) => setTimeout(r, wait));
      attempt -= 1; // waiting out a limit is not a failed attempt
      continue;
    }
    if (res.ok) {
      const json = await res.json();
      fs.mkdirSync(CACHE, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(json));
      return json;
    }
    if (attempt >= 3) throw new Error(`GitHub ${endpoint}: HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
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

/** Every non-merge commit that touched the kernel's extension table since 2022. */
async function tableCommits() {
  const seen = new Map();
  for (const file of ['arch/riscv/kernel/cpufeature.c', 'arch/riscv/kernel/cpu.c']) {
    for (let page = 1; ; page += 1) {
      const batch =
        (await gh(
          `repos/torvalds/linux/commits?path=${file}&since=2022-01-01T00:00:00Z&per_page=100&page=${page}`,
        )) ?? [];
      for (const c of batch) if (c.parents.length === 1) seen.set(c.sha, c.sha);
      if (batch.length < 100) break;
    }
  }
  const commits = [];
  for (const sha of seen.keys()) {
    const c = await gh(`repos/torvalds/linux/commits/${sha}`);
    if (c) commits.push({ ...c, adds: addedIds(c.files) });
  }
  return commits.sort((a, b) => a.commit.committer.date.localeCompare(b.commit.committer.date));
}

// Kernel release tags in order, oldest first. Containment is monotonic along
// this list, so the first tag that contains a commit is found by bisection.
const TAGS = [
  ...Array.from({ length: 6 }, (_, i) => `v4.${15 + i}`),
  ...Array.from({ length: 20 }, (_, i) => `v5.${i}`),
  ...Array.from({ length: 20 }, (_, i) => `v6.${i}`),
  ...Array.from({ length: 20 }, (_, i) => `v7.${i}`),
];

async function contains(tag, sha) {
  const cmp = await gh(`repos/torvalds/linux/compare/${tag}...${sha}?per_page=1`);
  if (!cmp) return null; // a tag not cut yet
  return cmp.status === 'behind' || cmp.status === 'identical';
}

/** The first release that contains the commit, with its date, or null if none has yet. */
async function firstRelease(sha) {
  let lo = 0;
  let hi = TAGS.length - 1;
  // Trim tags not cut yet off the end.
  while (hi >= 0 && (await contains(TAGS[hi], sha)) === null) hi -= 1;
  if (hi < 0 || !(await contains(TAGS[hi], sha))) return null;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (await contains(TAGS[mid], sha)) hi = mid;
    else lo = mid + 1;
  }
  const ref = await gh(`repos/torvalds/linux/git/ref/tags/${TAGS[lo]}`);
  const tag =
    ref?.object.type === 'tag' ? await gh(`repos/torvalds/linux/git/tags/${ref.object.sha}`) : null;
  const date =
    tag?.tagger.date ??
    (await gh(`repos/torvalds/linux/commits/${ref?.object.sha}`))?.commit.committer.date;
  return { version: TAGS[lo].slice(1), date: (date ?? '').slice(0, 10) };
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
async function seriesHistory(commit, { curated = null } = {}) {
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
  const posts = [...pooled.values()].sort((a, b) => a.date - b.date);
  const groups = groupSeries(posts);
  const landed = selectLanded(groups, subject, curated?.title);
  if (!landed)
    return {
      missing: `no posted series found for "${subject}" (${posts.length} postings searched)`,
    };
  const { group, partial } = landed;

  const authors = new Set(group.postings.map((p) => p.author));
  const threads = [];
  for (const p of group.postings) threads.push(await thread(p.href));
  const replies = reviewReplies(threads, authors);
  const repliers = [...new Set(replies.map((m) => personName(m.from)))];
  const release = await firstRelease(commit.sha);
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

/**
 * Drops what can change between runs from the cache, keeping only answers
 * that never change: a commit's details, its comparison with a tag that
 * exists, a tag's date. Lore searches and threads grow, the commit listings
 * move, and a tag not cut yet will be. The weekly workflow keeps the cache
 * between runs and passes --refresh; a local rerun keeps everything.
 */
export function pruneMutable(dir = CACHE) {
  if (!fs.existsSync(dir)) return 0;
  let dropped = 0;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    const mutable =
      name.startsWith('lore-') ||
      name.startsWith('gh-repos_torvalds_linux_commits_path') ||
      fs.readFileSync(file, 'utf8') === 'null';
    if (mutable) {
      fs.rmSync(file);
      dropped += 1;
    }
  }
  return dropped;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--refresh'))
    console.log(`refresh: dropped ${pruneMutable()} cached answers that can change`);
  argv = argv.filter((a) => !a.startsWith('--'));
  const ids = catalogueIds();
  const support = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'src', 'toolchain-support.json'), 'utf8'),
  );
  const linux = Object.entries(support.extensions).filter(([, v]) => v.linux?.supported);
  const wanted = argv.length ? new Set(argv.map((a) => a.toLowerCase())) : null;
  const previous = fs.existsSync(DATA)
    ? JSON.parse(fs.readFileSync(DATA, 'utf8'))
    : { series: {}, extensions: {}, listed: {}, bundles: {} };
  const data = wanted ? previous : { series: {}, extensions: {}, listed: {}, bundles: {} };
  for (const key of ['series', 'extensions', 'listed', 'bundles']) data[key] ??= {};

  const commits = await tableCommits();
  const firstCommit = new Map();
  for (const c of commits)
    for (const id of c.adds) if (!firstCommit.has(id)) firstCommit.set(id, c);

  const report = { collected: [], listed: [], bundles: [], missing: [] };
  const doneThisRun = new Set();
  const failed = new Map(); // series key -> why it could not be collected
  for (const [token, entry] of linux) {
    const id = ids.get(token);
    if (!id || (wanted && !wanted.has(token))) continue;
    // One form per extension: storing one removes the others, so a targeted
    // refresh cannot leave an extension both collected and a bundle.
    const only = (form) => {
      for (const key of ['extensions', 'listed', 'bundles']) if (key !== form) delete data[key][id];
    };
    if (entry.linux.through) {
      only('bundles');
      data.bundles[id] = { parts: entry.linux.through.map((p) => ids.get(p.toLowerCase()) ?? p) };
      report.bundles.push(id);
      continue;
    }
    const curated = CURATED[id] ?? null;
    let commit = curated
      ? await gh(`repos/torvalds/linux/commits/${curated.sha}`)
      : firstCommit.get(token);
    if (!commit) {
      report.missing.push(id);
      continue;
    }
    const adds = curated ? curated.adds : commit.adds.map((x) => ids.get(x) ?? x.toUpperCase());
    if (isBulk(commit.adds ?? [], Boolean(curated))) {
      const release = await firstRelease(commit.sha);
      only('listed');
      data.listed[id] = {
        release,
        others: commit.adds.length - 1,
        commit: commit.sha.slice(0, 12),
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
        adds: curated ? curated.adds.map((x) => x.toLowerCase()) : commit.adds,
      };
      const h = await seriesHistory(commit, { curated });
      if (h.missing) {
        failed.set(key, h.missing);
        report.missing.push(`${id} (${h.missing})`);
        continue;
      }
      // Keep a summary already written for this series; the summarizer
      // decides whether its input changed.
      data.series[key] = { ...h, adds, ai: previous.series?.[key]?.ai ?? null };
    }
    only('extensions');
    data.extensions[id] = { series: key, landedWith: adds.filter((x) => x !== id) };
    report.collected.push({ id, key });
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
    `collected ${report.collected.length}, listed only ${report.listed.length}, bundles ${report.bundles.length}, not found ${report.missing.length}${report.missing.length ? `: ${report.missing.join(', ')}` : ''}`,
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
    index[id] = { listed: { release: l.release?.version ?? null, others: l.others } };
  for (const [id, b] of Object.entries(data.bundles))
    if (b.parts.some((p) => data.extensions[p])) index[id] = { parts: b.parts };
  return sortedKeys(index);
}

/** Writes the data and the index the bundle carries. */
export function writeData(data) {
  const out = {
    series: sortedKeys(data.series),
    extensions: sortedKeys(data.extensions),
    listed: sortedKeys(data.listed),
    bundles: sortedKeys(data.bundles),
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
