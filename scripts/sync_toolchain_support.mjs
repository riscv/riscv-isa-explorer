#!/usr/bin/env node
/**
 * Regenerates src/toolchain-support.json: for each catalogue extension, the
 * first release of each tool that knows it. Clang and GCC accept it in -march
 * and binutils assembles it, which is not the same as generating code for it:
 * LLVM documents some as assembly-only, and those are marked. QEMU emulates
 * it; Linux detects it in the ISA string and reports it to user space.
 *
 *   node scripts/sync_toolchain_support.mjs [--cache <dir>] [--report <file>]
 *                                           [--allow-drop <tool>@<version>]
 *
 * Lists each project's release tags with git ls-remote, then fetches one file
 * per release (see scripts/toolchain-support.mjs for which file, and how each
 * format is read). Nothing is built or run. --cache keeps the fetched files,
 * so a second run is offline.
 *
 * Each scan starts at the first release with today's table: LLVM 14, GCC 12,
 * binutils 2.38, QEMU 7.0, Linux 6.6. Anything already known there is shown
 * as "this release or earlier".
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
  addBases,
  addBundles,
  bundlesByParts,
  addQemuImplied,
  parseBinutils,
  parseGccCommon,
  parseGccExtDef,
  parseLinux,
  parseLlvmFeatures,
  parseLlvmIsaInfo,
  parseLlvmUsage,
  parseQemu,
  standing,
  unacceptedDrops,
} from './toolchain-support.mjs';
import { NON_MARCH_IDS } from '../src/marchUtils.js';
import { closure } from '../src/isaGraph.js';
import { marchToken } from '../src/toolchainSupport.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? path.resolve(args[i + 1] ?? '') : null;
};
const cacheDir = option('--cache');
// --allow-drop llvm@24 (repeatable): accept a large fall in one release's
// extension count after checking that upstream really removed them.
const allowedDrops = new Set(
  args.flatMap((arg, i) => (args[i - 1] === '--allow-drop' ? [arg] : [])),
);
const reportPath = option('--report');
const outputPath = path.join(root, 'src', 'toolchain-support.json');

/*
 * A release's date: the annotated tag's own date where there is one (LLVM
 * 18.1.0's tag is dated the release day, 2024-03-06, while the commit it points
 * at is from a week earlier), otherwise the tagged commit's. GITHUB_TOKEN, when
 * set, lifts the API's 60-requests-an-hour anonymous limit.
 */
async function githubJson(path) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const response = await fetchRetrying(`https://api.github.com/${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

const github = (repo) => ({
  remote: `https://github.com/${repo}.git`,
  url: (tag, file) => `https://raw.githubusercontent.com/${repo}/${tag}/${file}`,
  date: async (tag) => {
    const ref = await githubJson(`repos/${repo}/git/ref/tags/${tag}`);
    if (ref.object.type === 'tag') {
      return (await githubJson(`repos/${repo}/git/tags/${ref.object.sha}`)).tagger.date;
    }
    return (await githubJson(`repos/${repo}/commits/${ref.object.sha}`)).commit.committer.date;
  },
});

/*
 * Each tool: where its tags and files live, how a release tag reads as a
 * version (`order` sorts and filters it; `version` is what the page shows),
 * the first release scanned, and the files to try, newest layout first.
 */
