#!/usr/bin/env node

// Syncs supervisor/CSR extension data from riscv-unified-db into riscv_extensions.json.
// Designed to run both locally and in CI — checks a watchlist of extensions
// that are known to be missing from UDB, and populates any that have since
// been added.
//
// Usage:
//   node scripts/sync_udb_extensions.cjs [path-to-udb] [--dry-run]
//
// If no UDB path is given, defaults to ../riscv-unified-db relative to the
// workspace root.
//
// SCOPE: metadata only — CSRs, long_name, type, version, state,
// ratification_date and behavior. It deliberately does NOT write dependencies. Those live in
// src/isa-dependency-graph.json, produced by scripts/seed-dependency-graph.mjs,
// which distinguishes the four shapes UDB actually uses (allOf, anyOf/oneOf,
// if/then, not:). Flattening them into one list inverts meaning — it yields
// "Zfinx requires F" when UDB says `not: F` — so there is exactly one parser
// for dependencies, and it is not this file. The sync workflow runs both.

const fs = require('fs');
const path = require('path');

const workspaceRoot = process.cwd();
const catalogPath = path.join(workspaceRoot, 'src', 'riscv_extensions.json');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const udbArg = args.find((a) => !a.startsWith('--'));
const udbRoot = udbArg
  ? path.resolve(udbArg)
  : path.resolve(workspaceRoot, '..', 'riscv-unified-db');

const UDB_EXT_DIR = path.join(udbRoot, 'spec', 'std', 'isa', 'ext');
const UDB_CSR_DIR = path.join(udbRoot, 'spec', 'std', 'isa', 'csr');

// Individual YAML parse failures are tolerated (a single malformed file
// shouldn't abort the whole sync), but a burst of them usually means UDB
// restructured its layout and our minimal parser is silently missing
// everything. Count them and fail the run past this threshold so the workflow
// surfaces a real error instead of reporting "No new extensions found".
const PARSE_FAILURE_THRESHOLD = 10;
let parseFailures = 0;

// ---- YAML helpers ----
// Minimal parser — handles only the fields we need from UDB's extension and
// CSR schemas. Not a general-purpose YAML parser.

