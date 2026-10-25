/**
 * Test the shared instruction reader and ownership report with local fixtures.
 *
 * Small examples check how definedBy conditions produce owner names and how
 * those names match a catalogue. Temporary YAML files check that both scripts
 * preserve conditions and reject invalid input. Report tests also cover directory
 * scanning and command-line output.
 *
 * The command-line tests use the project's catalogue and check that running the
 * report leaves the YAML inputs, instruction data and sync script unchanged.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { instructionOwners, readInstruction } from '../scripts/udb-instruction-reader.mjs';
import { parseUpstream } from '../scripts/check-udb-completeness.mjs';
import {
  readInstructions,
  ownershipReport,
  formatReport,
} from '../scripts/report-instruction-owners.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ext = (name) => ({ extension: { name } });
const instruction = (name, definedBy, source = `${name}.yaml`) => ({
  name,
  definedBy,
  source,
  owners: instructionOwners(definedBy),
});

function checkout(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instruction-owners-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const instDir = path.join(dir, 'spec/std/isa/inst');
  fs.mkdirSync(instDir, { recursive: true });
  for (const [file, contents] of Object.entries(files)) {
    const target = path.join(instDir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof contents === 'string' ? contents : YAML.stringify(contents));
  }
  return dir;
}

const run = (...args) => {
  const result = spawnSync(
    process.execPath,
    [
      // src/completeness.js is an ES module in a package without "type", so
      // importing it warns on stderr; only that warning is silenced here.
      '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
      path.join(root, 'scripts/report-instruction-owners.mjs'),
      ...args,
    ],
    {
      cwd: os.tmpdir(), // Catalogue and imports must not depend on the caller's cwd.
      encoding: 'utf8',
    },
  );
  assert.ifError(result.error);
  return result;
};

test('anyOf and oneOf collect every candidate once, at either nesting level', () => {
  assert.deepEqual(
    instructionOwners({
      extension: { anyOf: [{ name: 'Ssctr' }, { name: 'Smctr' }, { name: 'Smctr' }] },
    }),
    ['Ssctr', 'Smctr'],
  );
  assert.deepEqual(instructionOwners({ anyOf: [ext('Smctr'), ext('Ssctr')] }), ['Smctr', 'Ssctr']);
  assert.deepEqual(
    instructionOwners({ extension: { oneOf: [{ name: 'F' }, { name: 'Zfinx' }] } }),
    ['F', 'Zfinx'],
  );
});

test('joint width/version requirements and exclusive alternatives remain in report predicates', () => {
  const predicate = {
    allOf: [
      { xlen: 64 },
      {
        extension: {
          allOf: [
            { name: 'C', version: '>= 2.0' },
            { name: 'D', version: ['>= 2.2', '< 3'] },
          ],
        },
      },
    ],
  };
  const exclusive = { extension: { oneOf: [{ name: 'F' }, { name: 'Zfinx' }] } };
  const rows = [instruction('C.FLD', predicate), instruction('FADD.S', exclusive)];
  const before = JSON.stringify(rows);
  const report = ownershipReport({ group: [{ id: 'C' }, { id: 'D' }, { id: 'F' }] }, rows);
  assert.deepEqual(rows[0].owners, ['C', 'D']);
  assert.deepEqual(
    report.resolved.find((owner) => owner.id === 'C').instructions[0].definedBy,
    predicate,
  );
  const text = formatReport(report, 'test-revision');
  assert.ok(text.includes(JSON.stringify(predicate)));
  assert.ok(text.includes(JSON.stringify(exclusive)));
  assert.equal(JSON.stringify(rows), before, 'report must not mutate input predicates');
});

test('negated extension names and non-extension terms are not positive owners', () => {
  const predicate = {
    extension: { allOf: [{ name: 'Zbb' }, { not: { name: 'Zbkb' } }] },
  };
  assert.deepEqual(instructionOwners(predicate), ['Zbb']);
  assert.deepEqual(
    instructionOwners({ extension: { noneOf: [{ name: 'F' }, { name: 'D' }] } }),
    [],
  );
  assert.deepEqual(instructionOwners({ not: { not: ext('F') } }), ['F']);
  assert.deepEqual(instructionOwners({ xlen: 32 }), []);
});

test('unknown or malformed predicates fail explicitly instead of returning partial ownership', () => {
  for (const predicate of [
    null,
    {},
    { name: 'I' },
    { extension: { anyOf: [] } },
    { extension: { name: 'I', typo: true } },
    { extension: { name: 123 } },
    { extension: { name: ' ' } },
    { extension: { name: 'Z ba' } },
    { extension: { name: 'I', version: 1 } },
    { xlen: 128 },
    { anyOf: [ext('I'), { 'idl()': 'unknown' }] },
    { param: { name: 'MXLEN', equal: 32 } },
  ]) {
    assert.throws(() => instructionOwners(predicate), /condition|requirement/);
  }
});

test('instructions without positive owners have deterministic report ordering', () => {
  const rows = [instruction('B', { xlen: 32 }), instruction('A', { xlen: 64 })];
  assert.deepEqual(
    ownershipReport({}, rows).ownerless.map((row) => row.name),
    ['A', 'B'],
  );
  assert.equal(
    formatReport(ownershipReport({}, rows), 'pin'),
    formatReport(ownershipReport({}, [...rows].reverse()), 'pin'),
  );
});

test('direct comparison uses exact owner IDs, shows partial losses, and applies no migration rules', () => {
  const catalog = {
    group: [
      { id: 'Zba', instructions: { SH1ADD: {}, LOCAL: {} } },
      { id: 'RV32I', instructions: { ADD: {} } },
      { id: 'V', instructions: { 'VADD.VV': {}, 'VLSEG2E8.V': {} } },
      { id: 'Zve32x', instructions: { 'VADD.VV': {} } },
      { id: 'Zimop', instructions: { 'MOP.R.0': {} } },
      { id: 'Zicsr', instructions: { CSRRS: {}, RDCYCLE: {} } },
      { id: 'Zkt', instructions: {} },
    ],
  };
  const rows = [
    instruction('SH1ADD', ext('Zba')),
    instruction('ADD', ext('I')),
    instruction('VADD.VV', ext('Zvl32b')),
    instruction('CSRRS', ext('Zicsr')),
    instruction('NEW', ext('zba')),
  ];
  const before = JSON.stringify(catalog);
  const report = ownershipReport(catalog, rows);
  assert.deepEqual(
    report.resolved.map((owner) => owner.id),
    ['Zba', 'Zicsr'],
  );
  assert.deepEqual(
    report.unresolved.map((owner) => owner.id),
    ['I', 'Zvl32b', 'zba'],
  );
  assert.deepEqual(
    report.differences.find((entry) => entry.id === 'Zba'),
    {
      id: 'Zba',
      current: 2,
      matched: 1,
      missing: ['LOCAL'],
    },
  );
  assert.deepEqual(report.differences.find((entry) => entry.id === 'V').missing, [
    'VADD.VV',
    'VLSEG2E8.V',
  ]);
  assert.deepEqual(report.differences.find((entry) => entry.id === 'Zve32x').missing, ['VADD.VV']);
  assert.deepEqual(report.differences.find((entry) => entry.id === 'Zimop').missing, ['MOP.R.0']);
  assert.deepEqual(report.differences.find((entry) => entry.id === 'Zicsr').missing, ['RDCYCLE']);
  assert.ok(
    !report.differences.some((entry) => entry.id === 'Zkt'),
    'correctly empty entries are not gaps',
  );
  assert.equal(JSON.stringify(catalog), before);
  assert.match(
    formatReport(report, 'pin'),
    /Zba: current=2, matched_by_name=1, not_matched_by_name=1/,
  );
  assert.equal(
    formatReport(report, 'pin'),
    formatReport(ownershipReport(catalog, [...rows].reverse()), 'pin'),
  );
});

test('RV32 catalogue spellings match plain UDB names within the same owner', () => {
  const catalog = {
    group: [
      { id: 'Zilsd', instructions: { 'LD.RV32': {}, 'SD.RV32': {}, 'LD.LOCAL': {} } },
      {
        id: 'Zclsd',
        instructions: {
          'C.LD.RV32': {},
          'C.LDSP.RV32': {},
          'C.SD.RV32': {},
          'C.SDSP.RV32': {},
        },
      },
      { id: 'Zbb', instructions: { 'ZEXT.H.RV32': {} } },
      { id: 'Zbkb', instructions: { 'REV8.RV32': {} } },
      { id: 'Other', instructions: { 'LD.RV32': {} } },
    ],
  };
  const rv32 = (name) => ({ allOf: [{ xlen: 32 }, ext(name)] });
  const rows = [
    instruction('LD', rv32('Zilsd')),
    instruction('SD', rv32('Zilsd')),
    instruction('C.LD', rv32('Zclsd')),
    instruction('C.LDSP', rv32('Zclsd')),
    instruction('C.SD', rv32('Zclsd')),
    instruction('C.SDSP', rv32('Zclsd')),
    instruction('ZEXT.H', rv32('Zbb')),
    instruction('REV8', { allOf: [{ xlen: 32 }, { anyOf: [ext('Zbb'), ext('Zbkb')] }] }),
  ];
  assert.deepEqual(ownershipReport(catalog, rows).differences, [
    { id: 'Other', current: 1, matched: 0, missing: ['LD.RV32'] },
    { id: 'Zilsd', current: 3, matched: 2, missing: ['LD.LOCAL'] },
  ]);
});

test('recursive YAML reading supports flow style, CRLF, and retains relative sources', (t) => {
  const dir = checkout(t, {
    'Smctr/nested/sctrclr.yaml':
      'kind: instruction\r\nname: sctrclr\r\ndefinedBy: {extension: {anyOf: [{name: Smctr}, {name: Ssctr}]}}\r\n',
    'I/add.yaml': { kind: 'instruction', name: 'add', definedBy: ext('I') },
  });
  const rows = readInstructions(dir);
  assert.deepEqual(
    rows.map((row) => row.name),
    ['ADD', 'SCTRCLR'],
  );
  assert.deepEqual(rows[1].owners, ['Smctr', 'Ssctr']);
  assert.equal(rows[1].source, 'spec/std/isa/inst/Smctr/nested/sctrclr.yaml');
});

test('both scripts read inline YAML, quoted names and negation with the same conditions', (t) => {
  const source =
    'kind: instruction\nname: "zext.h"\n' +
    'definedBy: {allOf: [{xlen: 32}, {extension: {allOf: [{name: Zbb}, {not: {name: Zbkb}}]}}]}\n' +
    'encoding:\n  match: 000010000000-----100-----00110011\n';
  const dir = checkout(t, { 'Zbb/zext.h.yaml': source });
  fs.mkdirSync(path.join(dir, 'spec/std/isa/ext'));
  const [report] = readInstructions(dir);
  const [checker] = parseUpstream(path.join(dir, 'spec/std/isa')).instructions;
  const predicate = {
    allOf: [{ xlen: 32 }, { extension: { allOf: [{ name: 'Zbb' }, { not: { name: 'Zbkb' } }] } }],
  };
  assert.equal(report.name, 'ZEXT.H');
  assert.equal(checker.mnemonic, 'ZEXT.H');
  assert.deepEqual(report.owners, ['Zbb']);
  assert.deepEqual(checker.definedBy, ['Zbb']);
  assert.deepEqual(report.definedBy, predicate);
  assert.deepEqual(checker.definedByPredicate, predicate);
  assert.equal(checker.ownerXlen, 32);
});

test('the shared reader rejects invalid instruction headers and missing ownership', () => {
  for (const [source, error] of [
    ['kind: extension\nname: Zbb\n', /expected kind: instruction/],
    ['kind: instruction\nname: [add]\n', /invalid instruction name/],
    ['kind: instruction\nname: add\n', /expected a definedBy condition object/],
    ['kind: instruction\nname: add\nname: sub\n', /Map keys must be unique/],
  ]) {
    assert.throws(() => readInstruction(source), error);
  }
});

test('duplicate mnemonics and malformed files identify the source; no directory owner fallback', (t) => {
  for (const [files, error] of [
    [
      {
        'I/a.yaml': { kind: 'instruction', name: 'add', definedBy: ext('I') },
        'I/b.yaml': { kind: 'instruction', name: 'ADD', definedBy: ext('I') },
      },
      /I\/b.yaml: duplicate/,
    ],
    [{ 'I/a.yaml': 'kind: instruction\nname: add\n' }, /I\/a.yaml: expected/],
    [{ 'I/a.yaml': 'kind: instruction\nname: [broken' }, /I\/a.yaml:/],
    [
      { 'I/a.yaml': { kind: 'instruction', name: ' add ', definedBy: ext('I') } },
      /I\/a.yaml: missing or invalid instruction name/,
    ],
    [
      {
        'I/a.yaml':
          'kind: instruction\nname: tagged\ndefinedBy: {extension: {name: !unknown Zba}}\n',
      },
      /I\/a.yaml:.*Unresolved tag/s,
    ],
    [{}, /no instruction YAML/],
  ]) {
    assert.throws(() => readInstructions(checkout(t, files)), error);
  }
});

test('symbolic links fail explicitly rather than silently omitting instruction sources', (t) => {
  const dir = checkout(t, {
    'I/a.yaml': { kind: 'instruction', name: 'a', definedBy: ext('I') },
  });
  const target = path.join(dir, 'outside.yaml');
  fs.writeFileSync(target, YAML.stringify({ kind: 'instruction', name: 'b', definedBy: ext('I') }));
  const link = path.join(dir, 'spec/std/isa/inst/I/b.yaml');
  try {
    fs.symlinkSync(target, link);
  } catch (error) {
    if (error.code === 'EPERM' && process.platform === 'win32')
      return t.skip('symlinks unavailable');
    throw error;
  }
  assert.throws(() => readInstructions(dir), /symbolic links are unsupported.*b.yaml/);
});

test('CLI reports findings successfully and changes neither source nor project instruction data', (t) => {
  // Choose names from the catalogue so adding or removing extensions does not break this test.
  const ids = new Set(
    Object.values(JSON.parse(fs.readFileSync(path.join(root, 'src/riscv_extensions.json'), 'utf8')))
      .flat()
      .map((entry) => entry.id),
  );
  const [owner, excluded] = [...ids].sort();
  let unknown = 'Zownerreportfixture';
  while (ids.has(unknown)) unknown += 'x';
  const dir = checkout(t, {
    'Test/future.yaml': { kind: 'instruction', name: 'future', definedBy: ext(unknown) },
    'Test/known.yaml': {
      kind: 'instruction',
      name: 'known',
      definedBy: { extension: { allOf: [{ name: owner }, { not: { name: excluded } }] } },
    },
  });
  const files = [
    'src/instr_dict.json',
    'src/riscv_extensions.json',
    'scripts/sync_instructions.mjs',
    ...fs
      .readdirSync(path.join(dir, 'spec/std/isa/inst/Test'))
      .map((f) => path.join(dir, 'spec/std/isa/inst/Test', f)),
  ];
  const before = files.map((file) => fs.readFileSync(path.resolve(root, file)));
  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /UDB revision: unavailable/);
  assert.ok(result.stdout.includes(`Resolved owners (1):\n  ${owner}: 1 instruction\n`));
  assert.ok(result.stdout.includes(`Unresolved owners (1):\n  ${unknown}: 1 instruction\n`));
  assert.match(result.stdout, /spec\/std\/isa\/inst\/Test\/future.yaml/);
  assert.match(result.stdout, /Catalogue entries with direct-matching differences/);
  assert.match(result.stdout, /not encoding coverage defects/);
  files.forEach((file, index) => {
    assert.ok(fs.readFileSync(path.resolve(root, file)).equals(before[index]), `${file} changed`);
  });
  assert.equal(run(dir).stdout, result.stdout, 'output is deterministic');
});

test('CLI uses nonzero exit for bad input, without emitting a misleading partial report', (t) => {
  const dir = checkout(t, {
    'I/add.yaml': { kind: 'instruction', name: 'add', definedBy: { unknown: true } },
  });
  for (const args of [
    [],
    [dir],
    [dir, '--json'],
    [dir, '--report', '--typo'],
    [path.join(dir, 'missing-checkout')],
    [dir, '--report'],
  ]) {
    const result = run(...args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /usage:|Instruction owner report failed:/);
  }
});

test('both CLIs reject invalid or ownerless conditions with a source path and no report', (t) => {
  for (const definedBy of [undefined, { unknown: true }, { xlen: 32 }, { not: ext('Zbb') }]) {
    const dir = checkout(t, {
      'Zfix/bad.yaml': { kind: 'instruction', name: 'bad', definedBy },
    });
    fs.mkdirSync(path.join(dir, 'spec/std/isa/ext'));
    const checker = spawnSync(
      process.execPath,
      [
        '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
        path.join(root, 'scripts/check-udb-completeness.mjs'),
        dir,
        '--published',
      ],
      { encoding: 'utf8' },
    );
    assert.ifError(checker.error);
    for (const result of [run(dir), checker]) {
      assert.equal(result.status, 2, result.stderr);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /Zfix[/\\]bad.yaml:.*definedBy (condition|names no extension)/);
    }
  }
});
