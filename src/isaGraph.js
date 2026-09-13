/**
 * isaGraph.js — the RISC-V extension dependency graph, and validated traversal.
 *
 * WHY THIS EXISTS
 * The dependency data used to be a hand-written table of ~21 extensions inside
 * marchUtils.js. Reconciling it against riscv-unified-db and clang showed the
 * table was correct as far as it went but covered under a third of what UDB
 * models, and drifted silently when it did not. The graph is now a data file
 * with per-edge provenance (src/isa-dependency-graph.json), every catalog
 * extension has a node, and CI fails if a new extension arrives without one.
 *
 * TWO KINDS OF CHECKING, AND WHY BOTH ARE NEEDED
 *   validateGraph()    — structural, selection-independent. Dangling edges,
 *                        cycles, self-edges, uncited edges, bad choice defaults.
 *                        Runs in CI over the whole graph on every commit.
 *   resolveSelection() — traversal-time, selection-dependent. A conflict that
 *                        only exists for a particular base ISA, a choice group
 *                        with nothing chosen, an extension made redundant by
 *                        another selection. None of these are properties of the
 *                        graph; they are properties of a walk through it, so no
 *                        amount of static validation finds them.
 *
 * Traversal REPORTS rather than drops. The previous implementation returned a
 * bare boolean from dependsOnIncompatible() and silently excluded the
 * extension, so "Zve64d disappeared from my RV32E config" had no explanation.
 * resolveSelection() returns the path that caused it.
 *
 * Note: unlike marchUtils.js this module does import its data file. The graph
 * IS the model here, it is small, and splitting the two would reintroduce the
 * second source of truth this replaces.
 */
import graphData from './isa-dependency-graph.json' with { type: 'json' };

export const DEPENDENCY_GRAPH = graphData;

/**
 * Provenance values an edge may claim. An edge citing anything else is a bug.
 *
 * 'spec' is for the ratified standalone specifications — the ones that are
 * neither in the ISA manual nor modelled by unified-db. SPMP is the case that
 * forced it: ratified 8/2026, absent from UDB, and its dependency on Sscsrind
 * stated only in its own document. Cite document and section in `ref`.
 */
export const EDGE_SOURCES = new Set(['udb', 'isa-manual', 'clang', 'spec']);

// ---------------------------------------------------------------------------
// Derived views (same shape as the flat tables they replace)
// ---------------------------------------------------------------------------

/**
 * A node the extension catalog actually offers. A few nodes exist only to keep
 * the graph closed — UDB's S requires Sm, which our catalog does not carry — and
 * those must not surface in views that feed the UI, since nothing downstream can
 * resolve them. The graph itself keeps them; only these flat views filter.
 */
const isCatalogued = (id) => graphData.nodes[id]?.catalogued !== false;

/** `{ D: ['F'], ... }` — hard requirements, catalogued extensions only. */
export const SMART_DEPENDENCIES = Object.fromEntries(
  Object.entries(graphData.nodes)
    .filter(([id]) => isCatalogued(id))
    .map(([id, node]) => [id, (node.requires ?? []).map((r) => r.ext).filter(isCatalogued)])
    .filter(([, deps]) => deps.length > 0),
);

/** `{ RV32E: ['F'], ... }` — declared conflicts, catalogued extensions only. */
export const INCOMPATIBLE_WITH = Object.fromEntries(
  Object.entries(graphData.nodes)
    .filter(([id]) => isCatalogued(id))
    .map(([id, node]) => [id, (node.conflicts ?? []).map((c) => c.ext).filter(isCatalogued)])
    .filter(([, conflicts]) => conflicts.length > 0),
);

// ---------------------------------------------------------------------------
// Structural validation
// ---------------------------------------------------------------------------

/**
 * Checks the graph is well formed, independent of any selection.
 *
 * @param {object} graph the graph document ({ nodes: {...} })
 * @param {string[]|null} catalogIds if given, enforces node-per-extension both ways
 * @returns {{errors: string[], warnings: string[], stats: object}}
 */
