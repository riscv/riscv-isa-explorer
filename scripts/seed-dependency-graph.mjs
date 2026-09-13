#!/usr/bin/env node
/**
 * Seeds src/isa-dependency-graph.json from riscv-unified-db.
 *
 * This is a bootstrap/reconcile tool, NOT part of the build. The committed
 * graph is the source of truth and is maintained by hand; this script exists so
 * a human can ask "has upstream moved?" and get a diff instead of guessing.
 *
 *   node scripts/seed-dependency-graph.mjs --udb <path-to-udb-checkout>          # write
 *   node scripts/seed-dependency-graph.mjs --udb <path-to-udb-checkout> --check  # diff only
 *
 * UDB schema note (this cost us once already): extension requirements live in
 * BOTH `requirements:` at the top level and `versions[].requirements:`, and the
 * `extension:` node is either a bare `{name: X}` or a combinator
 * (`allOf`/`anyOf`) containing `{name: X}` entries. Parsing only the top-level
 * `allOf` shape silently loses D->F, Q->D, B->Zba/Zbb/Zbs and ~15 others, which
 * reads as "UDB has gaps" when in fact the parser did.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';

const args = process.argv.slice(2);
const udbFlag = args.indexOf('--udb');
const udbRoot = udbFlag === -1 ? null : args[udbFlag + 1];
const checkOnly = args.includes('--check');
if (!udbRoot || udbRoot.startsWith('--')) {
  console.error('usage: seed-dependency-graph.mjs --udb <path-to-riscv-unified-db> [--check]');
  process.exit(2);
}

const here = path.dirname(new URL(import.meta.url).pathname);
const repoRoot = path.join(here, '..');
const GRAPH_PATH = path.join(repoRoot, 'src', 'isa-dependency-graph.json');

// ---------------------------------------------------------------------------
// UDB extraction
// ---------------------------------------------------------------------------

/**
 * Extension requirements reachable from a `requirements:` node.
 *
 * UDB puts `extension:` in two structurally different places, and reading only
 * one of them loses ~44 blocks including the whole Zvl*b chain:
 *
 *   requirements:                 requirements:
 *     extension:                    allOf:
 *       name: F                       - extension: {name: Zvl32b}
 *                                     - param: {name: VLEN, greaterThanOrEqual: 64}
 *
 * Three kinds of member, treated differently:
 *
 *   allOf   — hard requirements.
 *   anyOf   — a CHOICE. Svpbmt requires S and *one of* Sv39/Sv48/Sv57; flattening
 *             that into the hard set demands all three paging modes at once.
 *   not:    — a NEGATION, and `xlen:`/`param:` are conditions, not extensions.
 *             C.yaml reads "Zca, and (not F or xlen 64 or Zcf), and (not D or
 *             Zcd)": C requires only Zca. Flattening yields "C requires F and D",
 *             which is false — C is perfectly legal without either.
 *
 * Groups mixing negation or width conditions are therefore not hard edges and
 * not clean choice groups. They are returned as `conditional` so the caller can
 * report them rather than silently guess.
 */
