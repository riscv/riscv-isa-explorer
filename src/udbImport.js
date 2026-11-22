/**
 * udbImport.js — a UDB architecture configuration into the builder (#604).
 *
 * The file riscv-arch-test takes (and the builder's own UDB export) becomes a
 * builder selection and parameter values, with a report: what could not be
 * read, what the configuration lacks, and what the parameter model (the one
 * the UDB Export Check holds to `udb validate cfg`) says about each value.
 *
 * Takes the document already parsed; the caller parses YAML with integers as
 * BigInt (`intAsBigInt`), so 64-bit IDs arrive exact. Pure module: no React,
 * no data import; the caller passes the flat catalogue.
 */
import { BASE_ISA_IDS } from './marchUtils.js';
import { parameterDefinition } from './isaParams.js';
import { resolveSelection } from './isaGraph.js';
import { builderParamStates, toStored } from './paramEditing.js';

// I or E with MXLEN gives the base; UDB has no RV64I extension.
const BASE_FOR = {
  I: { 32: 'RV32I', 64: 'RV64I', 128: 'RV128I' },
  E: { 32: 'RV32E', 64: 'RV64E' },
};

const versionOf = (spec) =>
  String(spec ?? '')
    .replace(/^\s*[=~>< ]+\s*/, '')
    .trim();
const plain = (v) =>
  typeof v === 'bigint' && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
const deep = (v) => (Array.isArray(v) ? v.map(deep) : plain(v));

/**
 * @param {object} doc the parsed configuration
 * @param {{id: string, version?: string}[]} catalog the flat catalogue
 * @returns {{ok: boolean, ids: string[], paramChoices: object, name: string,
 *   errors: string[], invalid: string[], warnings: string[], info: string[],
 *   summary: object|null}} `errors` block loading; `invalid` values load and
 *   show as invalid in the Parameters tab
 */
export function importUdbConfig(doc, catalog) {
  // errors block loading (no base, a conflict); invalid values do not: they
  // load and show as invalid in the Parameters tab, where they can be fixed.
  const errors = [];
  const invalid = [];
  const warnings = [];
  const info = [];
  const fail = (message) => ({
    ok: false,
    ids: [],
    paramChoices: {},
    name: '',
    errors: [message],
    invalid: [],
    warnings: [],
    info: [],
    summary: null,
  });

  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return fail('This is not a UDB configuration: the file is not a YAML mapping.');
  }
  if (doc.kind !== 'architecture configuration') {
    return fail(
      `This is not a UDB architecture configuration (kind: ${JSON.stringify(doc.kind ?? null)}).`,
    );
  }
  if (doc.type !== 'fully configured') {
    return fail(
      `Only fully configured files can be imported; this one is ${JSON.stringify(doc.type ?? 'untyped')}. ` +
        'A partially configured file lists mandatory and optional extensions, which a builder selection cannot express.',
    );
  }

  const params = doc.params && typeof doc.params === 'object' ? doc.params : {};
  const mxlen = Number(plain(params.MXLEN));
  if (![32, 64, 128].includes(mxlen)) {
    return fail('MXLEN must be set to 32, 64 or 128: UDB requires it, and it decides the base.');
  }

  const list = Array.isArray(doc.implemented_extensions) ? doc.implemented_extensions : [];
  const byLower = new Map(catalog.map((e) => [e.id.toLowerCase(), e]));
  const ids = [];
  for (const entry of list) {
    const name = typeof entry === 'string' ? entry : entry?.name;
    if (typeof name !== 'string' || !name) continue;
    const version = versionOf(typeof entry === 'object' ? entry.version : '');
    if (name === 'I' || name === 'E') {
      const base = BASE_FOR[name][mxlen];
      if (!base) {
        errors.push(`${name} with MXLEN ${mxlen} is not a base the catalogue has.`);
        continue;
      }
      ids.push(base);
      continue;
    }
    const ext = byLower.get(name.toLowerCase());
    if (!ext) {
      warnings.push(`${name} is not in the catalogue, so it was left out.`);
      continue;
    }
    if (ext.id !== name) info.push(`${name} read as ${ext.id}.`);
    if (version && ext.version && version !== ext.version) {
      warnings.push(`${ext.id}: the file pins ${version}; the catalogue has ${ext.version}.`);
    }
    ids.push(ext.id);
  }
  const base = ids.find((id) => BASE_ISA_IDS.has(id));
  if (!base) {
    errors.push('implemented_extensions has no I or E, so there is no base ISA.');
  }
  if (!list.some((e) => (typeof e === 'string' ? e : e?.name) === 'Sm')) {
    warnings.push(
      'Sm is not listed. Every hart has M-mode, and UDB defines MXLEN and every M-mode parameter under Sm, so udb validate cfg rejects the file without it.',
    );
  }

  const paramChoices = {};
  for (const [pname, value] of Object.entries(params)) {
    if (pname === 'MXLEN') continue; // fixed by the base in the builder
    if (!parameterDefinition(pname)) {
      warnings.push(`${pname} is not a UDB parameter, so it was left out.`);
      continue;
    }
    if (value === null || value === undefined) continue; // a TODO left blank
    paramChoices[pname] = toStored(deep(value));
  }

  let summary = null;
  if (base && errors.length === 0) {
    const resolution = resolveSelection({ selected: ids, base });
    for (const c of resolution.conflicts) {
      errors.push(
        `${c.ext} conflicts with ${c.with}${c.path.length > 1 ? ` (through ${c.path.join(' -> ')})` : ''}.`,
      );
    }
    const listed = new Set(ids);
    const added = resolution.implied.filter((i) => !listed.has(i.ext)).map((i) => i.ext);
    if (added.length) {
      warnings.push(
        `The file does not list ${added.join(', ')}, which ${added.length === 1 ? 'is' : 'are'} required by what it does list; the builder adds ${added.length === 1 ? 'it' : 'them'}.`,
      );
    }
    let states = builderParamStates(resolution.resolved, paramChoices);
    // A value an extension fixes (Sstvala's REPORT_VA_IN_STVAL_*, Zic64b's
    // CACHE_BLOCK_SIZE) is the extension's, not a choice: keep it only if it
    // disagrees, where it is reported as an error below.
    for (const p of states.params) {
      if (
        p.kind === 'fixed' &&
        Object.prototype.hasOwnProperty.call(paramChoices, p.name) &&
        p.errors.length === 0
      ) {
        delete paramChoices[p.name];
      }
    }
    states = builderParamStates(resolution.resolved, paramChoices);
    for (const p of states.params) {
      if (!Object.prototype.hasOwnProperty.call(paramChoices, p.name)) continue;
      if (p.scope === false) {
        warnings.push(`${p.name} is set, but this configuration does not define it.`);
      } else if (p.errors.length) {
        invalid.push(`${p.name}: ${p.errors.join('; ')}`);
      }
    }
    summary = states.summary;
    const unset = summary.required - summary.set;
    if (unset) info.push(`${unset} required parameter${unset === 1 ? '' : 's'} not set yet.`);
    ids.splice(0, ids.length, ...resolution.resolved.filter((id) => byLower.has(id.toLowerCase())));
  }

  return {
    ok: errors.length === 0 && Boolean(base),
    ids,
    paramChoices,
    name: typeof doc.name === 'string' ? doc.name : '',
    errors,
    invalid,
    warnings,
    info,
    summary,
  };
}

/** What a browser import cannot check, with the command that can. */
export const NOT_CHECKED_HERE =
  "Not checked here: compatible: pointers to other configurations, and UDB's final satisfiability check. Run udb validate cfg on the file for those.";
