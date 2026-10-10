/**
 * Data integrity checks for src/riscv_extensions.json.
 *
 * These run with Node's built-in test runner (`node --test`) so the repo
 * gains test coverage without adding a test framework dependency.
 *
 * The catalog is the single source of truth for the whole app: the landscape
 * view, the encoder diagrams, and (once the ISA workspace lands) dependency
 * resolution and -march generation. A malformed entry here surfaces as a
 * confusing UI bug far from its cause, so it is worth asserting the shape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(
  readFileSync(join(here, '..', 'src', 'riscv_extensions.json'), 'utf8'),
);

/** Flatten { category: [ext, ...] } into [[category, ext], ...] */
function allExtensions() {
  const out = [];
  for (const [category, list] of Object.entries(catalog)) {
    for (const ext of list) out.push([category, ext]);
  }
  return out;
}

test('catalog is a non-empty object of category -> array', () => {
  assert.equal(typeof catalog, 'object');
  assert.ok(!Array.isArray(catalog), 'top level must be an object, not an array');
  const categories = Object.keys(catalog);
  assert.ok(categories.length > 0, 'catalog has no categories');
  for (const [name, list] of Object.entries(catalog)) {
    assert.ok(Array.isArray(list), `category "${name}" is not an array`);
  }
});

test('every extension has a non-empty id and name', () => {
  for (const [category, ext] of allExtensions()) {
    assert.ok(ext && typeof ext === 'object', `${category}: entry is not an object`);
    assert.equal(typeof ext.id, 'string', `${category}: missing string id`);
    assert.ok(ext.id.trim().length > 0, `${category}: empty id`);
    assert.equal(typeof ext.name, 'string', `${ext.id}: missing string name`);
    assert.ok(ext.name.trim().length > 0, `${ext.id}: empty name`);
  }
});

test('extension ids are unique, case-insensitively', () => {
  // marchUtils.buildLookup() keys extensions by id.toLowerCase(). Two entries
  // whose ids differ only in case would silently overwrite each other there,
  // so uniqueness must hold case-insensitively, not just exactly.
  const seen = new Map();
  const collisions = [];
  for (const [category, ext] of allExtensions()) {
    const key = ext.id.toLowerCase();
    if (seen.has(key)) collisions.push(`${ext.id} (${category}) collides with ${seen.get(key)}`);
    else seen.set(key, `${ext.id} (${category})`);
  }
  assert.deepEqual(collisions, [], `duplicate ids:\n  ${collisions.join('\n  ')}`);
});

test('instruction encodings are 16 or 32 bits of 0/1/-', () => {
  const bad = [];
  for (const [, ext] of allExtensions()) {
    for (const [mnemonic, details] of Object.entries(ext.instructions ?? {})) {
      const enc = details?.encoding;
      if (typeof enc !== 'string') {
        bad.push(`${ext.id}/${mnemonic}: encoding is not a string`);
        continue;
      }
      if (!/^[01-]+$/.test(enc)) {
        bad.push(`${ext.id}/${mnemonic}: encoding has characters outside [01-]`);
      }
      if (enc.length !== 32 && enc.length !== 16) {
        bad.push(`${ext.id}/${mnemonic}: encoding is ${enc.length} bits (expected 16 or 32)`);
      }
    }
  }
  assert.deepEqual(bad, [], `malformed encodings:\n  ${bad.join('\n  ')}`);
});

test('instructions carry hex match/mask and an extension attribution', () => {
  const bad = [];
  for (const [, ext] of allExtensions()) {
    for (const [mnemonic, details] of Object.entries(ext.instructions ?? {})) {
      for (const field of ['match', 'mask']) {
        const v = details?.[field];
        if (typeof v !== 'string' || !/^0x[0-9a-fA-F]+$/.test(v)) {
          bad.push(`${ext.id}/${mnemonic}: ${field} is not a hex string (got ${JSON.stringify(v)})`);
        }
      }
      if (!Array.isArray(details?.extension) || details.extension.length === 0) {
        bad.push(`${ext.id}/${mnemonic}: missing extension attribution`);
      }
      if (details?.variable_fields !== undefined && !Array.isArray(details.variable_fields)) {
        bad.push(`${ext.id}/${mnemonic}: variable_fields is not an array`);
      }
    }
  }
  assert.deepEqual(bad, [], `malformed instruction fields:\n  ${bad.join('\n  ')}`);
});

