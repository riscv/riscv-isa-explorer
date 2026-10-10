/**
 * Profile download (src/profileExport.js) and the .xlsx writer behind it
 * (src/xlsxWriter.js).
 *
 * The classification is the part that can be quietly wrong: an extension the
 * mandatory set already requires must never be offered as optional, and an
 * implied one must name what implies it. The writers are checked by reading
 * their output back, not by comparing against stored strings.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import YAML from 'yaml';
import {
  profileMembership,
  profileExtensionRows,
  buildProfileExport,
  toCsv,
  COLUMNS,
  EXPORT_FORMATS,
} from '../src/profileExport.js';
import { buildXlsx, columnName, crc32 } from '../src/xlsxWriter.js';
import { PROFILES, PROFILE_METADATA } from '../src/profiles.js';
import { closure } from '../src/isaGraph.js';
import { CATALOGUE_GROUPS } from '../src/evolutionModel.js';

const catalog = JSON.parse(
  readFileSync(new URL('../src/riscv_extensions.json', import.meta.url), 'utf8'),
);
const OPTIONAL = JSON.parse(
  readFileSync(new URL('../src/profile-optional.json', import.meta.url), 'utf8'),
);

const rowsFor = (profile) =>
  profileExtensionRows({
    membership: profileMembership({
      mandatory: PROFILES[profile],
      optional: OPTIONAL[profile],
      closure,
    }),
    catalog,
    groups: CATALOGUE_GROUPS,
  });

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

test('mandatory beats implied, and implied beats optional', () => {
  const graph = { A: ['B'], B: ['C'] };
  const m = profileMembership({
    mandatory: ['A'],
    optional: ['C', 'D'],
    closure: (id) => {
      const out = new Set();
      const walk = (x) => (graph[x] ?? []).forEach((y) => out.add(y) && walk(y));
      walk(id);
      return out;
    },
  });
  assert.equal(m.get('A').requirement, 'mandatory');
  assert.equal(m.get('B').requirement, 'implied');
  // C is listed as optional, but A requires it, so it is guaranteed.
  assert.equal(m.get('C').requirement, 'implied');
  assert.deepEqual(m.get('C').impliedBy, ['A']);
  assert.equal(m.get('D').requirement, 'optional');
});

test('without a closure nothing is implied: the lists as the spec writes them', () => {
  const m = profileMembership({ mandatory: PROFILES.RVA23, optional: OPTIONAL.RVA23 });
  assert.ok([...m.values()].every((v) => v.requirement !== 'implied'));
});

for (const profile of Object.keys(PROFILES)) {
  test(`${profile}: every mandatory extension is listed once, and no option is guaranteed`, () => {
    const rows = rowsFor(profile);
    const ids = rows.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, 'an extension appears twice');

    const mandatory = new Set(PROFILES[profile]);
    const guaranteed = new Set(PROFILES[profile].flatMap((id) => [...closure(id)]));
    for (const row of rows) {
      if (row.requirement === 'mandatory') assert.ok(mandatory.has(row.id), row.id);
      if (row.requirement === 'implied') {
        assert.ok(!mandatory.has(row.id), `${row.id} is mandatory, not implied`);
        assert.ok(row.implied_by, `${row.id} does not say what implies it`);
        for (const source of row.implied_by.split(' ')) assert.ok(mandatory.has(source), source);
      }
      if (row.requirement === 'optional') {
        assert.ok(!guaranteed.has(row.id), `${row.id} is guaranteed, not optional`);
      }
    }
    assert.equal(rows.filter((r) => r.requirement === 'mandatory').length, mandatory.size);
  });
}

test('rows run mandatory, then implied, then optional, each alphabetical', () => {
  const rows = rowsFor('RVA23');
  const order = ['mandatory', 'implied', 'optional'];
  for (let i = 1; i < rows.length; i++) {
    const [a, b] = [rows[i - 1], rows[i]];
    const byKind = order.indexOf(a.requirement) - order.indexOf(b.requirement);
    assert.ok(
      byKind < 0 || (byKind === 0 && a.id.localeCompare(b.id) < 0),
      `${a.id} before ${b.id}`,
    );
  }
});

test('catalogue fields are carried onto each row', () => {
  const zba = rowsFor('RVA23').find((r) => r.id === 'Zba');
  assert.equal(zba.requirement, 'mandatory');
  assert.equal(zba.status, 'ratified');
  assert.equal(zba.group, 'Bit Manipulation (Zb*)');
  assert.match(zba.spec_url, /^https:\/\//);
  assert.ok(zba.description.length > 0);
});

// ---------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------

const exportOf = (format, profile = 'RVA23') =>
  buildProfileExport(format, {
    profile,
    metadata: PROFILE_METADATA[profile],
    rows: rowsFor(profile),
  });

test('each format is named after the profile with its own extension', () => {
  for (const f of EXPORT_FORMATS) {
    assert.equal(exportOf(f.key).filename, `RVA23-extensions.${f.extension}`);
  }
  assert.equal(exportOf('csv', 'RVA23.1').filename, 'RVA23.1-extensions.csv');
  assert.throws(() => exportOf('pdf'));
});

test('JSON carries the profile, its counts and every row', () => {
  const doc = JSON.parse(exportOf('json').data);
  const rows = rowsFor('RVA23');
  assert.equal(doc.profile, 'RVA23');
  assert.equal(doc.extensions.length, rows.length);
  assert.equal(doc.counts.mandatory, PROFILES.RVA23.length);
  assert.equal(
    doc.counts.mandatory + doc.counts.implied + doc.counts.optional,
    doc.extensions.length,
  );
});

test('YAML parses back to the same rows, with versions kept as strings', () => {
  const doc = YAML.parse(exportOf('yaml').data);
  const rows = rowsFor('RVA23');
  assert.deepEqual(doc.extensions, rows);
  // Unquoted, 1.0 would come back as the number 1.
  assert.ok(doc.extensions.every((r) => typeof r.version === 'string'));
  assert.equal(doc.counts.mandatory, PROFILES.RVA23.length);
});

test('CSV quotes what needs quoting and defuses spreadsheet formulas', () => {
  const csv = toCsv([
    { id: 'X', name: 'a, b', description: 'say "hi"\nthen go', group: '=SUM(A1)' },
  ]);
  const [header, row] = csv.split('\r\n');
  assert.equal(header, COLUMNS.join(','));
  assert.ok(row.includes('"a, b"'));
  assert.ok(row.includes(`'=SUM(A1)`), 'a leading = must not reach a spreadsheet as a formula');
  assert.ok(csv.includes('"say ""hi""\nthen go"'));
  assert.equal(exportOf('csv').data.trim().split('\r\n').length, rowsFor('RVA23').length + 1);
});

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

/** Reads a zip's entries through its central directory, checking each CRC. */
function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;
  assert.equal(view.getUint32(eocd, true), 0x06054b50, 'no end-of-central-directory record');
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(view.getUint32(at, true), 0x02014b50, 'bad central directory entry');
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    const dataStart =
      local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    let data = bytes.subarray(dataStart, dataStart + size);
    if (method === 8) data = inflateRawSync(data);
    assert.equal(crc32(data), crc, `${name}: CRC mismatch`);
    files.set(name, new TextDecoder().decode(data));
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return files;
}

