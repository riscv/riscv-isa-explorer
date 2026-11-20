/**
 * The printable pocket guide (scripts/pocket-guide.mjs, printed to PDF by
 * scripts/pocket-guide-pdf.mjs in the deploy job).
 *
 * Its page numbers are computed before anything is rendered, because every
 * block has a page count the data fixes. The failures that matter are
 * therefore silent ones a reader finds on paper: a chip or an index entry
 * pointing at the wrong page, an extension missing or printed twice, a page
 * that grew past its box, or catalogue text injected as markup.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildAllGuides,
  buildGuide,
  encodingCells,
  FULL_EDITION,
  INSTRUCTION_CAP,
  loadInputs,
} from '../scripts/pocket-guide.mjs';
import { pocketGuidePath, pocketGuideSlug } from '../src/profileExport.js';
import { PROFILES } from '../src/profiles.js';
import { resolveSelection } from '../src/isaGraph.js';

const inputs = loadInputs({ date: '2026-01-02' });
const all = Object.values(inputs.catalog).flat();
const ids = new Set(all.map((e) => e.id));
const full = buildGuide({ ...inputs, edition: FULL_EDITION });

/** Each <section class="page">, with its number, kind, extension and body. */
function sections(html) {
  return [
    ...html.matchAll(
      /<section class="page [^"]*" id="p(\d+)" data-kind="(\w+)"(?: data-ext="([^"]*)")?[^>]*>([\s\S]*?)<\/section>/g,
    ),
  ].map(([, n, kind, ext, body]) => ({ number: Number(n), kind, ext, body }));
}

function referencesResolve(html) {
  const pages = new Map(sections(html).map((s) => [s.number, s]));
  const refs = [...html.matchAll(/data-ref="([^"]+)" data-page="(\d+)"/g)];
  assert.ok(refs.length > 0, 'no page references found');
  for (const [, id, n] of refs) {
    const target = pages.get(Number(n));
    assert.ok(target, `${id} points at page ${n}, which does not exist`);
    assert.equal(target.kind, 'ext', `${id} points at page ${n}, a ${target.kind} page`);
    assert.equal(target.ext, id, `${id} points at page ${n}, which renders ${target.ext}`);
  }
  return refs.length;
}

test('every ratified extension has exactly one page in the full edition', () => {
  const pages = sections(full.html).filter((s) => s.kind === 'ext');
  const ratified = all.filter((e) => e.state === 'ratified' && !e.discontinued).map((e) => e.id);
  assert.deepEqual(pages.map((p) => p.ext).sort(), [...ratified].sort());
  for (const base of ['RV32I', 'RV64I', 'RV32E', 'RV64E']) {
    assert.ok(ratified.includes(base), `${base} should be a ratified base`);
  }
});

test('the page count is the computed total, numbered 1..n in order', () => {
  for (const guide of buildAllGuides(inputs)) {
    const found = sections(guide.html);
    assert.equal(found.length, guide.pages.length, `${guide.path}: page count`);
    assert.deepEqual(
      found.map((s) => s.number),
      guide.pages.map((_, i) => i + 1),
      `${guide.path}: page numbers`,
    );
    assert.deepEqual(
      found.map((s) => s.kind),
      guide.pages.map((p) => p.kind),
    );
    assert.equal(found[0].kind, 'cover');
    assert.equal(found[1].kind, 'howto');
    assert.equal(found.at(-1).kind, 'index');
  }
});

test('profile chips and index entries point at the page that renders that extension', () => {
  for (const guide of buildAllGuides(inputs)) referencesResolve(guide.html);
  // Every extension in the full edition is in its index.
  const index = sections(full.html)
    .filter((s) => s.kind === 'index')
    .map((s) => s.body)
    .join('');
  for (const page of full.pages.filter((p) => p.kind === 'ext')) {
    assert.ok(
      index.includes(`data-ref="${page.id}" data-page="${page.number}"`),
      `${page.id} missing from the index`,
    );
  }
});

test('a profile edition contains each extension the profile resolves to', () => {
  for (const [name, members] of Object.entries(PROFILES)) {
    const base = members.find((id) => /^RV(32|64|128)[IE]$/.test(id)) ?? null;
    const resolved = resolveSelection({ selected: members, base }).resolved.filter((id) =>
      ids.has(id),
    );
    const guide = buildGuide({ ...inputs, edition: name });
    const rendered = sections(guide.html)
      .filter((s) => s.kind === 'ext')
      .map((s) => s.ext);
    assert.deepEqual(rendered.sort(), [...resolved].sort(), `${name} edition`);
    assert.ok(guide.html.includes('<code>rv'), `${name}: no -march string`);
  }
});

