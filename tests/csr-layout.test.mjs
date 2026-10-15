// csrLayout.js: the CSR details diagram, field filtering and readable text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  accessInfo,
  conditionTerms,
  csrDependsOnXlen,
  csrFields,
  csrRows,
  csrWidth,
  groupCsrNames,
  resetLabel,
} from '../src/csrLayout.js';

const catalog = JSON.parse(readFileSync(new URL('../src/riscv_extensions.json', import.meta.url)));
const extensions = [];
(function walk(node) {
  if (Array.isArray(node)) node.forEach(walk);
  else if (node && typeof node === 'object') {
    if (node.id && node.csrs) extensions.push(node);
    Object.values(node).forEach(walk);
  }
})(catalog);
const csrOf = (ext, name) => extensions.find((e) => e.id === ext).csrs[name];

test('a fixed-width CSR keeps its own width at either XLEN', () => {
  const fixed32 = Object.values(extensions.flatMap((e) => Object.values(e.csrs))).find(
    (csr) => Number(csr.length) === 32,
  );
  assert.equal(csrWidth(fixed32, 64), 32);
  assert.equal(csrWidth({ length: 'MXLEN' }, 32), 32);
  assert.equal(csrWidth({ length: 'MXLEN' }, 64), 64);
});

test('mstatus at RV64 is two rows that cover every bit exactly once', () => {
  const mstatus = csrOf('Sm', 'mstatus');
  const { fields } = csrFields(mstatus, 64);
  const rows = csrRows(fields, 64);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(
      row.segments.reduce((sum, s) => sum + s.width, 0),
      32,
    );
  }
  const sd = rows[0].segments[0];
  assert.equal(sd.field?.name, 'SD');
  assert.equal(sd.high, 63);
});

test('every catalogue CSR lays out without overlap or gaps in coverage', () => {
  for (const ext of extensions) {
    for (const [name, csr] of Object.entries(ext.csrs)) {
      for (const xlen of [32, 64]) {
        const width = csrWidth(csr, xlen);
        const rows = csrRows(csrFields(csr, xlen).fields, width);
        let expected = width - 1;
        for (const row of rows) {
          for (const segment of row.segments) {
            assert.equal(segment.high, expected, `${ext.id}/${name} RV${xlen}`);
            assert.ok(segment.width > 0);
            expected = segment.low - 1;
          }
        }
        assert.equal(expected, -1, `${ext.id}/${name} RV${xlen} does not reach bit 0`);
      }
    }
  }
});

test('RV64-only fields are left out of the RV32 view and counted', () => {
  const mstatus = csrOf('Sm', 'mstatus');
  const { fields, otherXlen } = csrFields(mstatus, 32);
  assert.ok(!fields.some((f) => f.name === 'MDT'));
  assert.ok(otherXlen > 0);
  assert.ok(csrDependsOnXlen(mstatus));
});

test('UDB values read as words', () => {
  assert.equal(resetLabel('UNDEFINED_LEGAL'), 'Any legal value');
  assert.equal(resetLabel('dynamic'), 'Config-dependent');
  assert.equal(resetLabel('1'), '1');
  assert.equal(resetLabel('255'), '0xff');
  assert.equal(accessInfo('RW-H').kind, 'hw');
  assert.equal(accessInfo('dynamic').label, 'Config');
});

test('conditions become short terms and drop the XLEN already chosen', () => {
  assert.deepEqual(
    conditionTerms({ allOf: [{ xlen: 64 }, { extension: { name: 'Smdbltrp' } }] }, 64),
    ['Smdbltrp'],
  );
  assert.deepEqual(
    conditionTerms({ extension: { anyOf: [{ name: 'F' }, { name: 'Zvl32b' }] } }, 64),
    ['F or Zvl32b'],
  );
  assert.deepEqual(conditionTerms({ xlen: 32 }, 64), ['RV32']);
  assert.deepEqual(conditionTerms(undefined, 64), []);
  assert.deepEqual(conditionTerms({ param: { name: 'X_IMPLEMENTED', equal: true } }, 64), [
    'X_IMPLEMENTED',
  ]);
});

test('numbered CSR families fold, in natural order, and RV32 high halves stay apart', () => {
  const items = groupCsrNames(
    Object.keys(csrOf('Sm', 'mstatus') ? extensions.find((e) => e.id === 'Sm').csrs : {}),
  );
  const labels = items.map((item) => (item.kind === 'family' ? item.label : item.name));
  assert.ok(labels.includes('pmpaddr0–63'));
  assert.ok(labels.includes('mhpmcounter3–31'));
  assert.ok(labels.includes('mhpmcounter3h–31h'));
  const pmp = items.find((item) => item.label === 'pmpaddr0–63');
  assert.deepEqual(
    pmp.members.slice(0, 3).map((m) => m.name),
    ['pmpaddr0', 'pmpaddr1', 'pmpaddr2'],
  );
  // A pair is not a family.
  assert.deepEqual(
    groupCsrNames(['mstatus', 'mstatush']).map((i) => i.kind),
    ['single', 'single'],
  );
});
