#!/usr/bin/env node
/**
 * Report what riscv-unified-db has that this catalogue does not.
 *
 *   node scripts/check-udb-completeness.mjs <path-to-riscv-unified-db> [--published | --all] [--json]
 *
 * Three scopes. The default is what upstream has ever ratified. --published
 * adds every extension the catalogue already lists, drafts included, so an
 * encoding we publish is checked even when upstream has not ratified it; it
 * still ignores drafts we do not carry. --all is every upstream extension.
 *
 * The decision logic lives in src/completeness.js, which takes no I/O so it can
 * be tested without a checkout. This file only reads YAML and prints.
 *
 * Reports; does not fail. A gate that goes red the day upstream ratifies
 * something is a gate people turn off, and the weekly sync workflow is a better
 * place to act on the result than a build.
 *
 * Why this exists: scripts/sync_udb_extensions.cjs iterates OUR catalogue, so
 * it enriches entries we already have and can never add one we lack. Nothing
 * watched the other direction until now.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareAgainstUpstream } from '../src/completeness.js';
import { readInstruction } from './udb-instruction-reader.mjs';

/** Fold exclusions into match/mask only when one legal field value remains. */
export function applyNotConstraints({ match, mask }, variables) {
  let m = match;
  let k = mask;
  const narrowed = [];

  // Separate folding is incomplete when two exclusion rules share bits.
  const constrained = variables.filter((v) => v.not?.length);
  for (let i = 0; i < constrained.length; i += 1) {
    const positions = new Set(constrained[i].positions);
    if (
      constrained.slice(i + 1).some((v) => v.positions.some((position) => positions.has(position)))
    ) {
      throw new Error('overlapping fields with not constraints are unsupported');
    }
  }

  for (const v of variables) {
    if (!v.not || v.not.length === 0) continue;
    const width = v.positions.length;
    const excluded = new Set(v.not);
    const fieldMask = v.positions.reduce((bits, position) => bits | (1n << BigInt(position)), 0n);
    const fixedMask = k & fieldMask;
    const fixedValue = m & fixedMask;
    const freePositions = v.positions.filter((position) => !(fixedMask & (1n << BigInt(position))));
    const compatibleCount = 2 ** freePositions.length;
    const compatibleExcluded = new Set(
      [...excluded].filter((candidate) => {
        const value = BigInt(candidate);
        return v.positions.every((position, index) => {
          const bit = 1n << BigInt(position);
          return (
            !(fixedMask & bit) ||
            Boolean((value >> BigInt(width - index - 1)) & 1n) === Boolean(fixedValue & bit)
          );
        });
      }),
    );
    const remaining = compatibleCount - compatibleExcluded.size;
    if (remaining === 0) {
      throw new Error(
        `not constraints exclude every value compatible with match for field ${v.name}`,
      );
    }
    if (remaining > 1) {
      narrowed.push({ field: v.name, remaining });
      continue;
    }
    if (freePositions.length === 0) continue;

    let only = null;
    for (let candidate = 0; candidate < compatibleCount; candidate += 1) {
      let value = fixedValue;
      for (let i = 0; i < freePositions.length; i += 1) {
        if ((BigInt(candidate) >> BigInt(freePositions.length - i - 1)) & 1n) {
          value |= 1n << BigInt(freePositions[i]);
        }
      }
      const fieldValue = v.positions.reduce(
        (result, position, index) =>
          result | (((value >> BigInt(position)) & 1n) << BigInt(width - index - 1)),
        0n,
      );
      if (!excluded.has(Number(fieldValue))) {
        only = value;
        break;
      }
    }
    if (only === null) {
      throw new Error(`could not resolve remaining value for field ${v.name}`);
    }
    k |= fieldMask;
    m = (m & ~fieldMask) | only;
  }

  return { match: m, mask: k, narrowed };
}

/** The XLEN a predicate pins, or null where it applies to both. */
export function predicateXlen(predicate) {
  if (!predicate || typeof predicate !== 'object') return null;
  if (Array.isArray(predicate)) {
    for (const item of predicate) {
      const found = predicateXlen(item);
      if (found != null) return found;
    }
    return null;
  }
  if (typeof predicate.xlen === 'number') return predicate.xlen;
  // Only allOf propagates a condition unconditionally: an xlen inside anyOf is
  // one alternative among several, not a requirement.
  return predicateXlen(predicate.allOf ?? null);
}

