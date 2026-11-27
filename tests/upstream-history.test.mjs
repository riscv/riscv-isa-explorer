// The upstream history (#649): the sync's parsing and grouping
// (scripts/upstream-history-lib.mjs), the summarizer's citation gate
// (scripts/summarize_upstream_history.mjs) with a fake model, the dialog's
// logic (src/upstreamHistory.js), and the committed data
// (src/upstream-history.json and its index). All offline; the weekly workflow
// does the fetching.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  addedIds,
  checkCitations,
  reviewReplies,
  versionLabel,
  decodeBody,
  decodeMime,
  dropDisguisedReplies,
  groupSeries,
  isBulk,
  isPosting,
  isRfc,
  ownWords,
  parseAtom,
  parseMbox,
  part,
  personName,
  selectLanded,
  similarTitles,
  span,
  title,
  trailers,
  version,
} from '../scripts/upstream-history-lib.mjs';
import { CURATED, UNCOLLECTED } from '../scripts/upstream-curated.mjs';
import { buildIndex } from '../scripts/sync_upstream_history.mjs';
import {
  MODEL_NAME,
  inputHash,
  messagesFor,
  summarize,
} from '../scripts/summarize_upstream_history.mjs';
import {
  bundleRelease,
  groupFor,
  hasHistory,
  historyQuestion,
  placeDates,
  progressionAxis,
  span as uiSpan,
  timelineItems,
} from '../src/upstreamHistory.js';

const read = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), 'utf8'));
const data = read('../src/upstream-history.json');
const index = read('../src/upstream-history-index.json');
const catalogue = new Set(
  Object.values(read('../src/riscv_extensions.json'))
    .flat()
    .filter(Boolean)
    .map((e) => e.id),
);

/* ---------- reading lore ---------- */

test('subjects: postings, versions, parts, RFC and titles', () => {
  assert.equal(isPosting('[PATCH v3 2/7] riscv: Add Zawrs support'), true);
  assert.equal(isPosting('Re: [PATCH v3 2/7] riscv: Add Zawrs support'), false);
  assert.equal(isPosting('AW: [PATCH] x'), false, 'a German client reply');
  assert.equal(isPosting('riscv: no patch tag'), false);
  assert.equal(version('[PATCH -next v18 00/20] riscv: Add vector ISA support'), 18);
  assert.equal(version('[RFC PATCH V3 00/11] riscv: Add vector ISA support'), 3);
  assert.equal(version('[PATCH] riscv: one patch'), 1);
  assert.deepEqual(part('[PATCH v2 03/16] x'), [3, 16]);
  assert.deepEqual(part('[PATCH] x'), []);
  assert.equal(isRfc('[RFC PATCH v2] x'), true);
  assert.equal(isRfc('[PATCH v2] RFC compliance'), false, 'only the tag counts');
  assert.equal(title('[PATCH v2 1/3] [RESEND] riscv: x'), 'riscv: x');
});

test('names from addresses and trailers', () => {
  assert.equal(personName('"Andy Chiu" <andy.chiu@sifive.com>'), 'Andy Chiu');
  assert.equal(personName('Andreas Korb <a@b> # QEMU, custom CVA6'), 'Andreas Korb');
  const msg =
    'x\n\nReviewed-by: A B <a@b>\nReviewed-by: C D <c@d>\nReviewed-by: A B <a@b>\nTested-by: E F <e@f> # QEMU\n';
  assert.deepEqual(trailers(msg, 'Reviewed-by'), ['A B', 'C D']);
  assert.deepEqual(trailers(msg, 'Tested-by'), ['E F']);
});

test('MIME words and quoted-printable bodies are decoded', () => {
  assert.equal(decodeMime('=?UTF-8?q?Cl=C3=A9ment_L=C3=A9ger?= <c@x>'), 'Clément Léger <c@x>');
  assert.equal(decodeMime('=?utf-8?b?QmrDtnJu?= =?utf-8?b?IFTDtnBlbA==?='), 'Björn Töpel');
  assert.equal(
    decodeBody('caf=C3=A9 and a soft=\nbreak', 'quoted-printable'),
    'café and a softbreak',
  );
  assert.equal(decodeBody('aGVsbG8=', 'base64'), 'hello');
  assert.equal(decodeBody('plain', '8bit'), 'plain');
});

