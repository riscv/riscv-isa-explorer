/**
 * compareModel.js — the aligned row model behind side-by-side comparison.
 *
 * Pure logic, in a .js file rather than .jsx for the same reason tileMemo.js
 * is: node's test runner cannot import .jsx, so keeping the diffing here is
 * what makes it testable without adding a transform. Same split as
 * marchUtils.js and isaGraph.js.
 *
 * The view renders whatever this returns and holds no per-field conditionals of
 * its own — each row carries its own label, its cells, whether the items agree,
 * and the name of a renderer. Adding a field to a comparison is a change here,
 * not in the view.
 */
import { closure } from './isaGraph.js';
import { PROFILES } from './profiles.js';
import PROFILE_OPTIONAL from './profile-optional.json' with { type: 'json' };
import { profileMembership, REQUIREMENTS } from './profileExport.js';

/** Columns past this are refused rather than silently truncated. */
export const COMPARE_MAX = 6;

/** URL parameter carrying a comparison. `ext` remains the single-selection one. */
export const COMPARE_PARAM = 'cmp';

export function instructionKey(extId, mnemonic) {
  return `${extId}.${mnemonic}`;
}

/**
 * Splits on the FIRST dot, not the last.
 *
 * Extension ids never contain a dot but mnemonics routinely do — ADD.UW,
 * SH1ADD.UW, NTL.P1. Splitting on the last dot would read "Zba.ADD.UW" as
 * extension "Zba.ADD".
 */
export function parseInstructionKey(key) {
  const text = typeof key === 'string' ? key : '';
  const idx = text.indexOf('.');
  if (idx < 1 || idx === text.length - 1) return null;
  return { extId: text.slice(0, idx), mnemonic: text.slice(idx + 1) };
}

/**
 * Reduces a cell to the value equality is decided on.
 *
 * Absent stays distinguishable from empty: "no state recorded" differs from
 * "state is blank". Arrays compare as sets because tag order is not meaningful.
 */
export function normalizeCell(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const items = value.map((v) => String(v).trim().toLowerCase());
    return `[${[...new Set(items)].sort().join(' ')}]`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return String(value).trim().toLowerCase();
}

/** True when every cell carries the same value. A lone column always agrees. */
export function cellsAllSame(cells) {
  if (!Array.isArray(cells) || cells.length < 2) return true;
  const first = normalizeCell(cells[0]);
  return cells.every((cell) => Object.is(normalizeCell(cell), first));
}

function makeRow(field, items) {
  const cells = items.map(field.get);
  return {
    key: field.key,
    label: field.label,
    render: field.render,
    cells,
    allSame: cellsAllSame(cells),
  };
}

const countOf = (obj) => Object.keys(obj || {}).length;
const orNull = (value) => (value === undefined || value === null || value === '' ? null : value);
const listOrNull = (value) => (Array.isArray(value) && value.length > 0 ? value : null);

const EXTENSION_FIELDS = [
  { key: 'name', label: 'Name', render: 'text', get: (e) => orNull(e.name) },
  { key: 'long_name', label: 'Long name', render: 'text', get: (e) => orNull(e.long_name) },
  { key: 'state', label: 'State', render: 'text', get: (e) => orNull(e.state) },
  {
    key: 'ratification_date',
    label: 'Ratified',
    render: 'text',
    get: (e) => orNull(e.ratification_date),
  },
  { key: 'type', label: 'Type', render: 'text', get: (e) => orNull(e.type) },
  // No Tags row. `tags` is a sync-internal routing key — it names which
  // riscv-opcodes tag an entry's instructions are pulled from, not a property
  // of the extension — and reading it as an attribute is misleading. RV64E and
  // RV128I both carry `rv64_i` because upstream has no rv64_e or rv128 tag to
  // route from, so a comparison showed two different base ISAs with identical
  // tags belonging to neither. marchUtils.js:591 already special-cases those
  // same base tags at runtime for the same reason. The field stays because the
  // sync needs it; it just has no business on screen.
  { key: 'use', label: 'Use', render: 'text', get: (e) => orNull(e.use) },
  {
    key: 'instruction_count',
    label: 'Instructions',
    render: 'mono',
    get: (e) => countOf(e.instructions),
  },
  // The count answers "how many", which is the wrong question when the reason
  // for putting two extensions side by side is to see what each one actually
  // gives you. Mnemonics are the keys of the instructions object, the same
  // shape encodingMap.js and marchUtils.js read. Sorted so the two columns line
  // up for the eye; the diff highlight then does the rest.
  {
    key: 'instruction_list',
    label: 'Instruction list',
    render: 'chips',
    get: (e) => listOrNull(Object.keys(e.instructions || {}).sort()),
  },
  { key: 'csr_count', label: 'CSRs', render: 'mono', get: (e) => countOf(e.csrs) },
  { key: 'members', label: 'Members', render: 'chips', get: (e) => listOrNull(e.members) },
  {
    key: 'requires',
    label: 'Requires',
    render: 'chips',
    get: (e) => listOrNull([...closure(e.id)].sort()),
  },
  { key: 'desc', label: 'Description', render: 'text', get: (e) => orNull(e.desc) },
  { key: 'url', label: 'Specification', render: 'link', get: (e) => orNull(e.url) },
];

