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
import { checkSchema } from '../../src/paramModel.js';

// Values that satisfy UDB's IDL rules for common parameters, so the value noise
// stays low. Not required for correctness: the check ignores value failures.
const GOOD_VALUES = {
  MSTATUS_FS_LEGAL_VALUES: [0, 1, 2, 3],
  MSTATUS_VS_LEGAL_VALUES: [0, 1, 2, 3],
  PHYS_ADDR_WIDTH: 34,
};

// 'low' picks the smallest valid value (false, minimum, first enum, one list
// entry); 'high' the largest (true, maximum, last enum, every list entry). The
// two break different UDB rules, which is the point: the check compares the
// builder's rule verdicts with UDB's, and a rule nothing breaks is not tested.
function pick(schema, xlen, strategy = 'low') {
  const high = strategy === 'high';
  if (!schema || typeof schema !== 'object') return null;
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum)) return high ? schema.enum.at(-1) : schema.enum[0];
  if (schema.type === 'boolean') return high;
  if (schema.type === 'integer') {
    if (high && schema.maximum !== undefined) return schema.maximum;
    return schema.minimum ?? 0;
  }
  if (schema.type === 'string') return '';
  if (schema.type === 'array') {
    if (schema.items && Array.isArray(schema.items.enum)) {
      if (high) return schema.items.enum.slice(0, schema.maxItems ?? schema.items.enum.length);
      return [schema.items.enum.includes(xlen) ? xlen : schema.items.enum[0]];
    }
    const length = schema.minItems ?? 1;
    if (Array.isArray(schema.items)) {
      const head = schema.items.map((item) => pick(item, xlen, strategy));
      while (head.length < length) head.push(pick(schema.additionalItems ?? {}, xlen, strategy));
      return head;
    }
    const item = pick(schema.items ?? {}, xlen, strategy);
    return Array.from({ length }, () => item ?? xlen);
  }
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    for (const branch of schema[key] ?? []) {
      const value = pick(branch, xlen, strategy);
      if (value !== null) return value;
    }
  }
  if (typeof schema.$ref === 'string') {
    if (/bool/i.test(schema.$ref)) return high;
    if (/uint|bit|int/i.test(schema.$ref)) return 0;
  }
  return null;
}

// Our data keeps integers above 2^53 as strings; UDB needs real integers.
const asNumber = (v) => {
  if (Array.isArray(v)) return v.map(asNumber);
  if (typeof v === 'string' && /^\d+$/.test(v)) {
    const n = BigInt(v);
    return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n;
  }
  return v;
};

// A pick can still break its schema (ARCH_ID_VALUE is a uint64 that is not 0),
// so it is checked and, if need be, replaced by the first small value that fits.
function valueFor(name, xlen, strategy) {
  const schema = parameterDefinition(name)?.schema;
  const first = asNumber(rawValueFor(name, xlen, strategy));
  if (first === null || !schema || checkSchema(first, schema).length === 0) return first;
  for (const candidate of [1, 4, 32, 64, true, false]) {
    if (checkSchema(candidate, schema).length === 0) return candidate;
  }
  return first;
}

function rawValueFor(name, xlen, strategy) {
  if (strategy === 'low') {
    if (name in GOOD_VALUES) return GOOD_VALUES[name];
    if (/XLEN$/.test(name)) return [xlen];
    if (name === 'MTVAL_WIDTH' || name === 'STVAL_WIDTH') return xlen;
  }
  if (name === 'MXLEN') return xlen;
  return pick(parameterDefinition(name)?.schema, xlen, strategy);
}

/**
 * @param {object} doc the parsed export
 * @param {string} name a config name for UDB
 * @param {{strategy?: 'low'|'high'}} [options]
 * @returns {{doc: object, unfilled: string[]}}
 */
export function fillUdbConfig(doc, name, { strategy = 'low' } = {}) {
  const out = { ...doc, name, description: `explorer export check: ${name}` };
  out.params = { ...(doc.params ?? {}) };
  const xlen = out.params.MXLEN;
  const unfilled = [];
  for (const [key, value] of Object.entries(out.params)) {
    if (value !== null && value !== undefined) continue;
    const filled = valueFor(key, xlen, strategy);
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
      const filled = valueFor(param, xlen, strategy);
      if (filled === null) unfilled.push(param);
      out.params[param] = filled;
      added = true;
    }
    if (!added) break;
  }
  return { doc: out, unfilled };
}