test('an mbox splits into messages with their headers and decoded bodies', () => {
  const mbox = [
    'From mboxrd@z Thu Jan  1 00:00:00 1970',
    'From: =?UTF-8?q?J=C3=B6rg?= <j@x>',
    'Subject: [PATCH v2 0/3] riscv: Add',
    ' the thing',
    'Date: Wed, 20 Dec 2023 16:57:16 +0100',
    'Message-ID: <cover@x>',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'A cover =C3=A9',
    '>From the archive',
    'From mboxrd@z Thu Jan  1 00:00:00 1970',
    'From: Reviewer <r@x>',
    'Subject: Re: [PATCH v2 0/3] riscv: Add the thing',
    'Date: Thu, 21 Dec 2023 10:00:00 +0000',
    'Message-ID: <reply@x>',
    'In-Reply-To: <cover@x>',
    '',
    'Looks good.',
  ].join('\n');
  const [cover, reply] = parseMbox(mbox);
  assert.equal(cover.from, 'Jörg <j@x>');
  assert.equal(cover.subject, '[PATCH v2 0/3] riscv: Add the thing', 'folded header unfolded');
  assert.equal(cover.messageId, 'cover@x');
  assert.match(cover.body, /A cover é/);
  assert.match(cover.body, /^From the archive$/m, 'mboxrd escaping undone');
  assert.equal(reply.inReplyTo, 'cover@x');
  assert.equal(reply.date.toISOString().slice(0, 10), '2023-12-21');
});

const entry = ({ id, subject, author, date, parent = null }) =>
  `<entry><author><name>${author}</name></author><title>${subject}</title><updated>${date}T10:00:00Z</updated><link href="https://lore.kernel.org/linux-riscv/${id}/"/>${
    parent ? `<thr:in-reply-to ref="x" href="https://lore.kernel.org/linux-riscv/${parent}/"/>` : ''
  }</entry>`;

test('Atom search results become entries, with the message each answers', () => {
  const xml = `<feed>${entry({ id: 'a%40x', subject: '[PATCH] Bj&#246;rn &amp; co', author: 'Deepak Gupta via B4 Relay', date: '2025-01-02' })}${entry({ id: 'b@x', subject: 'Re: [PATCH] x', author: 'R', date: '2025-01-03', parent: 'a@x' })}</feed>`;
  const [a, b] = parseAtom(xml);
  assert.equal(a.id, 'a@x', 'percent-encoding decoded');
  assert.equal(a.subject, '[PATCH] Björn & co');
  assert.equal(a.author, 'Deepak Gupta', 'b4 relay is the author');
  assert.equal(a.inReplyTo, null);
  assert.equal(b.inReplyTo, 'a@x');
  assert.deepEqual(parseAtom(''), []);
});

/* ---------- the kernel's extension table ---------- */

test('addedIds reads both forms of the table, in both files, and nothing else', () => {
  const files = [
    {
      filename: 'arch/riscv/kernel/cpufeature.c',
      patch:
        '@@\n+\t__RISCV_ISA_EXT_DATA(zicfiss, RISCV_ISA_EXT_ZICFISS),\n+\t__RISCV_ISA_EXT_SUPERSET(zicfilp, RISCV_ISA_EXT_ZICFILP, x),\n-\t__RISCV_ISA_EXT_DATA(old, RISCV_ISA_EXT_OLD),\n \t__RISCV_ISA_EXT_DATA(ctx, RISCV_ISA_EXT_CTX),',
    },
    {
      filename: 'arch/riscv/kernel/cpu.c',
      patch: '+\t\tSET_ISA_EXT_MAP("zbb", RISCV_ISA_EXT_ZBB);',
    },
    { filename: 'Documentation/x.rst', patch: '+__RISCV_ISA_EXT_DATA(nope, X),' },
  ];
  assert.deepEqual(addedIds(files), ['zbb', 'zicfilp', 'zicfiss']);
  assert.deepEqual(addedIds(undefined), []);
});

test('a commit listing more than three extensions is bookkeeping, unless named by hand', () => {
  assert.equal(isBulk(['zba', 'zbs']), false);
  assert.equal(isBulk(['a', 'c', 'd', 'f']), true);
  assert.equal(isBulk(['a', 'c', 'd', 'f'], true), false);
});

/* ---------- series ---------- */

const post = (id, subject, author, date, parent = null) => ({
  id,
  href: `https://lore.kernel.org/all/${id}/`,
  subject,
  author,
  date: new Date(`${date}T10:00:00Z`),
  inReplyTo: parent,
});

