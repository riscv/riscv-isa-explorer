import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseUpstream,
  applyNotConstraints,
  predicateXlen,
  EXTENSION_ALIASES,
} from '../scripts/check-udb-completeness.mjs';
import { readInstruction } from '../scripts/udb-instruction-reader.mjs';

const parseDefinedBy = (condition) =>
  readInstruction(`kind: instruction\nname: test\ndefinedBy:\n${condition}`);
const parseEncoding = (encoding) =>
  readInstruction(
    `kind: instruction\nname: test\ndefinedBy:\n  extension:\n    name: Zfix\nencoding:\n${encoding}`,
    { includeEncodings: true },
  ).encodings;

// Small UDB fixtures cover the instruction shapes used by the checker.

const here = path.dirname(fileURLToPath(import.meta.url));
const specDir = path.join(here, 'fixtures', 'udb', 'spec', 'std', 'isa');
const upstream = parseUpstream(specDir);
const inst = (name) => upstream.instructions.find((i) => i.mnemonic === name);

test('extensions are read, and their ids come from the filename', () => {
  assert.deepEqual(upstream.extensions.sort(), ['Zdraft', 'Zfix', 'Zlateratified', 'Zwasfrozen']);
});

test('only ever-ratified extensions are marked ratified', () => {
  assert.deepEqual(upstream.ratifiedExtensions.sort(), ['Zfix', 'Zlateratified', 'Zwasfrozen']);
  assert.equal(
    upstream.ratifiedExtensions.includes('Zdraft'),
    false,
    'a development extension is not ratified',
  );
});

test('"ever ratified" counts an extension whose later version is frozen', () => {
  // Zwasfrozen is ratified at 1.0.0 and frozen at 2.0.0. Reading only the LAST
  // state would drop it.
  assert.ok(upstream.ratifiedExtensions.includes('Zwasfrozen'));
});

test('"ever ratified" counts an extension ratified after a draft version', () => {
  // Zlateratified is development at 0.5.0 and ratified at 1.0.0.
  assert.ok(upstream.ratifiedExtensions.includes('Zlateratified'));
});

test('the single-owner definedBy shape is parsed', () => {
  assert.deepEqual(inst('SIMPLE').definedBy, ['Zfix']);
});

test('the anyOf definedBy shape yields every owner', () => {
  assert.deepEqual(inst('SHARED').definedBy, ['Zfix', 'Zwasfrozen']);
});

test('a width-only condition is rejected instead of leaving an instruction unowned', () => {
  const source = fs.readFileSync(path.join(here, 'fixtures', 'udb-unowned.yaml'), 'utf8');
  assert.throws(() => readInstruction(source), /definedBy names no extension/);
});

test('an instruction with no encoding is skipped, not crashed on', () => {
  assert.equal(inst('NOENCODING'), undefined);
});

test('the 0/1/- encoding string becomes the right match and mask', () => {
  const s = inst('SIMPLE');
  assert.equal(s.match, 0x0000000bn);
  assert.equal(s.mask, 0xfe00707fn);
  assert.equal(s.mask & 0x7fn, 0x7fn, 'the opcode field is fully fixed');
  assert.equal(s.match & 0x7fn, 0x0bn, 'opcode 0x0b, custom-0');
});

test('a quoted YAML match is read as a bit pattern', () => {
  const [encoding] = parseEncoding('  match: "0000000----------000-----0010011"');
  assert.equal(encoding.match, 0x00000013n);
  assert.equal(encoding.mask, 0xfe00707fn);
});

test('a dash in the encoding leaves that bit free in the mask', () => {
  const s = inst('SIMPLE');
  // bits 24-15 are dashes in the fixture, so none of them may be set in mask
  for (let bit = 15n; bit <= 24n; bit += 1n) {
    assert.equal((s.mask >> bit) & 1n, 0n, `bit ${bit} should be free`);
  }
});

test('match never sets a bit its own mask leaves free', () => {
  for (const i of upstream.instructions) {
    assert.equal((i.match & ~i.mask) === 0n, true, `${i.mnemonic} has a dead match bit`);
  }
});

test('the alias map is exported and covers upstream bare I', () => {
  // Exported so the workflow and the tests agree on it rather than each
  // carrying their own copy.
  assert.deepEqual(EXTENSION_ALIASES.I, ['RV32I', 'RV64I', 'RV32E', 'RV64E']);
});