export function validateGraph(graph = graphData, catalogIds = null) {
  const errors = [];
  const warnings = [];
  const nodes = graph?.nodes ?? {};
  const ids = Object.keys(nodes);
  const has = (id) => Object.prototype.hasOwnProperty.call(nodes, id);

  for (const [id, node] of Object.entries(nodes)) {
    const requires = node.requires ?? [];
    if (!Array.isArray(requires)) {
      errors.push(`${id}: requires must be an array`);
      continue;
    }

    const seenTargets = new Set();
    for (const edge of requires) {
      if (!edge || typeof edge.ext !== 'string') {
        errors.push(`${id}: edge without an "ext"`);
        continue;
      }
      if (edge.ext === id) errors.push(`${id}: requires itself`);
      if (!has(edge.ext)) errors.push(`${id} -> ${edge.ext}: no such node (dangling edge)`);
      if (seenTargets.has(edge.ext)) errors.push(`${id} -> ${edge.ext}: duplicate edge`);
      seenTargets.add(edge.ext);
      if (!EDGE_SOURCES.has(edge.src)) {
        errors.push(
          `${id} -> ${edge.ext}: src "${edge.src}" is not one of ${[...EDGE_SOURCES].join(', ')}`,
        );
      }
      // An uncited edge cannot be audited, and an unauditable graph is one
      // nobody can safely change later.
      if (!edge.ref || !String(edge.ref).trim()) {
        errors.push(`${id} -> ${edge.ext}: missing "ref" citation`);
      }
    }

    for (const choice of node.requiresOneOf ?? []) {
      const options = choice.options ?? [];
      if (options.length < 2) errors.push(`${id}: requiresOneOf group needs at least two options`);
      for (const option of options) {
        if (!has(option)) errors.push(`${id} -> one-of ${option}: no such node`);
      }
      if (!options.includes(choice.default)) {
        errors.push(`${id}: requiresOneOf default "${choice.default}" is not among its options`);
      }
      if (!EDGE_SOURCES.has(choice.src)) {
        errors.push(`${id}: requiresOneOf src "${choice.src}" is not a known source`);
      }
      if (!choice.ref || !String(choice.ref).trim()) {
        errors.push(`${id}: requiresOneOf group missing "ref" citation`);
      }
    }

    for (const conflict of node.conflicts ?? []) {
      if (!has(conflict.ext)) errors.push(`${id} conflicts with ${conflict.ext}: no such node`);
      if (conflict.ext === id) errors.push(`${id}: conflicts with itself`);
      if (!conflict.ref || !String(conflict.ref).trim()) {
        errors.push(`${id} conflicts with ${conflict.ext}: missing "ref" citation`);
      }
    }

    if (
      requires.length === 0 &&
      !node.requiresOneOf &&
      !node.verified &&
      !node.conditionalRequirements
    ) {
      warnings.push(`${id}: no dependencies and no "verified" marker — checked, or assumed?`);
    }
  }

  errors.push(...findCycles(nodes));

  if (catalogIds) {
    const inGraph = new Set(ids);
    for (const id of catalogIds) {
      if (!inGraph.has(id)) {
        errors.push(
          `${id} is in the catalog but has no graph node — add one to isa-dependency-graph.json`,
        );
      }
    }
    const inCatalog = new Set(catalogIds);
    for (const id of ids) {
      if (!inCatalog.has(id)) warnings.push(`${id} has a graph node but is not in the catalog`);
    }
  }

  return {
    errors,
    warnings,
    stats: {
      nodes: ids.length,
      withDependencies: ids.filter((id) => (nodes[id].requires ?? []).length > 0).length,
      edges: ids.reduce((total, id) => total + (nodes[id].requires ?? []).length, 0),
      unverified: ids.filter((id) => nodes[id].verified === 'none').length,
    },
  };
}

/** Every dependency cycle, reported once per cycle as a readable path. */
function findCycles(nodes) {
  const found = [];
  const state = new Map(); // id -> 'visiting' | 'done'
  const stack = [];

  const walk = (id) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') {
      const from = stack.indexOf(id);
      found.push(`dependency cycle: ${[...stack.slice(from), id].join(' -> ')}`);
      return;
    }
    state.set(id, 'visiting');
    stack.push(id);
    for (const edge of nodes[id]?.requires ?? []) {
      if (nodes[edge.ext]) walk(edge.ext); // dangling edges are reported separately
    }
    stack.pop();
    state.set(id, 'done');
  };

  for (const id of Object.keys(nodes)) walk(id);
  return found;
}

// ---------------------------------------------------------------------------
// Traversal
// ---------------------------------------------------------------------------

