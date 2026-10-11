/**
 * Reference links point at the extension, not at a repository root.
 *
 * Every catalog entry used to carry the same URL — github.com/riscv/riscv-isa-manual
 * — so "open reference link" told you nothing about the extension you clicked.
 * scripts/map-doc-links.mjs now resolves each one to its chapter on
 * docs.riscv.org.
 *
 * These tests do not reach the network. They guard the shape of the result and,
 * more importantly, the mistakes the mapping is prone to: a wrong link is worse
 * than the generic one it replaced, because it looks right.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ALL = (() => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'riscv_extensions.json');
  return Object.values(JSON.parse(fs.readFileSync(file, 'utf8'))).flat().filter(Boolean);
})();

const docLinked = ALL.filter((e) => /^https:\/\/docs\.riscv\.org\//.test(e.url ?? ''));

test('most of the catalog links to docs.riscv.org', () => {
  // A floor, not an equality: the count moves when upstream adds chapters. It
  // exists so a broken mapping run — which silently maps almost nothing — fails
  // instead of quietly shipping the generic link everywhere.
  assert.ok(
    docLinked.length >= 140,
    `only ${docLinked.length} of ${ALL.length} entries link to docs.riscv.org; the mapping looks broken`,
  );
});

test('every entry has a usable URL', () => {
  for (const ext of ALL) {
    assert.ok(ext.url, `${ext.id} has no url`);
    assert.match(ext.url, /^https:\/\//, `${ext.id}: ${ext.url}`);
  }
});

test('doc links are unversioned, so they follow the current snapshot', () => {
  // docs.riscv.org serves dated snapshots (…/isa/v20260120/…) behind unversioned
  // redirects. Linking to a dated path would rot at the next release.
  // RV128I is the one exemption, and it earns it: the RV128 chapter is not
  // served by the unversioned snapshot at all — /isa/unpriv/rv128.html is a
  // 404, under that name or any near variant — while the dated v20240411 path
  // resolves. It is an unfrozen draft ("We have not frozen the RV128 spec at
  // this time"), so its presence in the manual moves between releases and a
  // dated link is the only one that resolves today. If a later snapshot serves
  // it undated, drop this exemption and the link with it.
  // The profile components version as v1.0 rather than by date; same rule.
  const dated = docLinked.filter((e) => e.id !== 'RV128I' && /\/v(\d{8}|\d+\.\d+)\//.test(e.url));
  assert.deepEqual(
    dated.map((e) => `${e.id} -> ${e.url}`),
    [],
    'these links pin a snapshot and will rot',
  );
});

test('single-letter extensions point at their own chapter', () => {
  // The failure this catches: a heading like "A Rationale" contains the word
  // "a", so word-matching sent A to priv-rationale, D to supervisor and V to
  // priv-csrs. All three looked plausible in the UI and were wrong.
  const expected = {
    A: 'a-st-ext', B: 'b-st-ext', C: 'c-st-ext', D: 'd-st-ext',
    F: 'f-st-ext', M: 'm-st-ext', Q: 'q-st-ext', V: 'v-st-ext',
  };
  for (const [id, chapter] of Object.entries(expected)) {
    const ext = ALL.find((e) => e.id === id);
    assert.ok(ext, `${id} missing from the catalog`);
    assert.match(
      ext.url,
      new RegExp(`/unpriv/${chapter}\\.html$`),
      `${id} should point at the unprivileged ${chapter} chapter, got ${ext.url}`,
    );
  }
});

test('a few well-known extensions land on the right chapter', () => {
  const expected = {
    Zfa: '/unpriv/zfa.html',
    Zbb: '/unpriv/b-st-ext.html',
    Zknd: '/unpriv/scalar-crypto.html',
    Zvkg: '/unpriv/vector-crypto.html',
    Zicntr: '/unpriv/counters.html',
    H: '/priv/hypervisor.html',
    Smaia: '/aia/index.html',
    RERI: '/ras-eri/index.html',
    // Profile-named extensions have no ISA chapter; the ratified profile
    // specification that introduced each one defines it.
    Ziccrse: '/rva20-rvi20-rva22/extensions.html',
    Shgatpa: '/rva20-rvi20-rva22/extensions.html',
    Ssstrict: '/rva23/rva23-profiles.html',
    Ss1p13: '/priv/priv-preface.html',
  };
  for (const [id, suffix] of Object.entries(expected)) {
    const ext = ALL.find((e) => e.id === id);
    assert.ok(ext, `${id} missing from the catalog`);
    assert.ok(ext.url.endsWith(suffix), `${id} should end with ${suffix}, got ${ext.url}`);
  }
});

test('unmapped entries keep a real link rather than nothing', () => {
  // Roughly a third of the catalog has no chapter in either ISA volume —
  // profile mandate tags, privileged version tags, unratified drafts. They are
  // deliberately left on the manual repository rather than guessed at.
  const legacy = ALL.filter((e) => !/^https:\/\/docs\.riscv\.org\//.test(e.url ?? ''));
  for (const ext of legacy) {
    assert.match(ext.url, /^https:\/\/github\.com\/riscv\//, `${ext.id}: unexpected fallback ${ext.url}`);
  }
});
