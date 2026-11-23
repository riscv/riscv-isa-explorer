// The builder's one export menu (src/ExportMenu.jsx, src/exportFormats.js).
// The toolbar and the panel each had a copy; the toolbar's offered no UDB
// config and dropped the Parameters tab's values (#611).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  EXPORT_FORMATS,
  exportDetail,
  exportFilename,
  exportOptions,
} from '../src/exportFormats.js';
import { buildIsaConfigYaml } from '../src/exportUtils.js';

const catalog = JSON.parse(
  fs.readFileSync(new URL('../src/riscv_extensions.json', import.meta.url)),
);
const ALL = Object.values(catalog).flat();
const IDS = ['RV64I', 'M', 'A', 'F', 'D', 'C'];
const src = (f) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');

test('the menu offers all three files, Standard first', () => {
  assert.deepEqual(
    EXPORT_FORMATS.map((f) => f.format),
    ['landscape', 'udb', 'riscv-config'],
  );
  for (const f of EXPORT_FORMATS) assert.ok(f.label && exportDetail(f, {}), f.format);
});

test('every format gets an options object carrying the parameter values', () => {
  const paramChoices = { PHYS_ADDR_WIDTH: 40 };
  for (const { format } of EXPORT_FORMATS) {
    const opts = exportOptions(format, { includeInstructions: false, paramChoices });
    assert.equal(typeof opts, 'object', 'never the legacy bare boolean');
    assert.deepEqual(opts.paramChoices, paramChoices);
    const { yaml } = buildIsaConfigYaml(IDS, ALL, opts);
    assert.match(yaml, /PHYS_ADDR_WIDTH:? .*40|physical_addr_sz: 40/, `${format} writes the value`);
  }
  assert.deepEqual(exportOptions('udb', { paramChoices: undefined }).paramChoices, {});
});

test('the UDB config lists the parameters still to set, marked TODO', () => {
  const { yaml } = buildIsaConfigYaml(IDS, ALL, exportOptions('udb', { paramChoices: {} }));
  assert.match(yaml, /# TODO — implementation choices/);
});

test('filenames name the base and the format, and differ per format', () => {
  const names = EXPORT_FORMATS.map((f) => exportFilename(f.format, IDS, ALL));
  assert.deepEqual(names, [
    'riscv_rv64imafdc_config.yaml',
    'riscv_rv64imafdc_udb_config.yaml',
    'riscv_rv64imafdc_riscv_config_isa.yaml',
  ]);
});

test('the toolbar and the panel both render the one menu, and nothing else exports', () => {
  for (const f of ['WorkspacePanel.jsx', 'risc_v_visualizer.jsx']) {
    assert.match(src(f), /<ExportMenu\b/, f);
    assert.doesNotMatch(src(f), /buildIsaConfigYaml\(/, `${f} must not call the exporter itself`);
  }
  assert.match(src('ExportMenu.jsx'), /paramChoices/);
});

test('the riscv-config option names the fields left to fill in, as the file does', () => {
  const rc = EXPORT_FORMATS.find((f) => f.format === 'riscv-config');
  const unset = exportDetail(rc, {});
  const set = exportDetail(rc, { PHYS_ADDR_WIDTH: 40 });
  assert.match(unset, /Vendor, Device and the physical address width/);
  assert.match(set, /Vendor and Device/);
  assert.doesNotMatch(set, /fill in Vendor, Device and/);
  // The file agrees: three TODO fields without the width, two with it.
  const todos = (paramChoices) =>
    buildIsaConfigYaml(IDS, ALL, exportOptions('riscv-config', { paramChoices }))
      .yaml.split('\n')
      .filter((l) => /# TODO/.test(l)).length;
  assert.equal(todos({}), 3);
  assert.equal(todos({ PHYS_ADDR_WIDTH: 40 }), 2);
});