/**
 * Transitive hard requirements of `id`, excluding `id` itself.
 * Cycle-safe: a cycle yields a finite set rather than blowing the stack, so a
 * malformed graph degrades instead of taking the UI down with it.
 */
export function closure(id, graph = graphData) {
  const out = new Set();
  const walk = (current) => {
    for (const edge of graph.nodes?.[current]?.requires ?? []) {
      if (out.has(edge.ext)) continue;
      out.add(edge.ext);
      walk(edge.ext);
    }
  };
  walk(id);
  out.delete(id);
  return out;
}

/**
 * Walks the graph for a selection, validating as it goes.
 *
 * @param {object}   options
 * @param {string[]} options.selected  extension ids the user picked
 * @param {string}   [options.base]    base ISA id, e.g. 'RV32E'
 * @param {object}   [options.graph]
 * @param {boolean}  [options.applyChoiceDefaults=true] auto-satisfy one-of groups
 * @returns {{
 *   resolved: string[],
 *   implied: Array<{ext: string, path: string[]}>,
 *   redundant: Array<{ext: string, impliedBy: string[]}>,
 *   conflicts: Array<{ext: string, with: string, path: string[], ref: string}>,
 *   choices: Array<{node: string, options: string[], satisfiedBy: string|null, applied: string|null}>,
 *   unknown: Array<{ext: string, from: string|null}>
 * }}
 */
export function resolveSelection({
  selected = [],
  base = null,
  graph = graphData,
  applyChoiceDefaults = true,
} = {}) {
  const nodes = graph?.nodes ?? {};
  const resolved = new Set();
  const implied = [];
  const unknown = [];
  const pathTo = new Map(); // ext -> shortest known path from a selected root

  const seed = [...new Set(selected.filter(Boolean))];
  for (const id of seed) if (!nodes[id]) unknown.push({ ext: id, from: null });
  if (base && !nodes[base]) unknown.push({ ext: base, from: null });

  // Breadth-first, so `path` is the shortest explanation rather than an
  // arbitrary one — the path is shown to users, so it should be the clearest.
  const queue = [];
  for (const id of seed) {
    if (!nodes[id]) continue;
    resolved.add(id);
    pathTo.set(id, [id]);
    queue.push({ id, path: [id] });
  }

  while (queue.length) {
    const { id, path } = queue.shift();
    for (const edge of nodes[id]?.requires ?? []) {
      if (!nodes[edge.ext]) {
        if (!unknown.some((u) => u.ext === edge.ext && u.from === id)) {
          unknown.push({ ext: edge.ext, from: id });
        }
        continue;
      }
      if (resolved.has(edge.ext)) continue; // already explained by a shorter path
      const next = [...path, edge.ext];
      resolved.add(edge.ext);
      pathTo.set(edge.ext, next);
      implied.push({ ext: edge.ext, path: next });
      queue.push({ id: edge.ext, path: next });
    }
  }

  // One-of groups. Selection-dependent by nature: whether a group is satisfied
  // depends on what else the user picked, so it cannot be settled statically.
  const choices = [];
  for (const id of [...resolved]) {
    for (const choice of nodes[id]?.requiresOneOf ?? []) {
      // Prefer what the user actually picked. Options are often nested (Sv48
      // requires Sv39), so resolving Sv48 also resolves Sv39 — reporting the
      // latter as the satisfier would credit a choice the user never made.
      const satisfiedBy =
        choice.options.find((option) => seed.includes(option)) ??
        choice.options.find((option) => resolved.has(option)) ??
        null;
      let applied = null;
      if (!satisfiedBy && applyChoiceDefaults && nodes[choice.default]) {
        applied = choice.default;
        const basePath = pathTo.get(id) ?? [id];
        for (const ext of [applied, ...closure(applied, graph)]) {
          if (resolved.has(ext)) continue;
          const next = ext === applied ? [...basePath, ext] : [...basePath, applied, ext];
          resolved.add(ext);
          pathTo.set(ext, next);
          implied.push({ ext, path: next });
        }
      }
      choices.push({ node: id, options: [...choice.options], satisfiedBy, applied });
    }
  }

  // Conflicts, reported with the path that pulled the offending extension in —
  // "D conflicts with RV32E" is useless when the user never picked D.
  const conflicts = [];
  const candidates = base ? [base, ...resolved] : [...resolved];
  for (const holder of new Set(candidates)) {
    for (const conflict of nodes[holder]?.conflicts ?? []) {
      if (holder === conflict.ext) continue;
      if (!resolved.has(conflict.ext) && conflict.ext !== base) continue;
      conflicts.push({
        ext: conflict.ext,
        with: holder,
        path: pathTo.get(conflict.ext) ?? [conflict.ext],
        ref: conflict.ref ?? '',
      });
    }
  }

  // Redundancy: a selected extension another selection already implies.
  const redundant = [];
  for (const id of seed) {
    const impliedBy = seed.filter((other) => other !== id && closure(other, graph).has(id));
    if (impliedBy.length) redundant.push({ ext: id, impliedBy });
  }

  return { resolved: [...resolved], implied, redundant, conflicts, choices, unknown };
}

