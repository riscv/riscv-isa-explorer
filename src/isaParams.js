/**
 * UDB parameter definitions: what a parameter IS.
 *
 * This module answers "what is MTVEC_MODES, what values does it admit, and when
 * does it exist". It deliberately does not answer "what should it be". Values
 * come from two other places and neither belongs here: the catalogue's own
 * constraints in isa-dependency-graph.json, resolved by isaGraph.resolveParams,
 * and the user's own picks, carried as paramChoices.
 *
 * Pure module. No React, no catalogue import, same rule as marchUtils.js.
 */
import paramData from './isa-params.json' with { type: 'json' };

const PARAMS = paramData.params;

/** The UDB definition for a parameter name, or null when UDB does not define it. */
export function parameterDefinition(name) {
  return PARAMS[name] ?? null;
}

/** Every parameter name UDB defines, sorted. */
export function parameterNames() {
  return Object.keys(PARAMS);
}

function resolveDefinedBy(nameOrNode) {
  if (typeof nameOrNode === 'string') return PARAMS[nameOrNode]?.definedBy ?? null;
  return nameOrNode ?? null;
}

/**
 * The extension names a definedBy predicate mentions.
 *
 * Structural, not semantic: a name appearing here means the predicate refers to
 * that extension, NOT that selecting it puts the parameter in scope. An allOf of
 * two extensions needs both, and a param-gated branch may keep the parameter out
 * of scope no matter which extensions are selected. Deciding actual scope needs
 * an evaluator over extensions AND parameter values; this is the cheap question,
 * answered honestly as the cheap question.
 */
export function definingExtensions(nameOrNode) {
  const out = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    // A `param:` branch gates on a parameter VALUE. Any names inside it are
    // parameter names, not extensions, and must not leak into this list.
    if (node.param) return;
    if (node.extension) return walk(node.extension);
    if (typeof node.name === 'string') out.add(node.name);
    for (const key of ['allOf', 'anyOf', 'oneOf']) if (node[key]) walk(node[key]);
  };
  walk(resolveDefinedBy(nameOrNode));
  return [...out].sort();
}

/**
 * The parameter-value conditions a definedBy predicate depends on.
 *
 * 23 of the 228 parameters exist only when another parameter holds some value,
 * so scope is partly recursive. Returning these separately is what lets a caller
 * say "conditional on NUM_PMP_ENTRIES > 0" instead of silently including or
 * excluding the parameter, which are both wrong answers.
 */
export function gatingParameters(nameOrNode) {
  const out = [];
  const walkCondition = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walkCondition);
    if (typeof node.name === 'string') {
      const { name, reason, ...rest } = node;
      const [op, value] = Object.entries(rest)[0] ?? [null, null];
      out.push({ name, op, value, ...(reason ? { reason } : {}) });
    }
    for (const key of ['allOf', 'anyOf', 'oneOf']) if (node[key]) walkCondition(node[key]);
  };
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (node.param) return walkCondition(node.param);
    if (node.extension) return;
    for (const key of ['allOf', 'anyOf', 'oneOf']) if (node[key]) walk(node[key]);
  };
  walk(resolveDefinedBy(nameOrNode));
  return out;
}

/**
 * Whether a parameter exists in a configuration, as UDB decides it: true,
 * false, or null when the answer depends on a parameter value the caller does
 * not know (ARCH_ID_VALUE exists only when MARCHID_IMPLEMENTED is true).
 *
 * UDB's validator requires every parameter whose definedBy the configuration
 * satisfies (`CfgArch#full_config_valid?`), so the UDB export uses this to
 * decide what it must write (#588). Three-valued on purpose: guessing a
 * gated parameter in or out are both wrong answers.
 *
 * Extension versions in a predicate are not compared: the catalogue carries one
 * version per extension.
 *
 * @param {string|object} nameOrNode a parameter name or a definedBy tree
 * @param {{extensions: Set<string>, params?: Record<string, unknown>,
 *   includes?: Record<string, unknown[]>}} ctx
 *   extensions by their UDB names (I, not RV64I), known parameter values, and
 *   members a list parameter is known to contain even though its full value is
 *   not chosen (Sv39 forces SXLEN to include 64)
 * @returns {true|false|null}
 */
// Values may be BigInt (64-bit IDs parsed exactly) or Number; compare across both.
const num = (v) =>
  typeof v === 'bigint' ? v : typeof v === 'number' && Number.isInteger(v) ? BigInt(v) : null;
const same = (a, b) => (num(a) !== null && num(b) !== null ? num(a) === num(b) : a === b);

