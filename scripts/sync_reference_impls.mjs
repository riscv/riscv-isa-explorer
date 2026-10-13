#!/usr/bin/env node
/**
 * Regenerates src/instruction-references.json: where each catalogue
 * instruction is implemented in the two reference models, and where its
 * architectural certification test lives.
 *
 *   node scripts/sync_reference_impls.mjs <sail-riscv> <riscv-isa-sim>
 *                                         <riscv-arch-test> [--check]
 *                                         [--report <file>]
 *
 *   sail-riscv     the formal model. Instructions share execute clauses, so
 *                  scripts/sail-assembly.mjs reads the assembly mappings to
 *                  find the clause, and the match arm inside it, for each one.
 *   riscv-isa-sim  Spike. One file per instruction, riscv/insns/<name>.h, with
 *                  the mnemonic's dots written as underscores.
 *   riscv-arch-test  the Architectural Certification Tests (ACT). One test per
 *                  instruction, tests/<xlen>/<Ext>/<Ext>-<mnemonic>-NN.S, some
 *                  split into several numbered parts.
 *
 * All three are pinned to the checked-out commit. An instruction neither model has
 * yet is simply absent from that model's side; the panel shows it greyed out.
 *
 * --report writes a Markdown summary of what changed since the committed file:
 * the commits, and which instructions gained or lost a link in each model.
 * Its first line is `coverage-changed: true|false`, which the weekly workflow
 * reads. A new commit alone is not worth a pull request: every link is pinned,
 * so the old ones keep pointing at the right lines.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { sailLocator } from './sail-assembly.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const reportIndex = args.indexOf('--report');
const reportPath = reportIndex >= 0 ? path.resolve(args[reportIndex + 1] ?? '') : null;
const [sailRoot, spikeRoot, actRoot] = args
  .filter((arg, i) => !arg.startsWith('--') && (reportIndex < 0 || i !== reportIndex + 1))
  .map((p) => path.resolve(p));
if (!sailRoot || !spikeRoot || !actRoot) {
  console.error(
    'usage: sync_reference_impls.mjs <sail-riscv> <riscv-isa-sim> <riscv-arch-test> [--check] [--report <file>]',
  );
  process.exit(2);
}
const outputPath = path.join(root, 'src', 'instruction-references.json');

const revision = (repo) =>
  execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

const catalog = JSON.parse(
  fs.readFileSync(path.join(root, 'src', 'riscv_extensions.json'), 'utf8'),
);
// Per mnemonic: the catalogue extensions listing it, and its riscv-opcodes
// tags (rv32_zicntr), which say when it exists at one width only.
const owners = new Map();
const widthTags = new Map();
for (const ext of Object.values(catalog).flat()) {
  for (const [name, record] of Object.entries(ext?.instructions || {})) {
    const mnemonic = name.toLowerCase();
    if (!owners.has(mnemonic)) owners.set(mnemonic, new Set());
    owners.get(mnemonic).add(ext.id);
    widthTags.set(mnemonic, record.extension || []);
  }
}
const mnemonics = [...owners.keys()].sort();

/*
 * Instructions a model implements under another instruction's name, because
 * they share its encoding: hints, pseudo-instructions and the RV32 and RV64
 * readings of one compressed encoding. Used only when the direct lookup fails.
 */
const SHARED_ENCODING = {
  'c.addi16sp': 'c.lui',
  'c.addiw': 'c.jal',
  'c.nop': 'c.addi',
  'cm.jt': 'cm.jalt',
  'fence.tso': 'fence',
  pause: 'fence',
  'ntl.p1': 'add',
  'ntl.pall': 'add',
  'ntl.s1': 'add',
  'ntl.all': 'add',
  'prefetch.i': 'ori',
  'prefetch.r': 'ori',
  'prefetch.w': 'ori',
  rdcycle: 'csrrs',
  rdcycleh: 'csrrs',
  rdtime: 'csrrs',
  rdtimeh: 'csrrs',
  rdinstret: 'csrrs',
  rdinstreth: 'csrrs',
  'zext.h': 'packw',
  'zext.h.rv32': 'pack',
};

/*
 * The catalogue's RV32 forms share a mnemonic with the RV64 instruction. For
 * zext.h and rev8 that is one definition, parameterised on XLEN. ld, sd and
 * their compressed forms are not: on RV32 they are Zilsd/Zclsd register-pair
 * accesses. Spike implements both readings in one file (ld.h checks xlen);
 * Sail has no Zilsd yet, so there they stay unlinked rather than pointing at
 * the RV64 load.
 */