const TOOLS = {
  llvm: {
    name: 'Clang',
    repo: 'llvm/llvm-project',
    ...github('llvm/llvm-project'),
    // llvmorg-14.0.0 .. llvmorg-17.0.0, then llvmorg-18.1.0 onwards.
    tag: (t) => t.match(/^llvmorg-(\d+)\.[01]\.0$/)?.slice(1, 2),
    first: [14],
    sources: [
      ['llvm/lib/Support/RISCVISAInfo.cpp', parseLlvmIsaInfo],
      ['llvm/lib/Target/RISCV/RISCVFeatures.td', parseLlvmFeatures],
    ],
    // Which extensions are "Assembly Support" only (LLVM 16+).
    extra: ['llvm/docs/RISCVUsage.rst'],
  },
  gcc: {
    name: 'GCC',
    repo: 'gcc-mirror/gcc',
    ...github('gcc-mirror/gcc'),
    tag: (t) => t.match(/^releases\/gcc-(\d+)\.1\.0$/)?.slice(1, 2),
    first: [12],
    sources: [
      ['gcc/config/riscv/riscv-ext.def', parseGccExtDef],
      ['gcc/common/config/riscv/riscv-common.cc', parseGccCommon],
    ],
    // Where the lp64e ABI, and with it RV64E, shows up.
    extra: ['gcc/config/riscv/riscv.cc'],
  },
  binutils: {
    name: 'binutils',
    repo: 'sourceware.org/git/binutils-gdb.git',
    // No maintained GitHub mirror; sourceware's gitweb serves raw files.
    remote: 'https://sourceware.org/git/binutils-gdb.git',
    url: (tag, file) =>
      `https://sourceware.org/git/?p=binutils-gdb.git;a=blob_plain;f=${file};hb=${tag}`,
    // gitweb's tag page carries the tagger's date.
    date: async (tag) => {
      const page = `https://sourceware.org/git/?p=binutils-gdb.git;a=tag;h=refs/tags/${tag}`;
      const response = await fetchRetrying(page);
      const stamp = response.ok && (await response.text()).match(/datetime">([^<]+)</)?.[1];
      if (!stamp) throw new Error(`${page}: no tag date found`);
      return new Date(stamp).toISOString();
    },
    tag: (t) => {
      const m = t.match(/^binutils-(\d+)_(\d+)$/);
      return m && [m[1], m[2]];
    },
    first: [2, 38],
    sources: [['bfd/elfxx-riscv.c', parseBinutils]],
  },
  qemu: {
    name: 'QEMU',
    repo: 'qemu/qemu',
    ...github('qemu/qemu'),
    tag: (t) => t.match(/^v(\d+)\.(\d+)\.0$/)?.slice(1, 3),
    first: [7, 0],
    sources: [['target/riscv/cpu.c', parseQemu]],
    // RV_VLEN_MAX, the largest vlen= its V takes.
    extra: ['target/riscv/cpu.h'],
  },
  linux: {
    name: 'Linux',
    repo: 'torvalds/linux',
    ...github('torvalds/linux'),
    tag: (t) => t.match(/^v(\d+)\.(\d+)$/)?.slice(1, 3),
    // Before 6.6 the kernel listed only multi-letter extensions and took any
    // single letter, V included, before it could run vector code.
    first: [6, 6],
    sources: [['arch/riscv/kernel/cpufeature.c', parseLinux]],
  },
};

const compare = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  }
  return 0;
};

function releaseTags(tool) {
  const out = execFileSync('git', ['ls-remote', '--tags', '--refs', tool.remote], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const byVersion = new Map();
  for (const line of out.split('\n')) {
    const tag = line.split('\t')[1]?.replace('refs/tags/', '');
    const parts = tag && tool.tag(tag);
    if (!parts) continue;
    const order = parts.map(Number);
    if (compare(order, tool.first) < 0) continue;
    const version = parts.join('.');
    // llvmorg-11.0.0 and llvmorg-11.1.0 both exist; the first is the release.
    if (!byVersion.has(version) || tag < byVersion.get(version).tag) {
      byVersion.set(version, { version, tag, order });
    }
  }
  return [...byVersion.values()]
    .sort((a, b) => compare(a.order, b.order))
    .map(({ version, tag }) => ({ version, tag }));
}

/*
 * fetch that waits out rate limits and server hiccups: a 429 or 5xx is tried
 * again up to four times, honouring Retry-After when the server sends one.
 * raw.githubusercontent.com does rate-limit a run that fetches every release.
 */
async function fetchRetrying(url, options, attempts = 5) {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, options);
    if ((response.status !== 429 && response.status < 500) || attempt === attempts) return response;
    const wait = Number(response.headers.get('retry-after')) || 5 * 2 ** (attempt - 1);
    console.warn(`${url}: HTTP ${response.status}, retrying in ${wait}s`);
    await new Promise((resolve) => setTimeout(resolve, wait * 1000));
  }
}