function extensionRequirements(requirements) {
  const hard = [];
  const choices = [];
  const conditional = [];
  const excluded = [];
  // Implementation parameters the extension constrains. These are not
  // dependencies — VLEN is not an extension — but they are the other half of
  // what makes a configuration real, and UDB states them right here.
  const params = [];

  /**
   * True when every member names an extension and nothing else. Two spellings
   * occur, depending on whether the group sits under `requirements:` or already
   * inside an `extension:` node:
   *   {extension: {name: X}}   and   {name: X}
   * A `version:` alongside the name is fine — it constrains, it does not add a
   * condition on some other extension being absent.
   */
  const optionName = (member) => {
    if (!member || typeof member !== 'object') return null;
    const keys = Object.keys(member);
    if (keys.length === 1 && member.extension && typeof member.extension.name === 'string') {
      return member.extension.name;
    }
    if (typeof member.name === 'string' && keys.every((k) => k === 'name' || k === 'version')) {
      return member.name;
    }
    return null;
  };
  const pureChoiceOptions = (members) => {
    if (!Array.isArray(members) || members.length === 0) return null;
    const names = members.map(optionName);
    return names.every(Boolean) ? names : null;
  };

  // `negated` — inside a `not:`. `guarded` — inside anyOf/oneOf/if, where a
  // negation is one branch of a condition rather than an absolute exclusion.
  // Zfinx says allOf[not: F], an unconditional "must not have F". C says
  // anyOf[not: F, xlen: 64, Zcf], which is "F absent OR 64-bit OR Zcf" and
  // excludes nothing on its own.
  const walk = (node, negated = false, guarded = false) => {
    if (Array.isArray(node)) return node.forEach((child) => walk(child, negated, guarded));
    if (!node || typeof node !== 'object') return;

    for (const [key, value] of Object.entries(node)) {
      switch (key) {
        case 'extension':
          if (negated) walk(value, true, guarded);
          else if (typeof value?.name === 'string') hard.push(value.name);
          else walk(value, negated, guarded);
          break;
        case 'name':
          if (typeof value !== 'string') break;
          if (!negated) hard.push(value);
          else if (!guarded) excluded.push(value);
          break;
        case 'param':
          // { name: VLEN, greaterThanOrEqual: 128 } and friends. Only taken
          // from unguarded, unnegated positions, same rule as extensions.
          if (!negated && !guarded && value && typeof value.name === 'string') {
            const { name, reason, ...rest } = value;
            const [kind, bound] = Object.entries(rest)[0] ?? [];
            if (kind) params.push({ name, kind, value: bound, ...(reason ? { reason } : {}) });
          }
          break;
        case 'allOf':
          walk(value, negated, guarded);
          break;
        case 'anyOf':
        case 'oneOf': {
          const options = negated ? null : pureChoiceOptions(value);
          if (options) {
            choices.push(options);
            break;
          }
          conditional.push(key);
          // A non-pure group is a condition, so its branch-specific parts are
          // dropped. But whatever EVERY branch requires is required outright:
          // Zce's three alternative configurations all demand Zca, Zcb, Zcmp
          // and Zcmt, differing only in xlen and F. Taking the intersection
          // recovers those without asserting anything a branch does not.
          if (!negated && Array.isArray(value) && value.length > 0) {
            const perBranch = value.map((branch) => new Set(extensionRequirements(branch).hard));
            const common = [...perBranch[0]].filter((name) => perBranch.every((s) => s.has(name)));
            hard.push(...common);
          }
          break;
        }
        case 'not':
          walk(value, true, guarded);
          break;
        case 'if':
          // `if: {extension: U} then: {extension: S}` — an implication, not a
          // dependency. Supm and Zicfiss use this. Neither side is walked as a
          // requirement: the antecedent is a test, and the consequent only
          // holds when it passes.
          conditional.push('if');
          break;
        case 'then':
          break;
        // param / xlen / version are conditions on an implementation, not
        // extension dependencies.
        default:
          break;
      }
    }
  };

  walk(requirements);
  return { hard, choices, conditional, excluded, params };
}