test('parseUpstream throws on a directory that is not a checkout', () => {
  assert.throws(() => parseUpstream(path.join(here, 'fixtures', 'nope')));
});

test('invalid not: constraints report the instruction source path', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'udb-invalid-constraint-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const spec = path.join(root, 'ext');
  const inst = path.join(root, 'inst', 'Zfix');
  fs.mkdirSync(spec, { recursive: true });
  fs.mkdirSync(inst, { recursive: true });
  fs.writeFileSync(path.join(spec, 'Zfix.yaml'), 'state: ratified\n');
  const source = path.join(inst, 'bad.yaml');
  fs.writeFileSync(
    source,
    'kind: instruction\nname: bad\ndefinedBy: {extension: {name: Zfix}}\n' +
      'encoding:\n  match: "--------------10"\n  variables:\n' +
      '    - name: first\n      location: 0\n      not: [0]\n' +
      '    - name: second\n      location: 0\n      not: [0]\n',
  );

  assert.throws(() => parseUpstream(root), new RegExp(`${source}: overlapping fields with not`));
});

// ── `not:` constraints ─────────────────────────────────────────────────────

test('a not: list leaving one legal value pins the field', () => {
  // FCVTMOD.W.D excludes every rm value except 1 (RTZ).
  const p = inst('PINNEDBYNOT');
  assert.ok(p, 'the fixture must parse');
  const RM = 0x7n << 12n;
  assert.equal(p.mask & RM, RM, 'bits 14-12 must be fixed');
  assert.equal((p.match >> 12n) & 0x7n, 1n, 'to the single remaining value, 1');
});

test('a not: list that merely narrows leaves the bits free, and says so', () => {
  // "any value except these four" cannot be said with a match and a mask.
  // Flattening it would invent a constraint upstream did not state.
  const n = inst('NARROWEDBYNOT');
  const RM = 0x7n << 12n;
  assert.equal(n.mask & RM, 0n, 'bits 14-12 stay free');
  assert.deepEqual(n.narrowedFields, [{ field: 'tt', remaining: 4 }]);
});

test('an instruction with no not: constraints reports none narrowed', () => {
  assert.deepEqual(inst('SIMPLE').narrowedFields, []);
});

test('applyNotConstraints folds exclusions into contiguous and split fields', () => {
  const base = { match: 0n, mask: 0n };
  const pinned = applyNotConstraints(base, [
    { name: 'f', positions: [14, 13, 12], not: [0, 2, 3, 4, 5, 6, 7] },
  ]);
  assert.equal(pinned.mask, 0x7n << 12n);
  assert.equal(pinned.match, 1n << 12n);
  assert.deepEqual(pinned.narrowed, []);

  const untouched = applyNotConstraints(base, [{ name: 'f', positions: [14, 13, 12], not: [] }]);
  assert.equal(untouched.mask, 0n, 'an empty not: changes nothing');

  const narrowed = applyNotConstraints(base, [{ name: 'f', positions: [14, 13, 12], not: [0, 1] }]);
  assert.equal(narrowed.mask, 0n, 'six values remain, so nothing can be pinned');
  assert.deepEqual(narrowed.narrowed, [{ field: 'f', remaining: 6 }]);
});