function parseYaml(filepath) {
  const content = fs.readFileSync(filepath, 'utf8').replace(/\r/g, '');
  const result = {};
  const lines = content.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#') || line.trim().startsWith('$')) {
      i++;
      continue;
    }

    const m = line.match(/^(\w+):\s*(.*)$/);
    if (!m) { i++; continue; }

    const key = m[1];
    const val = m[2].trim();

    // multiline block scalar
    if (val === '|') {
      i++;
      let block = '';
      while (i < lines.length && (lines[i].startsWith('  ') || lines[i] === '')) {
        block += lines[i].replace(/^ {2}/, '') + '\n';
        i++;
      }
      result[key] = block.trim();
      continue;
    }

    // versions array — collect every entry as its own object.
    // A single `- version:` starts a new entry; subsequent indented
    // fields attach to that entry only (no merging across versions).
    // The "current" version is chosen later by pickVersion().
    if (key === 'versions') {
      i++;
      const versions = [];
      let ver = null;
      while (i < lines.length && (lines[i].startsWith('  ') || lines[i].trim() === '')) {
        const vl = lines[i].trim();
        if (vl.startsWith('- version:')) {
          ver = { version: vl.replace('- version:', '').trim().replace(/['"]/g, '') };
          versions.push(ver);
        } else if (ver) {
          const kv = vl.match(/^(\w+):\s*(.+)$/);
          if (kv) ver[kv[1]] = kv[2].trim().replace(/['"]/g, '');
        }
        i++;
      }
      result.versions = versions;
      continue;
    }

    // requirements — skipped entirely. Dependencies are the graph's job (see
    // the SCOPE note at the top); reading them here would create a second,
    // weaker parser competing with seed-dependency-graph.mjs.
    if (key === 'requirements') {
      i++;
      while (i < lines.length && lines[i].startsWith('  ')) i++;
      continue;
    }

    if (val) {
      result[key] = val.replace(/^["']|["']$/g, '');
    }
    i++;
  }
  return result;
}

// Pick the version entry that best represents the extension's current status.
// UDB lists versions oldest-first, so we take the newest ratified version if
// any are ratified, otherwise the newest entry overall. Returns null when the
// extension has no versions.
function pickVersion(versions) {
  if (!Array.isArray(versions) || versions.length === 0) return null;
  const ratified = versions.filter(v => v.state === 'ratified');
  const pool = ratified.length ? ratified : versions;
  return pool[pool.length - 1];
}

// Truncate to at most `max` characters without cutting a word in half.
// Trims to the last whitespace before the limit; falls back to a hard cut
// only when a single token is longer than `max`.
function truncateAtWord(text, max) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  // if the character at the boundary is whitespace, the word ending at `max`
  // is complete — keep it rather than dropping it
  if (s.charAt(max) === ' ') return s.slice(0, max).trim();
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim();
}

// ---- CSR lookup ----

// Normalize CSR length — UDB uses MXLEN/SXLEN for widths that depend on
// the hart's XLEN. We default those to 64 and flag it in the value.
function normalizeCsrLength(raw) {
  const n = parseInt(raw, 10);
  if (!isNaN(n)) return n;
  // MXLEN, SXLEN, etc. — architecture-dependent, default to 64
  if (typeof raw === 'string' && raw.includes('XLEN')) return 'MXLEN';
  return 64;
}

// Check whether a CSR YAML file is defined by a specific extension.
// Handles the forms used in UDB:
//   definedBy: ExtName                 (scalar)
//   definedBy: [A, B]                   (flow list)
//   definedBy:\n  anyOf:\n    - name: ExtName   (object / anyOf list)
// The object form is walked line-by-line and bounded to the indented block
// directly under `definedBy:`. A bare regex would wrongly match a
// `name: ExtName` that only appears in an unrelated section (e.g. the CSR's
// own `requirements:`), and would miss `- name:` list items.
function csrDefinedBy(raw, extId) {
  const lines = raw.replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)definedBy:\s*(.*)$/);
    if (!m) continue;

    const indent = m[1].length;
    const inline = m[2].trim();

    // scalar form: definedBy: ExtName  (exact, not a prefix)
    if (inline) {
      const cleaned = inline.replace(/^["']|["']$/g, '');
      if (cleaned === extId) return true;
      // flow list: definedBy: [A, B]
      if (inline.startsWith('[')) {
        const items = inline.replace(/^\[|\]$/g, '')
          .split(',').map(s => s.trim().replace(/['"]/g, ''));
        if (items.includes(extId)) return true;
      }
      continue;
    }

    // object / anyOf form: scan only the indented block that follows
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === '') continue;
      const childIndent = lines[j].match(/^(\s*)/)[1].length;
      if (childIndent <= indent) break; // dedented out of the definedBy block
      const nm = lines[j].match(/name:\s*(\S+)/);
      if (nm && nm[1].replace(/,$/, '').replace(/['"]/g, '') === extId) return true;
    }
  }
  return false;
}

function buildCsrEntry(csr) {
  return {
    address: String(csr.address || ''),
    priv_mode: csr.priv_mode || '',
    length: normalizeCsrLength(csr.length),
    desc: csr.long_name || ''
  };
}

function findCsrs(extId) {
  const csrs = {};

  // check for a dedicated subdirectory first
  const subdir = path.join(UDB_CSR_DIR, extId);
  if (fs.existsSync(subdir) && fs.statSync(subdir).isDirectory()) {
    for (const f of fs.readdirSync(subdir).filter(f => f.endsWith('.yaml'))) {
      try {
        const csr = parseYaml(path.join(subdir, f));
        if (csr.name) csrs[csr.name] = buildCsrEntry(csr);
      } catch (err) {
        parseFailures++;
        console.warn('  warning: could not parse ' + path.join(subdir, f) + ': ' + err.message);
      }
    }
    return csrs;
  }

  // fall back to root-level CSR files with definedBy referencing this extension
  if (!fs.existsSync(UDB_CSR_DIR)) return csrs;

  for (const f of fs.readdirSync(UDB_CSR_DIR).filter(f => f.endsWith('.yaml'))) {
    try {
      const filepath = path.join(UDB_CSR_DIR, f);
      const raw = fs.readFileSync(filepath, 'utf8');
      if (csrDefinedBy(raw, extId)) {
        const csr = parseYaml(filepath);
        if (csr.name) csrs[csr.name] = buildCsrEntry(csr);
      }
    } catch (err) {
      parseFailures++;
      console.warn('  warning: could not parse ' + path.join(UDB_CSR_DIR, f) + ': ' + err.message);
    }
  }

  return csrs;
}

// Sanity floor: fail fast if a UDB directory is missing or holds no YAML at all.
// This is distinct from PARSE_FAILURE_THRESHOLD, which only counts files that
// were found and then failed to parse. If UDB renames or moves a directory,
// readdirSync returns nothing, parseFailures stays 0, and the run would
// otherwise exit 0 as "No new extensions found" — the exact silent failure the
// threshold exists to prevent, which it can't catch because zero attempts
// produce zero failures. The floor catches "never found the files"; the
// threshold catches "found them, couldn't read them".
function assertUdbDir(dir, label) {
  if (!fs.existsSync(dir)) {
    console.error('ERROR: UDB ' + label + ' directory not found: ' + dir);
    console.error('UDB layout may have changed. Pass the path to riscv-unified-db as an argument, or clone it next to this repo.');
    process.exit(1);
  }
  const yamlCount = fs.readdirSync(dir).filter(f => f.endsWith('.yaml')).length;
  if (yamlCount === 0) {
    console.error('ERROR: UDB ' + label + ' directory contains no .yaml files: ' + dir);
    console.error('UDB layout may have changed.');
    process.exit(1);
  }
}

// ---- main ----

assertUdbDir(UDB_EXT_DIR, 'extension');
assertUdbDir(UDB_CSR_DIR, 'CSR');

if (!fs.existsSync(catalogPath)) {
  console.error('Catalog not found: ' + catalogPath);
  process.exit(1);
}

let catalog;
try {
  catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
} catch (err) {
  console.error('Failed to read or parse catalog: ' + catalogPath);
  console.error(err.message);
  process.exit(1);
}

// Build a flat index of every catalog entry, keyed by id.
// A duplicate id would silently overwrite the earlier entry here, so the
// shadowed one would never be synced and never reported — warn instead of
// failing silently. Last-wins is preserved.
const entryIndex = new Map();
for (const [category, entries] of Object.entries(catalog)) {
  if (!Array.isArray(entries)) continue;
  for (let i = 0; i < entries.length; i++) {
    const id = entries[i].id;
    if (entryIndex.has(id)) {
      console.warn('  warning: duplicate catalog id "' + id + '" (in ' +
        entryIndex.get(id).category + ' and ' + category + ') — only the last occurrence is synced');
    }
    entryIndex.set(id, { category, entries, index: i });
  }
}

// Find supervisor extensions that haven't been synced from UDB yet.
// We skip entries that already have csrs, behavior, or long_name — the
// presence of long_name means a previous sync already processed this
// extension (it may just not have enough UDB data for csrs/behavior).
// ALWAYS_WATCH below is the exception: extensions UDB has never carried, which
// that rule would otherwise drop the moment we describe them ourselves.
const supervisorPattern = /^(Ss|Sm|Sv|Sd|Su|Sh|Sn)/;

/*
 * Extensions UDB does not model at all, kept on the watchlist by name.
 *
 * The rule above is a proxy for "nothing is known about this yet", and the SPMP
 * family breaks it in both directions: these are ratified, their metadata was
 * transcribed by hand from the specification PDF, and carrying a long_name is
 * precisely what drops an entry off the derived list. So the one part of the
 * catalogue where we are AHEAD of UDB is the one part this report would go
 * quiet about — and the hand-written version, CSR addresses and ratification
 * date would never be reconciled against upstream's once it catches up.
 *
 * Naming them keeps them in "Still missing from UDB" until UDB ships them, at
 * which point this run populates them from upstream and the id can be dropped
 * from this set. Everything here must match supervisorPattern.
 */
const ALWAYS_WATCH = new Set(['Sspmp', 'Sspmpen', 'Smpmpdeleg']);

const gaps = [];
for (const [id, loc] of entryIndex) {
  const entry = loc.entries[loc.index];
  if (!supervisorPattern.test(id)) continue;
  if (!ALWAYS_WATCH.has(id)) {
    if (entry.csrs || entry.behavior || entry.long_name) continue;
    if (entry.tags && entry.tags.length > 0) continue;
  }
  gaps.push(id);
}

console.log('Supervisor extensions without structured data: ' + gaps.length);
console.log('Checking UDB at: ' + udbRoot);
console.log('');

let updated = 0;
let versionsWritten = 0;
const stillMissing = [];
const newlyPopulated = [];

for (const id of gaps) {
  const yamlPath = path.join(UDB_EXT_DIR, id + '.yaml');
  if (!fs.existsSync(yamlPath)) {
    stillMissing.push(id);
    continue;
  }

  let ext;
  try {
    ext = parseYaml(yamlPath);
  } catch (err) {
    parseFailures++;
    console.warn('  warning: could not parse ' + yamlPath + ': ' + err.message + ' — skipping');
    continue;
  }
  const csrs = findCsrs(id);
  const hasCsrs = Object.keys(csrs).length > 0;
  const loc = entryIndex.get(id);
  const entry = loc.entries[loc.index];

  // merge new fields into the existing entry
  if (ext.long_name) entry.long_name = ext.long_name;
  if (ext.type) entry.type = ext.type;
  const ver = pickVersion(ext.versions);
  if (ver) {
    // The version number the rest of the toolchain has to pin against. UDB
    // states it, pickVersion() already selects the right entry for state and
    // ratification_date, and dropping the number here forced every downstream
    // consumer to re-derive it or go without.
    if (ver.version) {
      entry.version = ver.version;
      versionsWritten++;
    }
    if (ver.state) entry.state = ver.state;
    // UDB writes `ratification_date: null` for unratified versions, which the
    // minimal parser captures as the string "null" — treat that as absent.
    // Only a real year-month is useful. UDB writes null for unratified versions,
    // which the minimal parser captures as the string "null", and at least one
    // entry carries the literal "unknown". Either would render as
    // "Ratified unknown" in the badge, which says less than showing no date.
    if (/^\d{4}-\d{2}$/.test(String(ver.ratification_date ?? ''))) {
      entry.ratification_date = ver.ratification_date;
    }
    if (ver.url && !entry.url) entry.url = ver.url;
  }

  if (hasCsrs) {
    entry.csrs = csrs;
  } else if (ext.description && ext.description.length > 30) {
    entry.behavior = truncateAtWord(ext.description, 300);
  }

  // Do NOT derive desc from the UDB `description`: those are hard-wrapped block
  // scalars that truncate into malformed fragments (e.g. "This extension
  // mandates that the `satp` mode Bare must"), and desc is the one field the UI
  // renders (card, detail panel, search index). Keep the curated short label;
  // fall back to UDB's clean `long_name` only when the entry has no desc at all.
  if (!entry.desc && ext.long_name) {
    entry.desc = ext.long_name;
  }

  // entry is already a reference to loc.entries[loc.index] — no reassignment needed
  updated++;
  newlyPopulated.push({
    id,
    csrCount: Object.keys(csrs).length,
    hasBehavior: !hasCsrs && !!entry.behavior
  });
}

// report
console.log('--- Results ---');

if (newlyPopulated.length) {
  console.log('Newly populated (' + newlyPopulated.length + '):');
  for (const p of newlyPopulated) {
    const detail = p.csrCount > 0
      ? p.csrCount + ' CSRs'
      : (p.hasBehavior ? 'behavioral' : 'metadata only');
    console.log('  + ' + p.id + ' (' + detail + ')');
  }
}

if (stillMissing.length) {
  console.log('');
  console.log('Still missing from UDB (' + stillMissing.length + '):');
  for (const id of stillMissing) {
    console.log('  - ' + id);
  }
}

if (updated === 0) {
  console.log('No new extensions found in UDB. Catalog unchanged.');
}

console.log('');
console.log('Done. Updated: ' + updated + ', Still missing: ' + stillMissing.length);
if (parseFailures > 0) {
  console.log('Parse failures: ' + parseFailures + ' (threshold ' + PARSE_FAILURE_THRESHOLD + ')');
}

// Fail the run if parse failures cross the threshold — a burst almost always
// means UDB restructured its layout and our minimal parser is quietly missing
// data, which would otherwise be reported as "No new extensions found".
//
// ---- Pass 1c: ratification status across the whole catalog ----
//
// Same widening as the CSR pass below, for the same reason: the gap loop above
// only visits supervisor-prefixed extensions with no structured data, so 176 of
// 227 entries carried no ratification marker at all.
//
// That matters more than it looks. The catalog lists genuinely unratified
// proposals such as Zvabd, Zibi and the vector dot-product extensions alongside
// ratified ones, and with no state field their instructions read as equally
// settled. It is the same hazard as publishing a withdrawn encoding: a reader
// cannot tell what is real. Labelling is the alternative to deleting them, and
// deleting would throw away work people track deliberately.
//
// Uses a real YAML parse rather than the minimal one, because versions[] is a
// list of maps and picking the wrong entry silently mislabels an extension.
const YAML_EXT = require('yaml');

// UDB models the base integer ISA as one extension, I, parameterised by XLEN.
// We list the concrete bases a reader looks for. Without this mapping all five
// come back unlabelled and read as though their ratification were in doubt,
// which would be wrong: I was ratified in 2019.
//
// E is deliberately absent here. UDB carries no E.yaml, so there is nothing to
// inherit, and asserting a date we cannot source would be worse than saying
// nothing.
const UDB_ID_ALIASES = { RV32I: 'I', RV64I: 'I', RV128I: 'I' };

let stateAdded = 0;
for (const [id, loc] of entryIndex) {
  const entry = loc.entries[loc.index];
  // Re-parse only when something is still missing. The guard used to be on
  // state alone, which meant an entry labelled by an earlier run could never
  // gain a version: the version arrived later than the state, and every
  // already-labelled entry short-circuited before reaching it.
  if (entry.state && entry.version) continue;

  const udbId = UDB_ID_ALIASES[id] || id;
  const yamlPath = path.join(UDB_EXT_DIR, udbId + '.yaml');
  if (!fs.existsSync(yamlPath)) continue;         // absent from UDB, nothing to say

  let doc;
  try {
    doc = YAML_EXT.parse(fs.readFileSync(yamlPath, 'utf8'));
  } catch (err) {
    parseFailures++;
    console.warn('  warning: could not parse ' + yamlPath + ': ' + err.message);
    continue;
  }

  const ver = pickVersion(doc && doc.versions);
  if (!ver) continue;

  // The number anything downstream has to pin against. UDB states it and
  // pickVersion() has already chosen the entry state is read from, so taking
  // the version from the same place keeps the two consistent by construction.
  if (ver.version && !entry.version) {
    entry.version = ver.version;
    versionsWritten++;
    updated++;
  }

  if (!ver.state) continue;
  if (entry.state) continue;                      // already labelled, leave it

  entry.state = ver.state;
  // Only a real year-month is useful. UDB writes null for unratified versions,
    // which the minimal parser captures as the string "null", and at least one
    // entry carries the literal "unknown". Either would render as
    // "Ratified unknown" in the badge, which says less than showing no date.
    if (/^\d{4}-\d{2}$/.test(String(ver.ratification_date ?? ''))) {
    entry.ratification_date = String(ver.ratification_date);
  }
  stateAdded++;
  updated++;
}

console.log('');
console.log('Ratification pass: ' + stateAdded + ' extension(s) gained a state');

// ---- Pass 2: CSR coverage across the whole catalog ----
//
// The pass above is deliberately narrow: supervisor-prefixed extensions with no
// structured data at all. That left CSRs missing everywhere else, so Zicntr,
// Zihpm, F, H, S, U and V carried none, and searching "mstatus" or "mcycle"
// found nothing even though UDB describes all of them.
//
// findCsrs() rescans the entire CSR directory per extension. That is fine for a
// handful of gaps but becomes 227 x 396 reads across the full catalog, so this
// builds the index in a single pass instead.
//
// Ownership follows our catalog, not UDB's. UDB attributes vector CSRs to
// Zvl32b, the minimum VLEN extension, because any V implementation has
// VLEN >= 32. We file vector content under V, exactly as we already do for
// vector instructions, so VL and VTYPE appear where a reader looks for them.
const CSR_EXT_REMAP = { Zvl32b: 'V' };

// A real YAML parse, not the text matcher csrDefinedBy() uses above.
//
// That matcher scans the indented block under definedBy for any `name:`, which
// is fine for the simple supervisor entries it was written for and wrong at
// catalog scale. mstatus declares a conditional dependence on V and F because
// it carries VS and FS fields, so a text scan files mstatus, misa and sstatus
// under both V and F, while Zihpm's 58 counters match nothing at all. Reading
// the structure instead gives F its three FP CSRs and Zihpm its counters.
//
// The shape to respect: definedBy nests under an `extension` key, as
// `definedBy: {extension: {name: Zicntr}}`, and may carry anyOf/allOf/oneOf.
// Reading definedBy.name alone silently yields nothing, which reads as "UDB has
// no CSR data" rather than as a bug.
const YAML = require('yaml');

function csrOwners(node, out = new Set()) {
  if (node == null) return out;
  if (typeof node === 'string') { out.add(node); return out; }
  if (Array.isArray(node)) { node.forEach(n => csrOwners(n, out)); return out; }
  if (typeof node !== 'object') return out;
  if (node.extension) csrOwners(node.extension, out);
  else if (typeof node.name === 'string') out.add(node.name);
  for (const key of ['anyOf', 'allOf', 'oneOf']) if (node[key]) csrOwners(node[key], out);
  return out;
}

// csr/ is not flat. Alongside ~85 loose files it holds per-extension
// subdirectories (F, V, H, Zicntr, ...), which is where the FP, vector and
// counter CSRs live. Reading only the top level sees 85 of 396 files and
// reports F, V and Zihpm as having no CSRs at all.
function walkCsrFiles(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walkCsrFiles(full));
    else if (entry.name.endsWith('.yaml')) found.push(full);
  }
  return found;
}

const csrIndex = new Map();
for (const filepath of walkCsrFiles(UDB_CSR_DIR)) {
  let doc;
  try {
    doc = YAML.parse(fs.readFileSync(filepath, 'utf8'));
  } catch (err) {
    parseFailures++;
    console.warn('  warning: could not parse ' + filepath + ': ' + err.message);
    continue;
  }
  if (!doc || !doc.name) continue;

  const entry = buildCsrEntry(doc);
  for (const owner of csrOwners(doc.definedBy)) {
    const id = CSR_EXT_REMAP[owner] || owner;
    if (!entryIndex.has(id)) continue;
    if (!csrIndex.has(id)) csrIndex.set(id, {});
    csrIndex.get(id)[doc.name] = entry;
  }
}

let csrsAdded = 0;
let extsGainedCsrs = 0;
for (const [id, found] of csrIndex) {
  const loc = entryIndex.get(id);
  if (!loc) continue;
  const entry = loc.entries[loc.index];
  // Fill gaps only. An entry that already carries CSRs was curated or synced
  // earlier, and replacing it silently would discard that work.
  if (entry.csrs && Object.keys(entry.csrs).length) continue;
  const names = Object.keys(found);
  if (!names.length) continue;
  entry.csrs = Object.fromEntries(names.sort().map(n => [n, found[n]]));
  extsGainedCsrs++;
  csrsAdded += names.length;
  updated++;
}

console.log('');
console.log('CSR coverage pass: ' + extsGainedCsrs + ' extension(s) gained ' + csrsAdded + ' CSR(s)');
console.log('Version pass: ' + versionsWritten + ' extension(s) gained a version');

// This guard runs BEFORE the write: past the threshold, the in-memory catalog is
// half-synced (real fields silently dropped), so persisting it would corrupt the
// checked-in data on local runs and stage a bad diff. Abort untouched instead.
if (parseFailures > PARSE_FAILURE_THRESHOLD) {
  console.error(
    'ERROR: ' + parseFailures + ' YAML parse failures exceed the threshold of ' +
    PARSE_FAILURE_THRESHOLD + ' — UDB layout may have changed. Aborting without writing.'
  );
  process.exit(1);
}

// write back only if something changed
if (dryRun) {
  console.log('--dry-run: catalogue not written');
} else if (updated > 0) {
  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + '\n');
}

// Otherwise exit 0 regardless of whether data changed — the workflow checks
// git diff to decide whether to open a PR.
