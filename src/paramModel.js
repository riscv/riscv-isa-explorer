/**
 * paramModel.js — every UDB parameter's state for a configuration (#596).
 *
 * Given the extensions a configuration implements and the values set so far,
 * this says, for each of UDB's parameters:
 *
 *   scope   true   UDB requires it for this configuration
 *           null   it exists only once another parameter takes a value
 *           false  not defined here (an extension it belongs to is absent)
 *   kind    fixed        an extension forces its value (Sstvala, Smmpm's MXLEN)
 *           constrained  an extension narrows it (includes 64, one of, at least)
 *           free         anything its schema allows
 *   errors  the value breaks its schema, its constraint, or a UDB rule
 *
 * It decides the same things `udb validate cfg` does: scope through
 * isaParams.parameterInScope (definedBy), values through checkSchema here, and
 * rules through paramRules.checkRequirements. The UDB Export Check compares this
 * model's verdicts with UDB's on 402 configurations, so the two cannot drift.
 *
 * Pure module: no React, no catalogue import.
 */
import { parameterDefinition, parameterInScope, parameterNames } from './isaParams.js';
import { checkRequirements } from './paramRules.js';

const UINT64_MAX = (1n << 64n) - 1n;
const DEFS = {
  'schema_defs.json#/$defs/uint64': { type: 'integer', minimum: 0, maximum: UINT64_MAX },
};

// A value is an integer only if it IS one. The schema side is different: our
// parameter data keeps integers above 2^53 as strings to preserve them in JSON,
// so a schema's enum, const, minimum and maximum are read with toBig, and a
// value with asInt. UDB rejects "4" where an integer is required, and so must
// this (#596).
const asInt = (v) =>
  typeof v === 'bigint' ? v : typeof v === 'number' && Number.isInteger(v) ? BigInt(v) : null;
const toBig = (v) => {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^(?:0x[0-9a-f]+|\d+)$/i.test(v.trim())) return BigInt(v.trim());
  return null;
};
// JSON.stringify cannot serialise BigInt; 64-bit values are BigInt.
const key = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x));
/** A value against a schema constant: numeric constants compare as integers. */
// A string constant is numeric only in a numeric context: an enum that also
// holds real numbers (MTVEC_BASE_ALIGNMENT_*, whose values above 2^53 are kept
// as strings), or const/minimum/maximum on an integer. VECTOR_LS_INDEX_MAX_EEW
// is a string enum of "8", "16", ... and must compare as text.
const same = (value, constant, numeric = typeof constant !== 'string') => {
  if (numeric) {
    const y = toBig(constant);
    if (y !== null) return asInt(value) === y;
  }
  return key(value) === key(constant);
};

/**
 * Check a value against a UDB parameter schema. Covers the keywords UDB uses:
 * type, const, enum, minimum, maximum, items (one schema or a tuple),
 * additionalItems, minItems, maxItems, uniqueItems, contains, allOf, not, and
 * the one $ref (uint64). Integers compare as BigInt, since 64-bit IDs exceed
 * JavaScript's safe range.
 *
 * @returns {string[]} problems, empty when the value is valid
 */
