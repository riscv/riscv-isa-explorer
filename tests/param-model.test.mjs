/**
 * The builder's parameter model (#596): src/paramRules.js evaluates UDB's
 * parameter rules, src/paramModel.js says what each parameter's state is.
 * The UDB Export Check compares both with `udb validate cfg` on hundreds of
 * configurations; these pin the parts that check cannot isolate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import paramData from '../src/isa-params.json' with { type: 'json' };
import { parseIdl, evaluate, checkRequirements } from '../src/paramRules.js';
import { checkSchema, paramStates } from '../src/paramModel.js';

const P = paramData.params;
const ctx = (extensions, params) => ({ extensions: new Set(extensions), params });

// ---------------------------------------------------------------------------
// paramRules.js
// ---------------------------------------------------------------------------

test('paramRules.js parses every IDL rule UDB gives a parameter', () => {
  const idl = Object.values(P).filter((d) => d.requirements?.['idl()']);
  assert.ok(idl.length >= 50, `only ${idl.length} IDL rules`);
  for (const d of idl) {
    assert.doesNotThrow(() => parseIdl(d.requirements['idl()']), d.name);
  }
});

test('IDL loops unroll, one statement per value', () => {
  const s = parseIdl(
    'for (U32 i = 3; i < 32; i++) { !implemented?(ExtensionName::Zihpm) -> !X[i]; }',
  );
  assert.equal(s.length, 29);
});

test('evaluation is three-valued and short-circuits on a decided side', () => {
  const [rule] = parseIdl('MXLEN == 32 -> ASID_WIDTH <= 9;');
  assert.equal(evaluate(rule, ctx([], { MXLEN: 64 })), true, 'false antecedent holds');
  assert.equal(evaluate(rule, ctx([], { MXLEN: 32, ASID_WIDTH: 12 })), false);
  assert.equal(evaluate(rule, ctx([], { MXLEN: 32 })), null, 'unset value is undecided');
  const [and] = parseIdl('X && Y');
  assert.equal(evaluate(and, ctx([], { X: false })), false, 'false && unknown is false');
});

test('64-bit literals, bit slices and $array functions', () => {
  const [big] = parseIdl("MXLEN == 64 -> ARCH_ID_VALUE != 64'h8000000000000000;");
  assert.equal(evaluate(big, ctx([], { MXLEN: 64, ARCH_ID_VALUE: 0x8000000000000000n })), false);
  const [slice] = parseIdl('CONFIG_PTR_ADDRESS[2:0] == 0');
  assert.equal(evaluate(slice, ctx([], { CONFIG_PTR_ADDRESS: 8 })), true);
  assert.equal(evaluate(slice, ctx([], { CONFIG_PTR_ADDRESS: 6 })), false);
  const [size] = parseIdl('$array_size(SXLEN) == 1 && SXLEN[0] == 32');
  assert.equal(evaluate(size, ctx([], { SXLEN: [32] })), true);
  assert.equal(evaluate(size, ctx([], { SXLEN: [32, 64] })), false);
});

test("UDB's own rules give UDB's answers", () => {
  const fs = (values) =>
    checkRequirements(P.MSTATUS_FS_LEGAL_VALUES, ctx(['F'], { MSTATUS_FS_LEGAL_VALUES: values }));
  assert.equal(fs([0, 1]).holds, false, 'with F, Dirty (3) must be legal');
  assert.equal(fs([0, 1, 2, 3]).holds, true);
  assert.match(fs([0]).reason, /Dirty/);
  // A loop rule: counters 3..31 need Zihpm.
  const hpm = (exts) =>
    checkRequirements(P.MCOUNTENABLE_EN, ctx(exts, { MCOUNTENABLE_EN: Array(32).fill(true) }))
      .holds;
  assert.equal(hpm(['Zicntr']), false);
  assert.equal(hpm(['Zicntr', 'Zihpm']), true);
  // A data rule with a list size: read-only mtvec offers exactly one mode.
  const mtvec = (modes) =>
    checkRequirements(P.MTVEC_MODES, ctx([], { MTVEC_ACCESS: 'ro', MTVEC_MODES: modes })).holds;
  assert.equal(mtvec([0]), true);
  assert.equal(mtvec([0, 1]), false);
});

// ---------------------------------------------------------------------------
// paramModel.js: checkSchema
// ---------------------------------------------------------------------------

test('checkSchema: types, ranges, enums and lists', () => {
  assert.deepEqual(checkSchema(true, { type: 'boolean' }), []);
  assert.ok(checkSchema(1, { type: 'boolean' }).length);
  assert.ok(checkSchema(70, P.PHYS_ADDR_WIDTH.schema).length, 'above its maximum');
  assert.ok(checkSchema('4', { type: 'integer' }).length, 'a numeric string is not an integer');
  assert.deepEqual(checkSchema([0, 1], P.MTVEC_MODES.schema), []);
  assert.ok(checkSchema([0, 0], P.MTVEC_MODES.schema).length, 'entries must be unique');
  assert.ok(checkSchema([2], P.MTVEC_MODES.schema).length);
});

test('checkSchema: 64-bit integers, kept as strings in our data, compare exactly', () => {
  const s = P.MTVEC_BASE_ALIGNMENT_DIRECT.schema;
  assert.deepEqual(checkSchema(9223372036854775808n, s), []);
  assert.ok(checkSchema('9223372036854775808', s).length, 'the string form is not accepted');
  assert.ok(checkSchema(0, P.ARCH_ID_VALUE.schema).length, 'uint64 but not 0');
  assert.deepEqual(checkSchema(1, P.ARCH_ID_VALUE.schema), []);
});

test('checkSchema: a string enum of digits compares as text', () => {
  assert.deepEqual(checkSchema('8', P.VECTOR_LS_INDEX_MAX_EEW.schema), []);
  assert.ok(checkSchema(8, P.VECTOR_LS_INDEX_MAX_EEW.schema).length);
});

test('checkSchema: tuple items with fixed positions', () => {
  const s = P.HPM_COUNTER_EN.schema;
  const ok = [false, false, false, ...Array(29).fill(true)];
  assert.deepEqual(checkSchema(ok, s), []);
  assert.ok(checkSchema([true, ...ok.slice(1)], s).length, 'counter 0 is fixed off');
});

// ---------------------------------------------------------------------------
// paramModel.js: paramStates
// ---------------------------------------------------------------------------

const stateOf = (result, name) => result.params.find((p) => p.name === name);

test('scope follows the extensions, and a gate opens with its value', () => {
  const base = paramStates({ extensions: new Set(['I', 'Sm']) });
  assert.equal(stateOf(base, 'PHYS_ADDR_WIDTH').scope, true);
  assert.equal(stateOf(base, 'SXLEN').scope, false, 'no S');
  assert.equal(stateOf(base, 'ARCH_ID_VALUE').scope, null, 'waits on MARCHID_IMPLEMENTED');
  const open = paramStates({
    extensions: new Set(['I', 'Sm']),
    values: { MARCHID_IMPLEMENTED: true },
  });
  assert.equal(stateOf(open, 'ARCH_ID_VALUE').scope, true);
});

test('an extension fixes or narrows values, and the model says which', () => {
  const r = paramStates({
    extensions: new Set(['I', 'Sm', 'S', 'U', 'Sv39']),
    constraints: [
      { name: 'MXLEN', kind: 'equal', value: 64, from: ['Smmpm'] },
      { name: 'SXLEN', kind: 'includes', value: [64], from: ['Sv39'] },
    ],
    values: { SXLEN: [32] },
  });
  const mxlen = stateOf(r, 'MXLEN');
  assert.equal(mxlen.kind, 'fixed');
  assert.equal(mxlen.set, true, 'a fixed value counts as set');
  const sxlen = stateOf(r, 'SXLEN');
  assert.equal(sxlen.kind, 'constrained');
  assert.match(sxlen.errors.join(' '), /must include 64 \(Sv39\)/);
});

test("a broken rule is reported with UDB's reason, and counted", () => {
  const r = paramStates({
    extensions: new Set(['I', 'Sm', 'F']),
    values: { MSTATUS_FS_LEGAL_VALUES: [0] },
  });
  const fs = stateOf(r, 'MSTATUS_FS_LEGAL_VALUES');
  assert.match(fs.rule, /Dirty/);
  assert.ok(r.summary.invalid >= 1);
  assert.ok(r.summary.required > r.summary.set, 'most required parameters are unset');
});
