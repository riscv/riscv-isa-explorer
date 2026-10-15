#!/usr/bin/env node
/**
 * Regenerates src/isa-manual-status.json: what each ISA manual preface lists
 * as ratified, pinned to the manual commit it was read from.
 *
 *   node scripts/sync_manual_status.mjs <riscv-isa-manual> [--check]
 *
 * tests/manual-status.test.mjs compares the catalogue against this snapshot on
 * every run, with no network. See scripts/manual-status.mjs for the format and
 * why: riscv-unified-db can lag the manual (Sm 1.13, riscv-unified-db#2740).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parsePreface } from './manual-status.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const check = args.includes('--check');
const manual = args.find((a) => !a.startsWith('--'));
if (!manual) {
  console.error('usage: sync_manual_status.mjs <riscv-isa-manual> [--check]');
  process.exit(2);
}
const outputPath = path.join(root, 'src', 'isa-manual-status.json');

const VOLUMES = { unprivileged: 'src/unpriv/preface.adoc', privileged: 'src/priv/preface.adoc' };
const commit = execFileSync('git', ['-C', manual, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
const volumes = {};
for (const [volume, file] of Object.entries(VOLUMES)) {
  volumes[volume] = {
    file,
    ratified: parsePreface(fs.readFileSync(path.join(manual, file), 'utf8')),
  };
}

const output = `${JSON.stringify(
  { source: { repo: 'riscv/riscv-isa-manual', commit }, volumes },
  null,
  2,
)}\n`;

if (check) {
  const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
  if (current !== output) {
    console.error('src/isa-manual-status.json is stale; run npm run sync:manual-status.');
    process.exitCode = 1;
  }
} else {
  fs.writeFileSync(outputPath, output);
  const count = Object.values(volumes).reduce((n, v) => n + v.ratified.length, 0);
  console.log(
    `Wrote ${path.relative(root, outputPath)}: ${count} ratified rows at ${commit.slice(0, 7)}.`,
  );
}