const REGISTER_PAIR = /^(c\.)?(ld|sd|ldsp|sdsp)\.rv32$/;
const base = (mnemonic) => mnemonic.replace(/\.rv32$/, '');
const candidates = (mnemonic, { pairs }) =>
  [
    mnemonic,
    pairs || !REGISTER_PAIR.test(mnemonic) ? base(mnemonic) : null,
    SHARED_ENCODING[mnemonic],
  ].filter(Boolean);

/* ── Sail ───────────────────────────────────────────────────────────────── */

const sailFiles = {};
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'unit_tests') walk(full);
    } else if (entry.name.endsWith('.sail')) {
      sailFiles[path.relative(sailRoot, full).split(path.sep).join('/')] = fs.readFileSync(
        full,
        'utf8',
      );
    }
  }
})(path.join(sailRoot, 'model'));
const locateSail = sailLocator(sailFiles);
if (locateSail.skipped.length) {
  console.warn(`Sail assembly clauses not understood: ${locateSail.skipped.join(' ')}`);
}

/* ── Spike ──────────────────────────────────────────────────────────────── */

const spikeInsns = new Set(
  fs
    .readdirSync(path.join(spikeRoot, 'riscv', 'insns'))
    .filter((f) => f.endsWith('.h'))
    .map((f) => f.slice(0, -2)),
);
const spikeName = (mnemonic) => {
  const name = mnemonic.replace(/\./g, '_');
  return [
    name,
    // Segment forms share the plain load/store file; nf is a field.
    name.replace(/seg\d/, ''),
    // MOPs are generated from one template each.
    name.replace(/^(c_mop|mop_rr?)_\d+$/, '$1_N'),
  ].find((n) => spikeInsns.has(n));
};

/* ── ACT ────────────────────────────────────────────────────────────────── */

/*
 * tests/<xlen>/<Dir>/<Prefix>-<mnemonic>-NN.S. The directory is the extension
 * (the prefix can be longer: ZihintntlZca-c.ntl.all sits in Zihintntl).
 * Misalign holds misaligned-access tests of ordinary loads and stores, not
 * tests of the instruction itself, and priv/ is organised by feature, so
 * neither is read.
 */
const ACT_XLENS = ['rv64i', 'rv32i', 'rv64e', 'rv32e'];
const actTests = new Map(); // mnemonic -> [{ xlen, dir, first, parts }]
for (const xlen of ACT_XLENS) {
  const xlenDir = path.join(actRoot, 'tests', xlen);
  if (!fs.existsSync(xlenDir)) continue;
  for (const dir of fs.readdirSync(xlenDir).sort()) {
    if (dir === 'Misalign') continue;
    const parts = new Map();
    for (const file of fs.readdirSync(path.join(xlenDir, dir)).sort()) {
      const test = file.match(/^[^-]+-(.+)-(\d+)\.S$/);
      if (!test) continue;
      const entry = parts.get(test[1]) ?? { first: file, parts: 0 };
      entry.parts++;
      parts.set(test[1], entry);
    }
    for (const [mnemonic, entry] of parts) {
      if (!actTests.has(mnemonic)) actTests.set(mnemonic, []);
      actTests.get(mnemonic).push({ xlen, dir, ...entry });
    }
  }
}

/* The ACT directory a catalogue extension's tests live in. */
const actDir = (id) => id.replace(/^RV(32|64)([IE])$/, '$2');

/*
 * The test for one catalogue instruction. An instruction that exists at one
 * width only takes a test at that width: rdcycleh is RV32-only, and ld.rv32
 * is Zilsd, which ACT does not test yet and must not land on the RV64 ld. Among several candidates, the directory of an extension that
 * owns the instruction wins: csrrs is tested under Zicsr, Zicntr and Zihpm,
 * and only Zicsr owns it. A shared-encoding alias counts only from such a
 * directory, so rdcycle takes Zicntr's csrrs test but ntl.all never takes
 * I's add test.
 */
