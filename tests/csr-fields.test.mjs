/**
 * Data-shape and correctness checks for the per-CSR bit-field maps (issue #243).
 *
 * scripts/sync_udb_extensions.cjs extracts a Schema A `fields` map from
 * riscv-unified-db for every CSR the catalog shares with UDB. Each field carries
 * only what a bit-field diagram needs: `bits` (a string, or {rv32, rv64} when the
 * placement depends on XLEN), `type` (a scalar access string or "dynamic"), and
 * `reset` (a scalar value or "dynamic").
 *
 * A catalog CSR that has no corresponding UDB file (e.g. Sspmpen/spmpen, whose
 * extension UDB does not carry) has nothing to extract and correctly carries no
 * `fields` key. So the presence invariant is an *iff*: a fields map exists if and
 * only if UDB defines that CSR — which is checked against the UDB checkout, and
 * skipped when none is present. The per-field shape checks below run regardless:
 * they validate the committed catalog data itself, so they stay meaningful in CI
 * (which has no UDB checkout) — see the note on each.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync,
  readdirSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse as parseYAML } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(
  readFileSync(join(here, '..', 'src', 'riscv_extensions.json'), 'utf8'),
);

/** [[extId, csrsObject], ...] over every extension that carries CSRs. */
function allCsrs() {
  const out = [];
  for (const list of Object.values(catalog)) {
    for (const ext of list) {
      if (!ext.csrs) continue;
      out.push([ext.id, ext.csrs]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// UDB ground truth, shared by the presence check and the correctness tests.
//
// Derived from an independent parse of the riscv-unified-db checkout beside the
// repo (not the sync's helpers). Absent without a checkout — the tests that
// genuinely need it skip cleanly, matching sync-tooling.test.mjs / the graph
// test, so contributors and CI without UDB still run the checks they can.
// ---------------------------------------------------------------------------

const csrDir = join(here, '..', '..', 'riscv-unified-db', 'spec', 'std', 'isa', 'csr');
const haveUdb = existsSync(csrDir);
const SKIP = 'no riscv-unified-db checkout beside this repo';

/** Re-derive Schema A from a raw UDB field node, independently of the sync. */
function expectedBits(fld) {
  if ('location_rv32' in fld || 'location_rv64' in fld) {
    return { rv32: String(fld.location_rv32 ?? ''), rv64: String(fld.location_rv64 ?? '') };
  }
  return String(fld.location ?? '');
}
const expectedType = (fld) => ('type' in fld ? String(fld.type) : 'dynamic');
const expectedReset = (fld) => ('reset_value' in fld ? String(fld.reset_value) : 'dynamic');

function walkYaml(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkYaml(full));
    else if (e.name.endsWith('.yaml')) out.push(full);
  }
  return out;
}

/**
 * Parse the whole UDB csr/ tree into:
 *   names — every CSR UDB defines (any file with a `name:`), the set the
 *           presence iff is checked against.
 *   truth — name -> { order:[fieldName...], byName:{ field:{bits,type,reset} } },
 *           the expected field data, for CSRs that carry a fields map.
 */
function buildUdbTruth() {
  const names = new Set();
  const truth = new Map();
  for (const file of walkYaml(csrDir)) {
    let doc;
    try {
      doc = parseYAML(readFileSync(file, 'utf8'));
    } catch {
      continue; // a single unparseable file should not abort the comparison
    }
    if (!doc || !doc.name) continue;
    names.add(doc.name);
    if (!doc.fields || typeof doc.fields !== 'object') continue;
    const order = [];
    const byName = {};
    for (const [fn, fld] of Object.entries(doc.fields)) {
      if (!fld || typeof fld !== 'object') continue;
      order.push(fn);
      byName[fn] = { bits: expectedBits(fld), type: expectedType(fld), reset: expectedReset(fld) };
    }
    truth.set(doc.name, { order, byName });
  }
  return { names, truth };
}

const udb = haveUdb ? buildUdbTruth() : null;

// ---------------------------------------------------------------------------
// Shape checks.
// ---------------------------------------------------------------------------

test('a CSR carries a fields map iff UDB defines that CSR', (t) => {
  // Presence can only be judged against UDB: which catalog CSRs *should* have a
  // map is exactly the set UDB defines. Without a checkout this cannot be known,
  // so it skips — the per-field shape checks below still run and are not vacuous.
  if (!haveUdb) return t.skip(SKIP);
  for (const [extId, csrs] of allCsrs()) {
    for (const [csrName, csr] of Object.entries(csrs)) {
      const where = `${extId}/${csrName}`;
      const hasMap = csr.fields && typeof csr.fields === 'object' && !Array.isArray(csr.fields);
      if (udb.names.has(csrName)) {
        assert.ok(hasMap, `${where} is defined in UDB but has no fields map`);
      } else {
        // No UDB file for this CSR (e.g. Sspmpen/spmpen) — nothing to extract, so
        // it must carry no fields key at all. Asserted explicitly, not skipped.
        assert.ok(
          !('fields' in csr),
          `${where} has no UDB definition but carries a fields key`,
        );
      }
    }
  }
});

test('every field has bits, type, and reset', () => {
  // No UDB needed: validates the committed catalog's own data, so it runs in CI
  // and covers every field actually emitted. CSRs with no fields map (no UDB
  // definition) are skipped here; their absence is asserted by the iff test above.
  for (const [extId, csrs] of allCsrs()) {
    for (const [csrName, csr] of Object.entries(csrs)) {
      if (!csr.fields) continue;
      for (const [fieldName, field] of Object.entries(csr.fields)) {
        const where = `${extId}/${csrName}.${fieldName}`;
        assert.ok(field && typeof field === 'object', `${where} is not an object`);
        assert.ok('bits' in field, `${where} missing bits`);
        assert.equal(typeof field.type, 'string', `${where} type must be a string`);
        assert.equal(typeof field.reset, 'string', `${where} reset must be a string`);
      }
    }
  }
});

test('bits is a string, or {rv32, rv64} with both halves present', () => {
  // No UDB needed — validates committed data, same as the test above.
  for (const [extId, csrs] of allCsrs()) {
    for (const [csrName, csr] of Object.entries(csrs)) {
      if (!csr.fields) continue;
      for (const [fieldName, field] of Object.entries(csr.fields)) {
        const where = `${extId}/${csrName}.${fieldName}`;
        const { bits } = field;
        if (typeof bits === 'string') continue; // non-split field
        assert.ok(
          bits && typeof bits === 'object' && !Array.isArray(bits),
          `${where} bits must be a string or an object`,
        );
        // XLEN-split fields must carry BOTH halves — a diagram cannot render
        // one XLEN from the other, and a half-populated entry is the exact
        // silent-drop this test exists to catch.
        assert.equal(typeof bits.rv32, 'string', `${where} XLEN-split bits missing rv32`);
        assert.equal(typeof bits.rv64, 'string', `${where} XLEN-split bits missing rv64`);
        assert.deepEqual(
          Object.keys(bits).sort(),
          ['rv32', 'rv64'],
          `${where} XLEN-split bits must have exactly rv32 and rv64`,
        );
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Correctness against riscv-unified-db (issue #243).
//
// The shape checks above cannot tell whether a field's bits, dynamic marker, or
// scalar value actually match UDB — an extraction that read the wrong location
// key, mislabelled a field "dynamic", normalised a value (RO-H -> RO), reordered
// fields, or dropped a whole CSR's fields would sail through them. These tests
// compare against the independently derived UDB truth, and skip without it.
// ---------------------------------------------------------------------------

/** First catalog occurrence of a CSR by name (field data is name-keyed and identical across refs). */
function catalogCsr(name) {
  for (const [, csrs] of allCsrs()) if (csrs[name]) return csrs[name];
  return null;
}

const NAMED_CSRS = ['misa', 'mstatus', 'satp', 'vtype', 'hstatus', 'fcsr', 'jvt'];

test('named CSRs match UDB field-for-field: bits, dynamic marker, verbatim value, order', (t) => {
  if (!haveUdb) return t.skip(SKIP);
  for (const name of NAMED_CSRS) {
    const cat = catalogCsr(name);
    assert.ok(cat, `${name} is not present in the catalog`);
    const truth = udb.truth.get(name);
    assert.ok(truth, `${name} was not found in the UDB checkout`);

    assert.deepEqual(
      Object.keys(cat.fields),
      truth.order,
      `${name}: field order diverges from UDB source order`,
    );
    for (const fn of truth.order) {
      const got = cat.fields[fn];
      const exp = truth.byName[fn];
      assert.deepEqual(got.bits, exp.bits, `${name}.${fn}: bits do not match UDB location`);
      assert.equal(got.type, exp.type, `${name}.${fn}: type marker/value does not match UDB`);
      assert.equal(got.reset, exp.reset, `${name}.${fn}: reset marker/value does not match UDB`);
    }
  }
});

test('every referenced CSR field matches UDB (wrong bits, marker, normalised value, or reorder)', (t) => {
  if (!haveUdb) return t.skip(SKIP);
  for (const [extId, csrs] of allCsrs()) {
    for (const [name, csr] of Object.entries(csrs)) {
      const truth = udb.truth.get(name);
      if (!truth) continue; // a catalog CSR absent from this UDB checkout — nothing to compare
      assert.deepEqual(
        Object.keys(csr.fields),
        truth.order,
        `${extId}/${name}: field order diverges from UDB source order`,
      );
      for (const fn of truth.order) {
        const got = csr.fields[fn];
        const exp = truth.byName[fn];
        assert.ok(got, `${extId}/${name}.${fn}: field present in UDB but missing from catalog`);
        assert.deepEqual(got.bits, exp.bits, `${extId}/${name}.${fn}: bits do not match UDB`);
        assert.equal(got.type, exp.type, `${extId}/${name}.${fn}: type marker/value does not match UDB`);
        assert.equal(got.reset, exp.reset, `${extId}/${name}.${fn}: reset marker/value does not match UDB`);
      }
    }
  }
});

test('a CSR with fields in UDB is never emitted as an empty map', (t) => {
  if (!haveUdb) return t.skip(SKIP);
  for (const [extId, csrs] of allCsrs()) {
    for (const [name, csr] of Object.entries(csrs)) {
      const truth = udb.truth.get(name);
      if (!truth || truth.order.length === 0) continue; // legitimately empty in UDB (e.g. medelegh)
      assert.notEqual(
        Object.keys(csr.fields).length,
        0,
        `${extId}/${name}: UDB defines ${truth.order.length} field(s) but the catalog map is empty`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// The bit-field backfill pass follows upstream corrections (issue #243).
//
// The pass in scripts/sync_udb_extensions.cjs used to write a `fields` map once
// and then skip any CSR that already had one, which stranded the catalog on
// stale values when upstream corrected a bit range, added a field, or fixed a
// type — the daily sync reported zero and the drift only surfaced as a red
// workflow with no self-healing path. It now compares the committed map against
// the freshly extracted one and rewrites only on a real difference.
//
// Both halves are pinned here against a throwaway UDB fixture rather than the
// real checkout: an unchanged rerun must write nothing and report zero (so the
// sync stays idempotent), and an upstream correction must flow through on the
// next sync.
// ---------------------------------------------------------------------------

const SCRIPT = join(here, '..', 'scripts', 'sync_udb_extensions.cjs');

/**
 * Build a throwaway workspace + UDB checkout carrying a single extension with
 * one CSR, run the UDB sync against them, and return { stdout, testcsr } where
 * testcsr is the CSR entry from the resulting catalog. Cleans up both temp
 * trees. Never touches the real catalog or the real riscv-unified-db checkout.
 */
function runSyncOnFixture(catalogFields, udbCsrYaml) {
  const ws = mkdtempSync(join(os.tmpdir(), 'csr-sync-ws-'));
  const udb = mkdtempSync(join(os.tmpdir(), 'csr-sync-udb-'));
  try {
    mkdirSync(join(ws, 'src'), { recursive: true });
    const testcsr = {
      address: '0x001',
      priv_mode: 'U',
      length: '32',
      desc: 'Test CSR',
    };
    if (catalogFields) testcsr.fields = catalogFields;
    const catalog = { base: [{ id: 'TestExt', name: 'Test', tags: [], csrs: { testcsr } }] };
    writeFileSync(join(ws, 'src', 'riscv_extensions.json'), JSON.stringify(catalog, null, 2) + '\n');

    const extDir = join(udb, 'spec', 'std', 'isa', 'ext');
    const csrDir = join(udb, 'spec', 'std', 'isa', 'csr');
    mkdirSync(extDir, { recursive: true });
    mkdirSync(csrDir, { recursive: true });
    // One ext file so the sync's "directory holds YAML" floor passes.
    writeFileSync(join(extDir, 'TestExt.yaml'), 'name: TestExt\n');
    writeFileSync(join(csrDir, 'testcsr.yaml'), udbCsrYaml);

    let stdout;
    try {
      stdout = execFileSync('node', [SCRIPT, udb], {
        cwd: ws,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      throw new Error(`sync exited non-zero:\n${err.stdout ?? ''}${err.stderr ?? ''}`);
    }
    const result = JSON.parse(readFileSync(join(ws, 'src', 'riscv_extensions.json'), 'utf8'));
    return { stdout, testcsr: result.base[0].csrs.testcsr };
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(udb, { recursive: true, force: true });
  }
}

// FOO occupies bits 7-5 upstream; matches buildCsrFields' extraction exactly.
const UDB_TESTCSR = [
  'name: testcsr',
  'long_name: Test CSR',
  'address: 0x001',
  'priv_mode: U',
  'length: 32',
  'fields:',
  '  FOO:',
  '    location: 7-5',
  '    type: RW',
  '    reset_value: 0',
  '',
].join('\n');

const FOO_UPSTREAM = { bits: '7-5', type: 'RW', reset: '0' };

test('sync corrects a catalog field whose bit range diverged from UDB', () => {
  // Catalog carries a stale placement (8-6) for a field UDB puts at 7-5. The old
  // write-once guard would have skipped it forever; the comparison must rewrite it.
  const { stdout, testcsr } = runSyncOnFixture(
    { FOO: { bits: '8-6', type: 'RW', reset: '0' } },
    UDB_TESTCSR,
  );
  assert.deepEqual(testcsr.fields.FOO, FOO_UPSTREAM, 'field was not corrected to the UDB bit range');
  assert.match(
    stdout,
    /Bit-field pass: 0 CSR\(s\) gained a fields map, 1 corrected to match UDB/,
    `expected exactly one correction reported; got:\n${stdout}`,
  );
});

test('sync leaves an already-matching field untouched and reports zero', () => {
  // Catalog already matches UDB. The run must not rewrite it and must report zero,
  // so a daily sync on unchanged data stays idempotent and opens no PR.
  const { stdout, testcsr } = runSyncOnFixture({ FOO: { ...FOO_UPSTREAM } }, UDB_TESTCSR);
  assert.deepEqual(testcsr.fields.FOO, FOO_UPSTREAM, 'an unchanged field must survive verbatim');
  assert.match(
    stdout,
    /Bit-field pass: 0 CSR\(s\) gained a fields map, 0 corrected to match UDB/,
    `expected zero backfills and zero corrections; got:\n${stdout}`,
  );
});
