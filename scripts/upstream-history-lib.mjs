/*
 * The parts of the upstream-history sync (#649) that need no network: reading
 * lore's search results and mailboxes, grouping postings into patch series,
 * picking the series that landed, and checking an AI summary's citations.
 * scripts/sync_upstream_history.mjs and scripts/summarize_upstream_history.mjs
 * do the fetching; tests/upstream-history.test.mjs tests these.
 */

/** Bots that reply to patches; their messages are neither postings nor review. */
export const BOT = /kernel test robot|patchwork-bot|lkp@intel|syzbot|kernelci/i;

/**
 * A commit that adds more than this many extensions to the kernel's table is
 * bookkeeping (the table catching up, as when 13 single letters were added
 * at once for 6.6), not the work that made any of them supported.
 */
export const BULK = 3;

const ONE_DAY = 864e5;

export const iso = (date) => date.toISOString().slice(0, 10);

export function decodeHtml(text) {
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** RFC 2047 encoded words in a header (UTF-8, Q or B). */
export function decodeMime(value) {
  return value
    .replace(/(=\?[^?]+\?[qb]\?[^?]*\?=)\s+(?==\?)/gi, '$1')
    .replace(/=\?utf-8\?([qb])\?([^?]*)\?=/gi, (_, enc, text) =>
      enc.toLowerCase() === 'b'
        ? Buffer.from(text, 'base64').toString('utf8')
        : Buffer.from(
            text
              .replace(/_/g, ' ')
              .replace(/=([0-9a-f]{2})/gi, (__, h) => String.fromCharCode(parseInt(h, 16))),
            'latin1',
          ).toString('utf8'),
    );
}

/** A body as sent: quoted-printable and base64 are decoded, anything else kept. */
export function decodeBody(body, encoding = '') {
  if (/quoted-printable/i.test(encoding)) {
    const bytes = body
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
    return Buffer.from(bytes, 'latin1').toString('utf8');
  }
  if (/base64/i.test(encoding))
    return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  return body;
}

/** The messages of an mboxrd file, as lore serves a thread (t.mbox). */
export function parseMbox(text) {
  return text
    .split(/^From mboxrd@z .*$/m)
    .filter((m) => m.trim())
    .map((raw) => {
      const cut = raw.search(/\r?\n\r?\n/);
      const head = (cut < 0 ? raw : raw.slice(0, cut)).replace(/\r?\n[ \t]+/g, ' ');
      const header = (name) =>
        (head.match(new RegExp(`^${name}:[ \\t]*(.*)$`, 'mi')) ?? [])[1]?.trim() ?? '';
      const body = cut < 0 ? '' : raw.slice(cut).replace(/^\r?\n\r?\n/, '');
      return {
        from: decodeMime(header('From')),
        subject: decodeMime(header('Subject')),
        date: new Date(header('Date')),
        messageId: header('Message-ID').replace(/[<>]/g, ''),
        inReplyTo: header('In-Reply-To').replace(/[<>]/g, ''),
        body: decodeBody(body.replace(/^>(>*From )/gm, '$1'), header('Content-Transfer-Encoding')),
      };
    });
}

/** The message id in a lore link, e.g. https://lore.kernel.org/all/<id>/. */
export function loreId(url) {
  const m = String(url ?? '').match(/lore\.kernel\.org\/[\w-]+\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/** Entries of a lore Atom search result. */
export function parseAtom(xml) {
  return String(xml ?? '')
    .split('<entry>')
    .slice(1)
    .map((e) => {
      const tag = (re) => (e.match(re) ?? [])[1] ?? '';
      const href = tag(/<link\s+href="([^"]+)"/);
      const parent = tag(/<thr:in-reply-to[^>]*\bhref="([^"]+)"/);
      return {
        subject: decodeHtml(tag(/<title>([^<]*)<\/title>/)),
        href,
        id: loreId(href),
        inReplyTo: parent ? loreId(parent) : null,
        date: new Date(tag(/<updated>([^<]*)<\/updated>/)),
        // b4's relay sends on the author's behalf; the person is the same.
        author: decodeHtml(tag(/<name>([^<]*)<\/name>/)).replace(/ via B4 Relay$/, ''),
      };
    });
}

/** A reply or a forward, by its subject. */
export const isReplySubject = (subject) => /^\s*(re|aw|fwd?|fw):/i.test(subject);

/** A patch as posted: [PATCH ...] in the subject, not a reply or a forward. */
export const isPosting = (subject) => /\[[^\]]*PATCH/i.test(subject) && !isReplySubject(subject);

/** The version in [PATCH v3 ...]; 1 when none is given. */
export const version = (subject) =>
  Number((subject.match(/\[[^\]]*PATCH[^\]]*?\b[vV](\d+)\b/) ?? [])[1] ?? 1);

