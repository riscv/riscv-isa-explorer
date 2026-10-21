#!/usr/bin/env node
/**
 * Compare UDB instruction owners with the extension catalogue and print a report.
 *
 * Reads YAML files recursively under spec/std/isa/inst/ in a UDB checkout and compares the
 * extension names in definedBy with IDs in src/riscv_extensions.json.
 * Reports matching owners, unknown owners and existing catalogue instructions
 * that direct owner/name matching would miss. No files are written.
 *
 * Ownership conditions are kept in the output. Listing an extension does not
 * mean it alone provides the instruction: definedBy may require other extensions,
 * a particular register width or an extension version. The comparison uses names,
 * so differences do not establish that an encoding is missing.
 *
 * Usage:
 *   node scripts/report-instruction-owners.mjs <path-to-udb>
 *
 * Exits 0 after reporting, including when matches are missing; 2 on invalid
 * arguments or a read/parse error.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { variantBase } from '../src/completeness.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const normalizeMnemonic = (name) => variantBase(name.toUpperCase());

/**
 * Collect extension names from definedBy, counting each name once.
 * For example, A AND B lists both names, but neither alone is enough to provide
 * the instruction. A AND NOT B lists only A. The reader keeps the full condition
 * for the report. Stop on unknown condition types so nothing is silently missed.
 */
export function instructionOwners(predicate) {
  const owners = new Set();
  const visit = (node, extension = false, negative = false) => {
    if (!object(node)) throw new Error('expected a definedBy condition object');
    const keys = Object.keys(node);
    if (extension && Object.hasOwn(node, 'name')) {
      if (
        typeof node.name !== 'string' ||
        !node.name ||
        /\s/.test(node.name) ||
        keys.some((key) => !['name', 'version'].includes(key)) ||
        (Object.hasOwn(node, 'version') &&
          typeof node.version !== 'string' &&
          !(Array.isArray(node.version) && node.version.every((v) => typeof v === 'string')))
      ) {
        throw new Error('unsupported extension requirement');
      }
      if (!negative) owners.add(node.name);
      return;
    }
    if (keys.length !== 1) throw new Error('expected exactly one condition operator');
    const key = keys[0];
    const value = node[key];
    if (['anyOf', 'allOf', 'oneOf', 'noneOf'].includes(key)) {
      if (!Array.isArray(value) || value.length < 2) {
        throw new Error(`${key} requires at least two conditions`);
      }
      for (const child of value) {
        visit(child, extension, key === 'noneOf' ? !negative : negative);
      }
    } else if (key === 'not') {
      visit(value, extension, !negative);
    } else if (key === 'extension' && !extension) {
      visit(value, true, negative);
    } else if (key === 'xlen' && !extension && [32, 64].includes(value)) {
      // XLEN is the CPU's register width. Keep this condition, but collect no owner.
    } else {
      throw new Error(`unsupported definedBy condition: ${key}`);
    }
  };
  visit(predicate);
  return [...owners].sort(compare);
}

function yamlFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`symbolic links are unsupported in the instruction tree: ${target}`);
    }
    if (entry.isDirectory()) return yamlFiles(target);
    return entry.isFile() && entry.name.endsWith('.yaml') ? [target] : [];
  });
}

/** Read all UDB instructions, including ones missing from the project catalogue. */
export function readInstructions(udbRoot) {
  const directory = path.join(udbRoot, 'spec', 'std', 'isa', 'inst');
  const files = yamlFiles(directory).sort(compare);
  const instructions = [];
  const seen = new Set();
  for (const file of files) {
    const source = path.relative(udbRoot, file).split(path.sep).join('/');
    try {
      const document = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
      // YAML can warn about an unknown tag and still return a value.
      // Stop on warnings too, since that value may have been read incorrectly.
      const issue = document.errors[0] ?? document.warnings[0];
      if (issue) throw issue;
      const instruction = document.toJS();
      if (!object(instruction) || instruction.kind !== 'instruction') {
        throw new Error('expected kind: instruction');
      }
      if (
        typeof instruction.name !== 'string' ||
        !instruction.name ||
        /\s/.test(instruction.name)
      ) {
        throw new Error('missing or invalid instruction name');
      }
      const name = instruction.name.toUpperCase();
      if (seen.has(name)) throw new Error(`duplicate instruction name: ${name}`);
      const owners = instructionOwners(instruction.definedBy);
      seen.add(name);
      instructions.push({ name, owners, source, definedBy: instruction.definedBy });
    } catch (error) {
      throw new Error(`${source}: ${error.message}`);
    }
  }
  if (!instructions.length) throw new Error(`no instruction YAML files found in ${directory}`);
  return instructions;
}