/** Read extension and instruction records from a UDB ISA directory. */
export function parseUpstream(specDir) {
  const extDir = path.join(specDir, 'ext');
  const extensions = [];
  const ratifiedExtensions = [];
  for (const file of fs.readdirSync(extDir).filter((f) => f.endsWith('.yaml'))) {
    const id = file.replace(/\.yaml$/, '');
    extensions.push(id);
    /*
     * "Ever ratified": an extension qualifies if ANY of its versions reached
     * ratified, even where a later one is frozen.
     */
    const text = fs.readFileSync(path.join(extDir, file), 'utf8');
    if (/^\s*state:\s*ratified\s*$/m.test(text)) ratifiedExtensions.push(id);
  }

  const instructions = [];
  const instRoot = path.join(specDir, 'inst');
  for (const dir of fs.readdirSync(instRoot)) {
    const sub = path.join(instRoot, dir);
    if (!fs.statSync(sub).isDirectory()) continue;
    for (const file of fs.readdirSync(sub).filter((f) => f.endsWith('.yaml'))) {
      const source = path.join(sub, file);
      const text = fs.readFileSync(source, 'utf8');
      let instruction;
      try {
        instruction = readInstruction(text, { includeEncodings: true });
      } catch (error) {
        throw new Error(`${source}: ${error.message}`);
      }
      const { name: mnemonic, owners, predicate, encodings } = instruction;

      // One entry per declared encoding: two where the file is XLEN-keyed.
      for (const enc of encodings) {
        let folded;
        try {
          folded = applyNotConstraints(enc, enc.variables);
        } catch (error) {
          throw new Error(`${source}: ${error.message}`);
        }
        instructions.push({
          mnemonic,
          // An encoding may be XLEN-keyed (`encoding: RV32: …`), and ownership
          // may be XLEN-conditioned (`definedBy: allOf: [ …, xlen: 64 ]`).
          // They are different statements and either can be present alone, so
          // both are carried rather than merged into one field.
          xlen: enc.xlen,
          ownerXlen: predicateXlen(predicate),
          match: folded.match,
          mask: folded.mask,
          narrowedFields: folded.narrowed,
          definedBy: owners,
          definedByPredicate: predicate,
        });
      }
    }
  }

  return { extensions, ratifiedExtensions, instructions };
}

/*
 * unified-db attributes the base integer instructions to a bare `I`. This
 * catalogue models the concrete bases instead, RV32I and RV64I, which is the
 * distinction a reader building an -march string actually needs.
 */
export const EXTENSION_ALIASES = { I: ['RV32I', 'RV64I', 'RV32E', 'RV64E'] };

/*
 * Instructions unified-db lists that the specification does not define, each
 * with the reason. They are left out of the gap count and printed on their
 * own, and tests/sync-tooling.test.mjs fails once upstream drops one, so an
 * entry cannot outlive the error it excuses.
 */
export const UPSTREAM_ERRATA = {};

/*
 * Exit codes match check-opcodes-drift.mjs, which the reporting workflow keys
 * off: 0 complete, 1 gaps found, 2 the checkout could not be read. Conflating
 * the last two would let a broken clone report a perfect catalogue, which is
 * the most dangerous output this tool has.
 */