test('a reply that kept the patch subject is not a posting', () => {
  const cover = post(
    'c18',
    '[PATCH -next v18 00/20] riscv: Add vector ISA support',
    'Andy Chiu',
    '2023-04-14',
  );
  const review = post(
    'r1',
    'Re: [PATCH -next v18 00/20] riscv: Add vector ISA support',
    'Palmer Dabbelt',
    '2023-04-19',
    'c18',
  );
  // Listed twice by lore, once with "Re:": a reply, whatever the other copy says.
  const disguised = post(
    'b1',
    '[PATCH -next v18 00/20] riscv: Add vector ISA support',
    'Björn Töpel',
    '2023-04-19',
    'c18',
  );
  const disguisedRe = { ...disguised, subject: `Re: ${disguised.subject}` };
  // Answering their own reply: still review.
  const ownReply = post(
    'b0',
    'Re: [PATCH -next v18 00/20] riscv: Add vector ISA support',
    'Björn Töpel',
    '2023-04-19',
    'c18',
  );
  const chained = post(
    'b2',
    '[PATCH -next v18 00/20] riscv: Add vector ISA support',
    'Björn Töpel',
    '2023-04-20',
    'b0',
  );
  const patch = post(
    'p1',
    '[PATCH -next v18 01/20] riscv: Rename',
    'Andy Chiu',
    '2023-04-14',
    'c18',
  );
  const v19 = post(
    'c19',
    '[PATCH -next v19 00/20] riscv: Add vector ISA support',
    'Andy Chiu',
    '2023-05-09',
    'c18',
  );
  const orphan = post('o1', '[PATCH v2] x', 'Someone', '2023-05-01', 'not-in-results');
  // A cover letter without a [PATCH] tag, as the 2017 port's were: its patches stay.
  const untagged = post('port8', 'RISC-V Linux Port v8', 'Palmer Dabbelt', '2017-09-12');
  const portPatch = post(
    'port8-10',
    '[PATCH v8 10/18] RISC-V: Init and Halt Code',
    'Palmer Dabbelt',
    '2017-09-12',
    'port8',
  );
  const all = [
    cover,
    review,
    disguised,
    disguisedRe,
    ownReply,
    chained,
    patch,
    v19,
    orphan,
    untagged,
    portPatch,
  ];
  const kept = dropDisguisedReplies(
    all.filter((p) => isPosting(p.subject)),
    all,
  ).map((p) => p.id);
  assert.deepEqual(kept, ['c18', 'p1', 'c19', 'o1', 'port8-10']);
});

test('postings group into series across versions, resends, respins and a changed title', () => {
  const posts = [
    post(
      'z1',
      '[RFC PATCH] riscv: Add Zawrs support for spinlocks',
      'Christoph Muellner',
      '2022-06-02',
    ),
    post(
      'z2',
      '[RFC PATCH v2] riscv: Add Zawrs support for spinlocks',
      'Christoph Muellner',
      '2022-06-23',
    ),
    post(
      'h3',
      '[PATCH v3 0/2] Add Zawrs support and use it for spinlocks',
      'Heiko Stuebner',
      '2023-05-21',
    ),
    post(
      'h3b',
      '[PATCH v3 2/2] riscv: Add Zawrs support for spinlocks',
      'Heiko Stuebner',
      '2023-05-21',
      'h3',
    ),
    post('a1', '[PATCH 0/5] riscv: Apply Zawrs when available', 'Andrew Jones', '2024-03-15'),
    post(
      'a1p',
      '[PATCH 1/5] riscv: Add Zawrs support for spinlocks',
      'Andrew Jones',
      '2024-03-15',
      'a1',
    ),
    post('a3', '[PATCH v3 0/6] riscv: Apply Zawrs when available', 'Andrew Jones', '2024-04-26'),
    post('a3r', '[PATCH v3 0/6] riscv: Apply Zawrs when available', 'Andrew Jones', '2024-04-27'),
    post('bot', '[PATCH] riscv: Apply Zawrs when available', 'kernel test robot', '2024-04-28'),
    post(
      's1',
      '[PATCH v1] Zbb string optimizations and call support in alternatives',
      'Heiko Stuebner',
      '2022-11-10',
    ),
    post('s5', '[PATCH v5] Zbb string optimizations', 'Heiko Stuebner', '2023-01-13'),
  ];
  const groups = groupSeries(posts);
  const byTitle = Object.fromEntries(groups.map((g) => [g.title, g]));
  const apply = byTitle['riscv: Apply Zawrs when available'];
  assert.ok(apply, 'the 2024 series');
  assert.deepEqual(
    apply.postings.map((p) => [p.version, p.resends]),
    [
      [1, 0],
      [3, 1],
    ],
    'v3 sent twice counts once, with a resend',
  );
  assert.ok(
    apply.postings[0].titles.has('riscv add zawrs support for spinlocks'),
    'patch titles kept',
  );
  assert.equal(
    groups.filter((g) => /Zbb string/.test(g.title)).length,
    1,
    'a shortened title is one series',
  );
  assert.ok(
    !groups.some((g) => g.postings.some((p) => p.author === 'kernel test robot')),
    'bots dropped',
  );
});

