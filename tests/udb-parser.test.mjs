import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseUpstream,
  parseVariables,
  applyNotConstraints,
  parseEncodings,
  parseDefinedBy,
  predicateXlen,
  EXTENSION_ALIASES,
} from '../scripts/check-udb-completeness.mjs';

/*
 * The parser, against committed fixtures.
 *
 * Every defect this file has had lived in the parsing, and real data found all
 * of them because there was nothing importable to test:
 *
 *   - a definedBy regex terminating on /$/m, which in multiline mode is the end
 *     of the FIRST line, so it captured nothing and every instruction came back
 *     unowned;
 *   - `owners || [dir]`, which never fell back because an empty array is truthy;
 *   - no `state` read at all, so draft extensions were reported as ratified gaps.
 *
 * The fixtures below carry one case per shape, so a regression fails here
 * rather than in a weekly cron nobody is watching.
 */

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
  /*
   * Zlateratified is development at 0.5.0 and ratified at 1.0.0, so the
   * ratified state is not the first one in the file. Mutation testing put this
   * here: substituting "read only the first state" failed nothing, because
   * every other fixture happened to list ratified first.
   */
  assert.ok(upstream.ratifiedExtensions.includes('Zlateratified'));
});

test('the single-owner definedBy shape is parsed', () => {
  assert.deepEqual(inst('SIMPLE').definedBy, ['Zfix']);
});

test('the anyOf definedBy shape yields every owner', () => {
  assert.deepEqual(inst('SHARED').definedBy, ['Zfix', 'Zwasfrozen']);
});

test('an instruction with no definedBy falls back to its directory', () => {
  // The `|| [dir]` bug: an empty array is truthy, so the fallback never fired
  // and the instruction was left unowned.
  assert.deepEqual(inst('UNOWNED').definedBy, ['Zfix']);
});

test('an instruction with no encoding is skipped, not crashed on', () => {
  assert.equal(inst('NOENCODING'), undefined);
});

