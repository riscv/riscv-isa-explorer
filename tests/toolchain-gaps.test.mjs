// scripts/check-toolchain-gaps.mjs: the ratified extensions each toolchain's
// newest release does not accept, which the monthly workflow keeps in one
// issue. The synthetic cases pin the rules; the real-data cases keep the
// exclusion and tracking lists honest.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  NOT_GAPS,
  TRACKING,
  ageSince,
  formatReport,
  staleEntries,
  toolchainGaps,
} from '../scripts/check-toolchain-gaps.mjs';

const read = (f) => JSON.parse(fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8'));
const NOW = new Date('2026-11-23T00:00:00Z');

const releases = (...versions) => ({
  releases: versions.map((version) => ({ version, date: '2026-01-01' })),
});
const data = (extensions) => ({
  tools: {
    llvm: releases('20', '21'),
    gcc: releases('15', '16'),
    binutils: releases('2.46'),
    qemu: releases('11.0'),
    linux: releases('7.3'),
  },
  extensions,
});
const ext = (id, state = 'ratified', ratification_date = '2024-03') => ({
  id,
  name: id,
  tags: [],
  state,
  ratification_date,
});

test('a tool that lacks a ratified extension reports it, oldest first', () => {
  const r = toolchainGaps(
    data({
      zfoo: { llvm: { supported: '21' } },
      zbar: { gcc: { supported: '16' } },
    }),
    { g: [ext('Zfoo', 'ratified', '2025-01'), ext('Zbar', 'ratified', '2023-06')] },
    { now: NOW },
  );
  const gcc = r.gaps.find((t) => t.key === 'gcc');
  assert.deepEqual(
    gcc.missing.map((m) => m.id),
    ['Zfoo'],
  );
  const qemu = r.gaps.find((t) => t.key === 'qemu');
  assert.deepEqual(
    qemu.missing.map((m) => [m.id, m.open]),
    [
      ['Zbar', '3y 05m'],
      ['Zfoo', '1y 10m'],
    ],
  );
  assert.equal(r.leads[0].key, 'linux');
  assert.equal(gcc.newest, '16');
});

test('experimental-only is its own list, and a bundle notes when its parts arrived', () => {
  const r = toolchainGaps(
    data({
      zexp: { llvm: { experimental: '20' } },
      zbun: { binutils: { parts: { since: '2.46', via: ['Za', 'Zb'] } } },
    }),
    { g: [ext('Zexp'), ext('Zbun')] },
    { now: NOW },
  );
  const llvm = r.gaps.find((t) => t.key === 'llvm');
  assert.deepEqual(
    llvm.experimental.map((m) => [m.id, m.since]),
    [['Zexp', '20']],
  );
  assert.ok(!llvm.missing.some((m) => m.id === 'Zexp'));
  const binutils = r.gaps.find((t) => t.key === 'binutils');
  assert.match(formatReport(r), /Zbun \(every part since 2\.46\)/);
  assert.ok(binutils.missing.some((m) => m.id === 'Zbun'));
});

test('drafts, ids with no -march token and the NOT_GAPS ids are not gaps', () => {
  const notGap = Object.keys(NOT_GAPS)[0];
  const r = toolchainGaps(
    data({ zdraft: {}, [notGap.toLowerCase()]: {} }),
    { g: [ext('Zdraft', 'draft'), ext('S'), ext(notGap)] },
    { now: NOW },
  );
  assert.equal(r.ratified, 1, `only ${notGap} is a ratified -march entry`);
  for (const t of [...r.gaps, ...r.leads]) assert.deepEqual(t.missing, []);
  assert.match(formatReport(r), /complete: true$/);
});

test('a NOT_GAPS id a tool starts accepting is reported as stale', () => {
  const id = Object.keys(NOT_GAPS)[0];
  const stale = staleEntries(data({ [id.toLowerCase()]: { gcc: { supported: '16' } } }), [ext(id)]);
  const mine = stale.filter((s) => s.startsWith(`NOT_GAPS.${id}:`));
  assert.equal(mine.length, 1);
  assert.match(mine[0], /GCC accepts it now/);
  assert.match(staleEntries(data({}), [])[0], /no longer a ratified -march entry/);
});

test('ages read as years and months from the ratification month', () => {
  assert.equal(ageSince('2024-03', NOW), '2y 08m');
  assert.equal(ageSince('2026-11', NOW), '0y 00m');
  assert.equal(ageSince(undefined, NOW), null);
  assert.equal(ageSince('2027-01', NOW), null, 'a future date has no age');
});

test('every NOT_GAPS entry says why, and none hides a real gap', () => {
  for (const [id, reason] of Object.entries(NOT_GAPS)) {
    assert.ok(reason.length > 20, `${id} needs a reason`);
  }
  const r = toolchainGaps(read('toolchain-support.json'), read('riscv_extensions.json'));
  assert.deepEqual(r.stale, [], 'NOT_GAPS and TRACKING match the data');
  for (const [id, links] of Object.entries(TRACKING)) {
    for (const [tool, link] of Object.entries(links)) {
      assert.match(link.url, /^https:\/\//, `${id}.${tool}`);
      assert.ok(link.state, `${id}.${tool} says how far the work is`);
    }
  }
});

test('the report on the committed data covers every tool and ends with the result line', () => {
  const r = toolchainGaps(read('toolchain-support.json'), read('riscv_extensions.json'));
  const report = formatReport(r);
  for (const name of ['Clang', 'GCC', 'binutils', 'QEMU', 'Linux']) {
    assert.match(report, new RegExp(`### ${name} `));
  }
  assert.match(report, /\ncomplete: (true|false)$/);
  assert.ok(r.ratified > 150, `ratified -march entries: ${r.ratified}`);
});