/**
 * @param {Array<object>} exts catalog entries, in the order the user pinned them
 */
export function buildExtensionComparison(exts) {
  const items = (exts || []).filter(Boolean);
  return {
    kind: 'ext',
    columns: items.map((e) => ({
      key: e.id,
      label: e.id,
      sublabel: orNull(e.long_name) ?? orNull(e.name),
    })),
    rows: EXTENSION_FIELDS.map((field) => makeRow(field, items)),
    bitDiff: null,
  };
}

const INSTRUCTION_FIELDS = [
  { key: 'owner', label: 'Extension', render: 'text', get: (it) => orNull(it.extId) },
  {
    key: 'encoding',
    label: 'Encoding',
    render: 'encoding',
    get: (it) => orNull(it.instr.encoding),
  },
  { key: 'match', label: 'Match', render: 'mono', get: (it) => orNull(it.instr.match) },
  { key: 'mask', label: 'Mask', render: 'mono', get: (it) => orNull(it.instr.mask) },
  {
    key: 'variable_fields',
    label: 'Variable fields',
    render: 'chips',
    get: (it) => listOrNull(it.instr.variable_fields),
  },
  { key: 'alias_of', label: 'Alias of', render: 'text', get: (it) => orNull(it.instr.alias_of) },
  {
    key: 'deprecated',
    label: 'Deprecated',
    render: 'text',
    get: (it) => (it.instr.deprecated ? 'yes' : 'no'),
  },
];

const normalizeEncoding = (value) => String(value ?? '').replace(/\s+/g, '');

/**
 * Which of the 32 bit positions the items disagree on.
 *
 * Index 0 is bit 31, matching both the stored string and EncodingDiagram's
 * left-to-right rendering. Returns null unless there are at least two items and
 * every one is exactly 32 characters: a short or malformed encoding has no bit
 * positions to align against, and a wrong alignment is worse than none.
 *
 * @param {string[]} encodings
 * @returns {boolean[] | null} 32 entries, or null
 */
export function encodingBitDiff(encodings) {
  const normalized = (encodings || []).map(normalizeEncoding);
  if (normalized.length < 2) return null;
  if (normalized.some((e) => e.length !== 32)) return null;
  const [first] = normalized;
  return Array.from({ length: 32 }, (_, i) => normalized.some((e) => e[i] !== first[i]));
}

/**
 * @param {Array<{extId: string, mnemonic: string, instr: object}>} items
 */
export function buildInstructionComparison(items) {
  const list = (items || []).filter((it) => it && it.instr);
  return {
    kind: 'instr',
    columns: list.map((it) => ({
      key: instructionKey(it.extId, it.mnemonic),
      label: it.mnemonic,
      sublabel: it.extId,
    })),
    rows: INSTRUCTION_FIELDS.map((field) => makeRow(field, list)),
    bitDiff: encodingBitDiff(list.map((it) => it.instr.encoding)),
  };
}

/**
 * What each profile says about each extension: mandatory, optional, or (with
 * expandDependencies) implied by a mandatory one. profileExport.js owns the
 * classification so the comparison and the download cannot disagree.
 *
 * profiles.js is a faithful transcription of the profile specification and
 * deliberately does NOT expand dependencies — the graph owns that. So the two
 * modes answer different questions: the literal lists are what the profile
 * document enumerates, the expanded one is what a conforming implementation
 * actually provides. An empty cell means different things in each, which is
 * why the view says which mode it is in rather than swapping silently.
 */
function membershipFor(name, expandDependencies) {
  return profileMembership({
    mandatory: PROFILES[name] || [],
    optional: PROFILE_OPTIONAL[name] || [],
    closure: expandDependencies ? closure : null,
  });
}

