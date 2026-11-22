#!/usr/bin/env node
/**
 * Write the configurations `udb validate cfg` checks (#589): the UDB export of
 * every profile, and of each catalogue extension added on its own to RV64I and
 * RV32I, with TODOs filled by fill.mjs.
 *
 *   node scripts/udb-validate/generate.mjs --out <dir> [--profiles-only]
 *   node scripts/udb-validate/generate.mjs --out <dir> --selection RV64I,M,A
 *   node scripts/udb-validate/generate.mjs --out <dir> --cfg <share-link value>
 *
 * Writes <dir>/<name>.yaml per configuration and <dir>/manifest.json, which
 * maps each name to what was selected, for the report.
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { buildIsaConfigYaml } from '../../src/exportUtils.js';
import { resolveSelection } from '../../src/isaGraph.js';
import { BASE_ISA_IDS } from '../../src/marchUtils.js';
import { PROFILES } from '../../src/profiles.js';
import { decodeBuilderConfig } from '../../src/configPermalink.js';
import { fillUdbConfig } from './fill.mjs';
import { definingExtensions, parameterDefinition, parameterNames } from '../../src/isaParams.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : (args[i + 1] ?? '');
};
const outDir = flag('--out');
if (!outDir) {
  console.error(
    'usage: generate.mjs --out <dir> [--profiles-only | --selection ids | --cfg value]',
  );
  process.exit(2);
}

const catalogue = JSON.parse(
  fs.readFileSync(new URL('../../src/riscv_extensions.json', import.meta.url), 'utf8'),
);
const ALL = Object.values(catalogue).flat().filter(Boolean);
const KNOWN = new Set(ALL.map((e) => e.id));

const resolveIds = (selected) => {
  const base = selected.find((id) => BASE_ISA_IDS.has(id)) ?? null;
  const r = resolveSelection({ selected, base });
  const unresolved = r.choices.some((c) => !c.satisfiedBy && !c.applied);
  return { ids: r.resolved.filter((id) => KNOWN.has(id)), conflicts: r.conflicts, unresolved };
};

const configs = []; // { name, kind, selection, ids }
const add = (name, kind, selection) => {
  const { ids, conflicts, unresolved } = resolveIds(selection);
  if (conflicts.length || unresolved) return { skipped: true, conflicts, unresolved };
  configs.push({ name, kind, selection, ids });
  return { skipped: false };
};

const only = flag('--selection');
const cfg = flag('--cfg');
const skipped = [];
// One configuration someone asked about: a conflict is the answer, not a skip.
const single = (name, selection) => {
  const r = add(name, 'selection', selection);
  if (!r.skipped) return;
  for (const c of r.conflicts ?? []) console.error(`conflict: ${c.with} with ${c.ext}`);
  if (r.unresolved) console.error('an extension needs one of several options; pick one');
  process.exit(1);
};
if (only) {
  single(
    'selection',
    only
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
} else if (cfg) {
  const state = decodeBuilderConfig(cfg, PROFILES);
  if (!state) {
    console.error('could not decode the share link');
    process.exit(2);
  }
  single('share-link', [...state.workspaceIds]);
} else {
  for (const name of Object.keys(PROFILES)) {
    add(`profile-${name.replace(/\./g, 'p')}`, 'profile', PROFILES[name]);
  }
  if (!args.includes('--profiles-only')) {
    for (const ext of ALL) {
      if (BASE_ISA_IDS.has(ext.id) || ext.discontinued) continue;
      for (const base of ['RV64I', 'RV32I']) {
        const name = `${base.toLowerCase()}-${ext.id}`;
        if (add(name, 'extension', [base, ext.id]).skipped) skipped.push(name);
      }
    }
  }
}

// A second, 'high' fill for the profiles and for configurations whose extension
// defines a parameter that carries a UDB rule, so the builder's rule verdicts
// are compared with UDB's on values that break different rules (#596).
const RULED = new Set(
  parameterNames()
    .filter((n) => parameterDefinition(n)?.requirements)
    .flatMap((n) => definingExtensions(n)),
);
RULED.delete('Sm'); // every configuration has Sm; its rules are covered by the profiles

fs.mkdirSync(outDir, { recursive: true });
const manifest = {};
const write = (c, strategy, name) => {
  const { yaml } = buildIsaConfigYaml(c.ids, ALL, { format: 'udb' });
  const { doc, unfilled } = fillUdbConfig(YAML.parse(yaml), name, { strategy });
  fs.writeFileSync(path.join(outDir, `${name}.yaml`), YAML.stringify(doc));
  manifest[name] = { kind: c.kind, selection: c.selection, strategy, unfilled };
};
for (const c of configs) {
  write(c, 'low', c.name);
  const ext = c.kind === 'extension' ? c.selection[1] : null;
  if (c.kind === 'profile' || (ext && RULED.has(ext))) write(c, 'high', `${c.name}-high`);
}
fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `wrote ${Object.keys(manifest).length} configurations to ${outDir}` +
    (skipped.length
      ? ` (${skipped.length} skipped: conflict with the base or an open choice)`
      : ''),
);
