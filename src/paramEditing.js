/**
 * paramEditing.js — what the Parameters tab needs around the model (#600).
 *
 *   editorFor(schema)       which editor a parameter gets
 *   parseInput(text, ...)   a typed value from what the user typed
 *   toStored / fromStored   values as the builder saves them: JSON-safe, so a
 *                           64-bit integer is {"$int": "..."}, never a BigInt
 *                           (JSON.stringify throws on BigInt, and the builder
 *                           saves to localStorage on every change)
 *   builderParamStates(...) paramModel.paramStates for a builder selection
 *
 * Pure module: no React, no catalogue import.
 */
import { BASE_ISA_IDS, BASE_ISA_PREFIX_MAP } from './marchUtils.js';
import { definingExtensions, parameterDefinition } from './isaParams.js';
import { resolveParams } from './isaGraph.js';
import { paramStates } from './paramModel.js';

// ---------------------------------------------------------------------------
// Stored form
// ---------------------------------------------------------------------------

const SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** A value as the builder stores it: numbers beyond 2^53 become {$int}. */
export function toStored(value) {
  if (typeof value === 'bigint') {
    return value <= SAFE && value >= -SAFE ? Number(value) : { $int: value.toString() };
  }
  if (Array.isArray(value)) return value.map(toStored);
  return value;
}

/** A stored value as the model reads it: {$int} back to BigInt. */
export function fromStored(value) {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof value.$int === 'string'
  ) {
    return /^-?\d+$/.test(value.$int) ? BigInt(value.$int) : undefined;
  }
  if (Array.isArray(value)) return value.map(fromStored);
  return value;
}

/** How a value reads in the UI. */
export function formatValue(value) {
  const v = fromStored(value);
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.map((x) => formatValue(x)).join(', ');
  return String(v);
}

// ---------------------------------------------------------------------------
// Editors
// ---------------------------------------------------------------------------

/**
 * @returns {{kind: 'boolean'|'enum'|'integer'|'enum-list'|'bitmap'|'list'|'string'|'text',
 *   options?: unknown[], min?: bigint, max?: bigint, length?: number,
 *   fixed?: Record<number, unknown>, maxItems?: number}}
 */
export function editorFor(schema) {
  if (!schema || typeof schema !== 'object') return { kind: 'text' };
  const base = schema.allOf ? Object.assign({}, ...schema.allOf.filter((s) => !s.not)) : schema;
  if (base.type === 'boolean') return { kind: 'boolean' };
  if (Array.isArray(base.enum)) return { kind: 'enum', options: base.enum };
  if (base.type === 'integer' || /uint|int/.test(base.$ref ?? '')) {
    const min =
      base.minimum !== undefined
        ? BigInt(base.minimum)
        : /uint/.test(base.$ref ?? '')
          ? 0n
          : undefined;
    const max =
      base.maximum !== undefined
        ? BigInt(base.maximum)
        : /uint64/.test(base.$ref ?? '')
          ? (1n << 64n) - 1n
          : undefined;
    return { kind: 'integer', min, max };
  }
  if (base.type === 'string') return { kind: 'string' };
  if (base.type === 'array') {
    if (base.items && !Array.isArray(base.items) && Array.isArray(base.items.enum)) {
      return { kind: 'enum-list', options: base.items.enum, maxItems: base.maxItems };
    }
    const itemSchema = Array.isArray(base.items) ? base.additionalItems : base.items;
    const booleans =
      itemSchema?.type === 'boolean' ||
      (Array.isArray(base.items) && base.items.every((i) => typeof i.const === 'boolean'));
    if (booleans && base.minItems && base.minItems === base.maxItems) {
      const fixed = {};
      if (Array.isArray(base.items)) {
        base.items.forEach((item, i) => {
          if (item.const !== undefined) fixed[i] = item.const;
        });
      }
      return { kind: 'bitmap', length: base.minItems, fixed };
    }
    return { kind: 'list', maxItems: base.maxItems };
  }
  return { kind: 'text' };
}

/**
 * A typed value from text the user entered, or {error}. Empty text unsets.
 * @returns {{value: unknown} | {error: string} | {unset: true}}
 */
export function parseInput(text, editor) {
  const raw = String(text ?? '').trim();
  if (raw === '') return { unset: true };
  const int = (s) => {
    const t = s.replace(/_/g, '');
    if (/^-?\d+$/.test(t)) return BigInt(t);
    if (/^0x[0-9a-f]+$/i.test(t)) return BigInt(t);
    return null;
  };
  if (editor.kind === 'integer') {
    const n = int(raw);
    if (n === null) return { error: 'a whole number (decimal or 0x hex)' };
    return { value: toStored(n) };
  }
  if (editor.kind === 'list') {
    const items = raw.split(/[\s,]+/).filter(Boolean);
    const values = [];
    for (const item of items) {
      const n = int(item);
      values.push(n === null ? item : n);
    }
    return { value: toStored(values) };
  }
  return { value: raw };
}

// ---------------------------------------------------------------------------
// The builder's view of the model
// ---------------------------------------------------------------------------

/**
 * paramStates for a builder selection: catalogue ids, with Sm always present
 * (every hart has M-mode, as the UDB export assumes) and MXLEN fixed by the
 * base.
 *
 * @param {string[]} ids the builder's resolved selection
 * @param {Record<string, unknown>} stored the builder's saved values
 */
export function builderParamStates(ids, stored = {}) {
  const base = ids.find((id) => BASE_ISA_IDS.has(id)) ?? null;
  if (!base) return null;
  const info = BASE_ISA_PREFIX_MAP[base];
  const extensions = new Set(ids.map((id) => (id === base ? info.base.toUpperCase() : id)));
  extensions.add('Sm');
  const values = {};
  for (const [name, value] of Object.entries(stored ?? {})) {
    const v = fromStored(value);
    if (v !== undefined && v !== null) values[name] = v;
  }
  const constraints = resolveParams(ids).filter((c) => c.name !== 'MXLEN');
  constraints.push({ name: 'MXLEN', kind: 'equal', value: info.xlen, from: [base] });
  return paramStates({ extensions, values, constraints });
}

/** The extension a parameter is listed under: the first that defines it. */
export function groupOf(name) {
  return definingExtensions(name)[0] ?? 'Other';
}

/** UDB's one-line name for a parameter, or its name. */
export function labelOf(name) {
  return parameterDefinition(name)?.long_name ?? name;
}
