/**
 * Unit tests for src/marchUtils.js — the -march generator and dependency table.
 *
 * These are pure-function tests: marchUtils imports no React and no JSON, and
 * takes the flat extension array as a parameter, so it can be exercised
 * directly with no DOM and no fixtures beyond the catalog itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  buildMarchString,
  parseMarchString,
  SMART_DEPENDENCIES,
  INCOMPATIBLE_WITH,
  NON_MARCH_IDS,
  SHORTHAND_BUNDLES,
  absorbedByShorthand,
  DATA_PROVENANCE,
} from '../src/marchUtils.js';

const here = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(readFileSync(join(here, '..', 'src', 'riscv_extensions.json'), 'utf8'));
const ALL = Object.values(catalog).flat();

const march = (ids) => buildMarchString(ids, ALL);

// ---------------------------------------------------------------------------
// Canonical generation — these encode spec §27 rules and must always hold.
// ---------------------------------------------------------------------------

test('emits canonical single-letter order, base letter not repeated', () => {
  const r = march(['RV64I', 'M', 'A', 'F', 'D', 'C']);
  assert.equal(r.march, 'rv64imafdc');
});

test('multi-letter tokens are underscore-prefixed and alphabetical', () => {
  const r = march(['RV64I', 'M', 'Zbb', 'Zba', 'Zicsr']);
  assert.equal(r.march, 'rv64im_zba_zbb_zicsr');
});

test('never emits the g shorthand', () => {
  const r = march(['RV64I', 'M', 'A', 'F', 'D', 'Zicsr', 'Zifencei']);
  assert.ok(!/(^|[^a-z])g([^a-z]|$)/.test(r.march), `g leaked into ${r.march}`);
});

test('decoder expands g, encoder round-trips to explicit tokens', () => {
  const p = parseMarchString('rv64gc', ALL);
  assert.equal(p.xlen, 64);
  assert.ok(p.gExpanded, 'g should be flagged as expanded');
  const r = march(p.resolvedIds);
  assert.ok(!r.march.includes('g'), `re-encoded string still contains g: ${r.march}`);
});

test('requires a base ISA', () => {
  const r = march(['M', 'A']);
  assert.equal(r.march, null);
  assert.match(r.warnings.join(' '), /base ISA/i);
});

test('UI-only grouping tags are excluded, not emitted', () => {
  for (const tag of NON_MARCH_IDS) {
    const r = march(['RV64I', tag]);
    assert.ok(
      r.excluded.some((e) => e.id === tag),
      `${tag} should appear in excluded[]`,
    );
    assert.ok(!r.march.includes(tag.toLowerCase()), `${tag} leaked into ${r.march}`);
  }
});

test('privileged spec version tags are excluded', () => {
  const r = march(['RV64I', 'Sm1p12']);
  assert.ok(r.excluded.some((e) => e.id === 'Sm1p12'));
});

// ---------------------------------------------------------------------------
// Dependency table integrity
// ---------------------------------------------------------------------------

test('every dependency target exists in the catalog', () => {
  const ids = new Set(ALL.map((e) => e.id));
  const missing = [];
  for (const [ext, deps] of Object.entries(SMART_DEPENDENCIES)) {
    for (const d of deps) if (!ids.has(d)) missing.push(`${ext} -> ${d}`);
  }
  assert.deepEqual(
    missing,
    [],
    `dependencies pointing at non-existent extensions:\n  ${missing.join('\n  ')}`,
  );
});

// ---------------------------------------------------------------------------
// Known defects — these are expected to FAIL until fixed.
// Each corresponds to a review finding on PR #139.
// ---------------------------------------------------------------------------

test('[defect] E-base and F are rejected as incompatible', () => {
  // INCOMPATIBLE_WITH declares RV32E/RV64E incompatible with F, but nothing
  // consults the table, so an invalid string is produced silently.
  assert.ok(INCOMPATIBLE_WITH.RV32E.includes('F'), 'table should declare the conflict');
  const r = march(['RV32E', 'F']);
  assert.ok(
    r.march === null || r.excluded.some((e) => e.id === 'F') || r.warnings.length > 0,
    `RV32E + F produced "${r.march}" with no warning or exclusion`,
  );
});

test('[defect] I and E cannot both be selected', () => {
  // buildMarchString filters only the base's own letter, so an E base with I
  // also selected yields rv32ei..., which no toolchain accepts.
  const r = march(['RV32E', 'I']);
  assert.ok(!/^rv32ei/.test(r.march ?? ''), `produced mutually exclusive base letters: ${r.march}`);
});

test('[defect] F implies Zicsr', () => {
  // F defines fcsr/frm/fflags, so it depends on Zicsr; GCC's riscv_ext_info
  // encodes the same implication. Absent here, a config with F but no Zicsr
  // resolves without complaint.
  assert.ok(SMART_DEPENDENCIES.F?.includes('Zicsr'), 'SMART_DEPENDENCIES has no F -> Zicsr entry');
});

// ---------------------------------------------------------------------------
// Extension version suffix handling (RISC-V §27)
// ---------------------------------------------------------------------------

test('decoder handles extension version suffixes on base and sub-extensions (RISC-V §27)', () => {
  // Compilers (GCC, LLVM) emit and accept version numbers on extensions (e.g. rv64i2p0, rv32i2p1_m2p0, rv64i_zba1p0).
  const p1 = parseMarchString('rv64i2p0', ALL);
  assert.equal(p1.xlen, 64);
  assert.deepEqual(p1.resolvedIds, ['RV64I']);
  assert.deepEqual(p1.unknownTokens, []);
  assert.equal(p1.warnings.length, 0);

  const p2 = parseMarchString('rv32i2p1m2p0c2p0', ALL);
  assert.equal(p2.xlen, 32);
  assert.deepEqual(p2.resolvedIds, ['RV32I', 'M', 'C']);
  assert.deepEqual(p2.unknownTokens, []);

  const p3 = parseMarchString('rv64i2p1_zba1p0_zicsr2p0', ALL);
  assert.equal(p3.xlen, 64);
  assert.deepEqual(p3.resolvedIds, ['RV64I', 'Zba', 'Zicsr']);
  assert.deepEqual(p3.unknownTokens, []);

  const p4 = parseMarchString('rv64i_unknown1p0', ALL);
  assert.deepEqual(p4.resolvedIds, ['RV64I']);
  assert.deepEqual(p4.unknownTokens, ['unknown1p0']);
});

test('suffix-stripping does not resolve naming-prefix/umbrella typos (e.g. zve32, zve64)', () => {
  // zve32 and zve64 are typos for zve32x, zve64d, etc. Suffix-stripping must NOT
  // fall back to matching the umbrella/prefix tag Zve, preserving unrecognised tokens.
  const p1 = parseMarchString('rv64i_zve32', ALL);
  assert.deepEqual(p1.resolvedIds, ['RV64I']);
  assert.deepEqual(p1.unknownTokens, ['zve32']);

  const p2 = parseMarchString('rv64i_zve64', ALL);
  assert.deepEqual(p2.resolvedIds, ['RV64I']);
  assert.deepEqual(p2.unknownTokens, ['zve64']);

  // Real architectural extensions with version suffixes must still resolve
  const p3 = parseMarchString('rv64i_zve32x1p0', ALL);
  assert.deepEqual(p3.resolvedIds, ['RV64I', 'Zve32x']);
  assert.deepEqual(p3.unknownTokens, []);

  // Exact catalog names ending in digits (e.g. Sm1p11) must continue resolving directly
  const p4 = parseMarchString('rv64i_sm1p11', ALL);
  assert.deepEqual(p4.resolvedIds, ['RV64I', 'Sm1p11']);
  assert.deepEqual(p4.unknownTokens, []);
});

test('a shared member is absorbed by the widest bundle that claims it', () => {
  // Zbkb and Zknd belong to both Zkn and Zk, and Zk lists Zkn among its own
  // members, so Zk is the wider claim and has to win. This used to be decided
  // by whichever entry Object.entries reached last, which made it a property of
  // how SHORTHAND_BUNDLES happens to be declared rather than of the ISA.
  const absorbed = absorbedByShorthand(['Zk', 'Zkn', 'Zks']);
  assert.equal(absorbed.get('Zbkb'), 'Zk');
  assert.equal(absorbed.get('Zknd'), 'Zk');
  assert.equal(absorbed.get('Zkn'), 'Zk', 'Zk lists Zkn, so it absorbs it');
  assert.equal(absorbed.get('Zksed'), 'Zks', 'Zksed is claimed only by Zks');
});

test('absorption does not depend on the order SHORTHAND_BUNDLES is declared in', () => {
  // The declared order happens to put Zk last, so simply iterating the object
  // gives the right answer today and a test that only checks the outcome would
  // pass even if the rule were deleted. Feed the same bundles in a different
  // key order instead: widest-wins has to survive that, key order cannot.
  const selected = Object.keys(SHORTHAND_BUNDLES);
  const reversed = Object.fromEntries(Object.entries(SHORTHAND_BUNDLES).reverse());
  const asDeclared = absorbedByShorthand(selected);
  const asReversed = absorbedByShorthand(selected, reversed);
  assert.ok(asDeclared.size > 0, 'the fixture should absorb something');
  assert.deepEqual(
    [...asDeclared].sort(),
    [...asReversed].sort(),
    'reordering SHORTHAND_BUNDLES must not change which shorthand absorbs a member',
  );
  // and the surviving answer is the widest claimant, not merely a stable one
  for (const [member, shorthand] of asDeclared) {
    const claimants = selected.filter((s) => SHORTHAND_BUNDLES[s].includes(member));
    const widest = claimants.reduce((a, b) =>
      SHORTHAND_BUNDLES[b].length > SHORTHAND_BUNDLES[a].length ? b : a,
    );
    assert.equal(shorthand, widest, `${member} should be absorbed by ${widest}, not ${shorthand}`);
  }
});

test('nothing is absorbed without a shorthand, and the input may be empty', () => {
  assert.equal(absorbedByShorthand(['RV64I', 'Zbkb']).size, 0, 'a bare member absorbs nothing');
  assert.equal(absorbedByShorthand([]).size, 0);
  assert.equal(absorbedByShorthand(undefined).size, 0, 'must not throw on no selection');
});

test('DATA_PROVENANCE is an array of rows, because a consumer maps over it', () => {
  // WorkspacePanel renders DATA_PROVENANCE.map(...). It was briefly replaced by
  // an object of prose strings, which threw "DATA_PROVENANCE.map is not a
  // function" and unmounted the entire app the moment the builder panel opened.
  assert.ok(Array.isArray(DATA_PROVENANCE), 'a consumer calls .map on this');
  assert.ok(DATA_PROVENANCE.length > 0);
  for (const row of DATA_PROVENANCE) {
    for (const key of ['label', 'source', 'url']) {
      assert.equal(
        typeof row[key],
        'string',
        `provenance row is missing ${key}: ${JSON.stringify(row)}`,
      );
      assert.ok(row[key].length > 0, `provenance row has an empty ${key}`);
    }
  }
});

/**
 * The general form of the bug above.
 *
 * Neither build nor lint nor any unit test noticed that an exported constant
 * changed shape under a consumer that maps over it, because no test opens the
 * builder panel. Rather than add one test per constant, read the JSX for
 * `X.map(` where X is imported from marchUtils, and require X to be an array.
 */
test('every marchUtils export a component maps over is actually an array', async () => {
  const mod = await import('../src/marchUtils.js');
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const jsx = readdirSync(srcDir).filter((f) => f.endsWith('.jsx'));
  const checked = [];
  for (const file of jsx) {
    const text = readFileSync(join(srcDir, file), 'utf8');
    if (!/from '\.\/marchUtils\.js'/.test(text)) continue;
    for (const [, name] of text.matchAll(/\b([A-Z][A-Z0-9_]+)\.map\(/g)) {
      if (!(name in mod)) continue;
      checked.push(`${file}:${name}`);
      assert.ok(
        Array.isArray(mod[name]),
        `${file} calls ${name}.map(...) but marchUtils exports it as ${typeof mod[name]}`,
      );
    }
  }
  assert.ok(
    checked.length > 0,
    'this guard found nothing to check — has the import shape changed?',
  );
});