/** [n, total] for "[PATCH v3 2/7]", [] for a single patch. */
export const part = (subject) => (subject.match(/\b(\d+)\/(\d+)\]/) ?? []).slice(1).map(Number);

export const isRfc = (subject) => /\[[^\]]*\bRFC\b/i.test(subject);

/** The subject without its [PATCH ...] prefix. */
export const title = (subject) => subject.replace(/^\s*(\[[^\]]*\]\s*)+/, '').trim();

export const norm = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** "Name <addr>" -> "Name"; a trailer's "# comment" is dropped. */
export const personName = (addr) =>
  addr
    .replace(/\s*#.*$/, '')
    .replace(/\s*<.*>/, '')
    .replace(/^"|"$/g, '')
    .trim();

/** Every name in a commit's trailers of one kind, in order, once each. */
export function trailers(message, key) {
  const names = [...message.matchAll(new RegExp(`^${key}:\\s*(.+)$`, 'gmi'))].map((m) =>
    personName(m[1]),
  );
  return [...new Set(names.filter(Boolean))];
}

const words = (text) =>
  new Set(
    norm(text)
      .split(' ')
      .filter((w) => w.length > 2 && w !== 'riscv'),
  );

/**
 * One series under two titles: a title that grows or shrinks between versions
 * ("Zbb string optimizations and call support in alternatives" became "Zbb
 * string optimizations") keeps most of the shorter title's words.
 */
export function similarTitles(a, b) {
  const x = words(a);
  const y = words(b);
  const shorter = Math.min(x.size, y.size);
  if (shorter < 2) return norm(a) === norm(b);
  return [...x].filter((w) => y.has(w)).length / shorter >= 0.8;
}

// The table entries that list an extension: the riscv_isa_ext[] macros, in
// cpu.c and then cpufeature.c, and the older SET_ISA_EXT_MAP("zbb", ...).
const ADDED = /^\+.*?(?:__RISCV_ISA_EXT_\w*\(\s*(\w+)\s*,|SET_ISA_EXT_MAP\("(\w+)")/gm;
const TABLE_FILE = /^arch\/riscv\/kernel\/(cpufeature|cpu)\.c$/;

/** The extensions (lower case) a commit adds to the kernel's table, from its file diffs. */
export function addedIds(files) {
  const ids = new Set();
  for (const f of files ?? []) {
    if (!TABLE_FILE.test(f.filename)) continue;
    for (const m of (f.patch ?? '').matchAll(ADDED)) ids.add((m[1] ?? m[2]).toLowerCase());
  }
  return [...ids].sort();
}

export const isBulk = (adds, curated = false) => !curated && adds.length > BULK;

/**
 * Drops replies that kept the patch subject without "Re:" (some mail clients
 * do), so review is never counted as a new version or its writer as an
 * author. A message is a reply when any copy lore lists of it carries "Re:",
 * or when it answers something that is not a posting by the same author. A
 * patch under its own cover letter, or a v2 sent in reply to its v1, stays.
 */
export function dropDisguisedReplies(posts, all = posts) {
  const byId = new Map();
  const replyIds = new Set();
  for (const m of all) {
    if (!m.id) continue;
    if (!byId.has(m.id)) byId.set(m.id, m);
    // By "Re:", not by a missing [PATCH]: the 2017 port's cover letters were
    // titled "RISC-V Linux Port v8", and its patches answer them.
    if (isReplySubject(m.subject)) replyIds.add(m.id);
  }
  const genuine = new Map();
  const isGenuine = (p, depth = 0) => {
    if (!p.id) return true;
    if (genuine.has(p.id)) return genuine.get(p.id);
    let ok = !replyIds.has(p.id);
    if (ok && p.inReplyTo && byId.has(p.inReplyTo) && depth < 50) {
      const parent = byId.get(p.inReplyTo);
      ok = parent.author === p.author && !replyIds.has(parent.id) && isGenuine(parent, depth + 1);
    }
    genuine.set(p.id, ok);
    return ok;
  };
  return posts.filter((p) => isGenuine(p));
}

/**
 * Groups postings into series. A numbered patch joins its cover letter (same
 * author and version, within a day); postings whose titles agree
 * (similarTitles) are one series across versions and respins; a version sent
 * twice counts once, with its resends.
 */
export function groupSeries(input) {
  const posts = dropDisguisedReplies(
    input.filter((p) => isPosting(p.subject) && !BOT.test(p.author)),
    input,
  );
  const covers = posts.filter((p) => part(p.subject)[0] === 0);
  const groups = [];
  // Patches answering the same cover the search did not return: the first
  // of them stands for the series, so its siblings are not split into
  // separate groups (and one of them mistaken for an earlier attempt).
  const unseenCover = new Map(); // author|parent id -> { head, group }
  for (const p of [...posts].sort((a, b) => a.date - b.date)) {
    const [n] = part(p.subject);
    // The cover the patch answers, when lore says; otherwise the same
    // author's cover of that version sent within a day.
    const cover = n
      ? (covers.find((c) => c.id && c.id === p.inReplyTo) ??
        covers.find(
          (c) =>
            c.author === p.author &&
            version(c.subject) === version(p.subject) &&
            Math.abs(c.date - p.date) < ONE_DAY,
        ))
      : null;
    const sibling = n && !cover && p.inReplyTo ? `${p.author}|${p.inReplyTo}` : null;
    const shared = sibling ? unseenCover.get(sibling) : null;
    const head = cover ?? shared?.head ?? p;
    const headTitle = title(head.subject);
    let group = shared?.group ?? groups.find((g) => similarTitles(g.title, headTitle));
    if (!group) {
      group = { title: headTitle, postings: new Map() };
      groups.push(group);
    }
    if (sibling && !shared) unseenCover.set(sibling, { head, group });
    const key = `${isRfc(head.subject)}|${version(head.subject)}|${head.author}|${iso(head.date)}`;
    if (!group.postings.has(key))
      group.postings.set(key, {
        version: version(head.subject),
        rfc: isRfc(head.subject),
        date: head.date,
        author: head.author,
        href: head.href,
        titles: new Set(),
      });
    group.postings.get(key).titles.add(norm(title(p.subject)));
  }
  return groups.map((g) => {
    const byVersion = new Map();
    for (const p of [...g.postings.values()].sort((a, b) => a.date - b.date)) {
      const k = `${p.rfc}|${p.version}|${p.author}`;
      if (byVersion.has(k)) {
        const first = byVersion.get(k);
        first.resends += 1;
        for (const t of p.titles) first.titles.add(t);
      } else byVersion.set(k, { ...p, resends: 0 });
    }
    return { title: g.title, postings: [...byVersion.values()] };
  });
}

const latest = (groups) =>
  [...groups].sort((a, b) => b.postings.at(-1).date - a.postings.at(-1).date)[0] ?? null;

/**
 * The series that landed: for a named series (the curated list), the latest
 * group carrying that title; otherwise the latest group with a patch titled
 * like the commit.
 */
export function selectLanded(groups, commitSubject, namedTitle = null) {
  if (namedTitle) {
    const named = latest(groups.filter((g) => norm(g.title).includes(norm(namedTitle))));
    if (named) return { group: named, partial: false };
  }
  const key = norm(title(commitSubject));
  const byPatch = latest(groups.filter((g) => g.postings.some((p) => p.titles.has(key))));
  // A named series the archive cannot find by title keeps its name, and says
  // the versions found are not all of them.
  return byPatch ? { group: byPatch, partial: Boolean(namedTitle) } : null;
}

// Another subsystem using an extension is not an attempt to add it: KVM
// guest support and its selftests, crypto code using Zbc, perf, BPF.
const CONSUMER =
  /^\s*((risc-?v|riscv)\s*:\s*)?(kvm|crypto|selftests?|perf|bpf|libbpf|tools|ftrace)\b|\bselftests?\b|\bkvm\b/i;

/**
 * The other series that were attempts at the same support: begun before the
 * series that landed, and not another subsystem's use of the extension (the
 * extension-name search also finds those). Later work is not an earlier attempt.
 */
export function earlierAttempts(groups, landed) {
  const start = landed.postings[0].date;
  return groups.filter(
    (g) => g !== landed && g.postings[0].date < start && !CONSUMER.test(g.title),
  );
}

/** "2y 03m" between two ISO dates, or "N days" under a month. */
export function span(from, to) {
  const days = Math.round((Date.parse(to) - Date.parse(from)) / ONE_DAY);
  const years = Math.floor(days / 365);
  const months = Math.floor((days % 365) / 30.42);
  if (!years && !months) return `${days} days`;
  return years ? `${years}y ${String(months).padStart(2, '0')}m` : `${months}m`;
}

/** What a reply's writer added: no quoted lines, attribution lines, diffs or signatures. */
export function ownWords(body, limit = 800) {
  const out = [];
  for (const line of body.split('\n')) {
    if (/^-- ?$/.test(line)) break;
    if (/^diff --git /.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    if (/wrote:\s*$/.test(line.trim())) continue;
    out.push(line);
  }
  const text = out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const parts = text.split(/(\s+)/);
  return parts.length > limit * 2 ? `${parts.slice(0, limit * 2).join('')} [...]` : text;
}

// Abbreviations whose full stop does not end a sentence.
const ABBREVIATIONS = /\b(e\.g|i\.e|etc|vs|cf|al|approx|incl|resp)\./gi;

/**
 * Checks an AI summary against the numbered messages it was written from.
 * The model is told to end every sentence with its citations, so that is what
 * is checked: each sentence must end "[n, m]." with every n a message that
 * exists. Text after a sentence's citation, or a sentence without one,
 * whatever letter or digit it starts with, is uncited.
 */
export function checkCitations(summary, messageCount) {
  const text = summary.replace(ABBREVIATIONS, '$1').trim();
  const end = /\[([^\]]*)\]\s*[.!?](?=\s|$)/g;
  const cited = [];
  const invalid = [];
  const uncited = [];
  let last = 0;
  let m;
  while ((m = end.exec(text))) {
    const sentence = text.slice(last, m.index).trim();
    // A full stop before the citation means an earlier sentence went uncited:
    // inside the text ("First. Second [1].") or at its end ("Claim. [1].").
    const pieces = sentence.split(/(?<=[.!?])\s+(?=\S)/);
    for (const piece of pieces.slice(0, -1)) uncited.push(piece.trim());
    if (/[.!?]$/.test(pieces.at(-1) ?? '')) uncited.push(pieces.at(-1).trim());
    for (const n of m[1].split(',').map((x) => x.trim()))
      if (/^\d+$/.test(n) && Number(n) >= 1 && Number(n) <= messageCount) cited.push(Number(n));
      else invalid.push(n);
    last = end.lastIndex;
  }
  const rest = text.slice(last).trim();
  if (rest) uncited.push(rest);
  return {
    cited: [...new Set(cited)].sort((a, b) => a - b),
    invalid: [...new Set(invalid)],
    uncited,
    ok: invalid.length === 0 && uncited.length === 0 && cited.length > 0,
  };
}

/**
 * The review of a series: replies across every version's thread, each once
 * (a v2 posted in reply to v1 brings v1's thread along), from anyone but the
 * series' own authors and the bots.
 */
export function reviewReplies(threads, authors) {
  const seen = new Set();
  const replies = [];
  for (const messages of threads)
    for (const m of messages) {
      const key = m.messageId || `${m.from}|${m.date?.toISOString?.()}|${m.subject}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!isReplySubject(m.subject) || BOT.test(m.from)) continue;
      if ([...authors].some((a) => m.from.includes(a))) continue;
      replies.push(m);
    }
  return replies;
}

/** "RFC v3" for a message, from its own subject; null when the subject has no [PATCH] tag. */
export function versionLabel(subject) {
  if (!/\[[^\]]*PATCH/i.test(subject)) return null;
  return `${isRfc(subject) ? 'RFC ' : ''}v${version(subject)}`;
}