test('two titles are one series when the shorter one is mostly in the longer', () => {
  assert.equal(
    similarTitles(
      'Zbb string optimizations and call support in alternatives',
      'Zbb string optimizations',
    ),
    true,
  );
  assert.equal(
    similarTitles('riscv: Apply Zawrs when available', 'riscv: Add Zawrs support for spinlocks'),
    false,
  );
  assert.equal(
    similarTitles('RISC-V: Add Zba', 'RISC-V: Add Zbb'),
    false,
    'one significant word each: exact match only',
  );
  assert.equal(similarTitles('riscv: Add Zicbop', 'RISC-V: add zicbop'), true);
});

test('a patch joins the cover it answers, even beside another of that day', () => {
  const groups = groupSeries([
    post('ca', '[PATCH 0/2] riscv: First series', 'Same Author', '2024-01-10'),
    post('cb', '[PATCH 0/2] riscv: Second series', 'Same Author', '2024-01-10'),
    post('pb', '[PATCH 1/2] riscv: Detect the thing', 'Same Author', '2024-01-10', 'cb'),
  ]);
  const second = groups.find((g) => g.title === 'riscv: Second series');
  assert.ok(
    second.postings[0].titles.has('riscv detect the thing'),
    'the patch belongs to the cover it replies to',
  );
  assert.ok(
    !groups
      .find((g) => g.title === 'riscv: First series')
      .postings[0].titles.has('riscv detect the thing'),
  );
  assert.equal(selectLanded(groups, 'riscv: Detect the thing').group.title, 'riscv: Second series');
});

test('the landed series: by the commit title, the latest, or a named one', () => {
  const groups = groupSeries([
    post(
      'old',
      '[PATCH] riscv: Add Zawrs support for spinlocks',
      'Christoph Muellner',
      '2022-06-02',
    ),
    post('c', '[PATCH v3 0/6] riscv: Apply Zawrs when available', 'Andrew Jones', '2024-04-26'),
    post(
      'p',
      '[PATCH v3 3/6] riscv: Add Zawrs support for spinlocks',
      'Andrew Jones',
      '2024-04-26',
      'c',
    ),
  ]);
  const landed = selectLanded(groups, 'riscv: Add Zawrs support for spinlocks');
  assert.equal(
    landed.group.title,
    'riscv: Apply Zawrs when available',
    'the latest series carrying the patch',
  );
  assert.equal(landed.partial, false);
  const named = selectLanded(
    groups,
    'RISC-V: Init and Halt Code',
    'riscv: Apply Zawrs when available',
  );
  assert.equal(named.group.title, 'riscv: Apply Zawrs when available');
  const partial = selectLanded(
    groups,
    'riscv: Add Zawrs support for spinlocks',
    'RISC-V Linux Port',
  );
  assert.equal(partial.partial, true, 'a named series not found by title is marked partial');
  assert.equal(selectLanded(groups, 'riscv: something else'), null);
});

test('durations read as years and months, or days under a month', () => {
  assert.equal(span('2022-06-02', '2024-09-15'), '2y 03m');
  assert.equal(span('2026-05-11', '2026-07-30'), '2m');
  assert.equal(span('2023-12-13', '2024-01-10'), '28 days');
  assert.equal(
    uiSpan('2022-06-02', '2024-09-15'),
    span('2022-06-02', '2024-09-15'),
    'the dialog agrees with the sync',
  );
});

/* ---------- summaries ---------- */

test('ownWords keeps what the writer added', () => {
  const body = [
    'On Mon, Jan 1, 2024 at 10:00 Someone wrote:',
    '> quoted line',
    'My point about wrs.nto.',
    '',
    'diff --git a/x b/x',
    '+code',
  ].join('\n');
  assert.equal(ownWords(body), 'My point about wrs.nto.');
  assert.equal(ownWords('text\n-- \nsignature'), 'text');
});

