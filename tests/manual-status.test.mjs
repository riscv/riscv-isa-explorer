/**
 * The catalogue against the ISA manual's own list of ratified modules
 * (src/isa-manual-status.json, read from both prefaces by
 * scripts/sync_manual_status.mjs).
 *
 * riscv-unified-db is the source for state and version, and it can lag the
 * manual: on 2026-10-15 a reader noticed Sm at 1.12.0 because UDB still listed
 * 1.13.0 as frozen, while the privileged preface listed Machine ISA 1.13 as
 * ratified (riscv-unified-db#2740). This test fails on that kind of gap, so
 * the next one is caught by CI instead of by a reader.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { compareWithCatalogue, parsePreface, UMBRELLAS } from '../scripts/manual-status.mjs';

const require = createRequire(import.meta.url);
const status = require('../src/isa-manual-status.json');
const catalog = require('../src/riscv_extensions.json');
const rows = Object.values(status.volumes).flatMap((v) => v.ratified);

test('the snapshot is pinned and covers both volumes', () => {
  assert.equal(status.source.repo, 'riscv/riscv-isa-manual');
  assert.match(status.source.commit, /^[0-9a-f]{40}$/);
  assert.deepEqual(Object.keys(status.volumes).sort(), ['privileged', 'unprivileged']);
  assert.ok(status.volumes.unprivileged.ratified.length > 50);
  assert.ok(status.volumes.privileged.ratified.length > 20);
  // The two privilege levels are in it, under the catalogue's ids.
  const ids = new Set(rows.map((r) => r.id));
  assert.ok(ids.has('Sm') && ids.has('S'));
});

test('everything the manual lists as ratified is ratified in the catalogue, at that version', () => {
  const problems = compareWithCatalogue(rows, catalog);
  assert.deepEqual(
    problems,
    [],
    `the catalogue disagrees with the ISA manual:\n  ${problems.join('\n  ')}`,
  );
});

test('the comparison catches a lagging state, a wrong version and a missing entry', () => {
  // This week's case: UDB had Sm 1.13.0 frozen, so the catalogue showed 1.12.0.
  const catalogue = {
    standard: [
      { id: 'Sm', state: 'ratified', version: '1.12.0' },
      { id: 'S', state: 'frozen', version: '1.13.0' },
    ],
    z_vector: [{ id: 'Zvl32b', state: 'ratified' }, { id: 'Zvl64b' }],
  };
  const problems = compareWithCatalogue(
    [
      { name: 'Machine', id: 'Sm', version: '1.13' },
      { name: 'Supervisor', id: 'S', version: '1.13' },
      { name: 'zvl*', id: 'zvl*', version: '1.0' },
      { name: 'zfoo', id: 'zfoo', version: '1.0' },
      { name: 'RVWMO', id: null, version: '2.0' },
    ],
    catalogue,
  );
  assert.deepEqual(problems, [
    'Sm: version 1.13 in the manual, 1.12.0 in the catalogue',
    'S: ratified at 1.13 in the manual, "frozen" in the catalogue',
    'Zvl64b: ratified at 1.0 in the manual, "no state" in the catalogue',
    'zfoo 1.0: ratified in the manual, missing from the catalogue',
  ]);
});

test('the parser reads only the current table, and refuses a reorganised one', () => {
  const preface = `
It contains the following versions of the RISC-V ISA modules,
all of which have been ratified:

|===
|Privilege Level |Version
|Machine |1.13
h|Extension h|Version
|ext:zicond[] |1.0
|ext:zvl*[] |1.0
|Pointer Masking |1.0
|===

[.big]*_Preface to Document Version 20260120_*
|===
|Machine |1.12
|===`;
  assert.deepEqual(parsePreface(preface), [
    { name: 'Machine', id: 'Sm', version: '1.13' },
    { name: 'zicond', id: 'zicond', version: '1.0' },
    { name: 'zvl*', id: 'zvl*', version: '1.0' },
    { name: 'Pointer Masking', id: null, version: '1.0' },
  ]);
  assert.ok(UMBRELLAS.has('Pointer Masking'));
  assert.throws(() => parsePreface('no table here'), /all of which have been ratified/);
  assert.throws(
    () => parsePreface('all of which have been ratified:\n|===\n|Something New |1.0\n|==='),
    /neither an extension nor a known name/,
  );
});
