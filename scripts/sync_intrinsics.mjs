#!/usr/bin/env node
/**
 * Regenerates src/instruction-intrinsics.json: the C intrinsics that compile
 * to each catalogue instruction.
 *
 *   node scripts/sync_intrinsics.mjs <rvv-intrinsic-doc> <riscv-c-api-doc> [--check]
 *
 * Two upstream sources, both from riscv-non-isa:
 *
 *   rvv-intrinsic-doc  the generated per-section listings under
 *                      auto-generated/{,vector-crypto/,bfloat16/}intrinsic_funcs/.
 *                      An intrinsic's name is the instruction's mnemonic with
 *                      `.` written as `_`, then type and policy suffixes
 *                      (__riscv_vaadd_vv_i32m1_m). Stripping the suffixes and
 *                      matching what is left against the catalogue is exact:
 *                      names that match no instruction (vreinterpret, vundefined,
 *                      vneg and the other pseudo-intrinsics) are skipped, not
 *                      guessed at.
 *   riscv-c-api-doc    the Prototype | Instruction | Extension | Notes tables for
 *                      the scalar bit-manipulation, crypto and MOP intrinsics.
 *                      The Instruction column is the mapping, written with
 *                      optional parts in brackets: `ror[i][w]` is ror, rori, rorw
 *                      and roriw.
 *
 * Only the vector listing is large, so a vector instruction keeps one
 * representative prototype and a count; a scalar one keeps them all.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const [rvvRoot, capiRoot] = args.filter((arg) => !arg.startsWith('--')).map((p) => path.resolve(p));
if (!rvvRoot || !capiRoot) {
  console.error('usage: sync_intrinsics.mjs <rvv-intrinsic-doc> <riscv-c-api-doc> [--check]');
  process.exit(2);
}
const outputPath = path.join(root, 'src', 'instruction-intrinsics.json');

const revision = (repo) =>
  execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const blob = (repo, slug, file, anchor) =>
  `https://github.com/riscv-non-isa/${slug}/blob/${revision(repo)}/${path
    .relative(repo, file)
    .split(path.sep)
    .join('/')}${anchor ? `#${anchor}` : ''}`;

// Catalogue mnemonics by their underscore spelling (VAADD.VV -> vaadd_vv).
const catalog = JSON.parse(
  fs.readFileSync(path.join(root, 'src', 'riscv_extensions.json'), 'utf8'),
);
const byKey = new Map();
for (const ext of Object.values(catalog).flat()) {
  for (const mnemonic of Object.keys(ext?.instructions || {})) {
    byKey.set(mnemonic.toLowerCase().replace(/\./g, '_'), mnemonic.toLowerCase());
  }
}

const out = {};

/* ── Vector ─────────────────────────────────────────────────────────────── */

// A vector type (_i32m1, _f16mf4x2, _b8) or a scalar one (_f32 in vfmv_f_s).
const TYPE_SUFFIX = /_(?:(?:bf|[iuf])\d+(?:mf\d|m\d)?(?:x\d)?|b\d+)$/;
const POLICY_SUFFIX = /_(?:tumu|tum|tu|mu|m|rm)$/;

/*
 * The instruction an intrinsic name reduces to, or null. The catalogue is
 * checked after every strip, not only at the end: `_m` is both the masked
 * policy suffix and part of mnemonics such as vcpop.m, so stripping to a fixed
 * point would turn __riscv_vcpop_m_b8 into vcpop.
 */
const vectorMnemonic = (name) => {
  let stem = name.replace(/^__riscv_/, '');
  while (!byKey.has(stem)) {
    const next = stem.replace(TYPE_SUFFIX, '');
    const stripped = next !== stem ? next : stem.replace(POLICY_SUFFIX, '');
    if (stripped === stem) return null;
    stem = stripped;
  }
  return byKey.get(stem);
};

/*
XX * need Zvfh or Zvfbfa on top of V), then 32-bit elements at LMUL=1. The first type in
 * the name is the one that counts; vsm4r_vs_u32mf2_u32m1 is an mf2 operation.
 */
const exampleRank = (name, prototype) => {
  const type = name.match(/_(?:bf|[iuf])(\d+)(mf\d|m\d)/);
  let rank = 0;
  if (/_(?:m|tu|tum|tumu|mu)$/.test(name)) rank += 100;
  if (/\bv(?:b?)float16|_Float16|__bf16/.test(prototype)) rank += 10;
  if (type?.[2] !== 'm1') rank += 2;
  if (type?.[1] !== '32') rank += 1;
  return rank;
};

