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
import { noInstructionReason, cleanBehaviorText } from '../src/extensionNotes.js';

const here = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(readFileSync(join(here, '..', 'src', 'riscv_extensions.json'), 'utf8'));
const allExtensions = Object.values(catalog).flat().filter(Boolean);

// ── cleanBehaviorText helper ─────────────────────────────────────────────────

test('cleanBehaviorText returns empty string for non-string input', () => {
  assert.equal(cleanBehaviorText(null), '');
  assert.equal(cleanBehaviorText(undefined), '');
  assert.equal(cleanBehaviorText(123), '');
  assert.equal(cleanBehaviorText({}), '');
  assert.equal(cleanBehaviorText([]), '');
});

test('cleanBehaviorText returns empty string for whitespace-only input', () => {
  assert.equal(cleanBehaviorText(''), '');
  assert.equal(cleanBehaviorText('   '), '');
  assert.equal(cleanBehaviorText('\n\n'), '');
  assert.equal(cleanBehaviorText('\t  \n  '), '');
});

test('cleanBehaviorText returns text unchanged when no NOTE marker is present', () => {
  const text = 'This extension provides memory protection.';
  assert.equal(cleanBehaviorText(text), text);
});

test('cleanBehaviorText removes block-style NOTE delimited by equal signs', () => {
  const text =
    'Main text here.\n[NOTE]\n====\nThis is a note.\nMore note content.\n====\nText after note.';
  const expected = 'Main text here. Text after note.';
  assert.equal(cleanBehaviorText(text), expected);
});

test('cleanBehaviorText removes inline-style NOTE that runs to paragraph break', () => {
  const text = 'Main text here.\n[NOTE]\nThis is a note.\nMore note content.\n\nText after note.';
  const expected = 'Main text here.\n\nText after note.';
  assert.equal(cleanBehaviorText(text), expected);
});

test('cleanBehaviorText removes text when it begins with NOTE', () => {
  const text = '[NOTE]\n====\nOnly a note here.\n====';
  assert.equal(cleanBehaviorText(text), '');
});

test('cleanBehaviorText removes NOTE content up to paragraph break, preserving text after', () => {
  const text = 'Important behavior.\n[NOTE]\nFirst note content.\n\nMore text after note.';
  // Inline NOTE is removed up to paragraph break; text after break is preserved
  const expected = 'Important behavior.\n\nMore text after note.';
  assert.equal(cleanBehaviorText(text), expected);
});

test('cleanBehaviorText trims whitespace from result', () => {
  const text = '  \n  Main text.  \n[NOTE]\nNote content.\n\n  ';
  assert.equal(cleanBehaviorText(text), 'Main text.');
});

test('cleanBehaviorText joins source line wraps and keeps paragraph breaks', () => {
  // UDB wraps its AsciiDoc at about 80 columns (Svbare: "must\nbe supported").
  const text =
    'This extension mandates that the satp mode Bare must\nbe supported.\n\nSecond\n  paragraph.';
  assert.equal(
    cleanBehaviorText(text),
    'This extension mandates that the satp mode Bare must be supported.\n\nSecond paragraph.',
  );
});

test('cleanBehaviorText reduces inline formatting and list markers to text', () => {
  assert.equal(
    cleanBehaviorText('`stvec.MODE` must hold 0, and hardware does *not* update **A/D**.'),
    'stvec.MODE must hold 0, and hardware does not update A/D.',
  );
  assert.equal(
    cleanBehaviorText(
      '*Sha* comprises:\n\n** *H* The hypervisor extension.\n\n** *Ssstateen* The\n   state-enable view.',
    ),
    'Sha comprises:\n\n• H The hypervisor extension.\n\n• Ssstateen The state-enable view.',
  );
});

