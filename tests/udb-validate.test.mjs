/**
 * The UDB export check (#589): scripts/udb-validate/generate.mjs, fill.mjs,
 * classify.mjs and report.mjs. validate.rb needs Ruby and a UDB checkout and
 * runs in .github/workflows/udb-validate.yml; these cover the Node side, which
 * decides what is checked and what fails.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';
import { fillUdbConfig } from '../scripts/udb-validate/fill.mjs';
import { classifyReason, compareWithBaseline } from '../scripts/udb-validate/classify.mjs';
import { buildIsaConfigYaml } from '../src/exportUtils.js';

const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const ALL = Object.values(
  JSON.parse(fs.readFileSync(path.join(root, 'src/riscv_extensions.json'), 'utf8')),
)
  .flat()
  .filter(Boolean);

// Reasons as UDB wrote them in real runs.
const R = {
  missing: "Parameter is required but missing: 'ASID_WIDTH'",
  undefinedParam:
    "Parameter is not defined by this config: 'MXLEN'.\nFailing condition(s):\n  - `Sm>=0`{false}",
  extOnly:
    'Extension requirement is unmet: C@2.0.0. Failing condition(s):\n  - (!`D>=0`{true} ^ `Zcd>=0`{false})',
  extOnParam:
    'Extension requirement is unmet: Sstvala@1.0.0. Failing condition(s):\n  - `(REPORT_VA_IN_STVAL_ON_BREAKPOINT==true)`{false}',
  paramRule:
    "Parameter requirements not met: 'MSTATUS_FS_LEGAL_VALUES'.\n  - (`F>=0`{true} -> `$array_includes?(MSTATUS_FS_LEGAL_VALUES, 3)`{false})",
  schema: "Parameter value violates the schema: 'HPM_COUNTER_EN' = '[false]'",
  version: '= 9.9 is not a known version of extension M',
};

test('classify.mjs: what the export decides is structural, filled values are not', () => {
  assert.equal(classifyReason(R.missing), 'structural');
  assert.equal(classifyReason(R.undefinedParam), 'structural');
  assert.equal(classifyReason(R.extOnly), 'structural', 'C without Zcd is a dependency gap');
  assert.equal(classifyReason(R.extOnParam), 'value', 'depends on a value the user writes');
  assert.equal(classifyReason(R.paramRule), 'value');
  assert.equal(classifyReason(R.schema), 'structural');
  assert.equal(classifyReason(R.version), 'structural');
  assert.equal(classifyReason('Something UDB has never said'), 'structural');
});

test('classify.mjs: only failures the baseline does not accept are new', () => {
  const results = [
    { name: 'a', valid: false, reasons: [R.missing, R.paramRule] },
    { name: 'b', valid: false, reasons: [R.extOnly] },
    { name: 'c', valid: false, reasons: [], error: 'NoMethodError: nil' },
    { name: 'd', valid: true, reasons: [] },
  ];
  const baseline = {
    b: ['Extension requirement is unmet: C@2.0.0. Failing condition(s):'],
    d: ["Parameter is required but missing: 'X'"],
  };
  const r = compareWithBaseline(results, baseline);
  assert.deepEqual(
    r.fresh.map((f) => f.name),
    ['a', 'c'],
  );
  assert.equal(r.stillKnown.length, 1);
  assert.deepEqual(r.fixed, [{ name: 'd', reason: "Parameter is required but missing: 'X'" }]);
  assert.equal(r.valueFailures, 1);
  assert.equal(r.checked, 4);
});

test('fill.mjs fills every TODO and adds gated parameters its values bring in', () => {
  const { yaml } = buildIsaConfigYaml(['RV64I'], ALL, { format: 'udb' });
  const raw = YAML.parse(yaml);
  assert.ok(
    Object.values(raw.params).some((v) => v === null),
    'the export has TODOs',
  );
  const { doc, unfilled } = fillUdbConfig(raw, 'x');
  assert.deepEqual(unfilled, []);
  assert.ok(Object.values(doc.params).every((v) => v !== null && v !== undefined));
  assert.equal(doc.name, 'x');
  // A filled value that opens a gate brings the gated parameter with it.
  const gated = fillUdbConfig(
    { ...raw, params: { ...raw.params, MARCHID_IMPLEMENTED: true } },
    'y',
  );
  assert.ok('ARCH_ID_VALUE' in gated.doc.params);
});

test('generate.mjs writes the profiles and a manifest', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'udb-validate-'));
  execFileSync(
    process.execPath,
    ['scripts/udb-validate/generate.mjs', '--out', out, '--profiles-only'],
    {
      cwd: root,
      stdio: 'pipe',
    },
  );
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  assert.ok(manifest['profile-RVA23'], Object.keys(manifest).join(', '));
  const doc = YAML.parse(fs.readFileSync(path.join(out, 'profile-RVA23.yaml'), 'utf8'));
  assert.ok(doc.implemented_extensions.some((e) => e.name === 'Sm'));
  assert.ok(Object.values(doc.params).every((v) => v !== null));
});

test('generate.mjs refuses a selection that conflicts, rather than checking nothing', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'udb-validate-'));
  assert.throws(() =>
    execFileSync(
      process.execPath,
      ['scripts/udb-validate/generate.mjs', '--out', out, '--selection', 'RV32E,D'],
      { cwd: root, stdio: 'pipe' },
    ),
  );
});

test('report.mjs and the baseline: every accepted failure names its configuration and reason', () => {
  const text = fs.readFileSync(path.join(root, 'scripts/udb-validate/report.mjs'), 'utf8');
  assert.match(text, /--strict/);
  const { accepted, why } = JSON.parse(
    fs.readFileSync(path.join(root, 'scripts/udb-validate/baseline.json'), 'utf8'),
  );
  for (const [name, reasons] of Object.entries(accepted)) {
    assert.ok(Array.isArray(reasons) && reasons.length, name);
    for (const reason of reasons)
      assert.ok(why[reason] || why[name], `${name}: no "why" for ${reason}`);
  }
});

test('agree.mjs: the parameter model is compared with UDB, both ways', async () => {
  const { compareWithModel } = await import('../scripts/udb-validate/agree.mjs');
  const config = {
    implemented_extensions: [{ name: 'I' }, { name: 'Sm' }, { name: 'F' }],
    params: { MXLEN: 64, MSTATUS_FS_LEGAL_VALUES: [0] },
  };
  // UDB and the model both flag the F rule: no disagreement on it.
  const agreeing = compareWithModel(
    [{ name: 'c', reasons: ["Parameter requirements not met: 'MSTATUS_FS_LEGAL_VALUES'."] }],
    { c: config },
  );
  assert.ok(!agreeing.some((d) => d.kind === 'rule'), JSON.stringify(agreeing));
  // UDB silent where the model flags it: a disagreement, attributed to the model.
  const silent = compareWithModel([{ name: 'c', reasons: [] }], { c: config });
  assert.ok(
    silent.some((d) => d.kind === 'rule' && d.param === 'MSTATUS_FS_LEGAL_VALUES' && !d.udb),
  );
  // UDB stopped early on an unknown extension: only schema verdicts compare.
  const early = compareWithModel([{ name: 'c', reasons: ['Xfoo is not a known extension'] }], {
    c: config,
  });
  assert.deepEqual(early, []);
});

test('fill.mjs: the high strategy picks the other end of each schema, and stays valid', async () => {
  const { checkSchema } = await import('../src/paramModel.js');
  const { yaml } = buildIsaConfigYaml(['RV64I'], ALL, { format: 'udb' });
  const { doc } = fillUdbConfig(YAML.parse(yaml), 'h', { strategy: 'high' });
  assert.equal(doc.params.PRECISE_SYNCHRONOUS_EXCEPTIONS, true);
  const { default: params } = await import('../src/isa-params.json', { with: { type: 'json' } });
  for (const [name, value] of Object.entries(doc.params)) {
    assert.deepEqual(checkSchema(value, params.params[name]?.schema), [], name);
  }
});

test('classify.mjs: a condition UDB could not decide is about values', () => {
  const r =
    'Extension requirement is unmet: C@2.0.0. Condition not yet determined: (`Zca>=0`{true} && (!`F>=0`{true} || `xlen=64`{unknown}))';
  assert.equal(classifyReason(r), 'value');
});
