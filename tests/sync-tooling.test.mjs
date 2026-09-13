/**
 * The synchronisation tooling, exercised as processes.
 *
 * These scripts had no tests, which is uncomfortable given how much rides on
 * them: they decide which upstream instructions attach to which extension, and
 * a silent misroute there shows up much later as a catalogue that looks fine
 * and is wrong. Two real examples reached production — RV128I displaying
 * RV64I's 52 instructions because it was routed through the rv64_i tag, and
 * MRET/WFI reachable from nowhere because no catalogue entry claimed them.
 *
 * They export nothing and run on load, so they are driven the way CI drives
 * them rather than imported. That is the honest surface: it tests the thing
 * that actually runs.
 *
 * Nothing here writes. The instruction sync is exercised through --dry-run, and
 * one test asserts --dry-run really does leave the catalogue alone — a guard on
 * the guard, since every other test in this file depends on it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const CATALOG = path.join(root, 'src', 'riscv_extensions.json');

const hashCatalog = () =>
  createHash('sha256').update(fs.readFileSync(CATALOG)).digest('hex');

/** Run a script, returning { status, stdout }. Never throws on a non-zero exit. */
function run(script, args = []) {
  try {
    const stdout = execFileSync('node', [path.join(root, 'scripts', script), ...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout };
  } catch (err) {
    return { status: err.status ?? 1, stdout: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

test('the committed catalogue is what the instruction sync produces', () => {
  // --strict fails when a mapped tag yields no instructions, so a clean exit
  // means every routing rule still resolves against the current instr_dict.
  // If someone hand-edits an extension's instructions, this is what notices.
  const { status, stdout } = run('sync_instructions.mjs', ['--dry-run', '--strict']);
  assert.equal(status, 0, `sync reported a problem:\n${stdout}`);
  assert.match(stdout, /Instructions written:\s+\d+/, 'expected a summary line');
});

test('--dry-run does not touch the catalogue', () => {
  // Everything else here leans on this being true.
  const before = hashCatalog();
  run('sync_instructions.mjs', ['--dry-run', '--strict']);
  assert.equal(hashCatalog(), before, '--dry-run wrote to the catalogue');
});

test('the sync reports the instruction count it actually wrote', () => {
  const { stdout } = run('sync_instructions.mjs', ['--dry-run']);
  const reported = Number(stdout.match(/Instructions written:\s+(\d+)/)?.[1]);
  const actual = Object.values(JSON.parse(fs.readFileSync(CATALOG, 'utf8')))
    .flat()
    .filter(Boolean)
    .reduce((n, e) => n + Object.keys(e.instructions || {}).length, 0);
  assert.equal(reported, actual, 'the summary disagrees with the catalogue it describes');
});

test('every routed tag resolves to a catalogue entry', () => {
  // The reverse direction is deliberately not asserted. Upstream carries tags
  // this catalogue has no entry for — vector dot/zip/fp8 proposals that appear
  // zero times in the ratified manual — and their absence is correct, not a
  // gap. What must hold is that nothing the catalogue claims to route from has
  // gone away upstream.
  const catalog = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
  const dict = JSON.parse(fs.readFileSync(path.join(root, 'src', 'instr_dict.json'), 'utf8'));
  const upstream = new Set();
  for (const v of Object.values(dict)) for (const t of v.extension ?? []) upstream.add(t.toLowerCase());

  const dangling = [];
  for (const e of Object.values(catalog).flat().filter(Boolean)) {
    for (const t of e.tags ?? []) {
      if (!upstream.has(t.toLowerCase())) dangling.push(`${e.id} -> ${t}`);
    }
  }
  assert.deepEqual(dangling, [], 'these entries route from tags upstream no longer defines');
});

test('the UDB sync fails loudly when pointed somewhere wrong', () => {
  // It used to be possible for a sync to report an error and still exit 0,
  // which lets a scheduled job look successful while having done nothing.
  const { status, stdout } = run('sync_udb_extensions.cjs', ['/nonexistent-udb-path']);
  assert.equal(status, 1, 'a missing UDB checkout must be a failure, not a warning');
  assert.match(stdout, /not found/i, 'it should say what it could not find');
});

test('the UDB sync captures the extension version, when a UDB checkout is available', (t) => {
  // Skipped rather than failed when UDB is absent, matching the graph test
  // below: contributors are not required to clone it.
  const udb = path.resolve(root, '..', 'riscv-unified-db');
  if (!fs.existsSync(path.join(udb, 'spec', 'std', 'isa', 'ext'))) {
    t.skip('no riscv-unified-db checkout beside this repo');
    return;
  }

  // The version was parsed and then dropped for a long time: pickVersion()
  // already chose the right entry to read state and ratification_date from,
  // and the number beside them went nowhere. Anything that has to pin an
  // extension — an ACT4 DUB config, a profile, a report — had to re-derive it.
  const before = hashCatalog();
  const { status, stdout } = run('sync_udb_extensions.cjs', [udb, '--dry-run']);
  assert.equal(status, 0, stdout);
  assert.match(stdout, /--dry-run: catalogue not written/, 'dry-run should say so');
  assert.equal(hashCatalog(), before, '--dry-run must not touch the catalogue');

  // Asserts the pass runs and reports, not how many it wrote: the count is
  // "gained a version", so it is large on a catalogue that has none and zero
  // once the data is committed. Coverage of the committed catalogue is
  // asserted in data-integrity.test.mjs, where the data lives.
  assert.match(
    stdout,
    /Version pass: \d+ extension\(s\) gained a version/,
    `the sync should report a version pass:\n${stdout}`
  );
});

test('--dry-run leaves the UDB sync catalogue alone', () => {
  // Guard on the guard, mirroring the instruction-sync test above: every
  // assertion made through --dry-run depends on it really not writing.
  const udb = path.resolve(root, '..', 'riscv-unified-db');
  if (!fs.existsSync(path.join(udb, 'spec', 'std', 'isa', 'ext'))) return;
  const before = hashCatalog();
  run('sync_udb_extensions.cjs', [udb, '--dry-run']);
  assert.equal(hashCatalog(), before);
});

test('extensions UDB does not carry stay on the watchlist', (t) => {
  /*
   * The report's watchlist is derived — an entry carrying a long_name is taken
   * to be already synced and dropped from it. That rule assumes UDB is always
   * ahead of us. SPMP is where it is not: ratified in its own specification,
   * absent from UDB entirely, and described here from that PDF, which is
   * exactly what would remove it from the list.
   *
   * So the one part of the catalogue UDB is behind on would be the one part the
   * weekly report never mentions. ALWAYS_WATCH holds them there.
   */
  const udb = path.resolve(root, '..', 'riscv-unified-db');
  if (!fs.existsSync(path.join(udb, 'spec', 'std', 'isa', 'ext'))) {
    t.skip('no riscv-unified-db checkout beside this repo');
    return;
  }

  const { status, stdout } = run('sync_udb_extensions.cjs', [udb, '--dry-run']);
  assert.equal(status, 0, stdout);
  for (const id of ['Sspmp', 'Sspmpen', 'Smpmpdeleg']) {
    assert.match(
      stdout,
      new RegExp(`^\\s+- ${id}$`, 'm'),
      `${id} should be reported as still missing from UDB:\n${stdout}`,
    );
  }
});

test('the graph seeder fails loudly when pointed somewhere wrong', () => {
  const { status } = run('seed-dependency-graph.mjs', ['--check', '--udb', '/nonexistent-udb-path']);
  assert.equal(status, 1, 'a missing UDB checkout must be a failure');
});

test('the graph matches upstream, when a UDB checkout is available', (t) => {
  // Skipped rather than failed when UDB is absent: contributors are not
  // required to clone it, and CI has its own step for this.
  const udb = path.resolve(root, '..', 'riscv-unified-db');
  if (!fs.existsSync(path.join(udb, 'spec', 'std', 'isa', 'ext'))) {
    t.skip('no riscv-unified-db checkout beside this repo');
    return;
  }
  const { status, stdout } = run('seed-dependency-graph.mjs', ['--check', '--udb', udb]);
  // Drift against a non-trunk branch says more about the branch than about us,
  // and the seeder now names the branch precisely so this stays diagnosable.
  if (status !== 0 && /not main/i.test(stdout)) {
    t.skip(`UDB checkout is on a feature branch:\n${stdout.split('\n').slice(-6).join('\n')}`);
    return;
  }
  assert.equal(status, 0, stdout);
});

test('the sync bot signs off as the same identity it authors as', () => {
  // The DCO gate compares the Signed-off-by trailer against the commit author
  // (%an <%ae>), but create-pull-request writes that trailer from the
  // *committer*, and defaults `author` to whoever triggered the run. Left at
  // the defaults the two never match and every weekly sync PR fails DCO.
  //
  // Worth a test because the failure is invisible until the cron fires: the
  // workflow only runs on a schedule, so a regression here surfaces as a
  // blocked PR on a Monday morning rather than a red check on the change
  // that caused it.
  const wf = fs.readFileSync(
    path.join(root, '.github', 'workflows', 'sync-udb-extensions.yml'),
    'utf8',
  );

  const author = wf.match(/^\s*author:\s*'(.+)'\s*$/m);
  const committer = wf.match(/^\s*committer:\s*'(.+)'\s*$/m);

  assert.ok(author, 'the create-pull-request step must pin an explicit author');
  assert.ok(committer, 'the create-pull-request step must pin an explicit committer');
  assert.equal(
    author[1],
    committer[1],
    'author and committer must be the same identity, or the sign-off cannot match',
  );
  assert.match(wf, /^\s*signoff:\s*true\s*$/m, 'the sync commit must be signed off');
});
