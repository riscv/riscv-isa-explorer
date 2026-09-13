/**
 * encodingUtils.js — RISC-V instruction encoding arithmetic.
 *
 * Extracted from risc_v_visualizer.jsx so that both the Encoder Validator and
 * the Custom Extension Sandbox can share the same validated logic. Pure
 * functions, no React, no data imports.
 *
 * Every function here operates on 32-bit instruction patterns expressed as
 * BigInts. The width is fixed by the ISA (variable-length encodings are a
 * different data path) and is not a parameter.
 */

export const BIT_WIDTH = 32n;
export const BIT_MASK_32 = (1n << BIT_WIDTH) - 1n;

/**
 * Normalise a hex string to lowercase with `0x` prefix.
 * Returns '' for empty input.
 */
export function normalizeHexString(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return text.toLowerCase().startsWith('0x') ? text.toLowerCase() : `0x${text.toLowerCase()}`;
}

/**
 * Parse a hex string to BigInt. Returns null on failure rather than throwing,
 * because user input can be anything.
 */
export function parseHexToBigInt(value) {
  const normalized = normalizeHexString(value);
  if (!normalized) return null;
  if (!/^0x[0-9a-f]+$/i.test(normalized)) return null;
  try {
    return BigInt(normalized);
  } catch {
    return null;
  }
}

/** Format a BigInt as a zero-padded 8-digit hex string with `0x` prefix. */
export function toHex32(value) {
  const v = (value ?? 0n) & BIT_MASK_32;
  return `0x${v.toString(16).padStart(8, '0')}`;
}

/** Strip whitespace from an encoding string. */
export function normalizeEncodingString(value) {
  const encoding = String(value ?? '').replace(/\s+/g, '');
  if (!encoding) return '';
  return encoding;
}

/**
 * Convert a 32-character encoding pattern (`0`, `1`, `-`) to a match/mask pair.
 *
 * Returns `{ match: BigInt, mask: BigInt, error: null }` on success,
 * or `{ match: null, mask: null, error: string }` on failure.
 */
export function encodingToMatchMask(encoding) {
  const normalized = normalizeEncodingString(encoding);
  if (!normalized) return { match: null, mask: null, error: 'Provide an encoding or match/mask.' };
  if (normalized.length !== 32) {
    return {
      match: null,
      mask: null,
      error: `Encoding must be 32 characters (got ${normalized.length}).`,
    };
  }
  if (!/^[01-]{32}$/.test(normalized)) {
    return { match: null, mask: null, error: 'Encoding may only contain 0, 1, and -.' };
  }

  let match = 0n;
  let mask = 0n;
  for (let i = 0; i < 32; i++) {
    const bit = 31n - BigInt(i);
    const ch = normalized[i];
    if (ch === '-') continue;
    mask |= 1n << bit;
    if (ch === '1') match |= 1n << bit;
  }
  return { match, mask, error: null };
}

/**
 * Convert a match/mask pair back to a 32-character encoding string.
 *
 * Fixed `0` and `1` bits come from the mask; unmasked positions are `-`.
 */
export function matchMaskToEncoding(match, mask) {
  const m = (match ?? 0n) & BIT_MASK_32;
  const k = (mask ?? 0n) & BIT_MASK_32;
  let out = '';
  for (let bit = 31n; bit >= 0n; bit--) {
    const bitMask = 1n << bit;
    if ((k & bitMask) === 0n) out += '-';
    else out += (m & bitMask) === 0n ? '0' : '1';
  }
  return out;
}

/**
 * Do two instruction patterns overlap?
 *
 * Two patterns overlap iff there exists at least one 32-bit word that matches
 * both. This is true when the fixed bits they share agree on every position.
 */
export function patternsOverlap(aMatch, aMask, bMatch, bMask) {
  const commonMask = aMask & bMask & BIT_MASK_32;
  const diff = (aMatch ^ bMatch) & commonMask & BIT_MASK_32;
  return diff === 0n;
}

/**
 * Is `subset` a strict subset of `superset`?
 *
 * True when every word matching the subset also matches the superset — i.e.
 * the superset constrains fewer bits, and on the bits it does constrain it
 * agrees with the subset.
 */
export function isSubsetPattern(subsetMatch, subsetMask, supMatch, supMask) {
  const subsetMaskNorm = (subsetMask ?? 0n) & BIT_MASK_32;
  const supMaskNorm = (supMask ?? 0n) & BIT_MASK_32;
  const subsetMatchNorm = (subsetMatch ?? 0n) & BIT_MASK_32;
  const supMatchNorm = (supMatch ?? 0n) & BIT_MASK_32;

  const supBitsNotConstrainedBySubset = supMaskNorm & ~subsetMaskNorm;
  if (supBitsNotConstrainedBySubset !== 0n) return false;
  const mismatch = (subsetMatchNorm ^ supMatchNorm) & supMaskNorm;
  return mismatch === 0n;
}

/**
 * An example 32-bit word that satisfies both patterns simultaneously.
 *
 * Used to make conflict reports concrete: "here is a word that would decode
 * as both instructions."
 */
export function overlapExampleWord(aMatch, aMask, bMatch, bMask) {
  const am = (aMatch ?? 0n) & BIT_MASK_32;
  const ak = (aMask ?? 0n) & BIT_MASK_32;
  const bm = (bMatch ?? 0n) & BIT_MASK_32;
  const bk = (bMask ?? 0n) & BIT_MASK_32;
  return ((am & ak) | (bm & (bk & ~ak))) & BIT_MASK_32;
}