async function fetchSource(tool, tag, file) {
  const cached = cacheDir && path.join(cacheDir, tool.repo, tag, file);
  if (cached && fs.existsSync(cached)) return fs.readFileSync(cached, 'utf8');
  const response = await fetchRetrying(tool.url(tag, file));
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${tool.repo}@${tag}:${file}: HTTP ${response.status}`);
  const text = await response.text();
  if (cached) {
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    fs.writeFileSync(cached, text);
  }
  return text;
}

/*
 * One release: its extensions (token -> status, bases included) and, per
 * token, what the page needs to say about it: QEMU's experimental option and
 * what an implied extension came with. A release with no table found is an
 * error: it means the file moved again and the parser needs a look.
 */
async function releaseAt(key, tool, tag) {
  for (const [file, parse] of tool.sources) {
    const text = await fetchSource(tool, tag, file);
    if (text === null) continue;
    const extensions = parse(text);
    if (!extensions.size) continue;
    const extras = [];
    for (const extra of tool.extra ?? []) extras.push((await fetchSource(tool, tag, extra)) ?? '');
    const options = addBases(key, extensions, [text, ...extras]);
    for (const [token, property] of extensions.properties ?? []) {
      options.set(token, `-cpu rv64,${property}=on`);
    }
    const impliedBy =
      key === 'qemu' ? addQemuImplied(extensions, extras[0] ?? '', requires) : new Map();
    const assemblyOnly = key === 'llvm' ? parseLlvmUsage(extras[0] ?? '') : new Set();
    // Runs code: knowing every part of a bundle is knowing the bundle.
    // Reads -march literally: only note that the parts are accepted.
    const run = key === 'qemu' || key === 'linux';
    const through = run ? addBundles(extensions, bundleParts) : new Map();
    const byParts = run ? new Set() : bundlesByParts(extensions, bundleParts);
    return { extensions, options, impliedBy, assemblyOnly, through, byParts };
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

// token -> catalogue id, and token -> every token it requires, for QEMU's
// implied extensions.
const idOf = new Map();
for (const ext of Object.values(catalog).flat()) {
  const token = ext && marchToken(ext.id);
  if (token && !idOf.has(token)) idOf.set(token, ext.id);
}
const requires = new Map(
  [...idOf].map(([token, id]) => [
    token,
    [...closure(id)].map(marchToken).filter((t) => t && idOf.has(t)),
  ]),
);

const previous = fs.existsSync(outputPath) ? JSON.parse(fs.readFileSync(outputPath, 'utf8')) : {};

/* YYYY-MM-DD, reusing the committed file's date so a run only looks up new
   releases, then the cache, then the network. */
async function releaseDate(key, tool, version, tag) {
  const known = previous.tools?.[key]?.releases?.find((r) => r.version === version)?.date;
  if (known) return known;
  const cached = cacheDir && path.join(cacheDir, tool.repo, tag, '.date');
  if (cached && fs.existsSync(cached)) return fs.readFileSync(cached, 'utf8');
  const date = (await tool.date(tag)).slice(0, 10);
  if (cached) {
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    fs.writeFileSync(cached, date);
  }
  return date;
}

/*
 * Extensions the specifications define purely as a group of others, so a
 * tool that knows every part knows them (see addBundles). Their parts are the
 * dependency graph's requirements; tests/toolchain-support.test.mjs keeps
 * the same list and checks the graph still gives exactly these parts.
 *
 *   A                   Zaamo + Zalrsc (unprivileged spec)
 *   B                   Zba + Zbb + Zbs (unprivileged spec, 20240411)
 *   Zk, Zkn, Zks        scalar cryptography shorthands
 *   Zvkn, Zvknc, Zvkng,
 *   Zvks, Zvksc, Zvksg  vector cryptography shorthands
 *   Zce                 Zca + Zcb + Zcmp + Zcmt (Zc spec; Zcf too on RV32)
 *   Sha                 H + the Sh* and Ssstateen it names (privileged spec)
 */
const BUNDLES = [
  'A',
  'B',
  'Zk',
  'Zkn',
  'Zks',
  'Zvkn',
  'Zvknc',
  'Zvkng',
  'Zvks',
  'Zvksc',
  'Zvksg',
  'Zce',
  'Sha',
];
const graph = JSON.parse(
  fs.readFileSync(path.join(root, 'src', 'isa-dependency-graph.json'), 'utf8'),
);
const bundleParts = new Map(
  BUNDLES.map((id) => [
    marchToken(id),
    (graph.nodes[id]?.requires ?? []).map((edge) => marchToken(edge.ext)),
  ]),
);

const tools = {};
const extensions = Object.fromEntries(tokens.map((token) => [token, {}]));
for (const [key, tool] of Object.entries(TOOLS)) {
  const releases = [];
  for (const { version, tag } of releaseTags(tool)) {
    releases.push({
      version,
      tag,
      date: await releaseDate(key, tool, version, tag),
      ...(await releaseAt(key, tool, tag)),
    });
  }
  // Only releases this run adds are judged (see unacceptedDrops). LLVM's
  // documentation parser gets the same guard as the extension tables.
  const measures = [['extension table', (r) => r.extensions.size]];
  if (key === 'llvm') measures.push(['Assembly Support list', (r) => r.assemblyOnly.size]);
  const drops = unacceptedDrops(releases, {
    key,
    name: tool.name,
    known: new Set(previous.tools?.[key]?.releases?.map((r) => r.version) ?? []),
    allowed: allowedDrops,
    measures,
  });
  if (drops.length) {
    throw new Error(
      `a count fell sharply (${drops.join('; ')}). Check whether the source changed format; ` +
        `if upstream really removed them, rerun with --allow-drop ${key}@<version>.`,
    );
  }
  tools[key] = {
    name: tool.name,
    repo: tool.repo,
    releases: releases.map(({ version, tag, date }) => ({ version, tag, date })),
  };
  for (const token of tokens) {
    const result = standing(releases, token);
    if (!Object.keys(result).length) continue;
    // Every spelling of QEMU's switch across the experimental run, with the
    // release it first appeared in: Smaia was x-aia in 7.0 and x-smaia from
    // 7.2. The last one is what still works while it stays experimental.
    if (result.experimental) {
      const options = [];
      for (const r of releases) {
        if (r.extensions.get(token) !== 'experimental') continue;
        const option = r.options.get(token);
        if (option && option !== options.at(-1)?.option) options.push({ option, from: r.version });
      }
      if (options.length) result.options = options;
    }
    const by = releases.at(-1).impliedBy.get(token);
    if (by) result.impliedBy = idOf.get(by) ?? by;
    // As the newest release's documentation describes it today.
    if (releases.at(-1).assemblyOnly.has(token)) result.assemblyOnly = true;
    const through = releases.at(-1).through.get(token);
    if (through) result.through = through.map((t) => idOf.get(t) ?? t);
    extensions[token][key] = result;
  }
  // -march tools: from which release the bundle's parts were all accepted,
  // when that is earlier than the name itself (GCC took _zba_zbb_zbs from 12,
  // _b only from 15).
  for (const token of bundleParts.keys()) {
    if (!extensions[token]) continue;
    let i = releases.length;
    while (i > 0 && releases[i - 1].byParts.has(token)) i--;
    if (i === releases.length) continue;
    const since = releases[i].version;
    const entry = extensions[token][key] ?? {};
    const literal = releases.findIndex((r) => r.version === entry.supported);
    if (literal >= 0 && literal <= i) continue;
    entry.parts = { since, via: bundleParts.get(token).map((t) => idOf.get(t) ?? t) };
    extensions[token][key] = entry;
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
