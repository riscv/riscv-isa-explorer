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
  assert.ok(
    reason.includes('currently available in this catalogue'),
    `message should be catalogue-scoped, got: ${reason}`,
  );
});

test('behavioral extensions get a behavior message', () => {
  const sv39 = allExtensions.find((e) => e.id === 'Sv39');
  assert.ok(sv39, 'Sv39 must exist in catalog');
  assert.ok(sv39.behavior, 'Sv39 must have a behavior field');
  const reason = noInstructionReason(sv39);
  assert.ok(reason, 'should return a non-empty string');
  assert.ok(
    reason.includes('a behavior description is available below'),
    `message should mention that a behavior description is available below, got: ${reason}`,
  );
  assert.ok(
    reason.includes('currently available in this catalogue'),
    `message should be catalogue-scoped, got: ${reason}`,
  );
});

test('behavioral extensions have non-empty behavior descriptions', () => {
  const sv39 = allExtensions.find((e) => e.id === 'Sv39');
  assert.ok(sv39.behavior, 'Sv39 must have a behavior field');
  assert.equal(typeof sv39.behavior, 'string');
  assert.equal(sv39.behavior, '39-bit virtual address translation (3 level)');

  const behavioralExts = allExtensions.filter((e) => Boolean(e.behavior));
  assert.ok(behavioralExts.length > 0, 'expected behavioral extensions in catalogue');
  for (const ext of behavioralExts) {
    assert.equal(typeof ext.behavior, 'string');
    assert.ok(ext.behavior.trim().length > 0, `${ext.id} must have non-empty behavior`);
  }
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
  assert.ok(
    reason.includes('currently available in this catalogue'),
    `message should be catalogue-scoped, got: ${reason}`,
  );
  assert.ok(
    reason.includes('touches 2 control/status registers (listed below)'),
    `message should use accurate touches wording, got: ${reason}`,
  );
  assert.ok(
    !reason.includes('defines'),
    `message should not claim extension defines registers, got: ${reason}`,
  );
});

test('Svpbmt, Svadu and Sstc do not claim to define registers', () => {
  for (const id of ['Svpbmt', 'Svadu', 'Sstc']) {
    const ext = allExtensions.find((e) => e.id === id);
    assert.ok(ext, `${id} must exist in catalog`);
    const count = Object.keys(ext.csrs || {}).length;
    assert.ok(count > 0, `${id} must have CSRs`);
    const reason = noInstructionReason(ext);
    assert.ok(reason, `${id} should return a non-empty string`);
    assert.ok(
      !reason.includes('defines'),
      `${id} must not claim to define registers, got: ${reason}`,
    );
    assert.ok(
      reason.includes(`touches ${count} control/status register`),
      `${id} should use touches wording with accurate count, got: ${reason}`,
    );
    assert.ok(
      reason.includes('(listed below)'),
      `${id} should note registers are listed below, got: ${reason}`,
    );
    assert.ok(
      reason.includes('currently available in this catalogue'),
      `${id} should use catalogue-scoped wording, got: ${reason}`,
    );
  }
});

test('CSR message uses singular form when exactly 1 CSR is touched', () => {
  const single = { id: 'Xsingle', instructions: {}, csrs: { my_csr: {} } };
  const reason = noInstructionReason(single);
  assert.equal(
    reason,
    'No instruction encodings are currently available in this catalogue; this extension touches 1 control/status register (listed below).',
  );
});

test('CSR message uses plural form when multiple CSRs are touched', () => {
  const multi = { id: 'Xmulti', instructions: {}, csrs: { csr1: {}, csr2: {}, csr3: {} } };
  const reason = noInstructionReason(multi);
  assert.equal(
    reason,
    'No instruction encodings are currently available in this catalogue; this extension touches 3 control/status registers (listed below).',
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
    assert.ok(
      reason.includes('control/status registers'),
      `message should mention control/status registers, got: ${reason}`,
    );
    assert.ok(
      reason.includes('currently available in this catalogue'),
      `message should be catalogue-scoped, got: ${reason}`,
    );
    return;
  }
  const reason = noInstructionReason(both);
  assert.ok(reason, 'should return a non-empty string');
  assert.ok(
    reason.includes('control/status registers'),
    `message should mention control/status registers, got: ${reason}`,
  );
  assert.ok(
    reason.includes('currently available in this catalogue'),
    `message should be catalogue-scoped, got: ${reason}`,
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
  assert.equal(
    reason,
    'No instruction encodings are currently available in this catalogue.',
  );
  assert.ok(
    !reason.includes('This extension defines no instruction encodings'),
    'generic message must not claim extension itself defines no instructions',
  );
});

test('RV128I regression: empty instructions map gets catalogue-scoped explanation', () => {
  const rv128i = allExtensions.find((e) => e.id === 'RV128I');
  assert.ok(rv128i, 'RV128I must exist in catalog');
  assert.equal(
    Object.keys(rv128i.instructions || {}).length,
    0,
    'RV128I instruction map must be empty in catalogue',
  );
  const reason = noInstructionReason(rv128i);
  assert.ok(reason, 'should return a non-empty string');
  assert.ok(
    reason.includes('currently available in this catalogue'),
    `message should be catalogue-scoped, got: ${reason}`,
  );
  assert.ok(
    !reason.includes('This extension defines no instruction encodings'),
    `message must not claim the extension defines no instructions, got: ${reason}`,
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
  const uncatalogueScoped = [];
  const overlyBroadClaims = [];
  for (const ext of empty) {
    const reason = noInstructionReason(ext);
    if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
      failures.push(ext.id);
    }
    if (reason && !reason.includes('currently available in this catalogue')) {
      uncatalogueScoped.push(ext.id);
    }
    if (
      reason &&
      (reason.includes('This extension defines no instruction encodings') ||
        /defines \d+ control\/status register/.test(reason))
    ) {
      overlyBroadClaims.push(ext.id);
    }
  }
  assert.deepEqual(failures, [], `these zero-instruction extensions got no message: ${failures}`);
  assert.deepEqual(
    uncatalogueScoped,
    [],
    `these zero-instruction extensions lack catalogue-scoped wording: ${uncatalogueScoped}`,
  );
  assert.deepEqual(
    overlyBroadClaims,
    [],
    `these zero-instruction extensions contain overly broad claims: ${overlyBroadClaims}`,
  );
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
