#!/usr/bin/env node
/**
 * Emit a matrix of -march strings for toolchain validation.
 *
 * Prints one "<target-triple>\t<march-string>" pair per line. CI feeds each to
 * clang, which is the only check that validates our generated strings against a
 * real toolchain rather than against our own model of the specification.
 *
 * RV128I is deliberately excluded: clang has no riscv128 target, so the string
 * cannot be validated this way. That is a limitation of the checker, not a
 * statement about the string's correctness.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildMarchString } from '../src/marchUtils.js';
import { resolveSelection } from '../src/isaGraph.js';
import { PROFILES } from '../src/profiles.js';

const here = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(readFileSync(join(here, '..', 'src', 'riscv_extensions.json'), 'utf8'));
const ALL = Object.values(catalog).flat();

/** Representative selections, chosen to cover distinct code paths. */
const SELECTIONS = [
  { name: 'base only',            exts: [] },
  { name: 'imac',                 exts: ['M', 'A', 'C'] },
  { name: 'gc equivalent',        exts: ['M', 'A', 'F', 'D', 'C', 'Zicsr', 'Zifencei'] },
  { name: 'bitmanip',             exts: ['M', 'Zba', 'Zbb', 'Zbs'] },
  { name: 'float + csr',          exts: ['F', 'Zicsr'] },
  { name: 'double',               exts: ['M', 'A', 'F', 'D', 'Zicsr'] },
  { name: 'compressed only',      exts: ['C'] },
  { name: 'counters',             exts: ['Zicsr', 'Zicntr', 'Zihpm'] },
];

// RV128I omitted: no clang riscv128 target.
const BASES = ['RV32I', 'RV64I', 'RV32E', 'RV64E'];

// Third column is the toolchain tier the row needs:
//   core    — plain ratified extensions; any clang from the last few years takes it.
//   modern  — needs a recent clang. The profiles mandate Ssccptr and Zcmop, which
//             clang 18 (what ubuntu-24.04 ships) rejects and calls experimental
//             respectively. Both are ratified; the compiler is simply behind.
//   known-unsupported — ratified catalogue data newer than clang 21. Kept in
//             the emitted matrix so the blind spot is explicit and countable.
// CI validates `core` on Ubuntu's distro compiler and `modern` on the macOS 26
// image, whose preinstalled Apple clang 21 avoids a network/toolchain install.
const seen = new Set();
const emit = (march, tier) => {
  if (!march || seen.has(march)) return;
  seen.add(march);
  const triple = march.startsWith('rv32') ? 'riscv32-unknown-elf' : 'riscv64-unknown-elf';
  process.stdout.write(`${triple}\t${march}\t${tier}\n`);
};

for (const base of BASES) {
  for (const sel of SELECTIONS) {
    emit(buildMarchString([base, ...sel.exts], ALL).march, 'core');
  }
}

// The supported profiles, resolved exactly as the ISA builder resolves them.
// These are the largest and most realistic strings the tool produces, and they
// exercise the privileged/supervisor tail that the hand-written selections above
// never touch — which is how every profile came to emit an Sv39 that clang
// rejects, unnoticed.
const CATALOG_IDS = new Set(ALL.filter(Boolean).map((e) => e.id));
for (const members of Object.values(PROFILES)) {
  const base = members.find((id) => /^RV(32|64|128)[IE]$/.test(id)) ?? null;
  if (base === 'RV128I') continue; // no clang riscv128 target
  const { resolved } = resolveSelection({ selected: members, base });
  emit(buildMarchString(resolved.filter((id) => CATALOG_IDS.has(id)), ALL).march, 'modern');
}

// Ratified extensions clang 21 either still calls experimental or does not yet
// recognise. This is intentionally an id allowlist, not an error-message
// allowlist: when clang gains one, its row can move to `modern` and start gating.
const CLANG21_UNSUPPORTED = new Set([
  'Zalasr',
  'Zicfilp',
  'Zicfiss',
  'Ziccid',
  'Svrsw60t59b',
  'Sspmp',
  'Sspmpen',
  'Smpmpdeleg',
  'Smctr',
  'Ssctr',
  'Sstvecv',
  'Ssu32xl',
  'Ssube',
]);

// Every ratified, selectable catalogue entry under each base it does not
// conflict with. The representative rows above keep an older distro clang on
// the critical path; these exhaustive rows are consumed by the clang-21 job.
// Deduplication keeps roots/aliases that emit no token from inflating the set.
for (const ext of ALL.filter((entry) => entry?.state === 'ratified')) {
  for (const base of ['RV32I', 'RV64I']) {
    const selected = /^Zvl\d+b$/.test(ext.id) ? [base, ext.id, 'Zve32x'] : [base, ext.id];
    const result = resolveSelection({ selected, base });
    if (result.conflicts.length || result.unknown.length) continue;
    emit(
      buildMarchString(result.resolved.filter((id) => CATALOG_IDS.has(id)), ALL).march,
      CLANG21_UNSUPPORTED.has(ext.id) ? 'known-unsupported' : 'modern',
    );
  }
}
