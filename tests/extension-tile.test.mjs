/**
 * The tile's render behaviour, tested without a DOM.
 *
 * A user reported selections taking "seconds to minutes" on Chrome under macOS.
 * The cause was ExtensionBlock being defined inside RISCVExplorer's render body:
 * a new function reference every render, so React saw a new component type and
 * unmounted and rebuilt all 227 tiles instead of updating them. Confirmed in the
 * browser first, by checking whether tile DOM nodes were reused after a click.
 *
 * There is no DOM or React testing library here, and adding one would be a large
 * dependency for a small surface. Two things are testable as they stand, and
 * between them they cover the regression:
 *
 *   1. tilePropsAreEqual is a pure function and carries the whole optimisation.
 *   2. Whether a component is declared inside another is a property of the
 *      source, so it can be asserted by reading the file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tilePropsAreEqual } from '../src/tileMemo.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');

const baseProps = (over = {}) => ({
  data: { id: 'Zfa', name: 'Zfa', desc: 'Additional FP Instructions' },
  colorClass: 'border-blue-900/60',
  matchesSearch: false,
  selectedExtId: null,
  workspaceIds: new Set(),
  lockedExtensions: new Map(),
  compareIds: new Set(),
  builderMode: false,
  isHighlighted: () => false,
  isDimmed: () => false,
  onSelect: () => {},
  onToggleWorkspace: () => {},
  onToggleCompare: () => {},
  ...over,
});

test('identical props skip the re-render', () => {
  const a = baseProps();
  assert.equal(tilePropsAreEqual(a, { ...a }), true);
});

test('a new Set with the same membership still skips', () => {
  // The heart of it. workspaceIds is rebuilt on every change, so comparing it
  // by identity would re-render all 227 tiles whenever any one of them moved.
  const prev = baseProps({ workspaceIds: new Set(['D', 'F']) });
  const next = baseProps({ ...prev, workspaceIds: new Set(['D', 'F']) });
  assert.notEqual(prev.workspaceIds, next.workspaceIds, 'the Sets must be different objects');
  assert.equal(tilePropsAreEqual(prev, next), true, 'same membership should not re-render');
});

test('a tile re-renders when its own membership changes', () => {
  const prev = baseProps({ workspaceIds: new Set() });
  const next = baseProps({ ...prev, workspaceIds: new Set(['Zfa']) });
  assert.equal(tilePropsAreEqual(prev, next), false);
});

test('a tile does NOT re-render when a different tile changes', () => {
  // Selecting D must not repaint Zfa. This is what turns one click from 227
  // renders into one.
  const prev = baseProps({ workspaceIds: new Set(['F']) });
  const next = baseProps({ ...prev, workspaceIds: new Set(['F', 'D']) });
  assert.equal(tilePropsAreEqual(prev, next), true);
});

test('lock state and its reason are both tracked', () => {
  const unlocked = baseProps({ lockedExtensions: new Map() });
  const locked = baseProps({ ...unlocked, lockedExtensions: new Map([['Zfa', ['Q']]]) });
  assert.equal(tilePropsAreEqual(unlocked, locked), false, 'becoming locked must re-render');

  // The tooltip names who requires it, so the reason changing is user-visible
  // even though the locked flag itself did not move.
  const lockedByTwo = baseProps({ ...unlocked, lockedExtensions: new Map([['Zfa', ['Q', 'D']]]) });
  assert.equal(tilePropsAreEqual(locked, lockedByTwo), false, 'a changed reason must re-render');
});

test('everything the tile displays forces a re-render when it changes', () => {
  const base = baseProps();
  const changes = {
    data: { id: 'Zfa', name: 'Zfa', desc: 'changed' },
    colorClass: 'border-red-900',
    matchesSearch: true,
    selectedExtId: 'Zfa',
    builderMode: true,
    isHighlighted: () => true,
    isDimmed: () => true,
    onSelect: () => {},
    onToggleWorkspace: () => {},
  };
  for (const [key, value] of Object.entries(changes)) {
    /*
     * Spread the SAME base rather than calling baseProps() again. baseProps()
     * mints fresh arrow functions and Sets each call, so comparing two of its
     * results differed on five identities at once: the comparator returned
     * false whatever key was overridden, and this loop passed for any key at
     * all, including one that does not exist. Holding every other reference
     * fixed is what makes each iteration actually test its own key.
     */
    assert.equal(
      tilePropsAreEqual(base, { ...base, [key]: value }),
      false,
      `${key} changed but the tile would not re-render`,
    );
  }
});