test('the full edition has a profile page for every profile and lists the drafts', () => {
  const profilePages = full.pages.filter((p) => p.kind === 'profile');
  assert.deepEqual([...new Set(profilePages.map((p) => p.profile))], Object.keys(PROFILES));
  const drafts = sections(full.html)
    .filter((s) => s.kind === 'drafts')
    .map((s) => s.body)
    .join('');
  for (const ext of all.filter((e) => e.state !== 'ratified')) {
    assert.ok(drafts.includes(`<td class="did">${ext.id}</td>`), `${ext.id} not in drafts`);
  }
});

test('no extension page shows more than the instruction cap', () => {
  for (const guide of buildAllGuides(inputs)) {
    for (const page of sections(guide.html).filter((s) => s.kind === 'ext')) {
      const rows = (page.body.match(/<tr class="enc-row">/g) ?? []).length;
      assert.ok(rows <= INSTRUCTION_CAP, `${page.ext}: ${rows} rows`);
      const total = Object.keys(all.find((e) => e.id === page.ext).instructions ?? {}).length;
      assert.equal(rows, Math.min(total, INSTRUCTION_CAP), `${page.ext}: rows`);
      if (total > INSTRUCTION_CAP) {
        assert.ok(page.body.includes(`+${total - INSTRUCTION_CAP} more`), `${page.ext}: no "more"`);
      }
    }
  }
});

test('catalogue text is escaped, not injected as markup', () => {
  const [group] = Object.keys(inputs.catalog);
  const hostile = {
    ...inputs,
    catalog: {
      ...inputs.catalog,
      [group]: [
        ...inputs.catalog[group],
        {
          id: 'Xtest',
          name: 'Xtest',
          state: 'ratified',
          short: '<b>bold</b>',
          desc: '<script>alert(1)</script> & "quoted"',
          use: "it's <i>",
          instructions: { 'X.<IMG>': { encoding: '<svg onload=x>' } },
        },
      ],
    },
  };
  const { html } = buildGuide({ ...hostile, edition: FULL_EDITION });
  assert.ok(!/<script/i.test(html), 'a script tag reached the page');
  assert.ok(!html.includes('<b>bold</b>'));
  assert.ok(!html.includes('<svg'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quoted&quot;'));
  assert.ok(html.includes('X.&lt;IMG&gt;'));
});

test('the cover carries the build date, explorer version and UDB commit', () => {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const cover = sections(full.html)[0].body;
  assert.ok(cover.includes('2026-01-02'));
  assert.ok(cover.includes(`v${version}`));
  assert.ok(cover.includes(inputs.graph.sources.udb.commit.slice(0, 7)));
  assert.ok(full.html.includes('@page{size:105mm 148mm;margin:0}'));
  assert.ok(!/https?:\/\/(?!tech\.riscv\.org)[^"\s<]+\.(css|js|woff2?)/.test(full.html));
});

test('encodings split into fields, compressed ones shown whole', () => {
  const r = encodingCells('0000100----------000-----0111011');
  assert.equal((r.match(/class="sep"/g) ?? []).length, 5);
  assert.ok(r.startsWith('<span><b>0000100</b></span>'));
  const c = encodingCells('----------------001-----------01');
  assert.ok(c.startsWith('<span class="f16">'));
  assert.ok(!c.includes('sep'));
});

test('guide paths match what the download menu links to', () => {
  const paths = buildAllGuides(inputs).map((g) => g.path);
  assert.ok(paths.includes('pocket-guide/riscv-pocket-guide.html'));
  assert.ok(paths.includes('pocket-guide/rva23-1.html'));
  assert.equal(pocketGuideSlug('RVA23.1'), 'rva23-1');
  assert.equal(pocketGuidePath('RVA23.1'), 'pocket-guide/rva23-1.pdf');
  assert.equal(pocketGuidePath(null), 'pocket-guide/riscv-pocket-guide.pdf');
  for (const name of Object.keys(PROFILES)) {
    assert.ok(paths.includes(pocketGuidePath(name, 'html')), `${name} has no edition`);
  }
  assert.equal(new Set(paths).size, paths.length, 'two editions share a file name');
});

test('the PDF printer is the deploy step, and fails loudly', () => {
  const script = readFileSync(new URL('../scripts/pocket-guide-pdf.mjs', import.meta.url), 'utf8');
  assert.ok(script.includes('CHROME_BIN'));
  assert.ok(script.includes('--print-to-pdf='));
  assert.ok(script.includes('process.exit(1)'));
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const deploy = ci.slice(ci.indexOf('\n  deploy:'));
  assert.ok(deploy.includes('npm run guide:pdf'), 'the deploy job does not print the guide');
  assert.ok(
    deploy.indexOf('npm run guide:pdf') < deploy.indexOf('Publish dist/'),
    'the guide must be printed before dist/ is published',
  );
  assert.ok(!ci.slice(0, ci.indexOf('\n  deploy:')).includes('guide:pdf'));
});
