/**
 * Does the builder's parameter model agree with UDB? (#596)
 *
 * For each configuration the UDB Export Check validated, run src/paramModel.js
 * on the same extensions and values and compare its verdicts with the reasons
 * `udb validate cfg` gave:
 *
 *   rule       "Parameter requirements not met: 'X'"   vs a broken rule on X
 *   schema     "Parameter value violates the schema"    vs a schema error on X
 *   missing    "Parameter is required but missing"      vs X in scope, unset
 *   undefined  "Parameter is not defined by this config" vs X out of scope, set
 *
 * Any difference is the model being wrong about UDB, so it fails the check.
 */
import { paramStates } from '../../src/paramModel.js';

const PATTERNS = {
  rule: /^Parameter requirements not met: '([A-Z0-9_]+)'/,
  schema: /^Parameter value violates the schema: '([A-Z0-9_]+)'/,
  missing: /^Parameter is required but missing: '([A-Z0-9_]+)'/,
  undefined: /^Parameter is not defined by this config: '([A-Z0-9_]+)'/,
};

function udbVerdicts(result) {
  const out = { rule: new Set(), schema: new Set(), missing: new Set(), undefined: new Set() };
  for (const reason of result.reasons ?? []) {
    for (const [kind, re] of Object.entries(PATTERNS)) {
      const m = re.exec(String(reason));
      if (m) out[kind].add(m[1]);
    }
  }
  return out;
}

function modelVerdicts(config) {
  const extensions = new Set((config.implemented_extensions ?? []).map((e) => e.name));
  const values = config.params ?? {};
  const { params } = paramStates({ extensions, values });
  const out = { rule: new Set(), schema: new Set(), missing: new Set(), undefined: new Set() };
  for (const p of params) {
    if (p.scope === true && !p.set) out.missing.add(p.name);
    if (p.scope === false && p.set) out.undefined.add(p.name);
    if (p.rule) out.rule.add(p.name);
    if (p.errors.length > (p.rule ? 1 : 0)) out.schema.add(p.name);
  }
  return out;
}

/**
 * @param {{name: string, reasons: string[], error?: string}[]} results
 * @param {Record<string, object>} configs parsed configurations, by name
 * @returns {{name: string, kind: string, param: string, udb: boolean}[]}
 *   each disagreement: `udb` says whether UDB flagged it (the model did not)
 */
export function compareWithModel(results, configs) {
  const out = [];
  for (const result of results) {
    const config = configs[result.name];
    if (!config || result.error) continue;
    const udb = udbVerdicts(result);
    const model = modelVerdicts(config);
    // UDB stops before its scope and rule checks when a parameter has no
    // definition, breaks its schema, or an extension or version is unknown
    // (CfgArch#full_config_valid?), so only the schema verdicts compare then.
    const early = (result.reasons ?? []).some((r) =>
      /^Parameter has no definition|violates the schema|is not a known (extension|version)/.test(
        String(r),
      ),
    );
    for (const kind of early ? ['schema'] : Object.keys(PATTERNS)) {
      for (const param of udb[kind]) {
        if (!model[kind].has(param)) out.push({ name: result.name, kind, param, udb: true });
      }
      for (const param of model[kind]) {
        if (!udb[kind].has(param)) out.push({ name: result.name, kind, param, udb: false });
      }
    }
  }
  return out;
}