test('the loop above can fail: an ignored prop does not force a re-render', () => {
  // Guards the fixture itself. If baseProps() ever goes back to minting fresh
  // references, this is the test that catches it, because a prop the
  // comparator does not read must still be skippable.
  const base = baseProps();
  assert.equal(tilePropsAreEqual(base, { ...base, somethingUnread: 'changed' }), true);
});

test('typing does not re-render a tile whose match state is unchanged', () => {
  // The point of passing matchesSearch instead of searchQuery: two different
  // queries that both miss this tile must not repaint it.
  const base = baseProps({ matchesSearch: false });
  assert.equal(tilePropsAreEqual(base, { ...base }), true);

  const hit = baseProps({ matchesSearch: true });
  assert.equal(tilePropsAreEqual(base, { ...base, matchesSearch: true }), false);
  assert.equal(tilePropsAreEqual(hit, { ...hit, matchesSearch: true }), true);
});

test('no component is declared inside another component', () => {
  // The original defect, as a property of the source. A capitalised arrow
  // function or function declaration indented inside another component body is
  // a new type on every render, which remounts its whole subtree.
  const offenders = [];
  for (const file of fs.readdirSync(srcDir).filter((f) => /\.jsx?$/.test(f))) {
    const lines = fs.readFileSync(path.join(srcDir, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const m = line.match(
        /^\s+(?:const|let|function)\s+([A-Z][A-Za-z0-9]*)\s*(?:=\s*(?:React\.)?(?:memo\()?\(?[^)]*\)?\s*=>|\()/,
      );
      if (!m) return;
      // A memoised or hook-wrapped binding keeps a stable identity, so it is fine.
      if (/React\.(memo|useMemo|useCallback)/.test(line)) return;
      offenders.push(`${file}:${i + 1}  ${m[1]}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    'components must live at module scope, or React remounts their subtree every render:\n  ' +
      offenders.join('\n  '),
  );
});

test('EncodingDiagram lives in its own module, not in the visualizer', () => {
  // It has two consumers now — the instruction detail panel and the comparison
  // view. A component defined inside one consumer's file is not shared, it is
  // borrowed. Same reasoning that moved the tile out.
  const visualizer = fs.readFileSync(path.join(srcDir, 'risc_v_visualizer.jsx'), 'utf8');
  assert.ok(
    !/^const EncodingDiagram = /m.test(visualizer),
    'EncodingDiagram is still declared inside risc_v_visualizer.jsx',
  );
  assert.ok(
    /import EncodingDiagram from '\.\/EncodingDiagram\.jsx'/.test(visualizer),
    'risc_v_visualizer.jsx should import EncodingDiagram',
  );

  const diagram = fs.readFileSync(path.join(srcDir, 'EncodingDiagram.jsx'), 'utf8');
  assert.ok(/export default function EncodingDiagram/.test(diagram), 'no default export');
  assert.ok(/diffMask/.test(diagram), 'the diff mask prop is missing');
});

test('a new compareIds Set with the same membership still skips', () => {
  // Same reasoning as workspaceIds: the Set is rebuilt on every pin, so an
  // identity compare would re-render all 227 tiles each time one is pinned.
  const prev = baseProps({ compareIds: new Set(['Zba', 'Zbb']) });
  const next = baseProps({ ...prev, compareIds: new Set(['Zba', 'Zbb']) });
  assert.notEqual(prev.compareIds, next.compareIds, 'the Sets must be different objects');
  assert.equal(tilePropsAreEqual(prev, next), true);
});

test('a tile re-renders when its own compare membership changes', () => {
  const prev = baseProps({ compareIds: new Set() });
  const next = baseProps({ ...prev, compareIds: new Set(['Zfa']) });
  assert.equal(tilePropsAreEqual(prev, next), false);
});

test('pinning a different extension does not re-render this tile', () => {
  const prev = baseProps({ compareIds: new Set() });
  const next = baseProps({ ...prev, compareIds: new Set(['Zba']) });
  assert.equal(
    tilePropsAreEqual(prev, next),
    true,
    'baseProps is Zfa, so Zba is none of its business',
  );
});

test('an unstable onToggleCompare re-renders, which is why it must be memoised', () => {
  const prev = baseProps();
  const next = baseProps({ ...prev, onToggleCompare: () => {} });
  assert.equal(tilePropsAreEqual(prev, next), false);
});