const rvvDirs = ['', 'vector-crypto', 'bfloat16'].map((sub) =>
  path.join(rvvRoot, 'auto-generated', sub, 'intrinsic_funcs'),
);
const vector = new Map();
for (const dir of rvvDirs) {
  for (const file of fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.adoc'))
    .sort()) {
    const full = path.join(dir, file);
    let anchor = null;
    let code = '';
    let inCode = false;
    const flush = () => {
      // Prototypes wrap across lines; each one ends at its semicolon.
      for (const proto of code.split(';')) {
        const text = proto.replace(/\s+/g, ' ').trim();
        const name = text.match(/(__riscv_\w+)\s*\(/)?.[1];
        if (!name) continue;
        const mnemonic = vectorMnemonic(name);
        if (!mnemonic) continue;
        const entry = vector.get(mnemonic) ?? { names: new Set(), best: null, source: null };
        entry.names.add(name);
        const rank = exampleRank(name, text);
        if (!entry.best || rank < entry.best.rank) {
          entry.best = { rank, prototype: `${text};` };
          entry.source = blob(rvvRoot, 'rvv-intrinsic-doc', full, anchor);
        }
        vector.set(mnemonic, entry);
      }
      code = '';
    };
    for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
      const id = line.match(/^\[\[([^\]]+)\]\]$/)?.[1];
      if (id) anchor = id;
      if (line.trim() === '----') {
        if (inCode) flush();
        inCode = !inCode;
        continue;
      }
      if (inCode) code += `${line}\n`;
    }
  }
}
for (const [mnemonic, entry] of vector) {
  out[mnemonic] = {
    header: 'riscv_vector.h',
    prototypes: [entry.best.prototype],
    count: entry.names.size,
    source: entry.source,
  };
}

/* ── Scalar ─────────────────────────────────────────────────────────────── */

// `ror[i][w]` -> ror, rori, rorw, roriw; `mop.r.[n]` -> mop.r.0 ... mop.r.31.
const expand = (pattern) => {
  const open = pattern.indexOf('[');
  if (open === -1) return [pattern];
  const close = pattern.indexOf(']', open);
  const head = pattern.slice(0, open);
  const inner = pattern.slice(open + 1, close);
  const tail = expand(pattern.slice(close + 1));
  const options = inner === 'n' ? Array.from({ length: 32 }, (_, i) => String(i)) : ['', inner];
  return options.flatMap((option) => tail.map((rest) => `${head}${option}${rest}`));
};

const capiFile = path.join(capiRoot, 'src', 'c-api.adoc');
const capiLines = fs.readFileSync(capiFile, 'utf8').split('\n');
const scalar = new Map();
let header = null;
for (let i = 0; i < capiLines.length; i += 1) {
  const line = capiLines[i];
  if (/^=== /.test(line)) header = null;
  const named = line.match(/header file `(riscv_\w+\.h)`/)?.[1];
  if (named) header = named;
  if (!/^\|\*Prototype\*/.test(line)) continue;

  // Collect the table body and split it into cells; a row is four cells.
  let body = '';
  for (i += 1; i < capiLines.length && capiLines[i] !== '|==='; i += 1) body += `${capiLines[i]}\n`;
  const cells = body
    .split(/(?:^|\s)\|/)
    .map((cell) => cell.trim())
    .filter((_, index) => index > 0);
  for (let c = 0; c + 2 < cells.length; c += 4) {
    // Four crypto prototypes upstream write `uint64` for `uint64_t`.
    const prototype = cells[c]
      .match(/`\+(.+?)\+`/)?.[1]
      ?.trim()
      .replace(/\buint64\b(?!_t)/g, 'uint64_t');
    const pattern = cells[c + 1].match(/`([^`]+)`/)?.[1]?.trim();
    const extension = cells[c + 2].trim();
    if (!prototype || !pattern) continue;
    /*
     * The Instruction column can be wrong where the name is not: upstream
     * maps __riscv_aes64es to `aes32es`. When the intrinsic is named after a
     * catalogue instruction the column does not list, the name wins.
     */
    let candidates = expand(pattern);
    const named = prototype.match(/__riscv_(\w+?)(?:_(?:32|64))?\s*\(/)?.[1];
    if (named && byKey.has(named) && !candidates.includes(byKey.get(named))) {
      console.warn(`c-api-doc lists ${named} as \`${pattern}\`; using ${byKey.get(named)}.`);
      candidates = [byKey.get(named)];
    }
    for (const candidate of candidates) {
      const mnemonic = byKey.get(candidate.replace(/\./g, '_'));
      if (!mnemonic) continue;
      const entry = scalar.get(mnemonic) ?? { header, prototypes: [] };
      const note = extension.match(/\((RV32|RV64)\)/)?.[1];
      entry.prototypes.push(note ? `${prototype} // ${note} only` : prototype);
      scalar.set(mnemonic, entry);
    }
  }
}
for (const [mnemonic, entry] of scalar) {
  out[mnemonic] = {
    // null when the spec names no header for the section (MOP, today).
    header: entry.header,
    prototypes: entry.prototypes,
    count: entry.prototypes.length,
    source: blob(capiRoot, 'riscv-c-api-doc', capiFile),
  };
}

const sorted = Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
const output = `${JSON.stringify(sorted, null, 2)}\n`;
if (checkOnly) {
  const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
  if (current !== output) {
    console.error('Instruction intrinsics are stale; run npm run sync:intrinsics.');
    process.exitCode = 1;
  }
} else {
  fs.writeFileSync(outputPath, output);
  console.log(
    `Wrote intrinsics for ${Object.keys(sorted).length} instructions ` +
      `(${vector.size} vector, ${scalar.size} scalar).`,
  );
}