test('match fits within mask', () => {
  // A match bit set outside the mask can never be tested by a decoder, so it
  // indicates a bad entry upstream in riscv-opcodes or in the sync script.
  const bad = [];
  for (const [, ext] of allExtensions()) {
    for (const [mnemonic, details] of Object.entries(ext.instructions ?? {})) {
      const { match, mask } = details ?? {};
      if (typeof match !== 'string' || typeof mask !== 'string') continue;
      if (!/^0x[0-9a-fA-F]+$/.test(match) || !/^0x[0-9a-fA-F]+$/.test(mask)) continue;
      const m = BigInt(match);
      const k = BigInt(mask);
      if ((m & ~k) !== 0n) bad.push(`${ext.id}/${mnemonic}: match ${match} has bits outside mask ${mask}`);
    }
  }
  assert.deepEqual(bad, [], `match/mask inconsistencies:\n  ${bad.join('\n  ')}`);
});

test('binary encoding and hexadecimal match/mask describe the same bits', () => {
  const bad = [];
  for (const [, ext] of allExtensions()) {
    for (const [mnemonic, details] of Object.entries(ext.instructions ?? {})) {
      const encoding = details?.encoding;
      if (!/^[01-]{16}$|^[01-]{32}$/.test(encoding ?? '')) continue;

      let derivedMatch = 0n;
      let derivedMask = 0n;
      for (const bit of encoding) {
        derivedMatch <<= 1n;
        derivedMask <<= 1n;
        if (bit === '-') continue;
        derivedMask |= 1n;
        if (bit === '1') derivedMatch |= 1n;
      }

      const storedMatch = BigInt(details.match);
      const storedMask = BigInt(details.mask);
      if (derivedMatch !== storedMatch || derivedMask !== storedMask) {
        bad.push(
          `${ext.id}/${mnemonic}: encoding => 0x${derivedMatch.toString(16)}/` +
            `0x${derivedMask.toString(16)}, stored ${details.match}/${details.mask}`,
        );
      }
    }
  }
  assert.deepEqual(bad, [], `split-brain instruction encodings:\n  ${bad.join('\n  ')}`);
});

test('extensions carry a UDB version, and it is well formed', () => {
  // The version is what anything pinning an extension has to quote: an ACT4
  // DUT config writes `{ name: Zba, version: "= 1.0.0" }`, and without this
  // field every consumer had to re-derive it from UDB or go without.
  //
  // Not every entry can have one. UDB has no E.yaml, and the catalogue lists
  // proposals that UDB has not accepted yet, so absence is legitimate. What
  // is not legitimate is a malformed version, or a ratified extension with
  // none: if UDB ratified it, UDB stated the version it ratified.
  // UDB carries no E.yaml, so the embedded bases have nothing to inherit and
  // sync_udb_extensions.cjs excludes them from its alias map for the same
  // reason. Their ratified state is curated here, not sourced from UDB.
  const NOT_IN_UDB = new Set(['RV32E', 'RV64E']);

  const malformed = [];
  const ratifiedWithout = [];
  let withVersion = 0;

  for (const [, ext] of allExtensions()) {
    const v = ext.version;
    if (v === undefined) {
      if (ext.state === 'ratified' && !NOT_IN_UDB.has(ext.id)) ratifiedWithout.push(ext.id);
      continue;
    }
    withVersion++;
    if (typeof v !== 'string' || !/^\d+\.\d+(\.\d+)?$/.test(v)) {
      malformed.push(`${ext.id}: ${JSON.stringify(v)}`);
    }
  }

  assert.deepEqual(malformed, [], `malformed versions:\n  ${malformed.join('\n  ')}`);
  assert.deepEqual(
    ratifiedWithout,
    [],
    `ratified extensions with no version:\n  ${ratifiedWithout.join('\n  ')}`
  );
  assert.ok(
    withVersion > 150,
    `expected most of the catalogue to carry a version, got ${withVersion}`
  );
});