test('the shared reader reads variables and a multi-line not: list', () => {
  // cm.jalt's exclusion list wraps across lines upstream.
  const [encoding] = parseEncoding(`  match: 0000000----------000-----0001011
  variables:
    - name: index
      location: 19-15
      not: [ 0, 1, 2, 3,
             4, 5 ]
    - name: xd
      location: 11-7`);
  const vars = encoding.variables;
  assert.equal(vars.length, 2);
  assert.deepEqual(vars[0].positions, [19, 18, 17, 16, 15]);
  assert.deepEqual(vars[0].not, [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(vars[1].not, []);
});

// ── XLEN-keyed encodings ───────────────────────────────────────────────────

test('an XLEN-keyed encoding yields one entry per XLEN', () => {
  /*
   * unified-db writes 19 instructions with encodings keyed by XLEN, rev8 among
   * them. Taking the first `match:` in the file read one of the two, and it did
   * so for exactly the instructions where RV32 and RV64 diverge -- the shifts,
   * ld/sd, the Zbs single-bit ops -- so the gate compared half the data for the
   * cases most likely to disagree.
   */
  const encs = parseEncoding(`  RV32:
    match: 011010011000-----101-----0010011
    variables:
      - name: xs1
        location: 19-15
  RV64:
    match: 011010111000-----101-----0010011
    variables:
      - name: xs1
        location: 19-15
`);
  assert.equal(encs.length, 2);
  assert.deepEqual(
    encs.map((e) => e.xlen),
    ['RV32', 'RV64'],
  );
  assert.equal(encs[0].match, 0x69805013n, 'the RV32 form');
  assert.equal(encs[1].match, 0x6b805013n, 'the RV64 form');
});

test('a plain encoding yields exactly one entry, with no xlen', () => {
  const encs = parseEncoding(`  match: 0000000----------000-----0110011
  variables:
    - name: xs2
      location: 24-20`);
  assert.equal(encs.length, 1);
  assert.equal(encs[0].xlen, null);
});

test('not: constraints are folded per XLEN block, not across them', () => {
  const encs = parseEncoding(`  RV32:
    match: 0000000------------------0110011
    variables:
      - name: tt
        location: 14-12
        not: [0, 2, 3, 4, 5, 6, 7]
  RV64:
    match: 0000000------------------0110011
    variables:
      - name: tt
        location: 14-12
`);
  assert.equal(encs.length, 2);
  const RM = 0x7n << 12n;
  const rv32 = applyNotConstraints(encs[0], encs[0].variables);
  const rv64 = applyNotConstraints(encs[1], encs[1].variables);
  assert.equal(rv32.mask & RM, RM, 'RV32 pins tt via not:');
  assert.equal(rv64.mask & RM, 0n, 'RV64 leaves it free');
});

test('non-contiguous variable locations preserve bit order when folding not:', () => {
  const [encoding] = parseEncoding(`  match: ${'-'.repeat(43)}11111
  variables:
    - name: split
      location: 10|7
      not: [0, 2, 3]`);
  const result = applyNotConstraints(encoding, encoding.variables);
  const positions = [10, 7];
  const mask = positions.reduce((value, bit) => value | (1n << BigInt(bit)), 0n);
  assert.equal(result.mask & mask, mask);
  assert.equal(result.match & mask, 1n << 7n, 'remaining value 1 maps to the last listed bit');
});

test('the shared reader rejects unknown encoding shapes and malformed fields', () => {
  assert.throws(() => parseEncoding('  RV128:\n    match: 0000'), /unsupported encoding shape/);
  assert.throws(() => parseEncoding('  match: 001x'), /encoding match/);
  assert.throws(
    () =>
      parseEncoding(
        '  match: -------------------------0010011\n  variables: [{name: bad, location: 3-0, not: [16]}]',
      ),
    /not value out of range/,
  );
  assert.throws(
    () =>
      parseEncoding(
        '  match: -------------------------0010011\n  variables: [{name: bad, location: 3-2, not: [0, 1, 2, 3]}]',
      ),
    /not excludes every value/,
  );
  assert.throws(
    () =>
      parseEncoding(
        '  match: -------------------------0010011\n  variables: [{name: bad, location: 3-0, not: null}]',
      ),
    /invalid not list/,
  );
  assert.throws(
    () =>
      parseEncoding(
        '  match: -------------------------0010011\n  variables: [{name: bad, location: 999999999-0}]',
      ),
    /exceeds match width/,
  );
  assert.throws(
    () =>
      parseEncoding(
        '  match: -------------------------0010011\n  variables: [{name: bad, $inherits: common/foo}]',
      ),
    /unresolved inherited encoding variable.*resolve UDB metadata/,
  );
  assert.throws(
    () =>
      parseEncoding(
        '  match: -------------------------0010011\n  variables: [{name: bad, location: 3-0, typo: true}]',
      ),
    /unsupported encoding variable shape/,
  );
});

test('encoding parsing accepts schema-defined locations and scalar not values', () => {
  const [encoding] = parseEncoding(`  match: -------------------------0010011
  variables:
    - name: bit
      location: 10
      not: 0`);
  assert.deepEqual(encoding.variables[0], { name: 'bit', positions: [10], not: [0] });
  const result = applyNotConstraints(encoding, encoding.variables);
  assert.equal(result.mask & (1n << 10n), 1n << 10n, 'excluding zero pins the field to one');
  assert.equal(result.match & (1n << 10n), 1n << 10n);
});

test('not: values are counted only when compatible with bits fixed by match', () => {
  const [narrowed] = parseEncoding(`  match: ${'0'.repeat(26)}0---11
  variables:
    - name: field
      location: 5-4
      not: [2]`);
  const partial = applyNotConstraints(narrowed, narrowed.variables);
  assert.deepEqual(partial.narrowed, [{ field: 'field', remaining: 2 }]);

  const [encoding] = parseEncoding(`  match: ${'0'.repeat(26)}0---11
  variables:
    - name: field
      location: 5-4
      not: [0]`);
  const result = applyNotConstraints(encoding, encoding.variables);
  assert.equal(result.mask & (0x3n << 4n), 0x3n << 4n);
  assert.equal(result.match & (0x3n << 4n), 1n << 4n, 'the only legal value is 01');
  assert.deepEqual(result.narrowed, []);

  const [impossible] = parseEncoding(`  match: ${'0'.repeat(26)}0---11
  variables:
    - name: field
      location: 5-4
      not: [0, 1]`);
  assert.throws(
    () => applyNotConstraints(impossible, impossible.variables),
    /not constraints exclude every value compatible with match/,
  );
});

test('overlapping fields with not: constraints fail instead of being folded independently', () => {
  assert.throws(
    () =>
      applyNotConstraints({ match: 0n, mask: 0n }, [
        { name: 'first', positions: [2, 1], not: [0, 1] },
        { name: 'second', positions: [1, 0], not: [0, 2] },
      ]),
    /overlapping fields with not constraints are unsupported/,
  );
});

test('XLEN-keyed encoding requires both schema-defined forms', () => {
  assert.throws(
    () => parseEncoding('  RV32:\n    match: 00000000000000000000000000010011'),
    /unsupported encoding shape/,
  );
});

test('encoding match accepts only UDB schema widths and opcode suffixes', () => {
  assert.throws(
    () => parseEncoding('  match: 00000000000000000000000000000000'),
    /valid 16-, 32- or 48-bit pattern/,
  );
  assert.throws(
    () => parseEncoding('  match: 00000000000000000000000000000010'),
    /valid 16-, 32- or 48-bit pattern/,
  );
});

test('encoding match accepts all three UDB schema widths', () => {
  const encodings = [
    ...parseEncoding(`  match: ${'-'.repeat(14)}10`),
    ...parseEncoding(`  match: ${'-'.repeat(30)}11`),
    ...parseEncoding(`  match: ${'-'.repeat(43)}11111`),
  ];
  assert.deepEqual(
    encodings.map(({ match, mask }) => [match, mask]),
    [
      [0b10n, 0b11n],
      [0b11n, 0b11n],
      [0b11111n, 0b11111n],
    ],
  );
});

// ── definedBy as a predicate, not a flat owner list ────────────────────────

/*
 * Reading only the `name:` values answers "which extensions" and discards
 * "under what conditions". 132 instruction files in unified-db carry an
 * `xlen:` inside definedBy, so MULW's "RV64 AND (M OR Zmmul)" collapsed to
 * "[M, Zmmul]" and the RV64 half was simply gone. That condition is the only
 * thing distinguishing an RV32-only pairing from its RV64 namesake.
 *
 * Every shape below is taken from a real file in the corpus.
 */

test('the simple shape: one extension, no condition', () => {
  const { owners, predicate } = parseDefinedBy(`  extension:
    name: I`);
  assert.deepEqual(owners, ['I']);
  assert.deepEqual(predicate, { extension: { name: 'I' } });
  assert.equal(predicateXlen(predicate), null, 'applies to both XLENs');
});

test('an alternation keeps its shape', () => {
  const { owners, predicate } = parseDefinedBy(`  extension:
    anyOf:
      - name: Smctr
      - name: Ssctr`);
  assert.deepEqual(owners, ['Smctr', 'Ssctr']);
  assert.deepEqual(predicate, {
    extension: { anyOf: [{ name: 'Smctr' }, { name: 'Ssctr' }] },
  });
});

test('an xlen condition survives, nested or not', () => {
  // Zaamo/amoor.d.rl.yaml — extension first, then the width.
  const flat = parseDefinedBy(`  allOf:
    - extension:
        name: Zaamo
    - xlen: 64`);
  assert.deepEqual(flat.owners, ['Zaamo']);
  assert.equal(predicateXlen(flat.predicate), 64);

  // M/mulw.yaml — the width guards an alternation.
  const nested = parseDefinedBy(`  allOf:
    - xlen: 64
    - extension:
        anyOf:
          - name: M
          - name: Zmmul`);
  assert.deepEqual(nested.owners, ['M', 'Zmmul']);
  assert.equal(predicateXlen(nested.predicate), 64);
  assert.deepEqual(nested.predicate, {
    allOf: [{ xlen: 64 }, { extension: { anyOf: [{ name: 'M' }, { name: 'Zmmul' }] } }],
  });
});

test('alternative owners retain their separate XLEN conditions', () => {
  // LD uses I in RV64 and Zilsd in RV32; neither width applies to both owners.
  const { owners, predicate } = parseDefinedBy(`  anyOf:
    - allOf:
        - xlen: 64
        - extension:
            name: I
    - allOf:
        - xlen: 32
        - extension:
            name: Zilsd`);
  assert.deepEqual(owners, ['I', 'Zilsd']);
  assert.deepEqual(predicate, {
    anyOf: [
      { allOf: [{ xlen: 64 }, { extension: { name: 'I' } }] },
      { allOf: [{ xlen: 32 }, { extension: { name: 'Zilsd' } }] },
    ],
  });
  assert.equal(predicateXlen(predicate), null);
});

test('a negation is not mistaken for a requirement', () => {
  // Zbb/zext.h.yaml: Zbb AND NOT Zbkb. The flat reading gave [Zbb, Zbkb],
  // which states the opposite of what the file says about Zbkb.
  const { owners, predicate } = parseDefinedBy(`  extension:
    allOf:
      - name: Zbb
      - not:
          name: Zbkb`);
  assert.deepEqual(owners, ['Zbb']);
  assert.deepEqual(predicate, {
    extension: { allOf: [{ name: 'Zbb' }, { not: { name: 'Zbkb' } }] },
  });
});

test('an xlen inside an alternation does not pin the instruction', () => {
  // Only allOf propagates unconditionally: one alternative naming RV64 does
  // not make the instruction RV64-only.
  const { predicate } = parseDefinedBy(`  anyOf:
    - xlen: 64
    - extension:
        name: Zbb`);
  assert.equal(predicateXlen(predicate), null);
});

test('comments inside the block are ignored', () => {
  const { owners } = parseDefinedBy(`  # zext.h is an alias of pack under Zbkb
  extension:
    name: Zbb`);
  assert.deepEqual(owners, ['Zbb']);
});

test('an unrecognised shape throws instead of returning a partial owner list', () => {
  assert.throws(
    () =>
      parseDefinedBy(`  extension:
    ????`),
    /expected a definedBy condition object/,
  );
});

test('CRLF line endings preserve the ownership condition', () => {
  const { owners, predicate } = parseDefinedBy('  extension:\r\n    name: Zbb\r\n');
  assert.deepEqual(owners, ['Zbb']);
  assert.deepEqual(predicate, { extension: { name: 'Zbb' } });
});

test('CRLF line endings preserve encoding variables and not: values', () => {
  const crlfText =
    'kind: instruction\r\nname: test\r\ndefinedBy:\r\n  extension:\r\n    name: Zfix\r\n' +
    'encoding:\r\n  match: 0000011------------------0001011\r\n' +
    '  variables:\r\n    - name: rs1\r\n      location: 19-15\r\n' +
    '    - name: tt\r\n      location: 14-12\r\n      not: [0, 2, 3, 4, 5, 6, 7]\r\n';
  const { encodings } = readInstruction(crlfText, { includeEncodings: true });
  assert.equal(encodings[0].variables.length, 2);
  assert.equal(encodings[0].variables[0].name, 'rs1');
  assert.equal(encodings[0].variables[1].name, 'tt');
  assert.deepEqual(encodings[0].variables[1].not, [0, 2, 3, 4, 5, 6, 7]);
});