test('the 0/1/- encoding string becomes the right match and mask', () => {
  // match: 0000000----------000-----0001011
  const s = inst('SIMPLE');
  let match = 0n;
  let mask = 0n;
  for (const ch of '0000000----------000-----0001011') {
    match <<= 1n;
    mask <<= 1n;
    if (ch === '1') {
      match |= 1n;
      mask |= 1n;
    } else if (ch === '0') {
      mask |= 1n;
    }
  }
  assert.equal(s.match, match);
  assert.equal(s.mask, mask);
  assert.equal(s.mask & 0x7fn, 0x7fn, 'the opcode field is fully fixed');
  assert.equal(s.match & 0x7fn, 0x0bn, 'opcode 0x0b, custom-0');
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

test('every parsed instruction names at least one owner', () => {
  for (const i of upstream.instructions) {
    assert.ok(i.definedBy.length > 0, `${i.mnemonic} has no owner`);
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

// ── `not:` constraints ─────────────────────────────────────────────────────

test('a not: list leaving one legal value pins the field', () => {
  /*
   * The bug this fixes. unified-db can constrain a field by exclusion rather
   * than by fixing bits in the match string: fcvtmod.w.d shows rm as dashes and
   * carries not: [0,2,3,4,5,6,7], which leaves only 1 (RTZ). Reading the match
   * string alone reported it as free, and this catalogue -- which pins it
   * correctly -- was flagged as disagreeing with upstream.
   */
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

test('applyNotConstraints is a pure function over match and mask', () => {
  const base = { match: 0n, mask: 0n };
  const pinned = applyNotConstraints(base, [
    { name: 'f', hi: 14, lo: 12, not: [0, 2, 3, 4, 5, 6, 7] },
  ]);
  assert.equal(pinned.mask, 0x7n << 12n);
  assert.equal(pinned.match, 1n << 12n);
  assert.deepEqual(pinned.narrowed, []);

  const untouched = applyNotConstraints(base, [{ name: 'f', hi: 14, lo: 12, not: [] }]);
  assert.equal(untouched.mask, 0n, 'an empty not: changes nothing');

  const narrowed = applyNotConstraints(base, [{ name: 'f', hi: 14, lo: 12, not: [0, 1] }]);
  assert.equal(narrowed.mask, 0n, 'six values remain, so nothing can be pinned');
  assert.deepEqual(narrowed.narrowed, [{ field: 'f', remaining: 6 }]);
});

test('parseVariables reads a multi-line not: list', () => {
  // cm.jalt's exclusion list wraps across lines upstream.
  const vars = parseVariables(`
encoding:
  match: 0000000----------000-----0001011
  variables:
    - name: index
      location: 19-15
      not: [ 0, 1, 2, 3,
             4, 5 ]
    - name: xd
      location: 11-7
`);
  assert.equal(vars.length, 2);
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
  const encs = parseEncodings(`
encoding:
  RV32:
    match: 011010011000-----101-----0010011
    variables:
      - name: xs1
        location: 19-15
  RV64:
    match: 011010111000-----101-----0010011
    variables:
      - name: xs1
        location: 19-15
access:
  s: always
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
  const encs = parseEncodings(`
encoding:
  match: 0000000----------000-----0110011
  variables:
    - name: xs2
      location: 24-20
`);
  assert.equal(encs.length, 1);
  assert.equal(encs[0].xlen, null);
});

test('not: constraints are folded per XLEN block, not across them', () => {
  const encs = parseEncodings(`
encoding:
  RV32:
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
  assert.equal(encs[0].mask & RM, RM, 'RV32 pins tt via not:');
  assert.equal(encs[1].mask & RM, 0n, 'RV64 leaves it free');
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

test('a negation is not mistaken for a requirement', () => {
  // Zbb/zext.h.yaml: Zbb AND NOT Zbkb. The flat reading gave [Zbb, Zbkb],
  // which states the opposite of what the file says about Zbkb.
  const { owners, predicate } = parseDefinedBy(`  extension:
    allOf:
      - name: Zbb
      - not:
          name: Zbkb`);
  assert.deepEqual(owners, ['Zbb', 'Zbkb'], 'the flat list still names both');
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

test('an unrecognised shape yields no predicate rather than a wrong one', () => {
  const { owners, predicate } = parseDefinedBy(`  extension:
    ????`);
  assert.equal(predicate, null, 'degrade to the flat list rather than invent a condition');
  assert.deepEqual(owners, []);
});

test('CRLF line endings: blockUnder body lines have \\r stripped so parseDefinedBy works', () => {
  /*
   * blockUnder joins body lines with '\n'. On CRLF checkouts each body line
   * ends with '\r', so the joined output contains trailing \r characters.
   * parseDefinedBy splits on '\n' again, giving lines like '  extension:\r'
   * which parseMapping cannot match. Body lines must have \r stripped.
   */
  // Construct the block as blockUnder would return it from a CRLF checkout
  const crlfBlock = '  extension:\r\n    name: Zbb\r\n';
  const { owners } = parseDefinedBy(crlfBlock);
  assert.deepEqual(owners, ['Zbb'], 'CRLF body: \\r must be stripped before parseDefinedBy sees the lines');
});

test('CRLF line endings: parseVariables returns all fields on Windows checkouts', () => {
  /*
   * parseVariables used `variables:\n` in its regex. On CRLF files the text is
   * `variables:\r\n`, so the match fails and returns []. This silently drops
   * every not: constraint that #303 added, mis-reporting pinned fields as free bits.
   */
  const crlfText =
    'encoding:\r\n  match: 0000011------------------0001011\r\n' +
    '  variables:\r\n    - name: rs1\r\n      location: 19-15\r\n' +
    '    - name: tt\r\n      location: 14-12\r\n      not: [0, 2, 3, 4, 5, 6, 7]\r\n';
  const vars = parseVariables(crlfText);
  assert.equal(vars.length, 2, 'CRLF: parseVariables must find both variable fields');
  assert.equal(vars[0].name, 'rs1');
  assert.equal(vars[1].name, 'tt');
  assert.deepEqual(vars[1].not, [0, 2, 3, 4, 5, 6, 7], 'CRLF: not: list must be parsed from CRLF file');
});