test('the workbook is a valid zip holding the parts Excel requires', () => {
  const files = readZip(exportOf('xlsx').data);
  for (const part of [
    '[Content_Types].xml',
    '_rels/.rels',
    'xl/workbook.xml',
    'xl/_rels/workbook.xml.rels',
    'xl/styles.xml',
    'xl/worksheets/sheet1.xml',
    'xl/worksheets/sheet2.xml',
  ]) {
    assert.ok(files.has(part), `missing ${part}`);
  }
  assert.match(files.get('xl/workbook.xml'), /name="Extensions"/);
  const sheet = files.get('xl/worksheets/sheet1.xml');
  assert.ok(sheet.includes('<t xml:space="preserve">Zba</t>'));
  assert.equal((sheet.match(/<row /g) || []).length, rowsFor('RVA23').length + 1);
});

test('the same input always produces the same bytes', () => {
  assert.deepEqual(exportOf('xlsx').data, exportOf('xlsx').data);
});

test('cell text is escaped and characters XML forbids are dropped', () => {
  const files = readZip(buildXlsx([{ name: 'a/b:c', rows: [['h'], ['<x> & "y"\u0001']] }]));
  const sheet = files.get('xl/worksheets/sheet1.xml');
  assert.ok(sheet.includes('&lt;x&gt; &amp; &quot;y&quot;</t>'));
  assert.ok(!sheet.includes('\u0001'));
  // Excel rejects / and : in sheet names.
  assert.match(files.get('xl/workbook.xml'), /name="a b c"/);
});

test('column names run A..Z then AA', () => {
  assert.deepEqual([0, 1, 25, 26, 27, 51, 52].map(columnName), [
    'A',
    'B',
    'Z',
    'AA',
    'AB',
    'AZ',
    'BA',
  ]);
});

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});