/** Find matching owners, unknown owners and current instructions that matching would miss. */
export function ownershipReport(catalog, instructions) {
  const entries = Object.values(catalog).flat();
  const ids = new Set(entries.map((entry) => entry.id));
  const byOwner = new Map();
  for (const instruction of instructions) {
    for (const owner of instruction.owners) {
      if (!byOwner.has(owner)) byOwner.set(owner, new Map());
      byOwner.get(owner).set(instruction.name, instruction);
    }
  }
  const owners = [...byOwner]
    .sort(([a], [b]) => compare(a, b))
    .map(([id, rows]) => ({
      id,
      instructions: [...rows.values()].sort((a, b) => compare(a.name, b.name)),
    }));
  // Keep IDs exact: UDB's I does not directly match catalogue IDs like RV32I.
  // Report that difference so the migration can account for it.
  const differences = entries
    .map((entry) => {
      const names = Object.keys(entry.instructions ?? {}).sort(compare);
      const owned = new Set([...(byOwner.get(entry.id)?.keys() ?? [])].map(normalizeMnemonic));
      const missing = names.filter((name) => !owned.has(normalizeMnemonic(name)));
      return {
        id: entry.id,
        current: names.length,
        matched: names.length - missing.length,
        missing,
      };
    })
    .filter((entry) => entry.missing.length)
    .sort((a, b) => compare(a.id, b.id));
  return {
    instructionCount: instructions.length,
    catalogueCount: entries.length,
    resolved: owners.filter((owner) => ids.has(owner.id)),
    unresolved: owners.filter((owner) => !ids.has(owner.id)),
    differences,
    ownerless: instructions
      .filter((instruction) => !instruction.owners.length)
      .sort((a, b) => compare(a.name, b.name)),
  };
}

/** Group instructions with the same condition so the report prints that condition once. */
function conditions(instructions) {
  const groups = new Map();
  for (const instruction of instructions) {
    const predicate = instruction.definedBy;
    if (predicate.extension?.name && Object.keys(predicate.extension).length === 1) continue;
    const text = JSON.stringify(predicate);
    if (!groups.has(text)) groups.set(text, []);
    groups.get(text).push(instruction.name);
  }
  return [...groups]
    .sort(([a], [b]) => compare(a, b))
    .map(([predicate, names]) => `    ${names.join(', ')}: ${predicate}`);
}

export function formatReport(report, revision) {
  const lines = [
    `UDB revision: ${revision}`,
    `Catalogue: ${report.catalogueCount} entries; UDB: ${report.instructionCount} instruction files`,
    'Owner/name matching uses standard mnemonic suffix rules; no aliases, bundles or vector derivation applied.',
    'Conditions below are preserved, not evaluated; an owner match is not a claim of availability.',
    'Differences are migration planning findings, not encoding coverage defects.',
  ];
  for (const [title, owners] of [
    ['Resolved owners', report.resolved],
    ['Unresolved owners', report.unresolved],
  ]) {
    lines.push('', `${title} (${owners.length}):`);
    if (!owners.length) lines.push('  (none)');
    for (const owner of owners) {
      const count = owner.instructions.length;
      lines.push(`  ${owner.id}: ${count} instruction${count === 1 ? '' : 's'}`);
      if (title === 'Unresolved owners') {
        for (const instruction of owner.instructions) {
          lines.push(`    ${instruction.name}: ${instruction.source}`);
        }
      }
      lines.push(...conditions(owner.instructions));
    }
  }
  lines.push(
    '',
    `Catalogue entries with direct-matching differences (${report.differences.length}):`,
  );
  if (!report.differences.length) lines.push('  (none)');
  for (const entry of report.differences) {
    lines.push(
      `  ${entry.id}: current=${entry.current}, matched_by_name=${entry.matched}, not_matched_by_name=${entry.missing.length}`,
      `    ${entry.missing.join(', ')}`,
    );
  }
  if (report.ownerless.length) {
    lines.push('', `Instructions without positive owner references (${report.ownerless.length}):`);
    for (const instruction of report.ownerless) {
      lines.push(
        `  ${instruction.name}: ${instruction.source}; ${JSON.stringify(instruction.definedBy)}`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

function main(args) {
  if (args.length !== 1 || args[0].startsWith('-')) {
    console.error('usage: node scripts/report-instruction-owners.mjs <path-to-udb>');
    return 2;
  }
  const udbRoot = path.resolve(args[0]);
  try {
    const instructions = readInstructions(udbRoot);
    const catalog = JSON.parse(
      fs.readFileSync(path.join(root, 'src', 'riscv_extensions.json'), 'utf8'),
    );
    let revision = 'unavailable (not a Git checkout)';
    // An extracted UDB folder may sit inside another Git repository.
    // Only print a commit if the repository root is the supplied UDB folder.
    try {
      const top = execFileSync('git', ['-C', udbRoot, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      if (fs.realpathSync(top) === fs.realpathSync(udbRoot)) {
        revision = execFileSync('git', ['-C', udbRoot, 'rev-parse', 'HEAD'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
      }
    } catch {
      // Allow folders without Git metadata; the report says the revision is unknown.
      revision = 'unavailable (Git provenance could not be verified)';
    }
    process.stdout.write(formatReport(ownershipReport(catalog, instructions), revision));
    return 0; // Missing matches belong in the report; they do not mean the script failed.
  } catch (error) {
    console.error(`Instruction owner report failed: ${error.message}`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