test('the citation gate: every sentence cites, every citation exists', () => {
  const good =
    'The series adds Zawrs [1, 3]. Reviewers asked about wrs.nto, e.g. its timeout [2]. It landed in v3 [4].';
  assert.deepEqual(checkCitations(good, 4), {
    cited: [1, 2, 3, 4],
    invalid: [],
    uncited: [],
    ok: true,
  });
  assert.deepEqual(
    checkCitations('It adds Zawrs [9].', 4).invalid,
    ['9'],
    'a message that does not exist',
  );
  assert.deepEqual(checkCitations('It adds Zawrs [0].', 4).invalid, ['0']);
  const uncited = checkCitations('It adds Zawrs [1]. Everyone agreed.', 4);
  assert.equal(uncited.ok, false);
  assert.deepEqual(uncited.uncited, ['Everyone agreed.']);
  assert.equal(checkCitations('No citations at all', 4).ok, false);
  // Whatever a sentence starts with, it must end with its citations.
  assert.deepEqual(checkCitations('Supported [1]. unsupported claim.', 2).uncited, [
    'unsupported claim.',
  ]);
  assert.deepEqual(checkCitations('Supported [1]. 2025 brought another claim.', 2).uncited, [
    '2025 brought another claim.',
  ]);
  assert.equal(
    checkCitations('Reviewers agreed [1] and then a claim nobody made.', 2).ok,
    false,
    'text after the citation is uncited',
  );
  assert.deepEqual(
    checkCitations('First claim. Second claim [1].', 2).uncited,
    ['First claim.'],
    'a sentence hiding before a cited one',
  );
  assert.equal(
    checkCitations('It landed in Linux 6.5, e.g. for vector [1].', 2).ok,
    true,
    'versions and e.g. are not sentence ends',
  );
  for (const stray of ['Claim. [1].', 'Claim! [1].', 'Claim? [1].', 'Claim.\n[1].'])
    assert.equal(
      checkCitations(stray, 2).ok,
      false,
      `a citation after the full stop: ${JSON.stringify(stray)}`,
    );
});

const messages = (n) =>
  Array.from({ length: n }, (_, i) => ({
    n: i + 1,
    date: new Date('2024-04-26T10:00:00Z'),
    from: `Reviewer ${i + 1} <r${i + 1}@x>`,
    version: 'v3',
    subject: 'Re: [PATCH v3 0/6] riscv: Apply Zawrs when available',
    messageId: `m${i + 1}@x`,
    text: `point ${i + 1} about the series`,
  }));
const series = {
  title: 'riscv: Apply Zawrs when available',
  versions: [{ version: 'v3', date: '2024-04-26', author: 'Andrew Jones' }],
};

