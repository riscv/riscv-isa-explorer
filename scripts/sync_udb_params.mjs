#!/usr/bin/env node
/**
 * Generate src/isa-params.json from riscv-unified-db's parameter definitions.
 *
 * WHAT A PARAMETER IS
 *
 * UDB's spec/std/isa/param/*.yaml describe the knobs a real implementation must
 * settle: PHYS_ADDR_WIDTH, MTVEC_MODES, CACHE_BLOCK_SIZE and so on. They are not
 * ISA selection. Choosing Zba does not choose a cache block size.
 *
 * SCOPE: definitions only. This script records what a parameter IS. It records
 * no values, chooses none, and implies none. The catalogue's own constraints
 * live in isa-dependency-graph.json and stay there; this file is what those
 * constraints refer TO. Keeping the two apart is what lets the graph carry a
 * citation per edge while this file carries none: it asserts nothing that UDB
 * does not already assert.
 *
 * definedBy IS PRESERVED STRUCTURALLY, NOT FLATTENED
 *
 * The obvious shape is {param: owningExtension}, and it is wrong. definedBy is a
 * predicate tree: it nests the extension under an `extension:` key, combines
 * with allOf/anyOf, and in 23 of the 228 files it is gated on another
 * PARAMETER'S VALUE rather than on an extension at all (PMP_GRANULARITY exists
 * only when NUM_PMP_ENTRIES is non-zero). Flattening that to a single owner
 * would quietly turn "exists under these conditions" into "belongs to this
 * extension", and a later consumer could not tell the difference. It is copied
 * verbatim so a scope evaluator can be written later without re-syncing.
 *
 * Usage: node scripts/sync_udb_params.mjs <path-to-riscv-unified-db>
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';

const udbDir = process.argv[2];
if (!udbDir) {
  console.error('Usage: node scripts/sync_udb_params.mjs <path-to-riscv-unified-db>');
  process.exit(2);
}

const paramDir = path.join(udbDir, 'spec', 'std', 'isa', 'param');
if (!fs.existsSync(paramDir)) {
  console.error(`Could not find ${paramDir}`);
  process.exit(2);
}

function udbCommit() {
  try {
    return execFileSync('git', ['-C', udbDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    // A tarball or an export has no git dir. Recording "unknown" is honest and
    // still lets the file be regenerated; failing here would block a sync for a
    // reason that has nothing to do with the data.
    return 'unknown';
  }
}

/**
 * 138 of the 228 parameters carry `long_name: TODO` upstream: the field exists,
 * unified-db has not filled it in yet, and it is not a name. Copying it through
 * puts the string "TODO" in front of a description in this app's UI and in every
 * exported config, which reads as OUR placeholder rather than theirs. Recorded as
 * absent instead, so consumers fall back to the schema summary, which is real.
 * When upstream fills one in, the next daily sync picks it up.
 */
const PLACEHOLDER_NAME = /^(todo|tbd|fixme|xxx|n\/a|none)\.?$/i;
function longName(value) {
  const flat = oneLine(value);
  return flat && !PLACEHOLDER_NAME.test(flat) ? flat : null;
}

/**
 * BigInt out, JSON-safe in: a Number when it round-trips exactly, otherwise the
 * exact value as a decimal string. Consumers that only display a value need no
 * change; one that computes on a huge bound must notice the string, which is the
 * point. Silently handing back a rounded double is the failure being avoided.
 */
/**
 * YAML folded and literal scalars carry newlines, and both of these fields end up
 * inside single-line YAML comments in an exported config. A newline there does
 * not wrap the comment, it ENDS it, and the rest of the sentence becomes a bare
 * line the parser rejects. Collapsed here, once, rather than at each of the
 * places that render it.
 */
function oneLine(value) {
  if (typeof value !== 'string') return null;
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length ? flat : null;
}

function normalise(value) {
  if (typeof value === 'bigint') {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (Array.isArray(value)) return value.map(normalise);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalise(v)]));
  }
  return value;
}

const files = fs
  .readdirSync(paramDir)
  .filter((f) => f.endsWith('.yaml'))
  .sort();
const params = {};
const problems = [];

for (const file of files) {
  const raw = fs.readFileSync(path.join(paramDir, file), 'utf8');
  let doc;
  try {
    // intAsBigInt because these schemas carry values past 2**53: CACHE_BLOCK_SIZE
    // enumerates powers of two up to 2**63 and HPM_EVENTS bounds at 2**64. Parsed
    // as doubles they come back rounded, and a data file that quietly rounds its
    // own source is worse than one that omits it. normalise() below keeps the
    // safe ones as numbers and carries the rest as exact decimal strings.
    doc = YAML.parse(raw, { intAsBigInt: true });
  } catch (err) {
    problems.push(`${file}: unparseable (${err.message})`);
    continue;
  }
  if (!doc || typeof doc !== 'object') {
    problems.push(`${file}: empty document`);
    continue;
  }
  const name = doc.name;
  if (!name) {
    problems.push(`${file}: no name`);
    continue;
  }
  if (params[name]) {
    problems.push(`${name}: defined by both ${params[name].src} and ${file}`);
    continue;
  }
  if (!doc.schema) problems.push(`${name}: no schema`);
  if (!doc.definedBy) problems.push(`${name}: no definedBy`);

  params[name] = {
    name,
    long_name: longName(doc.long_name),
    description: oneLine(doc.description),
    schema: normalise(doc.schema ?? null),
    definedBy: normalise(doc.definedBy ?? null),
    ...(doc.requirements ? { requirements: normalise(doc.requirements) } : {}),
    src: file,
  };
}

if (problems.length) {
  console.error(`${problems.length} problem(s) in the upstream parameter files:`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

const out = {
  $comment:
    'UDB parameter DEFINITIONS. Generated by scripts/sync_udb_params.mjs — do not edit by hand. ' +
    'Definitions only: what each parameter is, what values it admits, and the conditions under ' +
    'which it exists. No values are chosen here. Parameter CONSTRAINTS live in ' +
    'isa-dependency-graph.json and refer to these names; tests/isa-params.test.mjs enforces that ' +
    'every constraint names a parameter defined here and carries a value its schema admits.',
  version: 1,
  sources: {
    udb: {
      repo: 'riscv/riscv-unified-db',
      commit: udbCommit(),
      branch: 'main',
      path: 'spec/std/isa/param',
    },
  },
  // Sorted so a re-sync of unchanged upstream data produces a byte-identical
  // file and the daily job opens no pull request.
  params: Object.fromEntries(
    Object.keys(params)
      .sort()
      .map((k) => [k, params[k]]),
  ),
};

const dest = path.join(process.cwd(), 'src', 'isa-params.json');
fs.writeFileSync(dest, `${JSON.stringify(out, null, 2)}\n`);
console.log(`Wrote ${Object.keys(params).length} parameter definitions to src/isa-params.json`);