function main(argv) {
  const udbRoot = argv[2];
  const asJson = argv.includes('--json');
  const includeAll = argv.includes('--all');
  const includePublished = argv.includes('--published');

  if (!udbRoot || !fs.existsSync(udbRoot)) {
    console.error(
      'usage: node scripts/check-udb-completeness.mjs <path-to-riscv-unified-db> [--published | --all] [--json]',
    );
    return 2;
  }

  const specDir = path.join(udbRoot, 'spec', 'std', 'isa');
  for (const d of ['ext', 'inst']) {
    if (!fs.existsSync(path.join(specDir, d))) {
      console.error(
        `error: ${path.join(specDir, d)} does not exist. Is this a unified-db checkout?`,
      );
      return 2;
    }
  }

  const { extensions, ratifiedExtensions, instructions } = parseUpstream(specDir);

  // A parser that silently matched nothing would report a perfect catalogue.
  if (extensions.length < 100 || instructions.length < 500) {
    console.error(
      `error: parsed only ${extensions.length} extensions and ${instructions.length} instructions. ` +
        'unified-db has likely restructured; refusing to report a clean run.',
    );
    return 2;
  }

  const catalogue = JSON.parse(
    fs.readFileSync(new URL('../src/riscv_extensions.json', import.meta.url), 'utf8'),
  );

  const result = compareAgainstUpstream(
    catalogue,
    { extensions, instructions },
    {
      extensionAliases: EXTENSION_ALIASES,
      allowMissingExtensions: Object.keys(EXTENSION_ALIASES),
      allowMissingInstructions: Object.keys(UPSTREAM_ERRATA),
      onlyRatified: !includeAll,
      includePublished,
      ratifiedExtensions,
    },
  );

  if (asJson) {
    console.log(JSON.stringify(result, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
    return result.complete ? 0 : 1;
  }

  const list = (rows, f) =>
    rows
      .map(f)
      .map((x) => `    ${x}`)
      .join('\n');

  console.log(
    `unified-db: ${extensions.length} extensions ` +
      `(${ratifiedExtensions.length} ever ratified), ${instructions.length} instructions`,
  );
  console.log(
    `scope: ${
      includeAll ? 'all upstream' : includePublished ? 'ratified + published here' : 'ratified only'
    }` + '   (--published adds drafts this catalogue lists; --all adds every draft)',
  );
  console.log(`catalogue:  ${Object.values(catalogue).flat().filter(Boolean).length} extensions\n`);

  console.log(`missing extensions (${result.missingExtensions.length}):`);
  console.log(
    result.missingExtensions.length ? list(result.missingExtensions, (x) => x) : '    none',
  );

  console.log(`\nmissing instructions (${result.missingInstructions.length}):`);
  console.log(
    result.missingInstructions.length
      ? list(result.missingInstructions, (x) => `${x.mnemonic}  (${x.definedBy.join(', ')})`)
      : '    none',
  );

  console.log(
    `\ncovered by a broader row (${result.coveredByBroaderRow.length}), of which ordering-only: ` +
      `${result.coveredByBroaderRow.filter((c) => c.orderingOnly).length}`,
  );

  if (result.encodingMismatches.length) {
    console.log(`\nsame name, different bits (${result.encodingMismatches.length}):`);
    for (const x of result.encodingMismatches) {
      console.log(`    ${x.extension} ${x.mnemonic}`);
      console.log(`      local    ${x.local}`);
      console.log(`      upstream ${x.upstream}`);
      console.log(
        x.narrower
          ? '      we pin a bit upstream leaves free'
          : '      upstream carries another encoding under this name',
      );
    }
  }

  const errata = Object.entries(UPSTREAM_ERRATA).filter(([mnemonic]) =>
    instructions.some((i) => i.mnemonic === mnemonic),
  );
  if (errata.length) {
    console.log(`\nknown upstream errors, not counted (${errata.length}):`);
    for (const [mnemonic, reason] of errata) console.log(`    ${mnemonic}  ${reason}`);
  }

  if (result.malformed.length) {
    console.log(`\nmalformed local encodings (${result.malformed.length}):`);
    console.log(list(result.malformed, (x) => `${x.extension} ${x.mnemonic}`));
  }

  /*
   * Two numbers, because they answer two questions and only the first one used
   * to be reported. "Is the encoding in the catalogue anywhere" was passing at
   * 100% while five extensions listed nothing at all — Zve32x, Zve32f, Zve64x,
   * Zve64f and Zvkb each had every instruction present under V or Zvbb, and
   * showed up here only as more attribution rows, which the gate never read.
   */
  const { coverage: cov } = result;
  console.log(`\ncoverage over ${cov.considered} upstream encodings:`);
  console.log(
    `    global (present anywhere in the catalogue)   ` +
      `${cov.global.covered}/${cov.considered}  ${cov.global.percent}%`,
  );
  console.log(
    `    per-extension (listed by an owner upstream names)  ` +
      `${cov.perExtension.covered}/${cov.considered}  ${cov.perExtension.percent}%`,
  );
  console.log(
    `      filed elsewhere ${cov.perExtension.filedElsewhere}` +
      `   encoding disagrees ${cov.perExtension.encodingDisagrees}` +
      `   absent ${cov.perExtension.uncovered}`,
  );
  if (result.attributionGroups.length) {
    console.log('      filed-elsewhere groups (upstream owner predicate):');
    for (const group of result.attributionGroups) {
      console.log(`        ${String(group.count).padStart(4)}  ${group.owners}`);
    }
  }

  // Global coverage plus local encoding integrity gate. Attribution differences are often legitimate
  // (unified-db files AMOCAS.B under Zabha, this catalogue under Zacas), so
  // per-extension coverage is a number to watch, not a threshold to pass.
  console.log(
    `\ncomplete: ${result.complete}   ` +
      '(global coverage, matching bits, and well-formed local encodings)',
  );
  return result.complete ? 0 : 1;
}

// Only run when invoked directly, so the parser can be imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  // Let stdout drain before Node exits. The JSON report is larger than the
  // common 64 KiB pipe buffer; process.exit() truncated it mid-string.
  try {
    process.exitCode = main(process.argv);
  } catch (error) {
    console.error(`UDB completeness check failed: ${error.message}`);
    process.exitCode = 2;
  }
}
