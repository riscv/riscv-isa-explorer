/**
 * Importing a UDB config (#604): src/udbImport.js. The values it reads are
 * checked by the parameter model the UDB Export Check holds to
 * `udb validate cfg`; these pin the mapping, the refusals and the round trip
 * through the builder's own export.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import YAML from 'yaml';
import { importUdbConfig } from '../src/udbImport.js';
import { buildIsaConfigYaml } from '../src/exportUtils.js';
import { resolveSelection } from '../src/isaGraph.js';
import { PROFILES } from '../src/profiles.js';

const catalogue = JSON.parse(
  fs.readFileSync(new URL('../src/riscv_extensions.json', import.meta.url)),
);
const ALL = Object.values(catalogue).flat().filter(Boolean);
const KNOWN = new Set(ALL.map((e) => e.id));
const VERSIONED = new Set(ALL.filter((e) => e.version).map((e) => e.id));
const resolve = (sel) =>
  resolveSelection({ selected: sel, base: sel.find((x) => /^RV/.test(x)) }).resolved.filter((i) =>
    KNOWN.has(i),
  );
const read = (yaml) => importUdbConfig(YAML.parse(yaml, { intAsBigInt: true }), ALL);
const doc = (over = {}) => ({
  $schema: 'config_schema.json#',
  kind: 'architecture configuration',
  type: 'fully configured',
  name: 't',
  implemented_extensions: [
    { name: 'I', version: '= 2.1.0' },
    { name: 'Sm', version: '= 1.13.0' },
  ],
  params: { MXLEN: 64 },
  ...over,
});

test("the builder's own UDB export imports back to the same configuration and values", () => {
  for (const profile of ['RVA20', 'RVA23', 'RVB23', 'RVI20U32']) {
    const ids = resolve(PROFILES[profile]);
    const paramChoices = {
      PHYS_ADDR_WIDTH: 34,
      MARCHID_IMPLEMENTED: true,
      ARCH_ID_VALUE: { $int: '9223372036854775809' },
    };
    const r = read(buildIsaConfigYaml(ids, ALL, { format: 'udb', paramChoices }).yaml);
    assert.equal(r.ok, true, `${profile}: ${r.errors.join('; ')}`);
    // An extension with no UDB version is a comment in the export, so it cannot
    // come back; every other one does, plus Sm, which the export always adds.
    const expected = new Set([...ids.filter((i) => VERSIONED.has(i)), 'Sm']);
    assert.deepEqual(
      new Set(r.ids),
      new Set([...expected].filter((i) => r.ids.includes(i) || ids.includes(i))),
    );
    for (const id of ids.filter((i) => VERSIONED.has(i)))
      assert.ok(r.ids.includes(id), `${profile}: lost ${id}`);
    assert.deepEqual(r.paramChoices.ARCH_ID_VALUE, { $int: '9223372036854775809' }, '64-bit exact');
    assert.equal(r.paramChoices.PHYS_ADDR_WIDTH, 34);
  }
});

test('a file that is not a fully configured UDB config is refused, with the reason', () => {
  assert.match(importUdbConfig(null, ALL).errors[0], /not a YAML mapping/);
  assert.match(
    importUdbConfig(doc({ kind: 'extension' }), ALL).errors[0],
    /not a UDB architecture/,
  );
  const partial = importUdbConfig(doc({ type: 'partially configured' }), ALL);
  assert.equal(partial.ok, false);
  assert.match(partial.errors[0], /Only fully configured/);
  assert.match(importUdbConfig(doc({ params: {} }), ALL).errors[0], /MXLEN/);
  const noBase = importUdbConfig(doc({ implemented_extensions: [{ name: 'M' }] }), ALL);
  assert.equal(noBase.ok, false);
});

test('I or E with MXLEN gives the base', () => {
  assert.ok(importUdbConfig(doc(), ALL).ids.includes('RV64I'));
  const rv32e = importUdbConfig(
    doc({ implemented_extensions: [{ name: 'E' }, { name: 'Sm' }], params: { MXLEN: 32 } }),
    ALL,
  );
  assert.ok(rv32e.ids.includes('RV32E'));
});

test('invalid values load and are listed; they do not block', () => {
  const r = importUdbConfig(
    doc({
      implemented_extensions: [{ name: 'I' }, { name: 'Sm' }, { name: 'F' }, { name: 'Zicsr' }],
      params: { MXLEN: 64, MSTATUS_FS_LEGAL_VALUES: [0] },
    }),
    ALL,
  );
  assert.equal(r.ok, true);
  assert.match(r.invalid.join(' '), /MSTATUS_FS_LEGAL_VALUES: .*Dirty/);
  assert.deepEqual(r.paramChoices.MSTATUS_FS_LEGAL_VALUES, [0]);
});

test('what the file lacks, misnames or adds is reported', () => {
  const r = importUdbConfig(
    doc({
      implemented_extensions: [
        { name: 'I' },
        { name: 'D', version: '= 9.9.9' },
        { name: 'Xbogus' },
      ],
      params: { MXLEN: 64, NOT_A_PARAM: 1, SXLEN: [64], CACHE_BLOCK_SIZE: null },
    }),
    ALL,
  );
  const w = r.warnings.join('\n');
  assert.match(w, /Xbogus is not in the catalogue/);
  assert.match(w, /D: the file pins 9\.9\.9/);
  assert.match(w, /does not list .*F/, 'D requires F; the builder adds it');
  assert.match(w, /Sm is not listed/);
  assert.match(w, /NOT_A_PARAM is not a UDB parameter/);
  assert.match(w, /SXLEN is set, but this configuration does not define it/);
  assert.ok(!('CACHE_BLOCK_SIZE' in r.paramChoices), 'a blank TODO is not a value');
  assert.ok(r.ids.includes('F'));
});

test('a value an extension fixes is not stored as a choice', () => {
  const ids = resolve(['RV64I', 'S', 'U', 'Sv39', 'Sstvala']);
  const r = read(buildIsaConfigYaml(ids, ALL, { format: 'udb' }).yaml);
  assert.equal(r.ok, true);
  assert.ok(!('REPORT_VA_IN_STVAL_ON_BREAKPOINT' in r.paramChoices), 'fixed by Sstvala');
});

test('the Parameters tab offers the import, and an empty builder shows the tab', () => {
  const view = fs.readFileSync(new URL('../src/ParametersView.jsx', import.meta.url), 'utf8');
  assert.match(view, /function ImportPanel/);
  assert.match(view, /await import\('yaml'\)/, 'the parser loads only when used');
  assert.match(view, /intAsBigInt: true/);
  const panel = fs.readFileSync(new URL('../src/WorkspacePanel.jsx', import.meta.url), 'utf8');
  assert.match(panel, /onImport=\{onImportConfig\}/);
  assert.doesNotMatch(panel, /!isEmpty && view === 'parameters'/);
});