export function checkSchema(value, schema, path = '') {
  if (!schema || typeof schema !== 'object') return [];
  const at = path ? `${path}: ` : '';
  const errors = [];
  if (schema.$ref) {
    const def = DEFS[schema.$ref];
    if (def) errors.push(...checkSchema(value, def, path));
  }
  for (const sub of schema.allOf ?? []) errors.push(...checkSchema(value, sub, path));
  if (schema.not && checkSchema(value, schema.not, path).length === 0) {
    errors.push(`${at}value is not allowed`);
  }
  if ('const' in schema && !same(value, schema.const, schema.type !== 'string')) {
    errors.push(`${at}must be ${JSON.stringify(schema.const)}`);
  }
  const numericEnum = Array.isArray(schema.enum) && schema.enum.some((e) => typeof e === 'number');
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => same(value, e, numericEnum))) {
    errors.push(`${at}must be one of ${schema.enum.join(', ')}`);
  }
  switch (schema.type) {
    case 'boolean':
      if (typeof value !== 'boolean') errors.push(`${at}must be true or false`);
      break;
    case 'string':
      if (typeof value !== 'string') errors.push(`${at}must be text`);
      break;
    case 'integer':
      if (asInt(value) === null) errors.push(`${at}must be a whole number`);
      break;
    case 'array':
      if (!Array.isArray(value)) errors.push(`${at}must be a list`);
      break;
    default:
      break;
  }
  const n = asInt(value);
  if (n !== null) {
    if (schema.minimum !== undefined && n < toBig(schema.minimum)) {
      errors.push(`${at}must be at least ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && n > toBig(schema.maximum)) {
      errors.push(`${at}must be at most ${schema.maximum}`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${at}needs at least ${schema.minItems} entries`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${at}allows at most ${schema.maxItems} entries`);
    }
    if (schema.uniqueItems && new Set(value.map(key)).size !== value.length) {
      errors.push(`${at}entries must be unique`);
    }
    if (Array.isArray(schema.items)) {
      value.forEach((item, i) => {
        const sub = schema.items[i] ?? schema.additionalItems;
        if (sub && typeof sub === 'object') errors.push(...checkSchema(item, sub, `[${i}]`));
      });
    } else if (schema.items) {
      value.forEach((item, i) => errors.push(...checkSchema(item, schema.items, `[${i}]`)));
    }
    if (schema.contains && !value.some((item) => checkSchema(item, schema.contains).length === 0)) {
      errors.push(`${at}must contain a matching entry`);
    }
  }
  return errors;
}

/** Whether a value meets what the extensions demand of it (from resolveParams). */
function checkConstraint(value, constraint) {
  const want = constraint.value;
  switch (constraint.kind) {
    case 'equal':
      return same(value, want) ? [] : [`must be ${JSON.stringify(want)}`];
    case 'includes': {
      const missing = [].concat(want).filter((w) => !(value ?? []).some((v) => same(v, w)));
      return missing.length ? [`must include ${missing.join(', ')}`] : [];
    }
    case 'oneOf':
      return [].concat(want).some((w) => same(value, w))
        ? []
        : [`must be one of ${[].concat(want).join(', ')}`];
    case 'greaterThanOrEqual':
      return asInt(value) !== null && asInt(value) >= toBig(want)
        ? []
        : [`must be at least ${want}`];
    default:
      return [];
  }
}

/**
 * @param {object} p
 * @param {Set<string>} p.extensions UDB names (I or E for the base, Sm, ...)
 * @param {Record<string, unknown>} p.values the values set so far
 * @param {{name, kind, value, from: string[]}[]} [p.constraints] resolveParams()
 * @returns {{params: object[], summary: {required: number, set: number, invalid: number}}}
 */
export function paramStates({ extensions, values = {}, constraints = [] }) {
  const byName = new Map(constraints.filter((c) => !c.conflict).map((c) => [c.name, c]));
  // Fixed values count as set: the extension decided them.
  const effective = { ...values };
  for (const c of byName.values()) {
    if (c.kind === 'equal' && !Object.prototype.hasOwnProperty.call(effective, c.name)) {
      effective[c.name] = c.value;
    }
  }
  const includes = {};
  for (const c of byName.values()) if (c.kind === 'includes') includes[c.name] = [].concat(c.value);

  const ctx = { extensions, params: effective };
  const params = [];
  for (const name of parameterNames()) {
    const definition = parameterDefinition(name);
    const scope = parameterInScope(name, { extensions, params: effective, includes });
    const constraint = byName.get(name) ?? null;
    const kind = !constraint ? 'free' : constraint.kind === 'equal' ? 'fixed' : 'constrained';
    const isSet = Object.prototype.hasOwnProperty.call(effective, name);
    const value = isSet ? effective[name] : undefined;
    const errors = [];
    let broken = null;
    if (isSet && scope !== false) {
      errors.push(...checkSchema(value, definition?.schema));
      if (constraint) {
        errors.push(
          ...checkConstraint(value, constraint).map((e) => `${e} (${constraint.from.join(', ')})`),
        );
      }
      const rule = checkRequirements(definition, ctx);
      if (rule.holds === false) {
        broken = rule.reason ?? 'breaks a UDB rule';
        errors.push(broken);
      }
    }
    params.push({ name, scope, kind, constraint, set: isSet, value, errors, rule: broken });
  }
  const required = params.filter((p) => p.scope === true);
  return {
    params,
    summary: {
      required: required.length,
      set: required.filter((p) => p.set).length,
      invalid: params.filter((p) => p.errors.length).length,
    },
  };
}
