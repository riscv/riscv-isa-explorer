#!/usr/bin/env node
/**
 * Regenerates src/toolchain-support.json: the first Clang and GCC release
 * whose -march accepts each catalogue extension.
 *
 *   node scripts/sync_toolchain_support.mjs [--cache <dir>] [--report <file>]
 *
 * Lists the release tags with git ls-remote, then fetches one file per
 * release from raw.githubusercontent.com (see scripts/toolchain-support.mjs
 * for which file, and how each format is read). No toolchain is built or run.
 * --cache keeps the fetched files, so a second run is offline.
 *
 * The scan starts at LLVM 14 and GCC 12, the first releases with today's
 * tables. Anything already accepted there is shown as "14 or earlier".
 *
 * --report writes a Markdown summary of what changed since the committed
 * file. Its first line is `changed: true|false`, which the monthly workflow
 * reads.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  parseGccCommon,
  parseGccExtDef,
  parseLlvmFeatures,
  parseLlvmIsaInfo,
  standing,
} from './toolchain-support.mjs';
import { NON_MARCH_IDS } from '../src/marchUtils.js';
import { marchToken } from '../src/toolchainSupport.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? path.resolve(args[i + 1] ?? '') : null;
};
const cacheDir = option('--cache');
const reportPath = option('--report');
const outputPath = path.join(root, 'src', 'toolchain-support.json');

const TOOLS = {
  llvm: {
    name: 'Clang',
    repo: 'llvm/llvm-project',
    first: 14,
    // llvmorg-14.0.0 .. llvmorg-17.0.0, then llvmorg-18.1.0 onwards.
    tag: /^llvmorg-(\d+)\.[01]\.0$/,
    sources: [
      ['llvm/lib/Support/RISCVISAInfo.cpp', parseLlvmIsaInfo],
      ['llvm/lib/Target/RISCV/RISCVFeatures.td', parseLlvmFeatures],
    ],
  },
  gcc: {
    name: 'GCC',
    repo: 'gcc-mirror/gcc',
    first: 12,
    tag: /^releases\/gcc-(\d+)\.1\.0$/,
    sources: [
      ['gcc/config/riscv/riscv-ext.def', parseGccExtDef],
      ['gcc/common/config/riscv/riscv-common.cc', parseGccCommon],
    ],
  },
};

function releaseTags(tool) {
  const out = execFileSync(
    'git',
    ['ls-remote', '--tags', '--refs', `https://github.com/${tool.repo}.git`],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const byMajor = new Map();
  for (const line of out.split('\n')) {
    const tag = line.split('\t')[1]?.replace('refs/tags/', '');
    const m = tag?.match(tool.tag);
    if (!m || Number(m[1]) < tool.first) continue;
    // llvmorg-11.0.0 and llvmorg-11.1.0 both exist; the first is the release.
    if (!byMajor.has(m[1]) || tag < byMajor.get(m[1])) byMajor.set(m[1], tag);
  }
  return [...byMajor].sort((a, b) => a[0] - b[0]).map(([version, tag]) => ({ version, tag }));
}

async function fetchSource(repo, tag, file) {
  const cached = cacheDir && path.join(cacheDir, repo, tag, file);
  if (cached && fs.existsSync(cached)) return fs.readFileSync(cached, 'utf8');
  const response = await fetch(`https://raw.githubusercontent.com/${repo}/${tag}/${file}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${repo}@${tag}:${file}: HTTP ${response.status}`);
  const text = await response.text();
  if (cached) {
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    fs.writeFileSync(cached, text);
  }
  return text;
}

/* The first source a release has, parsed. A release with none is an error:
   it means the file moved again and the parser needs a look. */
async function extensionsAt(tool, tag) {
  for (const [file, parse] of tool.sources) {
    const text = await fetchSource(tool.repo, tag, file);
    if (text === null) continue;
    const extensions = parse(text);
    if (extensions.size) return extensions;
  }
  throw new Error(`${tool.repo}@${tag}: no extension table found; has the file moved?`);
}

const catalog = JSON.parse(
  fs.readFileSync(path.join(root, 'src', 'riscv_extensions.json'), 'utf8'),
);
// Keyed by -march token, so a -march string can be looked up directly. Every
// token gets an entry, an empty one when no release takes it, which is what
// lets the builder say "no GCC accepts zvabd yet" instead of skipping it.
const tokens = [
  ...new Set(
    Object.values(catalog)
      .flat()
      .filter((ext) => ext && !NON_MARCH_IDS.has(ext.id))
      .map((ext) => marchToken(ext.id))
      .filter(Boolean),
  ),
].sort();

const tools = {};
const extensions = Object.fromEntries(tokens.map((token) => [token, {}]));
for (const [key, tool] of Object.entries(TOOLS)) {
  const releases = [];
  for (const { version, tag } of releaseTags(tool)) {
    releases.push({ version, tag, extensions: await extensionsAt(tool, tag) });
  }
  tools[key] = {
    name: tool.name,
    repo: tool.repo,
    releases: releases.map(({ version, tag }) => ({ version, tag })),
  };
  for (const token of tokens) {
    const result = standing(releases, token);
    if (Object.keys(result).length) extensions[token][key] = result;
  }
}

const output = `${JSON.stringify({ tools, extensions }, null, 2)}\n`;

function changeReport(previous) {
  const lines = [];
  let changed = false;
  for (const [key, tool] of Object.entries(tools)) {
    const before = previous.tools?.[key]?.releases?.map((r) => r.version) ?? [];
    const added = tool.releases.map((r) => r.version).filter((v) => !before.includes(v));
    const moved = tokens.filter(
      (token) =>
        JSON.stringify(previous.extensions?.[token]?.[key] ?? {}) !==
        JSON.stringify(extensions[token][key] ?? {}),
    );
    if (added.length || moved.length) changed = true;
    lines.push(
      `### ${tool.name}: ${tool.releases.at(-1).version} is the newest release`,
      '',
      `- New releases scanned: ${added.join(', ') || 'none'}`,
      `- Extensions whose support changed (${moved.length}): ${moved.map((token) => `\`${token}\``).join(' ') || 'none'}`,
      '',
    );
  }
  return `changed: ${changed}\n\n${lines.join('\n')}`;
}

const previous = fs.existsSync(outputPath) ? JSON.parse(fs.readFileSync(outputPath, 'utf8')) : {};
if (reportPath) fs.writeFileSync(reportPath, changeReport(previous));
fs.writeFileSync(outputPath, output);

console.log(`Wrote ${path.relative(root, outputPath)} for ${tokens.length} -march tokens:`);
for (const [key, tool] of Object.entries(tools)) {
  const of = (test) => tokens.filter((token) => test(extensions[token][key]));
  const supported = of((e) => e?.supported).length;
  const experimental = of((e) => e?.experimental && !e.supported).length;
  const missing = of((e) => !e);
  console.log(
    `  ${tool.name} ${tool.releases[0].version}-${tool.releases.at(-1).version}: ` +
      `${supported} supported, ${experimental} experimental only, ` +
      `not accepted (${missing.length}): ${missing.join(' ')}`,
  );
}
