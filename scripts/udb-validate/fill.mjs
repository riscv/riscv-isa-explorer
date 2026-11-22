/**
 * Fill a UDB export's TODO parameters with schema-valid values, the way a
 * careful engineer would, so `udb validate cfg` can judge the export's
 * STRUCTURE: whether every extension and parameter UDB requires is there
 * (#589). The values themselves mean nothing; failures they cause (an IDL rule
 * such as "with F, MSTATUS_FS_LEGAL_VALUES includes 3") are classified as
 * value failures by classify.mjs and do not fail the check.
 *
 * Gated parameters (ARCH_ID_VALUE exists only when MARCHID_IMPLEMENTED is
 * true) are added once the filled values bring them into scope, as a user
 * uncommenting the export's CONDITIONAL block would.
 */
import { parameterDefinition, parameterInScope, parameterNames } from '../../src/isaParams.js';

// Values that satisfy UDB's IDL rules for common parameters, so the value noise
// stays low. Not required for correctness: the check ignores value failures.
const GOOD_VALUES = {
  MSTATUS_FS_LEGAL_VALUES: [0, 1, 2, 3],
  MSTATUS_VS_LEGAL_VALUES: [0, 1, 2, 3],
  PHYS_ADDR_WIDTH: 34,
};

function pick(schema, xlen) {
  if (!schema || typeof schema !== 'object') return null;
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  if (schema.type === 'boolean') return false;
  if (schema.type === 'integer') return schema.minimum ?? 0;
  if (schema.type === 'string') return '';
  if (schema.type === 'array') {
    if (schema.items && Array.isArray(schema.items.enum)) {
      return [schema.items.enum.includes(xlen) ? xlen : schema.items.enum[0]];
    }
    const length = schema.minItems ?? 1;
    if (Array.isArray(schema.items)) {
      const head = schema.items.map((item) => pick(item, xlen));
      while (head.length < length) head.push(pick(schema.additionalItems ?? {}, xlen));
      return head;
    }
    const item = pick(schema.items ?? {}, xlen);
    return Array.from({ length }, () => item ?? xlen);
  }
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    for (const branch of schema[key] ?? []) {
      const value = pick(branch, xlen);
      if (value !== null) return value;
    }
  }
  if (typeof schema.$ref === 'string') {
    if (/bool/i.test(schema.$ref)) return false;
    if (/uint|bit|int/i.test(schema.$ref)) return 0;
  }
  return null;
}

function valueFor(name, xlen) {
  if (name in GOOD_VALUES) return GOOD_VALUES[name];
  if (/XLEN$/.test(name)) return [xlen];
  if (name === 'MTVAL_WIDTH' || name === 'STVAL_WIDTH') return xlen;
  return pick(parameterDefinition(name)?.schema, xlen);
}

/**
 * @param {object} doc the parsed export
 * @param {string} name a config name for UDB
 * @returns {{doc: object, unfilled: string[]}}
 */
export function fillUdbConfig(doc, name) {
  const out = { ...doc, name, description: `explorer export check: ${name}` };
  out.params = { ...(doc.params ?? {}) };
  const xlen = out.params.MXLEN;
  const unfilled = [];
  for (const [key, value] of Object.entries(out.params)) {
    if (value !== null && value !== undefined) continue;
    const filled = valueFor(key, xlen);
    if (filled === null) unfilled.push(key);
    out.params[key] = filled;
  }
  const extensions = new Set((out.implemented_extensions ?? []).map((e) => e.name));
  // A few rounds: a filled value can bring another gated parameter into scope.
  for (let round = 0; round < 4; round++) {
    let added = false;
    for (const param of parameterNames()) {
      if (param in out.params) continue;
      if (parameterInScope(param, { extensions, params: out.params }) !== true) continue;
      const filled = valueFor(param, xlen);
      if (filled === null) unfilled.push(param);
      out.params[param] = filled;
      added = true;
    }
    if (!added) break;
  }
  return { doc: out, unfilled };
}
