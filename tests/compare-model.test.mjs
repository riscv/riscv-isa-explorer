/**
 * Unit tests for src/compareModel.js — the aligned row model behind
 * side-by-side comparison.
 *
 * Pure-function tests against the real catalog. The catalog is the fixture
 * deliberately: the cases worth asserting (60 extensions carry no `state`,
 * SLLI differs between RV32I and RV64I) are properties of the real data, and a
 * hand-written fixture would drift away from them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  COMPARE_MAX,
  instructionKey,
  parseInstructionKey,
  normalizeCell,
  cellsAllSame,
  buildExtensionComparison,
  encodingBitDiff,
  buildInstructionComparison,
  buildComparePermalink,
  parseComparePermalink,
  toMarkdown,
  buildProfileComparison,
} from '../src/compareModel.js';

const here = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(readFileSync(join(here, '..', 'src', 'riscv_extensions.json'), 'utf8'));
const allExts = Object.values(catalog).flat().filter(Boolean);
const byId = (id) => allExts.find((e) => e.id === id);
const rowOf = (model, key) => model.rows.find((r) => r.key === key);

test('COMPARE_MAX is the documented cap', () => {
  assert.equal(COMPARE_MAX, 6);
});

test('instruction keys split on the first dot, because mnemonics contain dots', () => {
  assert.equal(instructionKey('Zba', 'ADD.UW'), 'Zba.ADD.UW');
  assert.deepEqual(parseInstructionKey('Zba.ADD.UW'), { extId: 'Zba', mnemonic: 'ADD.UW' });
  assert.deepEqual(parseInstructionKey('RV32I.SLLI'), { extId: 'RV32I', mnemonic: 'SLLI' });
});

test('a key with no mnemonic or no extension is not a key', () => {
  assert.equal(parseInstructionKey('SLLI'), null);
  assert.equal(parseInstructionKey('.SLLI'), null);
  assert.equal(parseInstructionKey('RV32I.'), null);
  assert.equal(parseInstructionKey(undefined), null);
});

test('absent normalizes to null and stays distinct from empty', () => {
  assert.equal(normalizeCell(undefined), null);
  assert.equal(normalizeCell(null), null);
  assert.notEqual(normalizeCell([]), null);
  assert.notEqual(normalizeCell(''), null);
});

test('arrays compare as sets, because list order is not meaningful', () => {
  assert.equal(normalizeCell(['bit', 'addr']), normalizeCell(['addr', 'bit']));
  assert.equal(cellsAllSame([['bit', 'addr'], ['addr', 'bit']]), true);
  assert.equal(cellsAllSame([['bit'], ['addr']]), false);
});

test('the sync-internal tags field is never shown as an attribute', () => {
  // `tags` routes riscv-opcodes instructions onto entries; it is not a property
  // of the extension. RV64E and RV128I both carry `rv64_i`, so displaying it
  // showed two different base ISAs with identical tags belonging to neither.
  const model = buildExtensionComparison([byId('RV64E'), byId('RV128I')]);
  assert.deepEqual(
    model.rows.filter((r) => /tag/i.test(r.key) || /tag/i.test(r.label)),
    [],
    'the comparison must not surface the tags routing key',
  );

  // Both entries do still carry the field, for the sync.
  assert.ok(byId('RV64E').tags.includes('rv64_i'));
});

test('a single column always agrees with itself', () => {
  assert.equal(cellsAllSame(['ratified']), true);
  assert.equal(cellsAllSame([]), true);
});

test('null is not equal to a present value', () => {
  assert.equal(cellsAllSame([null, 'ratified']), false);
  assert.equal(cellsAllSame([null, null]), true);
});

test('the extension model puts one cell per column, in column order', () => {
  const model = buildExtensionComparison([byId('Zba'), byId('Zbb'), byId('Zbc')]);
  assert.equal(model.kind, 'ext');
  assert.deepEqual(model.columns.map((c) => c.key), ['Zba', 'Zbb', 'Zbc']);
  assert.equal(model.bitDiff, null);
  for (const r of model.rows) {
    assert.equal(r.cells.length, 3, `row ${r.key} has ${r.cells.length} cells for 3 columns`);
  }
});

test('instruction counts differ across Zba, Zbb and Zbc and are flagged', () => {
  const model = buildExtensionComparison([byId('Zba'), byId('Zbb'), byId('Zbc')]);
  const counts = rowOf(model, 'instruction_count');
  assert.deepEqual(counts.cells, [
    Object.keys(byId('Zba').instructions).length,
    Object.keys(byId('Zbb').instructions).length,
    Object.keys(byId('Zbc').instructions).length,
  ]);
  assert.equal(counts.allSame, false);
});

test('comparing an extension with itself marks every row as agreeing', () => {
  const model = buildExtensionComparison([byId('Zba'), byId('Zba')]);
  assert.deepEqual(model.rows.filter((r) => !r.allSame).map((r) => r.key), []);
});

test('an extension with no state yields null, not a throw and not a blank', () => {
  const stateless = allExts.find((e) => e.state === undefined);
  assert.ok(stateless, 'expected at least one extension with no state');
  const model = buildExtensionComparison([stateless, byId('Zba')]);
  assert.equal(rowOf(model, 'state').cells[0], null);
  assert.equal(rowOf(model, 'state').allSame, false);
});

test('the dependency closure is exposed as a sorted chip row', () => {
  const model = buildExtensionComparison([byId('Zba'), byId('Zbb')]);
  const requires = rowOf(model, 'requires');
  assert.ok(requires, 'expected a requires row');
  for (const cell of requires.cells) {
    if (cell === null) continue;
    assert.deepEqual(cell, [...cell].sort(), 'closure should be sorted');
  }
});

test('every row declares a renderer the view knows', () => {
  const model = buildExtensionComparison([byId('Zba'), byId('Zbb')]);
  const known = new Set(['text', 'mono', 'chips', 'link', 'encoding']);
  for (const r of model.rows) {
    assert.ok(known.has(r.render), `row ${r.key} has unknown renderer ${r.render}`);
  }
});

const instrItem = (extId, mnemonic) => ({
  extId,
  mnemonic,
  instr: byId(extId).instructions[mnemonic],
});

test('SLLI differs between RV32I and RV64I at exactly bit 25', () => {
  // RV64 widens shamt by one bit, so bit 25 goes from a fixed 0 to part of a
  // variable field. This is the case the feature exists to make visible, and
  // the reason items are keyed by (extId, mnemonic) rather than by mnemonic.
  const model = buildInstructionComparison([instrItem('RV32I', 'SLLI'), instrItem('RV64I', 'SLLI')]);
  assert.ok(Array.isArray(model.bitDiff));
  assert.equal(model.bitDiff.length, 32);
  const differing = model.bitDiff.map((d, i) => (d ? 31 - i : null)).filter((b) => b !== null);
  assert.deepEqual(differing, [25]);
});

test('the instruction columns carry the mnemonic and its owning extension', () => {
  const model = buildInstructionComparison([instrItem('RV32I', 'SLLI'), instrItem('RV64I', 'SLLI')]);
  assert.equal(model.kind, 'instr');
  assert.deepEqual(model.columns, [
    { key: 'RV32I.SLLI', label: 'SLLI', sublabel: 'RV32I' },
    { key: 'RV64I.SLLI', label: 'SLLI', sublabel: 'RV64I' },
  ]);
  assert.equal(rowOf(model, 'owner').allSame, false);
  assert.equal(rowOf(model, 'encoding').allSame, false);
});

test('an instruction compared with itself has an all-false bit diff', () => {
  const model = buildInstructionComparison([instrItem('Zba', 'ADD.UW'), instrItem('Zba', 'ADD.UW')]);
  assert.deepEqual(model.bitDiff, new Array(32).fill(false));
  assert.deepEqual(model.rows.filter((r) => !r.allSame).map((r) => r.key), []);
});

test('a non-32-character encoding yields no bit diff rather than a wrong one', () => {
  assert.equal(encodingBitDiff(['0000', '0001']), null);
  assert.equal(encodingBitDiff(['0'.repeat(32), 'nonsense']), null);
  assert.equal(encodingBitDiff([]), null);
  assert.equal(encodingBitDiff(['0'.repeat(32)]), null, 'one encoding has nothing to differ from');
});

test('whitespace in an encoding does not shift the bit alignment', () => {
  const spaced = '0000000 ---------- 001 ----- 0010011';
  const plain = '0000000----------001-----0010011';
  assert.deepEqual(encodingBitDiff([spaced, plain]), new Array(32).fill(false));
});

test('deprecated reads as yes or no, never as absent', () => {
  const model = buildInstructionComparison([instrItem('Zba', 'ADD.UW'), instrItem('Zba', 'SH1ADD')]);
  for (const cell of rowOf(model, 'deprecated').cells) {
    assert.ok(cell === 'yes' || cell === 'no', `unexpected deprecated cell ${cell}`);
  }
});

test('items with no instruction record are dropped rather than rendered as holes', () => {
  const model = buildInstructionComparison([
    instrItem('Zba', 'ADD.UW'),
    { extId: 'Zba', mnemonic: 'NOPE', instr: undefined },
  ]);
  assert.equal(model.columns.length, 1);
});

test('an extension comparison round-trips through the permalink', () => {
  const encoded = buildComparePermalink('ext', ['Zba', 'Zbb', 'Zbc']);
  assert.equal(encoded, 'e:Zba,Zbb,Zbc');
  const parsed = parseComparePermalink(encoded, allExts);
  assert.equal(parsed.kind, 'ext');
  assert.deepEqual(parsed.resolved, ['Zba', 'Zbb', 'Zbc'], 'order must be preserved');
  assert.deepEqual(parsed.dropped, []);
  assert.deepEqual(parsed.overflow, []);
});

test('an instruction comparison round-trips, dots in mnemonics included', () => {
  const encoded = buildComparePermalink('instr', ['RV32I.SLLI', 'Zba.ADD.UW']);
  assert.equal(encoded, 'i:RV32I.SLLI,Zba.ADD.UW');
  const parsed = parseComparePermalink(encoded, allExts);
  assert.equal(parsed.kind, 'instr');
  assert.deepEqual(parsed.resolved, ['RV32I.SLLI', 'Zba.ADD.UW']);
});

test('an empty selection encodes to nothing rather than a bare prefix', () => {
  assert.equal(buildComparePermalink('ext', []), '');
  assert.equal(buildComparePermalink('instr', []), '');
  assert.equal(buildComparePermalink('nonsense', ['Zba']), '');
});

test('ids resolve case-insensitively but come back in catalog casing', () => {
  const parsed = parseComparePermalink('e:zba,ZBB', allExts);
  assert.deepEqual(parsed.resolved, ['Zba', 'Zbb']);
});

test('unknown ids are dropped and reported, never thrown', () => {
  const parsed = parseComparePermalink('e:Zba,Zqqq,Zbb', allExts);
  assert.deepEqual(parsed.resolved, ['Zba', 'Zbb']);
  assert.deepEqual(parsed.dropped, ['Zqqq']);
});

test('an instruction its named extension does not define is dropped', () => {
  const parsed = parseComparePermalink('i:RV32I.SLLI,Zba.SLLI', allExts);
  assert.deepEqual(parsed.resolved, ['RV32I.SLLI']);
  assert.deepEqual(parsed.dropped, ['Zba.SLLI']);
});

test('a missing or unknown kind prefix yields no kind and no throw', () => {
  for (const bad of ['Zba,Zbb', 'x:Zba', ':Zba', '']) {
    const parsed = parseComparePermalink(bad, allExts);
    assert.equal(parsed.kind, null, `expected no kind for ${JSON.stringify(bad)}`);
    assert.deepEqual(parsed.resolved, []);
  }
  assert.doesNotThrow(() => parseComparePermalink(undefined, allExts));
  assert.doesNotThrow(() => parseComparePermalink('e:Zba', undefined));
});

test('duplicates collapse without landing in resolved twice, dropped, or overflow', () => {
  const dup = parseComparePermalink('e:Zba,Zba,Zbb', allExts);
  assert.deepEqual(dup.resolved, ['Zba', 'Zbb']);
  assert.deepEqual(dup.dropped, []);
  assert.deepEqual(dup.overflow, []);
});

test('segments past COMPARE_MAX land in overflow, not dropped', () => {
  // Regression: these ids are real, resolvable catalog entries. Reporting
  // them as "not in the catalog" (the `dropped` message) would be false —
  // they were only bumped by the cap, which is a different fact.
  const ids = allExts.slice(0, COMPARE_MAX + 2).map((e) => e.id);
  const over = parseComparePermalink(`e:${ids.join(',')}`, allExts);
  assert.equal(over.resolved.length, COMPARE_MAX);
  assert.deepEqual(over.dropped, []);
  assert.equal(over.overflow.length, 2);
  assert.deepEqual(over.overflow, ids.slice(COMPARE_MAX));
});

test('unresolvable ids still land in dropped, not overflow', () => {
  const parsed = parseComparePermalink('e:Zba,Zqqq,Zbb', allExts);
  assert.deepEqual(parsed.dropped, ['Zqqq']);
  assert.deepEqual(parsed.overflow, []);
});

test('a mixed input of unresolvable ids and overflow populates both arrays correctly', () => {
  const ids = allExts.slice(0, COMPARE_MAX).map((e) => e.id);
  // Six resolvable ids fill the cap, then one bogus id (dropped) and one more
  // real, resolvable id (overflow) follow.
  const raw = `e:${ids.join(',')},Zqqq,${allExts[COMPARE_MAX].id}`;
  const parsed = parseComparePermalink(raw, allExts);
  assert.equal(parsed.resolved.length, COMPARE_MAX);
  assert.deepEqual(parsed.dropped, ['Zqqq']);
  assert.deepEqual(parsed.overflow, [allExts[COMPARE_MAX].id]);
});

test('the markdown export is a well-formed table with an attribute column', () => {
  const model = buildExtensionComparison([byId('Zba'), byId('Zbb')]);
  const lines = toMarkdown(model).split('\n');
  assert.ok(lines[0].startsWith('| Attribute |'), `header was ${lines[0]}`);
  assert.equal(lines[1], '| --- | --- | --- |');
  assert.equal(lines.length, model.rows.length + 2);
  for (const line of lines) {
    assert.equal((line.match(/(?<!\\)\|/g) || []).length, 4, `wrong cell count: ${line}`);
  }
});

test('differences-only drops the rows where everything agrees', () => {
  const model = buildExtensionComparison([byId('Zba'), byId('Zbb')]);
  const differing = model.rows.filter((r) => !r.allSame).length;
  assert.equal(toMarkdown(model, { differencesOnly: true }).split('\n').length, differing + 2);
});

test('an absent value renders as an em dash, not as blank', () => {
  const stateless = allExts.find((e) => e.state === undefined);
  const md = toMarkdown(buildExtensionComparison([stateless, byId('Zba')]));
  const stateLine = md.split('\n').find((l) => l.startsWith('| State |'));
  assert.ok(stateLine.includes('—'), `expected an em dash in: ${stateLine}`);
});

test('pipes in a value are escaped so the table survives', () => {
  const model = {
    kind: 'ext',
    columns: [
      { key: 'A', label: 'A', sublabel: null },
      { key: 'B', label: 'B', sublabel: null },
    ],
    rows: [
      { key: 'desc', label: 'Description', render: 'text', cells: ['a | b', 'c'], allSame: false },
    ],
    bitDiff: null,
  };
  const line = toMarkdown(model).split('\n')[2];
  assert.ok(line.includes('a \\| b'), `pipe was not escaped: ${line}`);
  assert.equal((line.match(/(?<!\\)\|/g) || []).length, 4);
});

test('a backslash before a pipe cannot smuggle in an extra column', () => {
  // The bug CodeQL caught: escaping the delimiter without escaping the escape
  // character. `a\|b` naively becomes `a\\|b` — Markdown reads that as a
  // literal backslash followed by an UNESCAPED pipe, so the cell quietly
  // splits the row. Both characters have to be escaped.
  const model = {
    kind: 'ext',
    columns: [
      { key: 'A', label: 'A', sublabel: null },
      { key: 'B', label: 'B', sublabel: null },
    ],
    rows: [
      {
        key: 'desc',
        label: 'Description',
        render: 'text',
        cells: ['a\\|b', 'plain'],
        allSame: false,
      },
    ],
    bitDiff: null,
  };
  const line = toMarkdown(model).split('\n')[2];
  assert.equal(
    (line.match(/(?<!\\)\|/g) || []).length,
    4,
    `a backslash-pipe pair broke the row into extra columns: ${line}`,
  );
  assert.ok(line.includes('a\\\\\\|b'), `backslash was not escaped: ${line}`);
});

test('a lone backslash survives the export', () => {
  const model = {
    kind: 'ext',
    columns: [{ key: 'A', label: 'A', sublabel: null }],
    rows: [
      { key: 'desc', label: 'Description', render: 'text', cells: ['C:\\\\path'], allSame: true },
    ],
    bitDiff: null,
  };
  const line = toMarkdown(model).split('\n')[2];
  assert.equal((line.match(/(?<!\\)\|/g) || []).length, 3, `row shape changed: ${line}`);
});

test('a newline inside a description does not break the row', () => {
  const model = {
    kind: 'ext',
    columns: [{ key: 'A', label: 'A', sublabel: null }],
    rows: [
      { key: 'desc', label: 'Description', render: 'text', cells: ['one\ntwo'], allSame: true },
    ],
    bitDiff: null,
  };
  assert.equal(toMarkdown(model).split('\n').length, 3);
});

test('an empty model exports nothing rather than a headerless table', () => {
  assert.equal(toMarkdown(buildExtensionComparison([])), '');
  assert.equal(toMarkdown(null), '');
});

// ---------------------------------------------------------------------------
// Profile comparison
// ---------------------------------------------------------------------------

import { PROFILES } from '../src/profiles.js';

test('the profile model has one row per extension across the union, sorted', () => {
  const model = buildProfileComparison(['RVA20', 'RVA22']);
  assert.equal(model.kind, 'profile');
  assert.deepEqual(model.columns.map((c) => c.key), ['RVA20', 'RVA22']);

  const union = [...new Set([...PROFILES.RVA20, ...PROFILES.RVA22])].sort();
  const presenceRows = model.rows.filter((r) => r.render === 'presence');
  assert.deepEqual(presenceRows.map((r) => r.label), union);
});

test('a summary row reports each profile\'s extension count', () => {
  const model = buildProfileComparison(['RVA20', 'RVA22']);
  const counts = model.rows.find((r) => r.key === 'extension_count');
  assert.ok(counts, 'expected an extension_count row');
  assert.deepEqual(counts.cells, [PROFILES.RVA20.length, PROFILES.RVA22.length]);
  assert.equal(counts.allSame, false, 'RVA20 and RVA22 list different numbers');
});

test('an extension in every profile is dimmed, one that differs is not', () => {
  const model = buildProfileComparison(['RVA20', 'RVA22']);
  const rowFor = (id) => model.rows.find((r) => r.render === 'presence' && r.label === id);

  // RV64I is mandatory in both.
  assert.equal(rowFor('RV64I').allSame, true);
  assert.deepEqual(rowFor('RV64I').cells, [true, true]);

  // Zba arrived with RVA22.
  const added = PROFILES.RVA22.filter((id) => !PROFILES.RVA20.includes(id));
  assert.ok(added.length > 0, 'expected RVA22 to add something over RVA20');
  const row = rowFor(added[0]);
  assert.equal(row.allSame, false);
  assert.deepEqual(row.cells, [false, true]);
});

test('comparing a profile with itself marks every row as agreeing', () => {
  const model = buildProfileComparison(['RVA23', 'RVA23']);
  assert.deepEqual(model.rows.filter((r) => !r.allSame).map((r) => r.key), []);
});

test('expanding dependencies widens the union and never narrows it', () => {
  const literal = buildProfileComparison(['RVA20', 'RVA22']);
  const expanded = buildProfileComparison(['RVA20', 'RVA22'], { expandDependencies: true });

  const ids = (m) => m.rows.filter((r) => r.render === 'presence').map((r) => r.label);
  const literalIds = new Set(ids(literal));
  for (const id of literalIds) {
    assert.ok(ids(expanded).includes(id), `${id} vanished when dependencies were expanded`);
  }
  assert.ok(
    ids(expanded).length >= literalIds.size,
    'expansion should not produce fewer extensions than the spec lists',
  );
  assert.equal(expanded.expandedDependencies, true);
  assert.equal(literal.expandedDependencies, false);
});

test('an unknown profile name is skipped rather than throwing', () => {
  assert.doesNotThrow(() => buildProfileComparison(['RVA20', 'NOPE']));
  const model = buildProfileComparison(['RVA20', 'NOPE']);
  assert.deepEqual(model.columns.map((c) => c.key), ['RVA20']);
  assert.equal(buildProfileComparison([]).columns.length, 0);
  assert.doesNotThrow(() => buildProfileComparison(undefined));
});

test('a profile comparison round-trips through the permalink', () => {
  const encoded = buildComparePermalink('profile', ['RVA22', 'RVA23']);
  assert.equal(encoded, 'p:RVA22,RVA23');
  const parsed = parseComparePermalink(encoded, allExts);
  assert.equal(parsed.kind, 'profile');
  assert.deepEqual(parsed.resolved, ['RVA22', 'RVA23']);
  assert.deepEqual(parsed.dropped, []);
});

test('minor profile names with dots round-trip through the permalink', () => {
  const encoded = buildComparePermalink('profile', ['RVA23.1', 'RVB23.1']);
  assert.equal(encoded, 'p:RVA23.1,RVB23.1');
  const parsed = parseComparePermalink(encoded, allExts);
  assert.deepEqual(parsed.resolved, ['RVA23.1', 'RVB23.1']);
  assert.deepEqual(parsed.dropped, []);
});

test('profile names resolve case-insensitively and unknown ones are dropped', () => {
  const parsed = parseComparePermalink('p:rva22,NOPE,RVB23', allExts);
  assert.deepEqual(parsed.resolved, ['RVA22', 'RVB23']);
  assert.deepEqual(parsed.dropped, ['NOPE']);
});

test('markdown renders presence as a check or a dash, never as true/false', () => {
  const md = toMarkdown(buildProfileComparison(['RVA20', 'RVA22']));
  const line = md.split('\n').find((l) => l.startsWith('| RV64I |'));
  assert.ok(line, 'expected an RV64I row in the export');
  assert.ok(!/true|false/.test(line), `presence leaked a boolean: ${line}`);
  assert.ok(line.includes('\u2713'), `expected a check mark in: ${line}`);
});
