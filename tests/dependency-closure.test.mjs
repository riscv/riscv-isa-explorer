/**
 * Differential check: SMART_DEPENDENCIES vs. a real toolchain.
 *
 * The dependency table is hand-maintained today (#139 marks it a placeholder
 * pending UDB sync). A hand-maintained graph drifts silently: an extension gains
 * a prerequisite upstream, nothing here notices, and the builder emits a config
 * with an unsatisfied dependency.
 *
 * This compares our transitive closure against clang's implication closure for
 * every entry. clang is NOT the specification — some of its implications are
 * modelling choices rather than normative requirements — so a divergence is a
 * finding to triage, not automatically a bug. Accepted divergences are recorded
 * in KNOWN_DIVERGENCES with a reason, which makes this a ratchet: existing debt
 * is documented, and anything new fails.
 *
 * Skips cleanly when clang has no RISC-V target, so it does not break local runs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { SMART_DEPENDENCIES } from '../src/marchUtils.js';

/**
 * Divergences we have looked at and accepted, with the reason.
 * Removing a gap from the graph should also remove its entry here — the test
 * below fails on stale entries as well as on new ones.
 *
 * Empty as of the move to isa-dependency-graph.json. The six Zve*-and-V entries
 * that lived here were the Zvl*b minimum-VLEN tokens, unresolved because we had
 * only clang's word for them. riscv-unified-db records Zve32x -> Zvl32b and
 * Zve64x -> Zvl64b directly, which agrees with clang and closes all six
 * transitively, so they are now real edges rather than documented debt.
 */
const KNOWN_DIVERGENCES = {};

function clangHasRiscv() {
  try {
    execFileSync('clang', ['--target=riscv64-unknown-elf', '-march=rv64i', '-x', 'c', '/dev/null', '-fsyntax-only'],
      { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

/** Our transitive closure for `ext`, lowercased. */
function ourClosure(ext, seen = new Set()) {
  for (const dep of SMART_DEPENDENCIES[ext] || []) {
    if (seen.has(dep)) continue;
    seen.add(dep);
    ourClosure(dep, seen);
  }
  return new Set([...seen].map((d) => d.toLowerCase()));
}

/** clang's implied feature set for `ext`, or null if clang rejects it. */
function clangClosure(ext) {
  const token = ext.toLowerCase();
  const march = token.length === 1 ? `rv64i${token}` : `rv64i_${token}`;
  // -### is a dry run: clang prints the driver command to stderr and exits 0,
  // so stderr must be captured on success, not only on failure.
  const r = spawnSync(
    'clang',
    ['--target=riscv64-unknown-elf', `-march=${march}`, '-x', 'c', '/dev/null', '-###'],
    { encoding: 'utf8' },
  );
  const stderr = r.stderr ?? '';
  if (!stderr.includes('"-target-feature"')) return null;
  const feats = new Set([...stderr.matchAll(/"\+([a-z0-9]+)"/g)].map((m) => m[1]));
  for (const drop of ['relax', 'i', token]) feats.delete(drop);
  return feats;
}

test('every documented divergence names a real dependency entry', () => {
  // A KNOWN_DIVERGENCES key that is not in SMART_DEPENDENCIES would never be
  // visited by the closure comparison, so it would sit there unchecked forever.
  const orphans = Object.keys(KNOWN_DIVERGENCES).filter((k) => !(k in SMART_DEPENDENCIES));
  assert.deepEqual(orphans, [], `KNOWN_DIVERGENCES entries with no SMART_DEPENDENCIES entry: ${orphans.join(', ')}`);
});

test('dependency closure matches clang, except where documented', { skip: !clangHasRiscv() && 'clang has no RISC-V target' }, () => {
  const undocumented = [];
  const stale = [];

  for (const ext of Object.keys(SMART_DEPENDENCIES)) {
    const theirs = clangClosure(ext);
    if (theirs === null) continue; // clang does not know this extension
    const ours = ourClosure(ext);
    const missing = [...theirs].filter((d) => !ours.has(d)).sort();
    const accepted = (KNOWN_DIVERGENCES[ext] ?? []).slice().sort();

    const unexpected = missing.filter((d) => !accepted.includes(d));
    if (unexpected.length) {
      undocumented.push(`${ext}: clang implies ${unexpected.join(', ')} — not in our closure and not documented`);
    }
    const gone = accepted.filter((d) => !missing.includes(d));
    if (gone.length) {
      stale.push(`${ext}: KNOWN_DIVERGENCES lists ${gone.join(', ')} but the gap is closed — remove the entry`);
    }
  }

  assert.deepEqual(undocumented, [], `undocumented dependency drift:\n  ${undocumented.join('\n  ')}`);
  assert.deepEqual(stale, [], `stale divergence entries:\n  ${stale.join('\n  ')}`);
});
