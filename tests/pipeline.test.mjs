/**
 * The data pipeline: every generated file comes from one pinned upstream, and
 * can be regenerated from it byte for byte.
 *
 * Two failures this guards against, both found on 2026-10-14:
 *
 * - src/instruction-metadata.json had been generated from a local UDB feature
 *   branch. Its 1,200 source links pointed at a commit GitHub does not have, so
 *   every instruction's "source" link was a 404, and nothing noticed, because
 *   no test compared it with the other UDB-derived files.
 * - The weekly UDB sync failed on a test that only runs with a UDB checkout,
 *   which CI did not have. CI now clones UDB at the commit these files record
 *   (.github/workflows/ci.yml), which also fails outright if that commit is not
 *   on GitHub, so the checks below run on every push.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { instructionSynopsis } from '../src/instructionMetadata.js';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UDB = path.resolve(process.env.UDB_DIR ?? path.join(root, '..', 'riscv-unified-db'));
const haveUdb = fs.existsSync(path.join(UDB, 'spec', 'std', 'isa'));

const graph = require('../src/isa-dependency-graph.json');
const params = require('../src/isa-params.json');
const metadata = require('../src/instruction-metadata.json');
const catalog = require('../src/riscv_extensions.json');

const node = (script, args) =>
  spawnSync(process.execPath, [path.join(root, 'scripts', script), ...args], {
    cwd: root,
    encoding: 'utf8',
  });

test('every UDB-derived file points at the same upstream commit', () => {
  const pin = graph.sources.udb.commit;
  assert.match(pin, /^[0-9a-f]{40}$/);
  assert.equal(graph.sources.udb.branch, 'main', 'the graph was seeded from a non-main UDB branch');
  assert.equal(params.sources.udb.commit, pin, 'isa-params.json');
  assert.equal(params.sources.udb.branch, 'main', 'isa-params.json branch');

  const revisions = new Set(
    Object.values(metadata)
      .map((m) => m.source_revision)
      .filter(Boolean),
  );
  assert.deepEqual([...revisions], [pin], 'instruction-metadata.json source_revision');
  for (const [name, m] of Object.entries(metadata)) {
    if (m.source) assert.ok(m.source.includes(`/blob/${pin}/`), `${name}: ${m.source}`);
  }

  const csrCommits = new Set();
  for (const ext of Object.values(catalog).flat().filter(Boolean)) {
    for (const csr of Object.values(ext.csrs ?? {})) {
      const m = String(csr.source ?? '').match(/riscv-unified-db\/blob\/([0-9a-f]{40})\//);
      if (m) csrCommits.add(m[1]);
    }
  }
  assert.deepEqual([...csrCommits], [pin], 'CSR source links in riscv_extensions.json');
});

test('the UDB-derived files regenerate byte for byte from the pinned commit', (t) => {
  if (!haveUdb) return t.skip('no riscv-unified-db checkout (CI clones one at the pinned commit)');
  const head = spawnSync('git', ['-C', UDB, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).stdout.trim();
  if (head !== graph.sources.udb.commit) {
    return t.skip(
      `UDB checkout is at ${head.slice(0, 7)}, not the pinned ${graph.sources.udb.commit.slice(0, 7)}`,
    );
  }
  for (const [script, args] of [
    ['sync_instruction_metadata.mjs', [UDB, '--check']],
    ['sync-profile-optional.mjs', [UDB, '--check']],
    ['seed-dependency-graph.mjs', ['--check', '--udb', UDB]],
  ]) {
    const run = node(script, args);
    assert.equal(run.status, 0, `${script} ${args.join(' ')}\n${run.stdout}${run.stderr}`);
  }
  // sync_udb_params.mjs has no --check: regenerate and compare, then restore.
  const file = path.join(root, 'src', 'isa-params.json');
  const before = fs.readFileSync(file, 'utf8');
  try {
    const run = node('sync_udb_params.mjs', [UDB]);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.equal(
      fs.readFileSync(file, 'utf8'),
      before,
      'isa-params.json does not regenerate identically',
    );
  } finally {
    fs.writeFileSync(file, before);
  }
});

test('the ISA manual snapshot regenerates byte for byte from its pinned commit', (t) => {
  const manual = path.resolve(process.env.MANUAL_DIR ?? path.join(root, '..', 'riscv-isa-manual'));
  if (!fs.existsSync(path.join(manual, 'src', 'priv', 'preface.adoc'))) {
    return t.skip('no riscv-isa-manual checkout (CI clones one at the pinned commit)');
  }
  const pin = require('../src/isa-manual-status.json').source.commit;
  const head = spawnSync('git', ['-C', manual, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).stdout.trim();
  if (head !== pin)
    return t.skip(`manual checkout is at ${head.slice(0, 7)}, not ${pin.slice(0, 7)}`);
  const run = node('sync_manual_status.mjs', [manual, '--check']);
  assert.equal(run.status, 0, run.stdout + run.stderr);
});

test('the syncs that need another checkout refuse to run without it', () => {
  // Their parsers are tested elsewhere; here, only that a missing argument is
  // an error with a usage line, never a silent write of empty data.
  for (const script of [
    'sync_intrinsics.mjs',
    'sync_reference_impls.mjs',
    'sync_udb_params.mjs',
    'sync_manual_status.mjs',
  ]) {
    const run = node(script, []);
    assert.equal(run.status, 2, `${script} exited ${run.status}`);
    assert.match(run.stdout + run.stderr, /usage/i, script);
  }
});

test('instructionSynopsis keeps the lead paragraph as plain text', () => {
  assert.equal(instructionSynopsis(undefined), '');
  assert.equal(
    instructionSynopsis('Adds `xs1` to **xs2**.\n\nMore detail.\n\n[NOTE] ignored'),
    'Adds xs1 to xs2.',
  );
  // A lead that is a template or table is skipped for the first prose paragraph.
  assert.equal(instructionSynopsis('<%- if x %>\n\nThe real text.'), 'The real text.');
  // Admonitions are cut from the lead, and UDB's "Can causes" typo is fixed.
  assert.equal(instructionSynopsis('Can causes a trap. [NOTE] Details.'), 'Can cause a trap.');
});