test('a summary that passes the gate keeps only the messages it cites', async () => {
  const calls = [];
  const fake = (user) => {
    calls.push(user);
    return {
      text: 'It adds Zawrs [1]. Reviewers asked about wrs.nto [3].',
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  };
  const r = await summarize(['Zawrs'], series, messages(3), fake);
  assert.equal(calls.length, 1);
  assert.match(
    calls[0],
    /\[2\] 2024-04-26 \| Reviewer 2 \| v3 \|/,
    'messages are numbered for the model',
  );
  assert.doesNotMatch(calls[0], /r2@x/, 'addresses are not sent');
  assert.deepEqual(
    r.sources.map((s) => [s.n, s.from, s.url]),
    [
      [1, 'Reviewer 1', 'https://lore.kernel.org/all/m1%40x/'],
      [3, 'Reviewer 3', 'https://lore.kernel.org/all/m3%40x/'],
    ],
  );
  assert.deepEqual(r.usage, { input: 10, output: 5, calls: 1 });
});

test('a summary failing the gate is retried once, then dropped', async () => {
  const answers = ['Uncited sentence. Another [1].', 'Fixed [1]. Now cited [2].'];
  let i = 0;
  const retried = await summarize(['Zawrs'], series, messages(2), () => ({ text: answers[i++] }));
  assert.equal(retried.summary, 'Fixed [1]. Now cited [2].');
  assert.equal(i, 2);
  let n = 0;
  const dropped = await summarize(['Zawrs'], series, messages(2), () => {
    n += 1;
    return { text: 'Cites a ghost [7].' };
  });
  assert.equal(dropped, null);
  assert.equal(n, 2, 'one retry, no more');
  assert.equal(
    await summarize(['Zawrs'], series, [], () => ({ text: 'x [1].' })),
    null,
    'nothing to summarise',
  );
});

test('a long discussion is summarised in parts, each citing only its own messages', async () => {
  const long = messages(3).map((m) => ({ ...m, text: 'x'.repeat(160_000) }));
  const partOf = (user) => Number((user.match(/messages (\d+) to/) ?? [])[1]);
  const prompts = [];
  const r = await summarize(['V'], series, long, (user) => {
    prompts.push(user);
    const first = partOf(user);
    return { text: first ? `Part summary [${first}].` : 'Merged [1, 2, 3].' };
  });
  assert.ok(r, 'parts citing their own messages pass');
  assert.equal(prompts.length, 4, 'three parts and a merge');
  assert.match(prompts.at(-1), /merge these partial summaries/);
  assert.deepEqual(
    r.sources.map((x) => x.n),
    [1, 2, 3],
  );

  // A part citing a message it was never shown is retried, then the summary is dropped.
  let calls = 0;
  const outOfRange = await summarize(['V'], series, long, (user) => {
    calls += 1;
    return { text: partOf(user) ? 'Part summary [1].' : 'Merged [1].' };
  });
  assert.equal(outOfRange, null, 'part 2 citing [1] must not pass');
  assert.ok(calls <= 2 + 2 * 2, 'bounded retries');
});

test('the input hash changes with anything the model is shown', () => {
  const a = inputHash(['Zawrs'], series, messages(3));
  assert.equal(a, inputHash(['Zawrs'], series, messages(3)), 'stable');
  const changed = messages(3);
  changed[1].text = 'a new point';
  assert.notEqual(a, inputHash(['Zawrs'], series, changed), 'a message');
  assert.notEqual(a, inputHash(['Zawrs', 'Zbs'], series, messages(3)), 'the extensions');
  assert.notEqual(
    a,
    inputHash(
      ['Zawrs'],
      {
        ...series,
        versions: [...series.versions, { version: 'v4', date: '2024-05-01', author: 'X' }],
      },
      messages(3),
    ),
    'the versions',
  );
});

test('review replies are counted once across overlapping version threads', () => {
  const m = (id, subject, from) => ({ messageId: id, subject, from, date: new Date('2024-01-01') });
  const v1 = [
    m('c1', '[PATCH 0/2] riscv: x', 'Author <a@x>'),
    m('r1', 'Re: [PATCH 0/2] riscv: x', 'Reviewer <r@x>'),
    m('own', 'Re: [PATCH 0/2] riscv: x', 'Author <a@x>'),
    m('bot', 'Re: [PATCH 0/2] riscv: x', 'kernel test robot <lkp@intel.com>'),
  ];
  // v2 was sent in reply to v1, so its thread brings v1's messages along.
  const v2 = [
    ...v1,
    m('c2', '[PATCH v2 0/2] riscv: x', 'Author <a@x>'),
    m('r2', 'Re: [PATCH v2 0/2] riscv: x', 'Reviewer <r@x>'),
  ];
  assert.deepEqual(
    reviewReplies([v1, v2], new Set(['Author'])).map((x) => x.messageId),
    ['r1', 'r2'],
  );
});

test('each summary message is labelled with the version its subject names', async () => {
  const msg = (id, subject, day, body = 'a real point about the patch') => ({
    messageId: id,
    subject,
    from: 'Reviewer <r@x>',
    date: new Date(`2024-01-0${day}T10:00:00Z`),
    body,
  });
  const v1 = [msg('c1', '[PATCH 0/2] riscv: x', 1), msg('r1', 'Re: [PATCH 0/2] riscv: x', 2)];
  const v2 = [
    ...v1,
    msg('r2', 'Re: [RFC PATCH v2 1/2] riscv: x', 4),
    msg('p2', '[PATCH v2 1/2] riscv: x', 3),
    msg('ack', 'Re: [PATCH v2 1/2] riscv: x', 5, 'Acked-by: X'),
  ];
  const threads = { h1: v1, h2: v2 };
  const out = await messagesFor(
    {
      versions: [
        { version: 'v1', href: 'h1' },
        { version: 'v2', href: 'h2' },
      ],
    },
    async (href) => threads[href],
  );
  assert.deepEqual(
    out.map((x) => [x.n, x.messageId, x.version]),
    [
      [1, 'c1', 'v1'],
      [2, 'r1', 'v1'],
      [3, 'r2', 'RFC v2'],
    ],
    'each once, oldest first, numbered; the patch itself and a bare ack left out',
  );
  assert.equal(versionLabel('Re: [PATCH v3 2/7] x'), 'v3');
  assert.equal(versionLabel('Re: a reply that lost its tag'), null);
});

/* ---------- the dialog's logic ---------- */

const ui = {
  B: { parts: ['Zba', 'Zbb', 'Zbs'] },
  Zba: { release: '6.5', firstPatch: '2022-12-20', versions: 2, replies: 28, landedWith: ['Zbs'] },
  Zbs: { release: '6.5', firstPatch: '2022-12-20', versions: 2, replies: 28, landedWith: ['Zba'] },
  Zbb: { release: '6.3', firstPatch: '2022-11-04', versions: 5, replies: 173, landedWith: [] },
  Q: { listed: { release: '6.6', others: 12 } },
};

test('which extensions open a dialog, and what Previous and Next walk', () => {
  assert.equal(hasHistory(ui, 'Zba'), true);
  assert.equal(hasHistory(ui, 'B'), true);
  assert.equal(hasHistory(ui, 'Q'), false, 'listed only: nothing to open');
  assert.equal(hasHistory(ui, 'Nope'), false);
  assert.deepEqual(groupFor(ui, 'B', 'Zbb'), {
    label: 'B parts',
    items: ['B', 'Zba', 'Zbb', 'Zbs'],
  });
  assert.deepEqual(groupFor(ui, 'Zbs', 'Zbs'), { label: 'Landed together', items: ['Zba', 'Zbs'] });
  assert.equal(groupFor(ui, 'Zbb', 'Zbb'), null);
});

test('a bundle is complete with its last part, compared as versions', () => {
  assert.equal(bundleRelease(ui, ['Zba', 'Zbb', 'Zbs']), '6.5');
  assert.equal(
    bundleRelease({ X: { release: '6.9' }, Y: { release: '6.10' } }, ['X', 'Y']),
    '6.10',
  );
  assert.equal(bundleRelease(ui, ['Q']), null);
  assert.equal(bundleRelease(ui, ['Zba', 'Unknown']), null, 'not complete while a part is unknown');
});

test('Ask AI asks about the extension and its family, never the thread', () => {
  assert.equal(
    historyQuestion(ui, 'B'),
    'Explain the RISC-V B extension and its parts Zba, Zbb and Zbs.',
  );
  assert.equal(
    historyQuestion(ui, 'Zba'),
    'Explain the RISC-V Zba extension and how it relates to Zbs.',
  );
  assert.equal(
    historyQuestion(ui, 'Zbb'),
    'Explain the RISC-V Zbb extension and the specification that defines it.',
  );
  for (const id of Object.keys(data.extensions)) {
    const q = historyQuestion(index, id);
    assert.match(q, /^Explain the RISC-V /);
    const people = Object.values(data.series[data.extensions[id].series].people).flat();
    for (const name of people) assert.ok(!q.includes(name), `${id}: the question names ${name}`);
  }
});

test('the timeline orders attempts, versions, applied and released', () => {
  const items = timelineItems({
    earlier: [{ date: '2022-06-02', title: 'old', authors: ['A'], postings: 2 }],
    versions: [
      { version: 'v1', date: '2024-03-15', author: 'B', resends: 0, href: 'h1' },
      { version: 'v3', date: '2024-07-12', author: 'B', resends: 1, href: 'h3' },
    ],
    commit: { applied: '2024-07-12', committer: 'C', sha: 'abc' },
    release: { version: '6.11', date: '2024-09-15' },
  });
  assert.deepEqual(
    items.map((i) => i.kind),
    ['earlier', 'landed', 'landed', 'applied', 'release'],
    'on the same day, the version comes before applied',
  );
  assert.equal(items[2].sub, 'B, resent 1×');
  assert.equal(items[0].sub, 'A, 2 postings');
});

test('the Progression axis fits the data and always dates its first label', () => {
  const short = progressionAxis(['2017-06-28'], ['2018-01-28']);
  const labels = short.ticks.filter((k) => k.label).map((k) => k.label);
  assert.equal(labels[0], '2017 Jul', 'a mid-year start names its year');
  assert.ok(labels.includes('2018'));
  assert.ok(short.x('2017-06-28') > 96 && short.x('2018-01-28') < 1000 - 72, 'inside the plot');
  assert.ok(short.x('2017-06-28') < short.x('2017-09-26'), 'time runs left to right');
  const long = progressionAxis(['2020-01-05'], ['2023-08-27']);
  assert.ok(
    long.ticks.every((k) => k.label === null || /^\d{4}$/.test(k.label)),
    'years only',
  );
  assert.equal(long.ticks.find((k) => k.label).label, '2020');
  const decade = progressionAxis(['2014-01-01'], ['2026-01-01']);
  assert.ok(decade.ticks.filter((k) => k.label).length <= 7, 'every other year on a long axis');
});

test('dates under a lane never collide; the more important one wins', () => {
  const placed = placeDates([
    { at: 500, text: 'release' },
    { at: 470, text: 'applied' },
    { at: 300, text: 'first' },
  ]);
  assert.deepEqual(
    placed.map((p) => p.text),
    ['release', 'first'],
  );
});

/* ---------- the committed data ---------- */

test('the index the bundle carries is exactly what the data gives', () => {
  assert.deepEqual(index, buildIndex(data));
});

test('every extension Linux supports is in the data, or explained', () => {
  const support = read('../src/toolchain-support.json');
  const byLower = new Map([...catalogue].map((id) => [id.toLowerCase(), id]));
  const supported = Object.entries(support.extensions)
    .filter(([, v]) => v.linux?.supported)
    .map(([token]) => byLower.get(token))
    .filter(Boolean);
  assert.ok(
    supported.length >= 100,
    `expected the Linux-supported extensions, found ${supported.length}`,
  );
  const missing = supported.filter(
    (id) => !data.extensions[id] && !data.listed[id] && !data.bundles[id] && !UNCOLLECTED[id],
  );
  assert.deepEqual(
    missing,
    [],
    'gone from the data: a regression, or add it to UNCOLLECTED with why',
  );
  for (const id of Object.keys(UNCOLLECTED))
    assert.ok(!data.extensions[id], `${id} is collected now; drop it from UNCOLLECTED`);
});

test('every history belongs to a catalogue extension and a series that exists', () => {
  for (const [id, e] of Object.entries(data.extensions)) {
    assert.ok(catalogue.has(id), `${id} is not in the catalogue`);
    assert.ok(data.series[e.series], `${id}: series ${e.series} missing`);
    for (const other of e.landedWith) {
      assert.ok(catalogue.has(other), `${id} landed with ${other}, not in the catalogue`);
      if (data.extensions[other]) {
        assert.equal(data.extensions[other].series, e.series, `${id} and ${other} landed together`);
        assert.ok(data.extensions[other].landedWith.includes(id), `${other} should name ${id}`);
      }
    }
  }
  for (const [id, b] of Object.entries(data.bundles)) {
    assert.ok(catalogue.has(id), id);
    for (const p of b.parts) assert.ok(catalogue.has(p), `${id} part ${p}`);
  }
});

test('every series runs in order: first patch, versions, applied, released', () => {
  for (const [key, s] of Object.entries(data.series)) {
    assert.match(key, /^[0-9a-f]{12}$/);
    assert.equal(s.commit.sha, key);
    assert.match(s.release.version, /^\d+\.\d+$/, key);
    const dates = s.versions.map((v) => v.date);
    assert.deepEqual([...dates].sort(), dates, `${key}: versions out of order`);
    assert.ok(s.firstPatch <= dates[0], `${key}: first patch after the landed series`);
    assert.ok(dates.at(-1) <= s.commit.applied, `${key}: a version after it was applied`);
    assert.ok(s.commit.applied <= s.release.date, `${key}: applied after the release`);
    for (const v of s.versions) assert.match(v.href, /^https:\/\/lore\.kernel\.org\//, key);
    assert.ok(!s.people.seriesAuthors.some((a) => /\bbot\b/i.test(a)), key);
  }
});

test('every AI summary passes the gate, cites real messages and names no account', () => {
  const raw = fs.readFileSync(new URL('../src/upstream-history.json', import.meta.url), 'utf8');
  // The model is named, never addressed: an ARN or inference-profile id carries
  // the AWS account number. (Lore message ids are full of long digit runs, so
  // a digit pattern cannot stand in for this.)
  assert.doesNotMatch(raw, /arn:aws|inference-profile|bedrock:/, 'no AWS identifiers in the data');
  let summaries = 0;
  for (const [key, s] of Object.entries(data.series)) {
    if (!s.ai) continue;
    summaries += 1;
    assert.equal(s.ai.model, MODEL_NAME, key);
    const cited = checkCitations(s.ai.summary, Math.max(...s.ai.sources.map((x) => x.n)));
    assert.equal(cited.ok, true, `${key}: ${JSON.stringify(cited.uncited.concat(cited.invalid))}`);
    assert.deepEqual(
      s.ai.sources.map((x) => x.n),
      cited.cited,
      `${key}: the sources are exactly the messages cited`,
    );
    for (const src of s.ai.sources)
      assert.match(src.url, /^https:\/\/lore\.kernel\.org\/all\//, key);
  }
  assert.ok(summaries >= 5, `expected summaries, found ${summaries}`);
});

test('the hand-written list names catalogue extensions, and the data uses it', () => {
  for (const [id, c] of Object.entries(CURATED)) {
    assert.ok(catalogue.has(id), id);
    assert.ok(c.adds.includes(id), `${id} must be among the extensions its series adds`);
    assert.match(c.sha, /^[0-9a-f]{40}$/, id);
    assert.ok(c.title && c.why, id);
    const e = data.extensions[id];
    assert.ok(e, `${id} is curated but has no history in the data`);
    assert.equal(data.series[e.series].commit.sha, c.sha.slice(0, 12), id);
    assert.equal(data.series[e.series].curated, true, id);
  }
});
