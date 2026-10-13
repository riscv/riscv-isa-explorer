/**
 * The Sail and Spike links (src/instruction-references.json). Spike's side is
 * a filename lookup; Sail's is a parser over the model's assembly mappings
 * (scripts/sail-assembly.mjs), so most of these tests feed that parser small
 * pieces of Sail written the ways the real model writes them, and check that
 * it finds the right line or, as importantly, declines to guess.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { sailLocator } from '../scripts/sail-assembly.mjs';
import { referenceLinks } from '../src/instructionUsage.js';

const require = createRequire(import.meta.url);
const references = require('../src/instruction-references.json');
const catalog = require('../src/riscv_extensions.json');

const lineOf = (text, needle) => text.split('\n').findIndex((l) => l.includes(needle)) + 1;

const MODEL = `
mapping width_mnemonic : word_width <-> string = {
  1 <-> "b",
  4 <-> "w",
}

mapping maybe_u : bool <-> string = {
  true  <-> "u",
  false <-> ""
}

mapping clause assembly = LOAD(imm, rs1, rd, is_unsigned, width)
  <-> "l" ^ width_mnemonic(width) ^ maybe_u(is_unsigned) ^ spc() ^ reg_name(rd)

function clause execute LOAD(imm, rs1, rd, is_unsigned, width) = {
  RETIRE_SUCCESS
}

private mapping mvv_mnemonic : mvvfunct6 <-> string = {
  MVV_VAADDU <-> "vaaddu.vv",
  MVV_VAADD  <-> "vaadd.vv",
}

function clause execute MVVTYPE(funct6, vm, vs2, vs1, vd) = {
  foreach (i from 0 to n) {
    result[i] = match funct6 {
      MVV_VAADDU => add_unsigned(),
      MVV_VAADD  => add_signed(),
    }
  }
}

mapping clause assembly = MVVTYPE(funct6, vm, vs2, vs1, vd)
  <-> mvv_mnemonic(funct6) ^ spc() ^ vreg_name(vd)

function clause execute F_UN(rs1, rd, FSQRT_D) = {
  sqrt()
}

function clause execute F_UN(rs1, rd, FCVT_S_D) = {
  convert()
}

mapping clause assembly = F_UN(rs1, rd, FCVT_S_D)
<-> "fcvt.s.d" ^ spc() ^ freg_name(rd)

mapping clause assembly =
  forwards ZVABD_VX(VABD, vm, vs2, rs1, vd) => "vabs.v" ^ spc() ^ vreg_name(vd)
    when rs1 == zreg

function clause execute ZVABD_VX(funct6, vm, vs2, rs1, vd) = {
  result = match funct6 {
    VABD  => absolute(),
  }
}

mapping clause assembly = MYSTERY(op, rd)
  <-> unknown_helper(op) ^ spc() ^ reg_name(rd)
`;

test('Sail: composed mnemonics expand every helper mapping', () => {
  const locate = sailLocator({ 'm.sail': MODEL });
  const execute = lineOf(MODEL, 'function clause execute LOAD');
  for (const mnemonic of ['lb', 'lw', 'lbu', 'lwu']) {
    assert.deepEqual(locate(mnemonic), { file: 'm.sail', line: execute }, mnemonic);
  }
  assert.equal(locate('ld'), null, 'width_mnemonic has no "d" here');
});

test('Sail: an enum mapping leads to the instruction’s own match arm', () => {
  const locate = sailLocator({ 'm.sail': MODEL });
  assert.equal(locate('vaadd.vv').line, lineOf(MODEL, 'MVV_VAADD  =>'));
  assert.equal(locate('vaaddu.vv').line, lineOf(MODEL, 'MVV_VAADDU =>'));
});

test('Sail: repeated execute clauses are told apart by the constant in their head', () => {
  const locate = sailLocator({ 'm.sail': MODEL });
  assert.equal(locate('fcvt.s.d').line, lineOf(MODEL, 'execute F_UN(rs1, rd, FCVT_S_D)'));
});

test('Sail: one-way forwards aliases count, with the constant naming the arm', () => {
  const locate = sailLocator({ 'm.sail': MODEL });
  assert.equal(locate('vabs.v').line, lineOf(MODEL, 'VABD  =>'));
});

test('Sail: a clause with a helper the parser cannot read is skipped, not guessed', () => {
  const locate = sailLocator({ 'm.sail': MODEL });
  assert.deepEqual(locate.skipped, ['MYSTERY']);
  assert.equal(locate('anything'), null);
});

test('every linked mnemonic is in the catalogue, and every link resolves', () => {
  const mnemonics = new Set(
    Object.values(catalog)
      .flat()
      .flatMap((ext) => Object.keys(ext?.instructions || {}))
      .map((m) => m.toLowerCase()),
  );
  assert.match(references.sail.commit, /^[0-9a-f]{40}$/);
  assert.match(references.spike.commit, /^[0-9a-f]{40}$/);
  for (const [mnemonic, entry] of Object.entries(references.instructions)) {
    assert.ok(mnemonics.has(mnemonic), `${mnemonic} is not a catalogue instruction`);
    if (entry.sail) {
      const [file, line] = entry.sail;
      assert.match(references.sail.files[file] ?? '', /^model\/.+\.sail$/, mnemonic);
      assert.ok(Number.isInteger(line) && line > 0, mnemonic);
    }
    if (entry.spike) assert.match(entry.spike, /^[a-z0-9_]+(_N)?$/, mnemonic);
  }
});

test('coverage does not quietly drop', () => {
  // Raise these after a sync that adds coverage; a drop means the parser or
  // a model's layout changed and the sync needs a look before committing.
  const count = (key) => Object.values(references.instructions).filter((e) => e[key]).length;
  assert.ok(count('sail') >= 1150, `Sail links: ${count('sail')}`);
  assert.ok(count('spike') >= 1220, `Spike links: ${count('spike')}`);
});

test('RV32 register-pair loads and stores never link to the RV64 Sail code', () => {
  // Sail has no Zilsd/Zclsd yet. When it does, these will link through their
  // own clauses and this test can check those instead.
  for (const mnemonic of ['ld.rv32', 'sd.rv32', 'c.ld.rv32', 'c.ldsp.rv32']) {
    assert.equal(references.instructions[mnemonic]?.sail, undefined, mnemonic);
    assert.ok(references.instructions[mnemonic]?.spike, mnemonic);
  }
});

test('referenceLinks builds commit-pinned URLs, and null for a missing model', () => {
  const links = referenceLinks(references, 'VAADD.VV');
  const { sail, spike } = references;
  assert.ok(
    links.sail.url.startsWith(`https://github.com/riscv/sail-riscv/blob/${sail.commit}/model/`),
  );
  assert.match(links.sail.url, /\.sail#L\d+$/);
  assert.equal(
    links.spike.url,
    `https://github.com/riscv-software-src/riscv-isa-sim/blob/${spike.commit}/riscv/insns/vaadd_vv.h`,
  );

  const quad = referenceLinks(references, 'fadd.q');
  assert.equal(quad.sail.url, null);
  assert.equal(quad.sail.commit, sail.commit.slice(0, 7));
  assert.ok(quad.spike.url);
});