/*
 * The volume filter used to name each privileged group explicitly, so adding
 * s_counters in #251 rendered its tiles in the grid while leaving them
 * classified as Volume I: dimmed under the Volume II filter and highlighted
 * under Volume I. Every s_* group in the catalogue must reach vol2Ids, whether
 * the code derives them by prefix or lists them one by one.
 */
test('every privileged catalog group is classified as Volume II', () => {
  const src = readFileSync(join(here, '..', 'src', 'risc_v_visualizer.jsx'), 'utf8');
  const start = src.indexOf('const volumeMembership');
  assert.ok(start !== -1, 'volumeMembership helper not found');
  const end = src.indexOf('}, []);', start);
  assert.ok(end !== -1, 'end of volumeMembership helper not found');
  const block = src.slice(start, end);

  const privileged = Object.keys(catalog).filter((group) => group.startsWith('s_'));
  assert.ok(privileged.length > 0, 'expected at least one s_* group in the catalog');

  const derivesByPrefix = /startsWith\('s_'\)/.test(block);
  if (derivesByPrefix) return;

  for (const group of privileged) {
    assert.ok(
      block.includes(`extensions.${group}`),
      `${group} is a privileged group but volumeMembership never adds it to vol2Ids, ` +
        'so its extensions would be treated as Volume I',
    );
  }
});

test('names removed as unsourced or mistaken do not come back', () => {
  // Each of these was selectable, could be exported into an -march string, and
  // was removed because no specification defines it (#250, #254, #374). Sync
  // tooling and hand edits both write to the catalogue, so nothing else stops
  // one reappearing. If a name here turns out to be real after all, remove it
  // from this list in the same change that adds it with a citation.
  const removed = {
    // Naming prefixes for families, not extensions.
    K: 'prefix',
    Zv: 'prefix',
    Zve: 'prefix',
    Zvf: 'prefix',
    Zvk: 'prefix',
    Zvw: 'prefix',
    // Found in no specification, toolchain or riscv-unified-db.
    Sscntrcfg: 'unsourced',
    Sshpmcfg: 'unsourced',
    Zitagelide: 'unsourced',
    'Zilsm*': 'unsourced',
    'Zilsm<x>b': 'unsourced',
    Zilsme: 'unsourced',
    Zilsmea: 'unsourced',
    Smrnpt: 'unsourced',
    Smrntt: 'unsourced',
    Ssvxscr: 'unsourced',
    Zilsp: 'unsourced',
    // Wrong names whose real extension is catalogued, or tracked in #387.
    Zicntrpmf: 'Smcntrpmf',
    Zcmlsd: 'Zclsd',
    Ssptead: 'Svade',
    Zccid: 'Ziccid',
    Smdid: 'Smsdid',
  };
  const banned = new Map(Object.entries(removed).map(([id, why]) => [id.toLowerCase(), [id, why]]));
  const graph = JSON.parse(
    readFileSync(join(here, '..', 'src', 'isa-dependency-graph.json'), 'utf8'),
  );

  const found = [];
  for (const [category, ext] of allExtensions()) {
    const hit = banned.get(ext.id.toLowerCase());
    if (hit) found.push(`${ext.id} in catalogue group ${category} (${hit[1]})`);
  }
  for (const id of Object.keys(graph.nodes)) {
    const hit = banned.get(id.toLowerCase());
    if (hit) found.push(`${id} in the dependency graph (${hit[1]})`);
  }
  assert.deepEqual(found, [], `removed names are back:\n  ${found.join('\n  ')}`);
});
