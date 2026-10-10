#!/usr/bin/env node
/**
 * Copies the Explorer modules and data the server runs on into mcp/explorer/,
 * so the published package is self-contained. Runs on `npm pack` and
 * `npm publish` (prepack). The copy is git-ignored: src/ stays the only
 * source of truth, and each release of the package carries the data as it
 * stood when it was packed.
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mcp = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(mcp, '..');
const out = join(mcp, 'explorer');

// Every module explorer.mjs loads, and everything those modules import.
export const FILES = [
  'isaGraph.js',
  'marchUtils.js',
  'profiles.js',
  'profileExport.js',
  'xlsxWriter.js',
  'evolutionModel.js',
  'encodingUtils.js',
  'instructionMetadata.js',
  'isa-dependency-graph.json',
  'riscv_extensions.json',
  'instruction-metadata.json',
  'profile-optional.json',
];

// Importing this module (the tests do, for FILES) must not touch the disk.
if (process.argv[1] === fileURLToPath(import.meta.url)) bundle();

function bundle() {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const file of FILES) copyFileSync(join(repo, 'src', file), join(out, file));

  const { version } = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  writeFileSync(join(out, 'version.json'), `${JSON.stringify({ version }, null, 2)}\n`);
  copyFileSync(join(repo, 'LICENSE'), join(mcp, 'LICENSE'));

  process.stderr.write(`bundled ${FILES.length} files from src/ (explorer ${version})\n`);
}