/**
 * Implementation parameters a selection constrains.
 *
 * These are the other half of a configuration. -march can express only one of
 * them — VLEN, and then only obliquely, through the Zvl*b extensions — but a
 * configuration handed to riscv-config or to hardware needs the rest.
 *
 * Constraints from different extensions are merged, and the merge is where the
 * meaning lives:
 *
 *   greaterThanOrEqual  the largest floor wins. Zvl64b and Zvl128b together
 *                       mean VLEN >= 128, not two separate demands.
 *   includes            union. Sv32 and Sv39 together mean SXLEN must offer
 *                       both 32 and 64.
 *   oneOf               intersection: each extension narrows the field. Za64rs
 *                       permits fewer strategies than Za128rs, so together the
 *                       stricter list stands.
 *   equal               all must agree. Disagreement is a real conflict and is
 *                       reported rather than silently resolved.
 *
 * @returns {Array<{name, kind, value, from: string[], reason?: string, conflict?: string}>}
 */
export function resolveParams(ids, graph = graphData) {
  const byName = new Map();

  for (const id of ids) {
    for (const prm of graph.nodes?.[id]?.params ?? []) {
      const existing = byName.get(prm.name);
      if (!existing) {
        byName.set(prm.name, {
          name: prm.name,
          kind: prm.kind,
          value: Array.isArray(prm.value) ? [...prm.value] : prm.value,
          from: [id],
          ...(prm.reason ? { reason: prm.reason } : {}),
        });
        continue;
      }
      existing.from.push(id);

      if (prm.kind !== existing.kind) {
        existing.conflict = `${prm.name} is constrained as both ${existing.kind} and ${prm.kind}`;
        continue;
      }
      switch (prm.kind) {
        case 'greaterThanOrEqual':
          existing.value = Math.max(existing.value, prm.value);
          break;
        case 'includes': {
          const set = new Set([].concat(existing.value, prm.value));
          existing.value = [...set].sort((a, b) => (a > b ? 1 : -1));
          break;
        }
        case 'oneOf': {
          const allowed = new Set(prm.value);
          const narrowed = [].concat(existing.value).filter((v) => allowed.has(v));
          if (narrowed.length === 0) {
            existing.conflict = `${prm.name}: ${existing.from.join(' and ')} allow no common value`;
          } else {
            existing.value = narrowed;
          }
          break;
        }
        case 'equal':
          if (existing.value !== prm.value) {
            existing.conflict = `${prm.name}: ${existing.from.join(' and ')} require ${existing.value} and ${prm.value}`;
          }
          break;
        default:
          break;
      }
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The VLEN floor a selection implies, or null when it has no vector extension.
 * Vector length is set by picking a Zvl*b extension rather than by a flag, so
 * this is the number a user actually chose without necessarily realising it.
 */
export function impliedVlen(ids, graph = graphData) {
  const vlen = resolveParams(ids, graph).find((p) => p.name === 'VLEN');
  return vlen && vlen.kind === 'greaterThanOrEqual' ? vlen.value : null;
}

/** The Zvl*b extension that sets a given VLEN floor, for the reverse direction. */
export function vlenExtension(bits, graph = graphData) {
  const id = `Zvl${bits}b`;
  return graph.nodes?.[id] ? id : null;
}

/** One-line explanation of why `ext` is in a resolution, for UI and errors. */
export function explain(ext, result) {
  const hit = result.implied.find((entry) => entry.ext === ext);
  return hit ? hit.path.join(' -> ') : `${ext} was selected directly`;
}
