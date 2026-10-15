/**
 * What the RISC-V ISA manual itself says is ratified, read from the first
 * table in each volume's preface.
 *
 * Each preface opens with "It contains the following versions of the RISC-V
 * ISA modules, all of which have been ratified:" and one table. Everything
 * after that table is history (the tables for earlier releases), so only the
 * first one is read. Rows look like
 *
 *   |RV32I |2.1
 *   |Machine |1.13
 *   |ext:zicond[] |1.0
 *   |ext:zvl*[] |1.0      (a family: every catalogue id starting zvl)
 *
 * riscv-unified-db is this catalogue's source for state and version, and it
 * can lag: on 2026-10-15 it still listed Sm 1.13.0 as frozen while this table
 * listed "Machine 1.13" as ratified (riscv-unified-db#2740). Checking the
 * catalogue against the manual is how that is caught.
 *
 * Pure: takes file contents, touches no disk.
 */

/* Plain names in the table that are not ext:…[] references. */
const PLAIN_NAMES = {
  Machine: 'Sm',
  Supervisor: 'S',
  RV32I: 'RV32I',
  RV64I: 'RV64I',
  RV32E: 'RV32E',
  RV64E: 'RV64E',
  RV128I: 'RV128I',
};

/*
 * Umbrella names the manual lists that are not catalogue extensions: a memory
 * model, and families the catalogue carries member by member. Kept rather
 * than dropped, so the snapshot still says what the manual said.
 */
export const UMBRELLAS = new Set(['RVWMO', 'Control-flow Integrity', 'Pointer Masking']);

/*
 * The current table of one preface: [{ name, id, version }]. `id` is the
 * catalogue id the row names (case as the manual writes it, lower for ext:
 * references), or null for an umbrella. Throws when the table is not where it
 * should be, so a reorganised preface fails the sync instead of reading as
 * "nothing is ratified".
 */
export function parsePreface(text) {
  const intro = text.search(/all of which have been ratified:/);
  if (intro < 0) throw new Error('preface has no "all of which have been ratified" table');
  const open = text.indexOf('|===', intro);
  const close = text.indexOf('|===', open + 4);
  if (open < 0 || close < 0) throw new Error('preface table is not closed');
  const rows = [];
  for (const line of text.slice(open + 4, close).split('\n')) {
    const m = line.match(/^\|\s*([^|]+?)\s*\|\s*([0-9]+(?:\.[0-9]+)*)\s*$/);
    if (!m) continue;
    const [, cell, version] = m;
    const ext = cell.match(/^ext:([a-z0-9]+\*?)\[\]$/i);
    const name = ext ? ext[1] : cell;
    const id = ext ? ext[1].toLowerCase() : (PLAIN_NAMES[cell] ?? null);
    if (!ext && !id && !UMBRELLAS.has(cell)) {
      throw new Error(`preface row "${cell}" is neither an extension nor a known name`);
    }
    rows.push({ name, id, version });
  }
  if (rows.length === 0) throw new Error('preface table has no rows');
  return rows;
}

/*
 * The catalogue against the manual: every row it lists as ratified must be a
 * catalogue entry marked ratified, at the same major.minor version when the
 * catalogue carries one. Returns readable problems; empty means they agree.
 */
export function compareWithCatalogue(rows, catalogue) {
  const byId = new Map(
    Object.values(catalogue)
      .flat()
      .filter(Boolean)
      .map((ext) => [ext.id.toLowerCase(), ext]),
  );
  const problems = [];
  // A family row (zvl*) stands for every catalogue id with that prefix.
  const expanded = rows.flatMap((row) => {
    if (!row.id?.endsWith('*')) return [row];
    const prefix = row.id.slice(0, -1).toLowerCase();
    const members = [...byId.keys()].filter((id) => id.startsWith(prefix));
    if (members.length === 0) {
      problems.push(
        `${row.name} ${row.version}: ratified in the manual, no catalogue entry matches`,
      );
    }
    return members.map((id) => ({ ...row, name: byId.get(id).id, id }));
  });
  for (const row of expanded) {
    if (!row.id) continue;
    const ext = byId.get(row.id.toLowerCase());
    if (!ext) {
      problems.push(
        `${row.name} ${row.version}: ratified in the manual, missing from the catalogue`,
      );
      continue;
    }
    if (ext.state !== 'ratified') {
      problems.push(
        `${ext.id}: ratified at ${row.version} in the manual, "${ext.state ?? 'no state'}" in the catalogue`,
      );
    }
    const [major, minor] = row.version.split('.');
    const ours = String(ext.version ?? '').split('.');
    if (ext.version && (ours[0] !== major || (ours[1] ?? '0') !== (minor ?? '0'))) {
      problems.push(
        `${ext.id}: version ${row.version} in the manual, ${ext.version} in the catalogue`,
      );
    }
  }
  return problems;
}