test('every behavior text the panel shows reads as prose', () => {
  // The panel shows cleanBehaviorText for zero-instruction extensions, and the
  // message promises it ("its behavior is described below").
  const leftovers = [];
  const missing = [];
  for (const ext of allExtensions) {
    const reason = noInstructionReason(ext);
    if (!reason) continue;
    const text = cleanBehaviorText(ext.behavior);
    // A bare * is arithmetic (Sstvecv: "stvec.BASE + 4 * cause"), not markup.
    if (/`|\*[^\s*][^*]*\*|(^|[^\n])\n(?!\n)/.test(text)) leftovers.push(ext.id);
    if (
      reason.includes('described below') &&
      (!text || text === ext.desc?.trim() || text === ext.use?.trim())
    ) {
      missing.push(ext.id);
    }
  }
  assert.deepEqual(leftovers, [], `markup or a source line wrap left in: ${leftovers}`);
  assert.deepEqual(missing, [], `"described below" with nothing shown: ${missing}`);
});

// ── Null for extensions with instructions ────────────────────────────────────

test('returns null for extensions that have instructions', () => {
  const zba = allExtensions.find((e) => e.id === 'Zba');
  assert.ok(zba, 'Zba must exist in catalog');
  assert.ok(Object.keys(zba.instructions).length > 0, 'Zba must have instructions');
  assert.equal(noInstructionReason(zba), null);
});

test('returns null when ext is missing', () => {
  assert.equal(noInstructionReason(null), null);
  assert.equal(noInstructionReason(undefined), null);
});

// ── Ratified extensions: definitive wording ──────────────────────────────────

test('ratified extensions without instructions use definitive wording', () => {
  const ext = { id: 'Xtest', state: 'ratified', instructions: {} };
  const reason = noInstructionReason(ext);
  assert.ok(reason.startsWith('This extension adds no instructions'));
});

test('VLEN parameter extensions get a VLEN-specific message', () => {
  const zvl128b = allExtensions.find((e) => e.id === 'Zvl128b');
  assert.ok(zvl128b, 'Zvl128b must exist in catalog');
  const reason = noInstructionReason(zvl128b);
  assert.ok(reason, 'should return a non-empty string');
  assert.ok(reason.includes('VLEN'), `message should mention VLEN, got: ${reason}`);
  assert.ok(
    reason.includes('vector length'),
    `message should mention vector length, got: ${reason}`,
  );
  assert.ok(
    reason.startsWith('This extension adds no instructions'),
    `ratified VLEN extensions should use definitive wording, got: ${reason}`,
  );
});

test('behavioral extensions get a behavior message', () => {
  const sv39 = allExtensions.find((e) => e.id === 'Sv39');
  assert.ok(sv39, 'Sv39 must exist in catalog');
  assert.ok(sv39.behavior, 'Sv39 must have a behavior field');
  const reason = noInstructionReason(sv39);
  assert.ok(reason, 'should return a non-empty string');
  assert.ok(
    reason.includes('behavior is described below'),
    `message should note behavior description, got: ${reason}`,
  );
});

// ── CSR wording: "touches", with count, never "defines" ──────────────────────

test('Svpbmt, Svadu and Sstc say "touches" with count and (listed below)', () => {
  for (const id of ['Svpbmt', 'Svadu', 'Sstc']) {
    const ext = allExtensions.find((e) => e.id === id);
    assert.ok(ext, `${id} must exist in catalog`);
    const count = Object.keys(ext.csrs || {}).length;
    assert.ok(count > 0, `${id} must have CSRs`);
    const reason = noInstructionReason(ext);
    assert.ok(reason, `${id} should return a non-empty string`);
    assert.ok(!reason.includes('defines'), `${id} must not say "defines", got: ${reason}`);
    assert.ok(
      reason.includes(`touches ${count} control/status register`),
      `${id} should use touches wording with accurate count, got: ${reason}`,
    );
    assert.ok(
      reason.includes('(listed below)'),
      `${id} should note registers are listed below, got: ${reason}`,
    );
    assert.ok(
      reason.startsWith('This extension adds no instructions'),
      `${id} should use definitive wording (ratified), got: ${reason}`,
    );
  }
});

test('CSR message uses singular form when exactly 1 CSR is touched', () => {
  const single = { id: 'Xsingle', state: 'ratified', instructions: {}, csrs: { my_csr: {} } };
  const reason = noInstructionReason(single);
  assert.equal(
    reason,
    'This extension adds no instructions; it touches 1 control/status register (listed below).',
  );
});

test('CSR message uses plural form when multiple CSRs are touched', () => {
  const multi = {
    id: 'Xmulti',
    state: 'ratified',
    instructions: {},
    csrs: { csr1: {}, csr2: {}, csr3: {} },
  };
  const reason = noInstructionReason(multi);
  assert.equal(
    reason,
    'This extension adds no instructions; it touches 3 control/status registers (listed below).',
  );
});

test('extensions with both CSRs and behavior get a combined message', () => {
  const both = allExtensions.find(
    (e) =>
      Object.keys(e.instructions || {}).length === 0 &&
      Object.keys(e.csrs || {}).length > 0 &&
      e.behavior &&
      e.state === 'ratified',
  );
  if (!both) {
    // If no such extension currently exists, test with a synthetic entry.
    const synthetic = {
      id: 'Xtest',
      state: 'ratified',
      instructions: {},
      csrs: { mstatus: {} },
      behavior: 'test',
    };
    const reason = noInstructionReason(synthetic);
    assert.ok(
      reason.includes('control/status register'),
      `message should mention control/status registers, got: ${reason}`,
    );
    assert.ok(
      reason.includes('behavior is described below'),
      `message should mention behavior, got: ${reason}`,
    );
    return;
  }
  const reason = noInstructionReason(both);
  assert.ok(reason, 'should return a non-empty string');
  assert.ok(
    reason.includes('control/status register'),
    `message should mention control/status registers, got: ${reason}`,
  );
  assert.ok(
    reason.includes('behavior is described below'),
    `message should mention behavior, got: ${reason}`,
  );
});

// ── Draft, unclassified, and missing-state extensions ────────────────────────

test('draft extensions use hedged wording', () => {
  const rv128i = allExtensions.find((e) => e.id === 'RV128I');
  assert.ok(rv128i, 'RV128I must exist in catalog');
  assert.equal(rv128i.state, 'draft', 'RV128I must be draft');
  const reason = noInstructionReason(rv128i);
  assert.equal(reason, 'No instruction encodings are listed for this extension yet.');
});

test('unclassified (missing state) extensions use hedged wording', () => {
  const ext = { id: 'Xnostate', instructions: {} };
  const reason = noInstructionReason(ext);
  assert.equal(reason, 'No instruction encodings are listed for this extension yet.');
});

test('development-state extensions use hedged wording', () => {
  const ext = { id: 'Xdev', state: 'development', instructions: {} };
  const reason = noInstructionReason(ext);
  assert.equal(reason, 'No instruction encodings are listed for this extension yet.');
});

test('frozen-state extensions use hedged wording', () => {
  const ext = { id: 'Xfrozen', state: 'frozen', instructions: {} };
  const reason = noInstructionReason(ext);
  assert.equal(reason, 'No instruction encodings are listed for this extension yet.');
});

// ── Regression coverage for representative entries ───────────────────────────

test('Sv39 regression: ratified, behavior only, no CSRs', () => {
  const sv39 = allExtensions.find((e) => e.id === 'Sv39');
  assert.ok(sv39, 'Sv39 must exist');
  assert.equal(sv39.state, 'ratified');
  assert.ok(sv39.behavior);
  assert.equal(Object.keys(sv39.csrs || {}).length, 0);
  assert.equal(Object.keys(sv39.instructions || {}).length, 0);
  const reason = noInstructionReason(sv39);
  assert.ok(reason.includes('behavior is described below'), `got: ${reason}`);
});

test('Svpbmt regression: ratified, CSRs, no behavior', () => {
  const ext = allExtensions.find((e) => e.id === 'Svpbmt');
  assert.ok(ext);
  assert.equal(ext.state, 'ratified');
  const csrCount = Object.keys(ext.csrs || {}).length;
  assert.ok(csrCount > 0);
  const reason = noInstructionReason(ext);
  assert.ok(reason.includes(`touches ${csrCount} control/status register`), `got: ${reason}`);
});

test('RV128I regression: draft, no instructions gets hedged wording', () => {
  const rv128i = allExtensions.find((e) => e.id === 'RV128I');
  assert.ok(rv128i, 'RV128I must exist in catalog');
  assert.equal(Object.keys(rv128i.instructions || {}).length, 0);
  const reason = noInstructionReason(rv128i);
  assert.equal(reason, 'No instruction encodings are listed for this extension yet.');
});

// ── Generic fallback ─────────────────────────────────────────────────────────

test('generic fallback for ratified extensions with no signals', () => {
  const zkt = allExtensions.find((e) => e.id === 'Zkt');
  assert.ok(zkt, 'Zkt must exist in catalog');
  assert.equal(Object.keys(zkt.instructions || {}).length, 0, 'Zkt must have no instructions');
  assert.ok(!zkt.behavior, 'Zkt should not have a behavior field');
  assert.equal(Object.keys(zkt.csrs || {}).length, 0, 'Zkt should have no CSRs');
  if (zkt.state === 'ratified') {
    assert.equal(noInstructionReason(zkt), 'This extension adds no instructions.');
  } else {
    assert.equal(
      noInstructionReason(zkt),
      'No instruction encodings are listed for this extension yet.',
    );
  }
});

// ── Purity ───────────────────────────────────────────────────────────────────

test('the helper is a pure function of the extension object', () => {
  const ext = { id: 'Zvl64b', state: 'ratified', instructions: {}, csrs: {} };
  const first = noInstructionReason(ext);
  const second = noInstructionReason(ext);
  assert.equal(first, second);
});

// ── All Zvl*b entries get the VLEN message ───────────────────────────────────

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

// ── Catalogue sweep: ratified-versus-not-yet-mapped wording split ────────────

test('every zero-instruction extension produces a non-empty message with correct wording split', () => {
  const empty = allExtensions.filter((e) => Object.keys(e.instructions || {}).length === 0);
  assert.ok(empty.length > 100, `expected 100+ zero-instruction extensions, got ${empty.length}`);

  const failures = [];
  const wrongWordingRatified = [];
  const wrongWordingNotRatified = [];
  const overlyBroadClaims = [];
  for (const ext of empty) {
    const reason = noInstructionReason(ext);
    if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
      failures.push(ext.id);
      continue;
    }
    const isRatified = ext.state === 'ratified';
    if (isRatified && !reason.startsWith('This extension adds no instructions')) {
      wrongWordingRatified.push(ext.id);
    }
    if (!isRatified && reason !== 'No instruction encodings are listed for this extension yet.') {
      wrongWordingNotRatified.push(ext.id);
    }
    if (/defines \d+ control\/status register/.test(reason)) {
      overlyBroadClaims.push(ext.id);
    }
  }
  assert.deepEqual(failures, [], `these zero-instruction extensions got no message: ${failures}`);
  assert.deepEqual(
    wrongWordingRatified,
    [],
    `ratified extensions should use definitive wording: ${wrongWordingRatified}`,
  );
  assert.deepEqual(
    wrongWordingNotRatified,
    [],
    `non-ratified extensions should use hedged wording: ${wrongWordingNotRatified}`,
  );
  assert.deepEqual(
    overlyBroadClaims,
    [],
    `no extension should say "defines N control/status registers": ${overlyBroadClaims}`,
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
