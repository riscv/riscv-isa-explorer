/**
 * profileExport.js — what a profile contains, and that list as a file.
 *
 * A profile names two lists: the extensions it mandates and the ones it allows
 * as options. The mandated list is a transcription of the specification and is
 * deliberately not expanded (see compareModel.js), but a conforming
 * implementation also provides everything those extensions require. So each
 * extension is classified once, here, and the download and the profile
 * comparison both read the same classification:
 *
 *   mandatory  listed as mandatory by the profile
 *   implied    not listed, but required by a mandatory extension
 *   optional   listed as an option and not already guaranteed
 *
 * The order matters. An option the mandatory set already pulls in is
 * guaranteed, not optional, and calling it optional would tell an implementer
 * they may leave out something they cannot.
 *
 * Pure: no React and no data import. Callers pass the lists, the catalogue and
 * the dependency closure, so tests can drive it with anything.
 */
import { buildXlsx } from './xlsxWriter.js';

export const REQUIREMENTS = ['mandatory', 'implied', 'optional'];

/**
 * @param {object} p
 * @param {string[]} p.mandatory
 * @param {string[]} [p.optional]
 * @param {(id: string) => Iterable<string>} [p.closure] transitive requirements
 *   of one extension, excluding itself. Omit it to classify the lists as the
 *   specification writes them, with nothing implied.
 * @returns {Map<string, {requirement: string, impliedBy: string[]}>}
 */
export function profileMembership({ mandatory, optional = [], closure = null }) {
  const out = new Map();
  for (const id of mandatory) out.set(id, { requirement: 'mandatory', impliedBy: [] });
  if (closure) {
    for (const source of mandatory) {
      for (const id of closure(source)) {
        if (out.get(id)?.requirement === 'mandatory') continue;
        if (!out.has(id)) out.set(id, { requirement: 'implied', impliedBy: [] });
        out.get(id).impliedBy.push(source);
      }
    }
    for (const entry of out.values()) entry.impliedBy.sort();
  }
  for (const id of optional) {
    if (!out.has(id)) out.set(id, { requirement: 'optional', impliedBy: [] });
  }
  return out;
}

function statusOf(ext) {
  if (!ext) return 'not in catalogue';
  if (ext.discontinued) return 'discontinued';
  return ext.state || 'unconfirmed';
}

/**
 * One row per extension, mandatory first, then implied, then optional, each
 * alphabetical. An id the catalogue does not carry still gets a row, marked as
 * such: dropping it would make the file disagree with the profile.
 *
 * @param {object} p
 * @param {Map} p.membership from profileMembership()
 * @param {Record<string, object[]>} p.catalog grouped catalogue
 * @param {{key: string, label: string}[]} [p.groups] display labels for group keys
 */
export function profileExtensionRows({ membership, catalog, groups = [] }) {
  const labels = new Map(groups.map((g) => [g.key, g.label]));
  const byId = new Map();
  for (const [group, list] of Object.entries(catalog)) {
    for (const ext of list) byId.set(ext.id, { ext, group: labels.get(group) ?? group });
  }
  const rank = (r) => REQUIREMENTS.indexOf(r);
  return [...membership.entries()]
    .sort(([a, x], [b, y]) => rank(x.requirement) - rank(y.requirement) || a.localeCompare(b))
    .map(([id, { requirement, impliedBy }]) => {
      const hit = byId.get(id);
      const ext = hit?.ext;
      return {
        id,
        name: ext?.short ?? '',
        requirement,
        implied_by: impliedBy.join(' '),
        group: hit?.group ?? '',
        status: statusOf(ext),
        version: ext?.version ?? '',
        ratification_date: ext?.ratification_date ?? '',
        spec_url: ext?.url ?? '',
        description: ext?.desc ?? '',
      };
    });
}

export const COLUMNS = [
  'id',
  'name',
  'requirement',
  'implied_by',
  'group',
  'status',
  'version',
  'ratification_date',
  'spec_url',
  'description',
];