function readUdb(root) {
  const dir = path.join(root, 'spec', 'std', 'isa', 'ext');
  const graph = {};
  const known = new Set();
  const conditionalNodes = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'))) {
    const id = file.slice(0, -5);
    known.add(id);
    const doc = parseYaml(fs.readFileSync(path.join(dir, file), 'utf8'));
    if (!doc || typeof doc !== 'object') continue;
    const hard = new Set();
    const choices = [];
    const excluded = new Set();
    const params = [];
    let skipped = 0;
    for (const req of [doc.requirements, ...(doc.versions ?? []).map((v) => v?.requirements)]) {
      if (!req) continue;
      const found = extensionRequirements(req);
      found.hard.forEach((n) => hard.add(n));
      found.excluded.forEach((n) => excluded.add(n));
      for (const prm of found.params) {
        if (!params.some((x) => x.name === prm.name && x.kind === prm.kind && x.value === prm.value)) {
          params.push(prm);
        }
      }
      skipped += found.conditional.length;
      for (const options of found.choices) {
        const key = options.slice().sort().join('|');
        if (!choices.some((c) => c.slice().sort().join('|') === key)) choices.push(options);
      }
    }
    hard.delete(id); // a few files name themselves via version constraints
    if (skipped) conditionalNodes.push(`${id} (${skipped} group${skipped > 1 ? 's' : ''})`);
    if (hard.size || choices.length || excluded.size || skipped || params.length) {
      graph[id] = {
        hard: [...hard].sort(),
        choices,
        excluded: [...excluded].sort(),
        conditional: skipped > 0,
        params,
      };
    }
  }
  // Branch as well as commit. A commit hash alone cannot tell you whether you
  // are looking at upstream or at somebody's work in progress, and that
  // distinction decides what a drift report means: against main it is a real
  // divergence to reconcile, against a feature branch it is noise. A checkout
  // sitting on a WIP branch once produced 18 "drifted" nodes that read as this
  // repo being stale; main matched exactly.
  let commit = 'unknown';
  let branch = 'unknown';
  try {
    commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    branch = execFileSync('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    if (branch === 'HEAD') {
      // Detached — a worktree pinned to a ref, which is exactly how you check
      // against main without disturbing someone's working branch. Recover the
      // name from the refs pointing at this commit, or the warning below fires
      // on the one workflow it should stay quiet for.
      const at = execFileSync(
        'git',
        ['-C', root, 'branch', '-a', '--points-at', 'HEAD', '--format=%(refname:short)'],
        { encoding: 'utf8' },
      )
        .split('\n')
        .map((l) => l.trim().replace(/^origin\//, ''))
        .filter(Boolean);
      branch = at.find((b) => b === 'main' || b === 'master') || at[0] || 'detached';
    }
  } catch { /* not a git checkout — provenance degrades, extraction still works */ }
  return { graph, known, commit, branch, conditionalNodes };
}

/** Extension ids in the shipped catalog. */
function readCatalogIds() {
  const cat = JSON.parse(fs.readFileSync(path.join(repoRoot, 'src', 'riscv_extensions.json'), 'utf8'));
  const ids = [];
  for (const group of Object.values(cat)) {
    if (Array.isArray(group)) group.forEach((e) => e?.id && ids.push(e.id));
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Edges we assert ourselves, where UDB is silent.
// Every entry needs a citation — an uncited edge is a guess wearing a fact's
// clothes, and this graph is meant to be auditable.
// ---------------------------------------------------------------------------
const LOCAL_EDGES = {
  Zdinx:    [{ ext: 'Zicsr', src: 'isa-manual', ref: 'Vol.I §21 — Zdinx uses the fcsr/frm/fflags CSRs' }],
  Zhinx:    [{ ext: 'Zicsr', src: 'isa-manual', ref: 'Vol.I §21 — Zhinx uses the fcsr/frm/fflags CSRs' }],
  Zhinxmin: [{ ext: 'Zicsr', src: 'isa-manual', ref: 'Vol.I §21 — Zhinxmin uses the fcsr/frm/fflags CSRs' }],
  Zfh:      [{ ext: 'Zfhmin', src: 'isa-manual', ref: 'Vol.I §16.2 — Zfh is a superset of Zfhmin' }],
  // clang implies zvfhmin for Zvfh, and Zvfh is the full vector half-precision
  // extension to Zvfhmin's conversion-only subset — the same superset relation
  // UDB *does* record for the scalar pair (Zfh -> Zfhmin). UDB's Zvfh.yaml
  // lists only Zve32f and Zfhmin, so this edge rests on clang plus the scalar
  // analogue rather than on UDB. Marked src:clang so the weaker backing shows.
  Zvfh:     [{ ext: 'Zvfhmin', src: 'clang', ref: 'clang -march=rv64i_zvfh implies +zvfhmin; UDB Zvfh.yaml is silent' }],

  // The SPMP family, ratified 8/2026 as its own specification and absent from
  // UDB entirely — so nothing above this line can produce these edges, and
  // `npm run udb:check` cannot see the extensions are missing in the first
  // place. Every edge below is quoted from the document.
  Sspmp: [
    { ext: 'Sscsrind', src: 'spec', ref: 'SPMP v1.0 §2.1 — "The Sscsrind extension for indirect CSR access must be implemented."' },
  ],
  Sspmpen: [
    { ext: 'Sspmp', src: 'spec', ref: 'SPMP v1.0 §3 — an SPMP entry is active only when spmpen[i] is set and spmpcfg[i].A is non-zero' },
  ],
  Smpmpdeleg: [
    { ext: 'Smcsrind', src: 'spec', ref: 'SPMP v1.0 §4 — "The Smcsrind extension for indirect CSR access must be implemented."' },
    { ext: 'Sspmp', src: 'spec', ref: 'SPMP v1.0 §4.1 — delegates PMP entries to S-mode, "thereby creating SPMP entries"' },
  ],
};

/** Base-ISA conflicts. Not dependencies, but they belong to the same graph. */
const CONFLICTS = {
  RV32E: [{ ext: 'F', ref: 'Vol.I §5 — RV32E has 16 GPRs and no F register file' }],
  RV64E: [{ ext: 'F', ref: 'Vol.I §5 — RV64E has 16 GPRs and no F register file' }],
};

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------
const { graph: udb, known: udbKnown, commit, branch, conditionalNodes } = readUdb(udbRoot);
const catalogIds = readCatalogIds();

/**
 * Which option to auto-select when a choice group is unsatisfied. The weakest
 * option is the honest default: it is the minimum that satisfies the
 * requirement, so it never silently buys capability the user did not ask for.
 * Ordered weakest-first; the first member present in the group wins.
 */
const WEAKEST_FIRST = ['Sv32', 'Sv39', 'Sv48', 'Sv57'];
function pickDefault(options) {
  for (const candidate of WEAKEST_FIRST) if (options.includes(candidate)) return candidate;
  return options.slice().sort()[0];
}

const nodes = {};
for (const id of catalogIds.slice().sort((a, b) => a.localeCompare(b))) {
  const requires = [];
  for (const dep of udb[id]?.hard ?? []) {
    requires.push({ ext: dep, src: 'udb', ref: `${id}.yaml requirements.extension` });
  }
  for (const local of LOCAL_EDGES[id] ?? []) {
    if (requires.some((r) => r.ext === local.ext)) continue; // UDB already covers it
    requires.push({ ext: local.ext, src: local.src, ref: local.ref });
  }
  requires.sort((a, b) => a.ext.localeCompare(b.ext));

  const node = { requires };

  const choices = udb[id]?.choices ?? [];
  if (choices.length) {
    node.requiresOneOf = choices.map((options) => ({
      options: options.slice().sort(),
      default: pickDefault(options),
      src: 'udb',
      ref: `${id}.yaml requirements.extension.anyOf`,
    }));
  }

  // Conflicts come from two places: our own base-ISA rules, and UDB's
  // unconditional `not:` clauses. The latter are real negative information —
  // Zfinx declares "not F" because it replaces the F register file — and
  // dropping them would leave nothing to stop an invalid pairing.
  const conflicts = [];
  for (const dep of udb[id]?.excluded ?? []) {
    conflicts.push({ ext: dep, src: 'udb', ref: `${id}.yaml requirements … not: ${dep}` });
  }
  for (const conflict of CONFLICTS[id] ?? []) {
    if (conflicts.some((c) => c.ext === conflict.ext)) continue;
    conflicts.push({ ext: conflict.ext, src: 'isa-manual', ref: conflict.ref });
  }
  if (conflicts.length) node.conflicts = conflicts;
  // How far to trust an empty `requires`. "udb" means UDB models this extension
  // and records no extension requirements; "none" means nothing authoritative
  // was consulted, so the emptiness is an assumption rather than a finding.
  // UDB expresses some requirements as conditionals (negations, xlen guards)
  // that this model does not represent. Record that, so an empty `requires` is
  // never read as "UDB says this extension depends on nothing" when what UDB
  // actually says is "it depends, conditionally".
  if (udb[id]?.conditional) node.conditionalRequirements = true;
  if (udb[id]?.params?.length) {
    node.params = udb[id].params.map((prm) => ({ ...prm, src: 'udb', ref: `${id}.yaml requirements … param` }));
  }

  if (requires.length === 0 && !node.requiresOneOf && !node.conditionalRequirements) {
    node.verified = udbKnown.has(id) ? 'udb' : 'none';
  }
  nodes[id] = node;
}

// Close the graph. UDB requires a few extensions our catalog does not carry
// (S -> Sm, for one), and an edge pointing at nothing is a validation error, so
// pull those in transitively. They are marked catalogued:false — they exist to
// keep traversal total, not because the UI offers them.
const pending = [];
const collectTargets = (node) => {
  for (const edge of node.requires ?? []) pending.push(edge.ext);
  for (const choice of node.requiresOneOf ?? []) pending.push(...choice.options);
};
Object.values(nodes).forEach(collectTargets);

while (pending.length) {
  const id = pending.pop();
  if (nodes[id]) continue;
  const requires = (udb[id]?.hard ?? []).map((dep) => ({
    ext: dep,
    src: 'udb',
    ref: `${id}.yaml requirements.extension`,
  }));
  const node = { requires, catalogued: false };
  if (udb[id]?.choices?.length) {
    node.requiresOneOf = udb[id].choices.map((options) => ({
      options: options.slice().sort(),
      default: pickDefault(options),
      src: 'udb',
      ref: `${id}.yaml requirements.extension.anyOf`,
    }));
  }
  if (requires.length === 0 && !node.requiresOneOf) {
    node.verified = udbKnown.has(id) ? 'udb' : 'none';
  }
  nodes[id] = node;
  collectTargets(node);
}

const graph = {
  $comment:
    'Dependency graph for RISC-V extensions. Source of truth, maintained by hand. ' +
    'Every catalog extension must appear here — tests/isa-graph.test.mjs enforces it. ' +
    'Reconcile against upstream with scripts/seed-dependency-graph.mjs --check.',
  version: 1,
  sources: {
    udb: { repo: 'riscv/riscv-unified-db', commit, branch, path: 'spec/std/isa/ext' },
    'isa-manual': { repo: 'riscv/riscv-isa-manual', note: 'section cited per edge' },
    // Edges carry src: 'clang' where neither UDB nor the manual states the
    // relation outright and the toolchain's own implication is the backing —
    // see LOCAL for Zvfh -> Zvfhmin. Declared here so a reader meeting that
    // src on an edge can tell what it rests on, and that it is the weakest of
    // the three.
    clang: {
      repo: 'llvm/llvm-project',
      note: 'RISCVISAInfo implication, cited per edge; weaker backing than udb or isa-manual',
    },
    // Ratified specifications published on their own, outside the ISA manual
    // and outside UDB. SPMP is the whole of it today. Document and section are
    // cited per edge because there is no single repository to name.
    spec: { note: 'standalone ratified specification; document and section cited per edge' },
  },
  // Sorted so a regeneration produces a reviewable diff rather than a reshuffle.
  nodes: Object.fromEntries(
    Object.keys(nodes).sort((a, b) => a.localeCompare(b)).map((id) => [id, nodes[id]]),
  ),
};

if (checkOnly) {
  if (!fs.existsSync(GRAPH_PATH)) {
    console.error(`no graph at ${GRAPH_PATH} — run without --check to seed it`);
    process.exit(1);
  }
  const committed = JSON.parse(fs.readFileSync(GRAPH_PATH, 'utf8')).nodes ?? {};
  const summarize = (node) => {
    const hard = (node?.requires ?? []).map((r) => r.ext).sort();
    const choices = (node?.requiresOneOf ?? [])
      .map((c) => `one-of(${c.options.slice().sort().join('|')})`)
      .sort();
    return [...hard, ...choices].join(',');
  };
  const drift = [];
  for (const id of [...new Set([...Object.keys(nodes), ...Object.keys(committed)])].sort()) {
    const mine = summarize(committed[id]);
    const theirs = summarize(nodes[id]);
    if (mine !== theirs) drift.push(`  ${id}: committed [${mine || '-'}] vs upstream [${theirs || '-'}]`);
  }
  // Name the branch on every outcome. Without it a drift report is ambiguous
  // between "this repo is stale" and "you are pointed at a feature branch".
  const TRUNK = ['main', 'master'];
  const where = `UDB ${commit.slice(0, 8)} (${branch})`;
  const offTrunk = branch !== 'unknown' && !TRUNK.includes(branch);
  const warning = offTrunk
    ? `\n\nNOTE: that checkout is on '${branch}', not main. Drift against a branch` +
      `\nother than the trunk usually says more about the branch than about this` +
      `\nrepository. Re-check against main before changing anything here:` +
      `\n  git -C <udb> worktree add /tmp/udb-main origin/main` +
      `\n  npm run graph:check -- /tmp/udb-main`
    : '';

  if (drift.length) {
    console.error(`drift vs ${where} in ${drift.length} node(s):\n${drift.join('\n')}${warning}`);
    process.exit(1);
  }
  console.log(`no drift — ${Object.keys(nodes).length} nodes match ${where}${warning}`);
} else {
  fs.writeFileSync(GRAPH_PATH, JSON.stringify(graph, null, 2) + '\n');
  const withDeps = Object.values(nodes).filter((n) => n.requires.length).length;
  const unverified = Object.values(nodes).filter((n) => n.verified === 'none').length;
  console.log(`wrote ${path.relative(repoRoot, GRAPH_PATH)}`);
  console.log(`  ${Object.keys(nodes).length} nodes, ${withDeps} with dependencies`);
  console.log(`  ${unverified} with no dependencies and no authoritative source (verified: none)`);
  if (conditionalNodes.length) {
    console.log(
      `\n  ${conditionalNodes.length} node(s) have conditional requirements this model does not\n` +
      '  represent (negations and xlen guards). Their unconditional edges are kept;\n' +
      '  the conditional parts are dropped rather than flattened into false hard edges:\n' +
      `    ${conditionalNodes.join(', ')}`,
    );
  }
}