const REQUIREMENT_HEADINGS = { mandatory: 'Mandatory', implied: 'Implied', optional: 'Optional' };

/**
 * @param {string[]} names profile ids, in the order the user pinned them
 * @param {{expandDependencies?: boolean, order?: 'grouped'|'alphabetical'}} [options]
 *   `grouped` (the default) puts each extension under the strongest
 *   requirement any compared profile gives it, so the Mandatory group holds
 *   everything any of them mandates; rows are alphabetical within a group.
 */
export function buildProfileComparison(
  names,
  { expandDependencies = false, order = 'grouped' } = {},
) {
  const kept = (names || []).filter((n) => PROFILES[n]);
  const maps = kept.map((n) => membershipFor(n, expandDependencies));

  // The union, sorted, so the row order is stable and independent of which
  // profile happens to be pinned first.
  const union = [...new Set(maps.flatMap((m) => [...m.keys()]))].sort();

  const countRow = (key, label, requirement) => {
    const cells = maps.map((m) => [...m.values()].filter((v) => v.requirement === requirement).length);
    return { key, label, render: 'mono', cells, allSame: cellsAllSame(cells) };
  };

  const extensionRows = union.map((id) => {
    const cells = maps.map((m) => m.get(id)?.requirement ?? null);
    return {
      key: `ext:${id}`,
      label: id,
      render: 'requirement',
      cells,
      allSame: cellsAllSame(cells),
      // REQUIREMENTS is strongest first, so the lowest index wins.
      group: REQUIREMENTS[Math.min(...cells.filter(Boolean).map((c) => REQUIREMENTS.indexOf(c)))],
    };
  });

  const body =
    order === 'alphabetical'
      ? extensionRows
      : REQUIREMENTS.flatMap((requirement) => {
          const members = extensionRows.filter((r) => r.group === requirement);
          if (members.length === 0) return [];
          return [
            {
              key: `section:${requirement}`,
              label: REQUIREMENT_HEADINGS[requirement],
              render: 'section',
              count: members.length,
              cells: kept.map(() => null),
              allSame: true,
            },
            ...members,
          ];
        });

  return {
    kind: 'profile',
    expandedDependencies: Boolean(expandDependencies),
    order: order === 'alphabetical' ? 'alphabetical' : 'grouped',
    columns: kept.map((n) => ({ key: n, label: n, sublabel: null })),
    rows: [
      countRow('extension_count', 'Mandatory', 'mandatory'),
      ...(expandDependencies ? [countRow('implied_count', 'Implied', 'implied')] : []),
      countRow('optional_count', 'Optional', 'optional'),
      ...body,
    ],
    bitDiff: null,
  };
}

const KIND_FOR_PREFIX = { e: 'ext', i: 'instr', p: 'profile' };
const PREFIX_FOR_KIND = { ext: 'e', instr: 'i', profile: 'p' };

/**
 * Encodes a comparison for the `cmp` URL parameter.
 *
 * @param {'ext'|'instr'} kind
 * @param {string[]} keys extension ids, or extId.MNEMONIC keys
 * @returns {string} '' when there is nothing to encode
 */
export function buildComparePermalink(kind, keys) {
  const prefix = PREFIX_FOR_KIND[kind];
  const list = (keys || []).filter(Boolean);
  if (!prefix || list.length === 0) return '';
  return `${prefix}:${list.join(',')}`;
}

/**
 * Reads a `cmp` parameter back into resolvable keys.
 *
 * Never throws. A shared link outlives the catalog it was made from, so an id
 * that no longer exists must degrade to a shorter comparison rather than to a
 * blank page. Everything unresolvable comes back in `dropped` so the caller can
 * say what it discarded. Segments that resolve fine but arrive past
 * COMPARE_MAX come back in `overflow` instead — being over the cap is a
 * different fact than being unrecognized, and the two must not be reported
 * with the same message.
 */
