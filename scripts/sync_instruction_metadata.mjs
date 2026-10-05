#!/usr/bin/env node

// Extract instruction prose and ownership from riscv-unified-db without
// touching the hand-maintained encoding dictionary or generated instruction
// encodings. The catalogue remains the allowlist: upstream-only instructions
// are reported, never silently added to the UI.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const udbRoot = path.resolve(process.argv[2] || path.join(root, '..', 'riscv-unified-db'));
const checkOnly = process.argv.includes('--check');
const revisionArg = process.argv.find((arg) => arg.startsWith('--revision='))?.slice(11);
const instRoot = path.join(udbRoot, 'spec', 'std', 'isa', 'inst');
const catalogPath = path.join(root, 'src', 'riscv_extensions.json');
const outputPath = path.join(root, 'src', 'instruction-metadata.json');

if (!fs.existsSync(instRoot)) {
  throw new Error(`Unified DB instruction directory not found: ${instRoot}`);
}

const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
const catalogNames = new Set(
  Object.values(catalog)
    .flat()
    .flatMap((extension) =>
      Object.keys(extension.instructions || {}).map((name) => name.toLowerCase()),
    ),
);

function yamlFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return yamlFiles(target);
    return entry.isFile() && entry.name.endsWith('.yaml') ? [target] : [];
  });
}

const files = yamlFiles(instRoot).sort();
const byName = new Map();
for (const file of files) {
  const instruction = YAML.parse(fs.readFileSync(file, 'utf8'));
  if (instruction?.kind !== 'instruction' || !instruction.name) continue;
  const name = String(instruction.name).toLowerCase();
  if (byName.has(name)) throw new Error(`Duplicate UDB instruction name: ${name}`);
  byName.set(name, { file, instruction });
}

const revision = revisionArg
  ? revisionArg
  : execFileSync('git', ['-C', udbRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const metadata = {};
for (const name of [...catalogNames].sort((a, b) => a.localeCompare(b))) {
  const source = byName.get(name);
  if (!source) continue;
  const { instruction } = source;
  metadata[name] = {
    long_name: instruction.long_name || '',
    description: typeof instruction.description === 'string' ? instruction.description.trim() : '',
    defined_by: instruction.definedBy || null,
    source: `https://github.com/riscv/riscv-unified-db/blob/${revision}/${path
      .relative(udbRoot, source.file)
      .split(path.sep)
      .join('/')}`,
    source_revision: revision,
  };
}

const output = `${JSON.stringify(metadata, null, 2)}\n`;
if (checkOnly) {
  const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
  if (current !== output) {
    console.error('Instruction metadata is stale; run npm run sync:instruction-metadata.');
    process.exitCode = 1;
  }
} else {
  fs.writeFileSync(outputPath, output);
  const missing = [...catalogNames].filter((name) => !byName.has(name)).sort();
  console.log(
    `Wrote ${Object.keys(metadata).length} instruction records at UDB ${revision}; ` +
      `${missing.length} catalogue mnemonics have no UDB record.`,
  );
  if (missing.length) console.log(`No UDB source: ${missing.join(', ')}`);
}