// A spreadsheet treats a cell starting with one of these as a formula. None of
// today's values do, but descriptions are synced from upstream prose.
const FORMULA_START = /^[=+\-@\t\r]/;
const csvField = (value) => {
  let s = String(value ?? '');
  if (FORMULA_START.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(rows) {
  const lines = [
    COLUMNS.join(','),
    ...rows.map((r) => COLUMNS.map((c) => csvField(r[c])).join(',')),
  ];
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * @param {object} p
 * @param {string} p.profile
 * @param {object} [p.metadata] PROFILE_METADATA entry
 * @param {object[]} p.rows from profileExtensionRows()
 */
export function toJson({ profile, metadata = {}, rows }) {
  return `${JSON.stringify({ ...profileHeader(profile, metadata, rows), extensions: rows }, null, 2)}\n`;
}

// Every scalar is written as a JSON string, which is also a valid YAML
// double-quoted scalar. That sidesteps YAML's implicit typing, where an
// unquoted version such as 1.0 would read back as a number.
const yamlScalar = (value) =>
  typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : JSON.stringify(String(value ?? ''));

export function toYaml({ profile, metadata = {}, rows }) {
  const header = profileHeader(profile, metadata, rows);
  const lines = ['# RISC-V profile extension list, exported from the RISC-V ISA Explorer'];
  for (const [key, value] of Object.entries(header)) {
    if (value && typeof value === 'object') {
      lines.push(`${key}:`);
      for (const [k, v] of Object.entries(value)) lines.push(`  ${k}: ${yamlScalar(v)}`);
    } else {
      lines.push(`${key}: ${yamlScalar(value)}`);
    }
  }
  lines.push('extensions:');
  for (const row of rows) {
    COLUMNS.forEach((column, i) => {
      lines.push(`${i === 0 ? '  - ' : '    '}${column}: ${yamlScalar(row[column])}`);
    });
  }
  return `${lines.join('\n')}\n`;
}

/** @returns {Uint8Array} */
export function toXlsx({ profile, metadata = {}, rows }) {
  const header = profileHeader(profile, metadata, rows);
  const about = [['Field', 'Value']];
  for (const [key, value] of Object.entries(header)) {
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) about.push([`${key}.${k}`, String(v)]);
    } else about.push([key, String(value ?? '')]);
  }
  return buildXlsx([
    { name: 'Extensions', rows: [COLUMNS, ...rows.map((r) => COLUMNS.map((c) => r[c] ?? ''))] },
    { name: 'Profile', rows: about },
  ]);
}

function profileHeader(profile, metadata, rows) {
  const count = (r) => rows.filter((row) => row.requirement === r).length;
  return {
    profile,
    description: metadata.description ?? '',
    xlen: metadata.xlen ?? '',
    scope: metadata.scope ?? '',
    counts: {
      mandatory: count('mandatory'),
      implied: count('implied'),
      optional: count('optional'),
    },
    source: 'https://tech.riscv.org/isa-explorer/',
  };
}

export const EXPORT_FORMATS = [
  { key: 'yaml', label: 'YAML', extension: 'yaml', mime: 'application/yaml' },
  { key: 'json', label: 'JSON', extension: 'json', mime: 'application/json' },
  { key: 'csv', label: 'CSV', extension: 'csv', mime: 'text/csv' },
  {
    key: 'xlsx',
    label: 'Excel (XLSX)',
    extension: 'xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
];

/** Builds the file for one format. @returns {{filename: string, mime: string, data: string|Uint8Array}} */
export function buildProfileExport(format, { profile, metadata, rows }) {
  const spec = EXPORT_FORMATS.find((f) => f.key === format);
  if (!spec) throw new Error(`Unknown export format: ${format}`);
  const input = { profile, metadata, rows };
  const data =
    format === 'csv'
      ? toCsv(rows)
      : format === 'json'
        ? toJson(input)
        : format === 'yaml'
          ? toYaml(input)
          : toXlsx(input);
  return { filename: `${profile}-extensions.${spec.extension}`, mime: spec.mime, data };
}
