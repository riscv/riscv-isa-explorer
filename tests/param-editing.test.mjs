/**
 * The Parameters tab (#600): src/paramEditing.js, and the paths its values
 * take: saved state, share links (src/configPermalink.js) and the UDB export
 * (src/exportUtils.js). The tab itself (src/ParametersView.jsx) is checked in
 * a browser; its wiring is checked here by source.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import paramData from '../src/isa-params.json' with { type: 'json' };
import {
  toStored,
  fromStored,
  formatValue,
  editorFor,
  parseInput,
  builderParamStates,
} from '../src/paramEditing.js';
import { encodeBuilderConfig, decodeBuilderConfig } from '../src/configPermalink.js';
import { buildIsaConfigYaml } from '../src/exportUtils.js';
import { resolveSelection } from '../src/isaGraph.js';
import { PROFILES } from '../src/profiles.js';

const P = paramData.params;
const catalogue = JSON.parse(
  fs.readFileSync(new URL('../src/riscv_extensions.json', import.meta.url)),
);
const ALL = Object.values(catalogue).flat().filter(Boolean);
const KNOWN = new Set(ALL.map((e) => e.id));
const resolve = (sel) =>
  resolveSelection({ selected: sel, base: sel.find((x) => /^RV/.test(x)) }).resolved.filter((i) =>
    KNOWN.has(i),
  );

test('stored values are JSON-safe, and 64-bit integers survive exactly', () => {
  const big = 0x8000000000000000n;
  const stored = toStored([big, 5n, 3]);
  assert.doesNotThrow(() => JSON.stringify({ v: stored }), 'the builder saves on every change');
  assert.deepEqual(JSON.parse(JSON.stringify(stored)), [{ $int: '9223372036854775808' }, 5, 3]);
  // Small integers stay plain numbers; only values past 2^53 need BigInt.
  assert.deepEqual(fromStored(JSON.parse(JSON.stringify(stored))), [big, 5, 3]);
  assert.equal(formatValue(stored), '9223372036854775808, 5, 3');
});

test('each parameter gets the editor its schema calls for', () => {
  assert.equal(editorFor(P.MUTABLE_MISA_A.schema).kind, 'boolean');
  assert.equal(editorFor(P.M_MODE_ENDIANNESS.schema).kind, 'enum');
  const width = editorFor(P.PHYS_ADDR_WIDTH.schema);
  assert.equal(width.kind, 'integer');
  assert.ok(width.min !== undefined && width.max !== undefined);
  assert.equal(editorFor(P.MTVEC_MODES.schema).kind, 'enum-list');
  const hpm = editorFor(P.HPM_COUNTER_EN.schema);
  assert.equal(hpm.kind, 'bitmap');
  assert.equal(hpm.length, 32);
  assert.deepEqual(hpm.fixed, { 0: false, 1: false, 2: false }, 'counters 0-2 are fixed off');
  const arch = editorFor(P.ARCH_ID_VALUE.schema);
  assert.equal(arch.kind, 'integer');
  assert.equal(arch.max, (1n << 64n) - 1n, 'uint64 through allOf and $ref');
  // Every parameter UDB defines gets some editor.
  for (const [name, d] of Object.entries(P)) assert.ok(editorFor(d.schema).kind, name);
});

test('typed input: decimal, hex, 64-bit, lists, and refusals', () => {
  const int = { kind: 'integer' };
  assert.deepEqual(parseInput('40', int), { value: 40 });
  assert.deepEqual(parseInput('0x8000000000000000', int), {
    value: { $int: '9223372036854775808' },
  });
  assert.deepEqual(parseInput('1_000', int), { value: 1000 });
  assert.ok(parseInput('abc', int).error);
  assert.deepEqual(parseInput('  ', int), { unset: true });
  assert.deepEqual(parseInput('1, 2 3', { kind: 'list' }), { value: [1, 2, 3] });
  assert.deepEqual(parseInput('little', { kind: 'string' }), { value: 'little' });
});

test("the tab's required parameters are exactly the UDB export's", () => {
  // Same selection, same parameter model, same answer: the tab cannot ask for
  // a parameter the export leaves out, or the other way round.
  const ids = resolve(PROFILES.RVA23);
  const states = builderParamStates(ids, {});
  const required = states.params
    .filter((p) => p.scope === true)
    .map((p) => p.name)
    .sort();
  const yaml = buildIsaConfigYaml(ids, ALL, { format: 'udb' }).yaml;
  const keys = [...yaml.split('params:')[1].matchAll(/^ {2}([A-Z][A-Z0-9_]*):/gm)]
    .map((m) => m[1])
    .sort();
  assert.deepEqual(required, keys);
});

test('a gate set in the tab brings its parameter in, and MXLEN is fixed by the base', () => {
  const ids = resolve(['RV64I']);
  const before = builderParamStates(ids, {});
  assert.equal(before.params.find((p) => p.name === 'ARCH_ID_VALUE').scope, null);
  const after = builderParamStates(ids, { MARCHID_IMPLEMENTED: true });
  assert.equal(after.params.find((p) => p.name === 'ARCH_ID_VALUE').scope, true);
  const mxlen = after.params.find((p) => p.name === 'MXLEN');
  assert.equal(mxlen.kind, 'fixed');
  assert.equal(mxlen.value, 64);
  assert.equal(builderParamStates([], {}), null, 'no base, no parameters');
});

test('share links carry lists and 64-bit values, and old links still decode', () => {
  const state = {
    workspaceIds: new Set(['RV64I', 'M']),
    seedProfile: null,
    customFromProfile: null,
    baselineLocked: true,
    paramChoices: {
      MTVEC_MODES: [0, 1],
      ARCH_ID_VALUE: { $int: '9223372036854775808' },
      M_MODE_ENDIANNESS: 'little',
      PHYS_ADDR_WIDTH: 40,
    },
  };
  const link = encodeBuilderConfig(state);
  const back = decodeBuilderConfig(link, PROFILES);
  assert.deepEqual(back.paramChoices, state.paramChoices);
  const old = decodeBuilderConfig(
    '1;c:RV64I;a:RV64I,M;o:PHYS_ADDR_WIDTH=40,TRAP_ON_EBREAK=true',
    PROFILES,
  );
  if (old) assert.deepEqual(old.paramChoices, { PHYS_ADDR_WIDTH: 40, TRAP_ON_EBREAK: true });
});

test('the UDB export writes the values set in the tab in place of TODO', () => {
  const ids = resolve(['RV64I', 'S', 'U', 'Sv39']);
  const yaml = buildIsaConfigYaml(ids, ALL, {
    format: 'udb',
    paramChoices: {
      PHYS_ADDR_WIDTH: 40,
      MARCHID_IMPLEMENTED: true,
      ARCH_ID_VALUE: { $int: '9223372036854775809' },
      MTVEC_MODES: [0, 1],
      SXLEN: [64],
      M_MODE_ENDIANNESS: 'little',
    },
  }).yaml;
  assert.match(yaml, /^ {2}PHYS_ADDR_WIDTH: 40 {3}# your value/m);
  assert.match(
    yaml,
    /^ {2}ARCH_ID_VALUE: 9223372036854775809 {3}# your value/m,
    'exact, and in scope once its gate is set',
  );
  assert.match(yaml, /^ {2}MTVEC_MODES: \[0, 1\] {3}# your value/m);
  assert.match(yaml, /^ {2}SXLEN: \[64\] {3}# your value, including 64/m);
  assert.match(yaml, /^ {2}M_MODE_ENDIANNESS: "little" {3}# your value/m);
});

test('ParametersView.jsx is a tab beside the existing view, which stays the default', () => {
  const panel = fs.readFileSync(new URL('../src/WorkspacePanel.jsx', import.meta.url), 'utf8');
  assert.match(panel, /useState\('configuration'\)/);
  assert.match(panel, /<ParametersView\b/);
  const view = fs.readFileSync(new URL('../src/ParametersView.jsx', import.meta.url), 'utf8');
  // Escape mid-edit must not close the whole builder.
  assert.match(
    view,
    /e\.key === 'Escape' && \(draft !== null \|\| error\)\) \{\s*e\.stopPropagation\(\)/,
  );
});

test('the landscape YAML records every value set, flags invalid ones, and skips out-of-scope ones', async () => {
  const { default: YAML } = await import('yaml');
  const ids = resolve(['RV64I', 'F', 'S', 'U', 'Sv39']);
  const paramChoices = {
    PHYS_ADDR_WIDTH: 40,
    SXLEN: [64],
    MSTATUS_FS_LEGAL_VALUES: [0],
    ARCH_ID_VALUE: { $int: '9223372036854775809' },
    MARCHID_IMPLEMENTED: true,
    VSXLEN: [64],
  };
  const yaml = buildIsaConfigYaml(ids, ALL, { paramChoices }).yaml;
  assert.ok(YAML.parse(yaml), 'still valid YAML');
  assert.match(yaml, /^ {4}chosen: \[64\]$/m, 'SXLEN, a list constraint, records its value');
  assert.match(yaml, /^ {2}PHYS_ADDR_WIDTH: 40$/m);
  assert.match(yaml, /^ {2}ARCH_ID_VALUE: 9223372036854775809$/m, '64-bit value exact');
  assert.match(yaml, /^ {2}MSTATUS_FS_LEGAL_VALUES: \[0\] {3}# INVALID: .*Dirty/m);
  assert.doesNotMatch(yaml, /VSXLEN/, 'no H: VSXLEN is not a parameter of this configuration');
  const bare = buildIsaConfigYaml(ids, ALL, {}).yaml;
  assert.doesNotMatch(bare, /parameter_values:/);
});

test('riscv-config takes physical_addr_sz from PHYS_ADDR_WIDTH when it is set', () => {
  const ids = resolve(['RV64I', 'M']);
  const set = buildIsaConfigYaml(ids, ALL, {
    format: 'riscv-config',
    paramChoices: { PHYS_ADDR_WIDTH: 40 },
  }).yaml;
  assert.match(set, /physical_addr_sz: 40 +# your PHYS_ADDR_WIDTH/);
  assert.match(set, /TWO FIELDS NEED YOUR INPUT/);
  const unset = buildIsaConfigYaml(ids, ALL, { format: 'riscv-config' }).yaml;
  assert.match(unset, /physical_addr_sz: 32 +# TODO/);
  assert.match(unset, /THREE FIELDS NEED YOUR INPUT/);
});
