/**
 * Profile gap check (src/profileGap.js, #583): what a builder configuration
 * lacks for a profile. Checked against the real profiles and graph, because
 * the failure that matters is a gap list that disagrees with the profile
 * highlight and download, which classify through the same profileMembership().
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { profileGap } from '../src/profileGap.js';
import { profileMembership } from '../src/profileExport.js';
import { PROFILES } from '../src/profiles.js';
import { closure, conditionallyImplied, resolveSelection } from '../src/isaGraph.js';
import { BASE_ISA_IDS } from '../src/marchUtils.js';

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const OPTIONAL = read('../src/profile-optional.json');
const KNOWN = new Set(
  Object.values(read('../src/riscv_extensions.json'))
    .flat()
    .map((e) => e.id),
);

// What the builder holds: the resolved closure, catalogue ids only.
const configOf = (selected) => {
  const base = selected.find((id) => BASE_ISA_IDS.has(id)) ?? null;
  return resolveSelection({ selected, base }).resolved.filter((id) => KNOWN.has(id));
};
const gap = (configIds, profile) =>
  profileGap({
    configIds,
    mandatory: PROFILES[profile],
    optional: OPTIONAL[profile] ?? [],
    closure,
    conditional: conditionallyImplied,
    known: KNOWN,
    bases: BASE_ISA_IDS,
  });

test('every profile meets itself', () => {
  for (const profile of Object.keys(PROFILES)) {
    const g = gap(configOf(PROFILES[profile]), profile);
    assert.equal(g.meets, true, `${profile}: ${g.missingMandatory.join(', ')}`);
    assert.equal(g.base, null, profile);
    assert.equal(g.requiredPresent, g.required, profile);
    assert.deepEqual(g.beyond, [], `${profile} carries ${g.beyond.join(', ')}`);
  }
});

test('RVA22 falls short of RVA23 by exactly the mandatory extensions RVA23 adds', () => {
  const config = configOf(PROFILES.RVA22);
  const g = gap(config, 'RVA23');
  assert.equal(g.meets, false);
  const expected = PROFILES.RVA23.filter((id) => !config.includes(id)).sort((a, b) =>
    a.localeCompare(b, 'en', { sensitivity: 'base' }),
  );
  assert.deepEqual(g.missingMandatory, expected);
  assert.ok(g.missingMandatory.includes('V'), 'V is mandatory in RVA23, optional in RVA22');
  // Adding what it reports closes the gap.
  assert.equal(gap(configOf([...config, ...g.missingMandatory]), 'RVA23').meets, true);
});

test('implied extensions are reported with what pulls them in', () => {
  const g = gap(configOf(['RV64I']), 'RVA23');
  const membership = profileMembership({
    mandatory: PROFILES.RVA23,
    closure,
    conditional: conditionallyImplied,
  });
  for (const { id, impliedBy } of g.missingImplied) {
    assert.equal(membership.get(id).requirement, 'implied', id);
    assert.deepEqual(impliedBy, membership.get(id).impliedBy, id);
  }
  assert.ok(g.missingImplied.length > 0);
});

test('a different base is reported, and the right one counts as missing', () => {
  const g = gap(configOf(['RV32I', 'M', 'A']), 'RVA23');
  assert.deepEqual(g.base, { wanted: 'RV64I', have: 'RV32I' });
  assert.ok(g.missingMandatory.includes('RV64I'));
  assert.ok(!g.beyond.includes('RV32I'), 'the base is reported once, as a mismatch');
});

test('optional extensions are split by presence, and extras are listed', () => {
  const config = configOf([...PROFILES.RVA23, 'Zvkned', 'Zbc']);
  const g = gap(config, 'RVA23');
  assert.equal(g.meets, true);
  for (const id of g.optionalPresent) assert.ok(config.includes(id), id);
  for (const id of g.optionalAbsent) assert.ok(!config.includes(id), id);
  const notInProfile = (id) =>
    !profileMembership({
      mandatory: PROFILES.RVA23,
      optional: OPTIONAL.RVA23,
      closure,
    }).has(id);
  for (const id of g.beyond) assert.ok(notInProfile(id), `${id} is in RVA23`);
});

test('an implied id outside the catalogue is never reported as missing', () => {
  const g = profileGap({
    configIds: ['X'],
    mandatory: ['X'],
    closure: () => ['GraphOnly'],
    known: new Set(['X']),
  });
  assert.equal(g.meets, true);
  assert.deepEqual(g.missingImplied, []);
});

test('the builder shows the card and can add what it reports', () => {
  const panel = readFileSync(new URL('../src/WorkspacePanel.jsx', import.meta.url), 'utf8');
  const view = readFileSync(new URL('../src/risc_v_visualizer.jsx', import.meta.url), 'utf8');
  assert.match(panel, /<ProfileGapCard\b/);
  assert.match(panel, /onAddIds\(gap\.missingMandatory\)/);
  // Through the smart add, so conflicts and base swaps are still handled.
  assert.match(view, /onAddIds=\{\(ids\) => addWorkspaceIdsSmart\(ids\)\}/);
});
