import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BIT_MASK_32,
  parseHexToBigInt,
  toHex32,
  normalizeHexString,
  normalizeEncodingString,
  encodingToMatchMask,
  matchMaskToEncoding,
  patternsOverlap,
  isSubsetPattern,
  overlapExampleWord,
} from '../src/encodingUtils.js';

test('parseHexToBigInt preserves BigInt values without decimal stringification corruption', () => {
  // 0x33n must not be stringified to "51" and reparsed as 0x51n (#329)
  assert.equal(parseHexToBigInt(0x33n), 0x33n);
  assert.equal(parseHexToBigInt(0xaben), 0xaben);
  assert.equal(parseHexToBigInt(0xfe00707fn), 0xfe00707fn);
});

test('parseHexToBigInt converts Numbers and hex strings to BigInt', () => {
  assert.equal(parseHexToBigInt(0x33), 0x33n);
  assert.equal(parseHexToBigInt(51), 0x33n);
  assert.equal(parseHexToBigInt('0x33'), 0x33n);
  assert.equal(parseHexToBigInt('0x00000033'), 0x33n);
  assert.equal(parseHexToBigInt('33'), 0x33n);
  assert.equal(parseHexToBigInt(''), null);
  assert.equal(parseHexToBigInt(null), null);
  assert.equal(parseHexToBigInt(undefined), null);
  assert.equal(parseHexToBigInt('0xinvalid'), null);
});

test('toHex32 formats BigInt, Number, and String representations without throwing TypeError', () => {
  assert.equal(toHex32(0x33n), '0x00000033');
  assert.equal(toHex32(0x33), '0x00000033');
  assert.equal(toHex32('0x33'), '0x00000033');
  assert.equal(toHex32('0x00000033'), '0x00000033');
  assert.equal(toHex32('33'), '0x00000033');
  assert.equal(toHex32(null), '0x00000000');
  assert.equal(toHex32(undefined), '0x00000000');
});

test('normalizeHexString and normalizeEncodingString strip whitespace cleanly', () => {
  assert.equal(normalizeHexString('  0x33  '), '0x33');
  assert.equal(normalizeHexString('33'), '0x33');
  assert.equal(normalizeHexString(null), '');
  assert.equal(normalizeHexString(''), '');

  assert.equal(normalizeEncodingString(' 0000000 ----- ----- 000 ----- 0110011 '), '0000000----------000-----0110011');
  assert.equal(normalizeEncodingString(null), '');
});

test('encodingToMatchMask and matchMaskToEncoding round-trip 32-bit instructions', () => {
  const enc = '0000000----------000-----0110011';
  const { match, mask, error } = encodingToMatchMask(enc);
  assert.equal(error, null);
  assert.equal(match, 0x33n);
  assert.equal(mask, 0xfe00707fn);

  const back = matchMaskToEncoding(match, mask);
  assert.equal(back, enc);

  // matchMaskToEncoding tolerates string inputs (#329)
  const backFromHexStr = matchMaskToEncoding('0x00000033', '0xfe00707f');
  assert.equal(backFromHexStr, enc);
});

test('encodingToMatchMask rejects invalid widths and characters', () => {
  assert.notEqual(encodingToMatchMask('').error, null);
  assert.notEqual(encodingToMatchMask('0101').error, null);
  assert.notEqual(encodingToMatchMask('0'.repeat(31)).error, null);
  assert.notEqual(encodingToMatchMask('x'.repeat(32)).error, null);
});

test('patternsOverlap, isSubsetPattern, and overlapExampleWord evaluate correctly with BigInt and string inputs', () => {
  // ADD: match 0x33, mask 0xfe00707f
  // SUB: match 0x40000033, mask 0xfe00707f
  assert.equal(patternsOverlap(0x33n, 0xfe00707fn, 0x33n, 0xfe00707fn), true);
  assert.equal(patternsOverlap(0x33n, 0xfe00707fn, 0x40000033n, 0xfe00707fn), false);

  // String input tolerance (#329)
  assert.equal(patternsOverlap('0x33', '0xfe00707f', '0x33', '0xfe00707f'), true);
  assert.equal(patternsOverlap('0x33', '0xfe00707f', '0x40000033', '0xfe00707f'), false);

  // Subset patterns: a narrower mask (e.g. 0x7f) matches a superset of words
  assert.equal(isSubsetPattern(0x33n, 0xfe00707fn, 0x33n, 0x7fn), true);
  assert.equal(isSubsetPattern(0x33n, 0x7fn, 0x33n, 0xfe00707fn), false);

  // Overlap example word
  const example = overlapExampleWord(0x33n, 0xfe00707fn, 0x33n, 0x7fn);
  assert.equal(example & 0xfe00707fn, 0x33n);
});

test('parseHexToBigInt keeps values wider than 32 bits so oversized input can be rejected', () => {
  // The match/mask validation in risc_v_visualizer.jsx rejects anything above BIT_MASK_32.
  // If parseHexToBigInt truncated, 0x11800202f would silently become 0x1800202f and be
  // reported as a conflict the user never typed.
  assert.equal(parseHexToBigInt('0x11800202f'), 0x11800202fn);
  assert.ok(parseHexToBigInt('0x11800202f') > BIT_MASK_32);
  assert.equal(parseHexToBigInt(0x1_0000_0033n), 0x1_0000_0033n);
  assert.equal(parseHexToBigInt(2 ** 32 + 0x33), 0x1_0000_0033n);
  // Helpers that need 32 bits still truncate on their own.
  assert.equal(toHex32('0x11800202f'), '0x1800202f');
});
