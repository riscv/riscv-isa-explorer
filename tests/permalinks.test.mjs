// src/permalinks.js: every ?ext= and ?insn= link the explorer can produce
// opens what it names (#635). Offline and exhaustive: the render tests follow
// a few links through the real bundle, this walks the whole catalogue.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  EXTENSION_PARAM,
  findExtensionById,
  instructionInExtension,
  normalizeMnemonicKey,
  permalinkSearch,
  resolveInstructionLink,
} from '../src/permalinks.js';

const catalogue = JSON.parse(
  fs.readFileSync(new URL('../src/riscv_extensions.json', import.meta.url), 'utf8'),
);
const pool = Object.values(catalogue).flat().filter(Boolean);
const instructions = pool.flatMap((ext) =>
  Object.keys(ext.instructions ?? {}).map((mnemonic) => ({ ext, mnemonic })),
);

test('extension ids are unique ignoring case, since ?ext= matches that way', () => {
  const seen = new Map();
  for (const ext of pool) {
    const key = ext.id.toLowerCase();
    assert.ok(!seen.has(key), `${ext.id} and ${seen.get(key)} share the link ?ext=${key}`);
    seen.set(key, ext.id);
  }
});

test('every extension link opens that extension', () => {
  for (const ext of pool) {
    const params = new URLSearchParams(permalinkSearch(ext.id));
    assert.equal(findExtensionById(pool, params.get(EXTENSION_PARAM)), ext, ext.id);
    assert.equal(findExtensionById(pool, ext.id.toLowerCase()), ext, `${ext.id}, lower case`);
  }
  assert.ok(pool.length > 200, `expected the catalogue, found ${pool.length} extensions`);
});

test('no extension lists two instructions that would share one link', () => {
  for (const ext of pool) {
    const seen = new Map();
    for (const mnemonic of Object.keys(ext.instructions ?? {})) {
      const key = normalizeMnemonicKey(mnemonic);
      assert.ok(!seen.has(key), `${ext.id}: ${mnemonic} and ${seen.get(key)} share ?insn=${key}`);
      seen.set(key, mnemonic);
    }
  }
});

test('every instruction link opens that instruction, under that extension', () => {
  for (const { ext, mnemonic } of instructions) {
    const hit = resolveInstructionLink(pool, permalinkSearch(ext.id, mnemonic));
    assert.equal(hit?.ext, ext, `${ext.id} ${mnemonic}`);
    assert.equal(hit.instruction.mnemonic, mnemonic, `${ext.id} ${mnemonic}`);
  }
  assert.ok(instructions.length > 4000, `expected every listing, found ${instructions.length}`);
});

test('an instruction link without ?ext= opens it under an extension that lists it', () => {
  const mnemonics = new Set(instructions.map(({ mnemonic }) => mnemonic));
  for (const mnemonic of mnemonics) {
    for (const spelling of [mnemonic, mnemonic.toLowerCase()]) {
      const hit = resolveInstructionLink(pool, `?insn=${encodeURIComponent(spelling)}`);
      assert.ok(hit, `?insn=${spelling} opened nothing`);
      assert.ok(instructionInExtension(hit.ext, mnemonic), `${hit.ext.id} lacks ${mnemonic}`);
    }
  }
});

test('links that name nothing resolve to nothing', () => {
  assert.equal(resolveInstructionLink(pool, '?insn=NOT.AN.INSN'), null);
  assert.equal(resolveInstructionLink(pool, '?insn='), null);
  assert.equal(resolveInstructionLink(pool, '?ext=Zba&insn=C.JAL'), null, 'Zba has no C.JAL');
  assert.equal(resolveInstructionLink(pool, '?ext=NoSuchExt&insn=ADD'), null);
  assert.equal(findExtensionById(pool, ''), null);
});