export function parseComparePermalink(value, allExts) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return { kind: null, resolved: [], dropped: [], overflow: [] };

  const colon = raw.indexOf(':');
  const kind = colon > 0 ? KIND_FOR_PREFIX[raw.slice(0, colon).toLowerCase()] : undefined;
  if (!kind) return { kind: null, resolved: [], dropped: [raw], overflow: [] };

  const byExtId = new Map(
    (allExts || []).filter((e) => e && e.id).map((e) => [e.id.toLowerCase(), e]),
  );
  const segments = raw
    .slice(colon + 1)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const resolved = [];
  const dropped = [];
  const overflow = [];
  const seen = new Set();

  for (const segment of segments) {
    let key = null;

    if (kind === 'profile') {
      key = Object.keys(PROFILES).find((n) => n.toLowerCase() === segment.toLowerCase()) || null;
    } else if (kind === 'ext') {
      const ext = byExtId.get(segment.toLowerCase());
      if (ext) key = ext.id;
    } else {
      const parsed = parseInstructionKey(segment);
      const ext = parsed ? byExtId.get(parsed.extId.toLowerCase()) : null;
      const mnemonic = ext
        ? Object.keys(ext.instructions || {}).find(
            (m) => m.toLowerCase() === parsed.mnemonic.toLowerCase(),
          )
        : null;
      if (ext && mnemonic) key = instructionKey(ext.id, mnemonic);
    }

    if (!key) {
      dropped.push(segment);
      continue;
    }
    // A duplicate segment is intentionally collapsed here — it lands in
    // neither `resolved` (a second time) nor `dropped`, since re-pinning the
    // same item is neither new data nor a problem worth reporting.
    if (seen.has(key)) continue;
    if (resolved.length >= COMPARE_MAX) {
      overflow.push(segment);
      continue;
    }
    seen.add(key);
    resolved.push(key);
  }

  return { kind, resolved, dropped, overflow };
}

/**
 * The rows a view shows. With differencesOnly, rows that agree are dropped,
 * and so is any section heading left with nothing under it: a lone
 * "Optional" over an empty group reads as a claim that the group exists.
 * Section headings never count as differences themselves.
 */
export function visibleRows(model, { differencesOnly = false } = {}) {
  if (!model) return [];
  if (!differencesOnly) return model.rows;
  const kept = model.rows.filter((r) => r.render === 'section' || !r.allSame);
  return kept.filter(
    (r, i) => r.render !== 'section' || (kept[i + 1] && kept[i + 1].render !== 'section'),
  );
}

/** Rows that compare something, i.e. everything except section headings. */
export const comparedRows = (model) => (model?.rows ?? []).filter((r) => r.render !== 'section');

/**
 * Flattens a cell to table text.
 *
 * Newlines collapse because a pipe table is one row per line, and `|` is
 * escaped because an unescaped one silently invents a column. `null` renders as
 * an em dash so an absent value reads as absent rather than as a gap.
 */
function cellText(value, render) {
  // Presence is a claim about membership, so it renders as a mark rather than
  // the word "true" — and false must not fall through to String(false).
  if (render === 'presence') return value ? '\u2713' : '—';
  if (render === 'requirement') return value ? value.charAt(0).toUpperCase() + value.slice(1) : '—';
  if (value === null || value === undefined) return '—';
  const text = Array.isArray(value) ? value.join(', ') : String(value);
  const flat = text.replace(/\s*\n\s*/g, ' ').trim();
  // Backslash first, then pipe — in one pass so neither escapes the other's
  // output. Escaping the delimiter without escaping the escape character is
  // the classic incomplete sanitization: `a\|b` would become `a\\|b`, which
  // Markdown reads as a literal backslash followed by an UNESCAPED pipe, and
  // the cell silently splits the row into an extra column.
  return flat === '' ? '—' : flat.replace(/[\\|]/g, (c) => `\\${c}`);
}

/**
 * Renders a comparison as a GitHub-flavoured pipe table.
 *
 * @param {object} model from buildExtensionComparison or buildInstructionComparison
 * @param {{differencesOnly?: boolean}} [options] pass the view's current toggle
 *   so the export matches what the user is looking at
 */
export function toMarkdown(model, { differencesOnly = false } = {}) {
  if (!model || !Array.isArray(model.columns) || model.columns.length === 0) return '';

  const headers = model.columns.map((c) =>
    c.sublabel && c.sublabel !== c.label ? `${c.label} (${c.sublabel})` : c.label,
  );
  const rows = visibleRows(model, { differencesOnly });

  return [
    `| Attribute | ${headers.map(cellText).join(' | ')} |`,
    `| --- | ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((r) =>
      r.render === 'section'
        ? `| **${cellText(r.label)}** | ${r.cells.map(() => '').join(' | ')} |`
        : `| ${cellText(r.label)} | ${r.cells.map((c) => cellText(c, r.render)).join(' | ')} |`,
    ),
  ].join('\n');
}
