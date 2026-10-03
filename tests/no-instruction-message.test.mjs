/**
 * Tests for the noInstructionReason helper.
 *
 * The helper derives an explanatory string from existing catalogue fields —
 * `csrs`, `behavior`, and the extension id — rather than a hand-maintained
 * mapping. These tests verify each classification path and then sweep the
 * full catalogue to ensure every zero-instruction extension gets a non-empty
 * message and every extension that does have instructions gets null.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { noInstructionReason } from '../src/extensionNotes.js';

const here = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(readFileSync(join(here, '..', 'src', 'riscv_extensions.json'), 'utf8'));
const allExtensions = Object.values(catalog).flat().filter(Boolean);

// ── Classification paths ─────────────────────────────────────────────────────

test('returns null for extensions that have instructions', () => {
  const zba = allExtensions.find((e) => e.id === 'Zba');
  assert.ok(zba, 'Zba must exist in catalog');
  assert.ok(Object.keys(zba.instructions).length > 0, 'Zba must have instructions');
  assert.equal(noInstructionReason(zba), null);
});

test('VLEN parameter extensions get a VLEN-specific message', () => {
  const zvl128b = allExtensions.find((e) => e.id === 'Zvl128b');
  assert.ok(zvl128b, 'Zvl128b must exist in catalog');
  const reason = noInstructionReason(zvl128b);
  assert.ok(reason, 'should return a non-empty string');
  assert.ok(reason.includes('VLEN'), `message should mention VLEN, got: ${reason}`);
});

test('behavioral extensions get a behavior message', () => {
  const sv39 = allExtensions.find((e) => e.id === 'Sv39');
  assert.ok(sv39, 'Sv39 must exist in catalog');
  assert.ok(sv39.behavior, 'Sv39 must have a behavior field');
  const reason = noInstructionReason(sv39);
  assert.ok(reason, 'should return a non-empty string');
  assert.ok(
    reason.includes('behavioral'),
    `message should mention behavioral rules, got: ${reason}`,
  );
});

test('CSR-only extensions get a CSR-focused message', () => {
  const sstc = allExtensions.find((e) => e.id === 'Sstc');
  assert.ok(sstc, 'Sstc must exist in catalog');
  assert.ok(Object.keys(sstc.csrs || {}).length > 0, 'Sstc must have CSRs');
  assert.ok(!sstc.behavior, 'Sstc should not have a behavior field for this test path');
  const reason = noInstructionReason(sstc);
  assert.ok(reason, 'should return a non-empty string');
  assert.ok(
    reason.includes('control/status register'),
    `message should mention CSRs, got: ${reason}`,
  );
});

test('extensions with both CSRs and behavior get a combined message', () => {
  // Find an extension that has both csrs and behavior and no instructions.
  const both = allExtensions.find(
    (e) =>
      Object.keys(e.instructions || {}).length === 0 &&
      Object.keys(e.csrs || {}).length > 0 &&
      e.behavior,
  );
  if (!both) {
    // If no such extension currently exists, test with a synthetic entry.
    const synthetic = { id: 'Xtest', instructions: {}, csrs: { mstatus: {} }, behavior: 'test' };
    const reason = noInstructionReason(synthetic);
    assert.ok(reason.includes('control/status') && reason.includes('behavioral'));
    return;
  }
  const reason = noInstructionReason(both);
  assert.ok(reason, 'should return a non-empty string');
  assert.ok(
    reason.includes('control/status') && reason.includes('behavioral'),
    `message should mention both CSRs and behavioral rules, got: ${reason}`,
  );
});

test('generic fallback for extensions with no distinguishing signals', () => {
  const zkt = allExtensions.find((e) => e.id === 'Zkt');
  assert.ok(zkt, 'Zkt must exist in catalog');
  assert.equal(Object.keys(zkt.instructions || {}).length, 0, 'Zkt must have no instructions');
  assert.ok(!zkt.behavior, 'Zkt should not have a behavior field');
  assert.equal(Object.keys(zkt.csrs || {}).length, 0, 'Zkt should have no CSRs');
  const reason = noInstructionReason(zkt);
  assert.ok(reason, 'should return a non-empty string');
  assert.ok(
    reason.includes('no instruction encodings'),
    `generic message should mention no instruction encodings, got: ${reason}`,
  );
});

// ── Purity ───────────────────────────────────────────────────────────────────

test('the helper is a pure function of the extension object', () => {
  const ext = { id: 'Zvl64b', instructions: {}, csrs: {} };
  const first = noInstructionReason(ext);
  const second = noInstructionReason(ext);
  assert.equal(first, second);
});

// ── Catalogue sweep ──────────────────────────────────────────────────────────

test('every zero-instruction extension produces a non-empty message', () => {
  const empty = allExtensions.filter((e) => Object.keys(e.instructions || {}).length === 0);
  assert.ok(empty.length > 100, `expected 100+ zero-instruction extensions, got ${empty.length}`);

  const failures = [];
  for (const ext of empty) {
    const reason = noInstructionReason(ext);
    if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
      failures.push(ext.id);
    }
  }
  assert.deepEqual(failures, [], `these zero-instruction extensions got no message: ${failures}`);
});

test('no false positives: extensions with instructions return null', () => {
  const populated = allExtensions.filter((e) => Object.keys(e.instructions || {}).length > 0);
  assert.ok(populated.length > 50, `expected 50+ populated extensions, got ${populated.length}`);

  const falsePositives = [];
  for (const ext of populated) {
    const reason = noInstructionReason(ext);
    if (reason !== null) {
      falsePositives.push(ext.id);
    }
  }
  assert.deepEqual(
    falsePositives,
    [],
    `these extensions have instructions but got a message: ${falsePositives}`,
  );
});

// ── All six Zvl*b entries get the VLEN message ───────────────────────────────

test('all Zvl*b extensions are recognised as VLEN parameters', () => {
  const vlenExts = allExtensions.filter((e) => /^Zvl\d+b$/.test(e.id));
  assert.ok(vlenExts.length >= 6, `expected at least 6 Zvl*b entries, got ${vlenExts.length}`);

  for (const ext of vlenExts) {
    const reason = noInstructionReason(ext);
    assert.ok(
      reason && reason.includes('VLEN'),
      `${ext.id} should get the VLEN message, got: ${reason}`,
    );
  }
});