export function parameterInScope(nameOrNode, { extensions, params = {}, includes = {} }) {
  const all = (results) => (results.includes(false) ? false : results.includes(null) ? null : true);
  const any = (results) => (results.includes(true) ? true : results.includes(null) ? null : false);
  const not = (r) => (r === null ? null : !r);

  const paramTest = (node) => {
    if (!node || typeof node !== 'object') return null;
    if (Array.isArray(node)) return all(node.map(paramTest));
    if (node.allOf) return all(node.allOf.map(paramTest));
    if (node.anyOf) return any(node.anyOf.map(paramTest));
    if (node.noneOf) return not(any(node.noneOf.map(paramTest)));
    if (typeof node.name !== 'string') return null;
    if (
      'includes' in node &&
      node.index === undefined &&
      !Object.prototype.hasOwnProperty.call(params, node.name) &&
      (includes[node.name] ?? []).includes(node.includes)
    ) {
      return true;
    }
    if (!Object.prototype.hasOwnProperty.call(params, node.name)) return null;
    let value = params[node.name];
    if (node.index !== undefined) value = Array.isArray(value) ? value[node.index] : undefined;
    if (node.size) value = Array.isArray(value) ? value.length : undefined;
    if (value === undefined) return null;
    if ('equal' in node) return same(value, node.equal);
    if ('notEqual' in node) return !same(value, node.notEqual);
    if ('includes' in node)
      return Array.isArray(value) && value.some((x) => same(x, node.includes));
    if ('greaterThan' in node) return num(value) !== null && num(value) > num(node.greaterThan);
    if ('lessThanOrEqual' in node) {
      return num(value) !== null && num(value) <= num(node.lessThanOrEqual);
    }
    return null;
  };
  const extTest = (node) => {
    if (!node || typeof node !== 'object') return false;
    if (Array.isArray(node)) return all(node.map(extTest));
    if (node.allOf) return all(node.allOf.map(extTest));
    if (node.anyOf) return any(node.anyOf.map(extTest));
    if (node.noneOf) return not(any(node.noneOf.map(extTest)));
    if (typeof node.name === 'string') return extensions.has(node.name);
    return false;
  };
  const walk = (node) => {
    if (!node || typeof node !== 'object') return false;
    if (Array.isArray(node)) return all(node.map(walk));
    if (node.param) return paramTest(node.param);
    if (node.extension) return extTest(node.extension);
    if (node.allOf) return all(node.allOf.map(walk));
    if (node.anyOf) return any(node.anyOf.map(walk));
    if (node.noneOf) return not(any(node.noneOf.map(walk)));
    return false;
  };
  const tree = resolveDefinedBy(nameOrNode);
  return tree ? walk(tree) : false;
}

// A summary is read at a glance, in a tooltip or a table cell. CACHE_BLOCK_SIZE
// enumerates 64 powers of two; printing all of them is not a summary, it is the
// schema again. Long enums are elided with their true count kept, so the reader
// learns the shape and knows to open the full definition for the rest.
const ENUM_PREVIEW = 6;
function list(values) {
  const shown = values.slice(0, ENUM_PREVIEW).map((v) => String(v));
  return values.length > ENUM_PREVIEW
    ? `${shown.join(', ')} and ${values.length - ENUM_PREVIEW} more`
    : shown.join(', ');
}

/**
 * A one-line, human-readable description of what a schema admits.
 *
 * The rule that matters: an ARRAY is never described as a choice. "one of" says
 * pick exactly one from this set, and no array parameter means that. They are
 * lists, sometimes of fixed length, sometimes drawn from an enum, and calling
 * MSTATUS_FS_LEGAL_VALUES "one of 0, 1, 2, 3" would tell a reader to supply a
 * number where UDB wants a list. tests/isa-params.test.mjs asserts no array
 * summary ever uses that phrasing, over the real data.
 */
export function schemaSummary(schema) {
  if (!schema || typeof schema !== 'object') return 'unspecified';

  // A $ref, or an allOf refining one. UDB uses these for the fixed-width integer
  // defs, sometimes with a `not` excluding a value.
  if (schema.$ref || schema.allOf) {
    const parts = [].concat(schema.allOf ?? [], schema.$ref ? [{ $ref: schema.$ref }] : []);
    const ref = parts.find((p) => p?.$ref)?.$ref ?? '';
    const width = /uint(\d+)/.exec(ref);
    const base = width ? `${width[1]}-bit unsigned integer` : 'integer';
    const excluded = parts.find((p) => p?.not?.const !== undefined)?.not?.const;
    return excluded !== undefined ? `${base}, not ${excluded}` : base;
  }

  if (schema.type === 'array') {
    const items = schema.items;
    const fixed = schema.minItems != null && schema.minItems === schema.maxItems;
    const length = fixed ? `${schema.minItems}` : null;

    // Tuple form: `items` is an array of per-position schemas, some `const`.
    if (Array.isArray(items)) {
      const pinned = items.filter((i) => i && i.const !== undefined).length;
      const kind = schema.additionalItems?.type ?? items.find((i) => i?.type)?.type ?? 'value';
      const head = length ? `list of ${length} ${kind}s` : `list of ${kind}s`;
      return pinned ? `${head}, first ${pinned} fixed` : head;
    }

    if (items?.enum) {
      const bound = fixed
        ? `${length} values`
        : `up to ${schema.maxItems ?? 'any number of'} values`;
      return `list of ${bound} drawn from ${list(items.enum)}`;
    }
    if (items?.type === 'boolean')
      return length ? `list of ${length} booleans` : 'list of booleans';
    if (items?.type === 'integer') {
      const range =
        items.minimum != null && items.maximum != null
          ? ` ${items.minimum} to ${items.maximum}`
          : '';
      return `list of integers${range}`;
    }
    return length ? `list of ${length} values` : 'list';
  }

  if (schema.enum) return `one of: ${list(schema.enum)}`;
  if (schema.const !== undefined) return `always ${schema.const}`;
  if (schema.type === 'boolean') return 'true or false';

  if (schema.type === 'integer') {
    const { minimum: lo, maximum: hi } = schema;
    if (lo != null && hi != null) return `integer, ${lo} to ${hi}`;
    if (lo != null) return `integer, at least ${lo}`;
    if (hi != null) return `integer, at most ${hi}`;
    return 'integer';
  }
  if (schema.type === 'string') return 'string';
  return schema.type ? String(schema.type) : 'unspecified';
}

/** long_name, description and a schema summary for a parameter, or null. */
export function describeParameter(name) {
  const def = PARAMS[name];
  if (!def) return null;
  return {
    name,
    longName: def.long_name,
    description: def.description,
    summary: schemaSummary(def.schema),
    extensions: definingExtensions(def.definedBy),
    gates: gatingParameters(def.definedBy),
  };
}