function actTest(mnemonic) {
  const tags = widthTags.get(mnemonic);
  const only = (width) => tags.length > 0 && tags.every((tag) => tag.startsWith(`rv${width}_`));
  const xlens = ACT_XLENS.filter((xlen) =>
    mnemonic.endsWith('.rv32') || only(32)
      ? xlen.startsWith('rv32')
      : only(64)
        ? xlen.startsWith('rv64')
        : true,
  );
  const own = new Set([...owners.get(mnemonic)].map(actDir));
  const pick = (name, ownOnly) => {
    const found = (actTests.get(name) ?? [])
      .filter((t) => xlens.includes(t.xlen))
      .sort((a, b) => xlens.indexOf(a.xlen) - xlens.indexOf(b.xlen));
    return found.find((t) => own.has(t.dir)) ?? (ownOnly ? undefined : found[0]);
  };
  return (
    pick(base(mnemonic), false) ??
    (SHARED_ENCODING[mnemonic] && pick(SHARED_ENCODING[mnemonic], true))
  );
}

/* ── Output ─────────────────────────────────────────────────────────────── */

const sailPaths = [];
const instructions = {};
for (const mnemonic of mnemonics) {
  const entry = {};
  for (const name of candidates(mnemonic, { pairs: false })) {
    const found = locateSail(name);
    if (found) {
      let index = sailPaths.indexOf(found.file);
      if (index < 0) index = sailPaths.push(found.file) - 1;
      entry.sail = [index, found.line];
      break;
    }
  }
  for (const name of candidates(mnemonic, { pairs: true })) {
    const found = spikeName(name);
    if (found) {
      entry.spike = found;
      break;
    }
  }
  const test = actTest(mnemonic);
  if (test) entry.act = [`${test.xlen}/${test.dir}/${test.first}`, test.parts];
  if (entry.sail || entry.spike || entry.act) instructions[mnemonic] = entry;
}

const output = `${JSON.stringify(
  {
    sail: { repo: 'riscv/sail-riscv', commit: revision(sailRoot), files: sailPaths },
    spike: { repo: 'riscv-software-src/riscv-isa-sim', commit: revision(spikeRoot) },
    act: { repo: 'riscv/riscv-arch-test', commit: revision(actRoot) },
    instructions,
  },
  null,
  2,
)}\n`;

const previous = fs.existsSync(outputPath)
  ? JSON.parse(fs.readFileSync(outputPath, 'utf8'))
  : { sail: {}, spike: {}, act: {}, instructions: {} };

function changeReport() {
  const linked = (data, key) =>
    new Set(Object.keys(data.instructions || {}).filter((m) => data.instructions[m][key]));
  const code = (items) => items.map((m) => `\`${m}\``).join(' ') || 'none';
  const lines = [];
  let changed = false;
  for (const [key, name, repo] of [
    ['sail', 'Sail', sailRoot],
    ['spike', 'Spike', spikeRoot],
    ['act', 'ACT', actRoot],
  ]) {
    const before = linked(previous, key);
    const after = new Set(mnemonics.filter((m) => instructions[m]?.[key]));
    const added = [...after].filter((m) => !before.has(m));
    const removed = [...before].filter((m) => !after.has(m));
    if (added.length || removed.length) changed = true;
    const from = previous[key]?.commit?.slice(0, 7) ?? 'none';
    lines.push(
      `### ${name}: \`${from}\` → \`${revision(repo).slice(0, 7)}\`, ${after.size} of ${mnemonics.length} linked`,
      '',
      `- Newly linked (${added.length}): ${code(added)}`,
      `- No longer linked (${removed.length}): ${code(removed)}`,
      '',
    );
  }
  if (locateSail.skipped.length) {
    lines.push(
      `Sail assembly clauses the parser could not read (their instructions get no Sail link): ${code(locateSail.skipped)}`,
      '',
    );
  }
  return `coverage-changed: ${changed}\n\n${lines.join('\n')}`;
}

const count = (key) => Object.values(instructions).filter((e) => e[key]).length;
const summary = `${mnemonics.length} instructions: ${count('sail')} in Sail, ${count('spike')} in Spike, ${count('act')} with an ACT test`;

if (checkOnly) {
  const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
  if (current !== output) {
    console.error('Reference implementation links are stale; run npm run sync:references.');
    process.exitCode = 1;
  }
} else {
  if (reportPath) fs.writeFileSync(reportPath, changeReport());
  fs.writeFileSync(outputPath, output);
  console.log(`Wrote ${path.relative(root, outputPath)}: ${summary}.`);
  const missing = (key) => mnemonics.filter((m) => !instructions[m]?.[key]);
  console.log(`Not in Sail (${missing('sail').length}): ${missing('sail').join(' ')}`);
  console.log(`Not in Spike (${missing('spike').length}): ${missing('spike').join(' ')}`);
  console.log(`No ACT test (${missing('act').length}): ${missing('act').join(' ')}`);
}
