/**
 * The printable pocket guide: one A6 page per extension, for reading away
 * from a screen.
 *
 * Every build writes print-ready HTML to pocket-guide/ next to the bundle:
 *
 *   - riscv-pocket-guide.html   every ratified extension, bases included
 *   - <profile>.html            one per profile in src/profiles.js, holding
 *                               that profile and the extensions it resolves to
 *
 * The deploy job prints each one to a PDF of the same name with the runner's
 * Chrome (scripts/pocket-guide-pdf.mjs). Nothing here is committed.
 *
 * Page numbers are computed here, not by CSS: every block has a page count
 * fixed by the data (one page per extension, a fixed number of chips, draft
 * rows and index rows per page), so the profile chips and the index can name
 * the page an extension is on before any of it is rendered. That is also why
 * nothing on a page may grow with the data: an extension with 600
 * instructions shows the first INSTRUCTION_CAP and says how many more there
 * are, rather than spilling onto a page the numbering does not know about.
 *
 * buildGuide() and buildAllGuides() are pure: they take the parsed data and
 * return strings. loadInputs() reads the data files, so the build and the
 * tests share it. Run directly, the module writes the files to dist/.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOGUE_GROUPS } from '../src/evolutionModel.js';
import {
  buildMarchString,
  NON_MARCH_IDS,
  SINGLE_LETTER_CANONICAL_ORDER,
} from '../src/marchUtils.js';
import { resolveSelection } from '../src/isaGraph.js';
import { PROFILES, PROFILE_METADATA } from '../src/profiles.js';
import { extensionSupport } from '../src/toolchainSupport.js';
import { pocketGuidePath, POCKET_GUIDE_DIR } from '../src/profileExport.js';
import { SITE_URL } from './static-pages.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const SRC = join(ROOT, 'src');

/* Fixed per-page capacities. Changing one moves page numbers, nothing else. */
export const INSTRUCTION_CAP = 10;
export const NEEDS_CAP = 10;
export const FIRST_PROFILE_PAGE_CHIPS = 40;
export const PROFILE_PAGE_CHIPS = 64;
export const DRAFT_ROWS_PER_PAGE = 20;
export const INDEX_ROWS_PER_COLUMN = 30;
export const INDEX_ROWS_PER_PAGE = INDEX_ROWS_PER_COLUMN * 2;

export const FULL_EDITION = 'full';
export const TOOL_KEYS = ['llvm', 'gcc', 'binutils', 'qemu', 'linux'];

/** The data files a build reads, so webpack can watch them. */
export const INPUT_FILES = [
  'riscv_extensions.json',
  'isa-dependency-graph.json',
  'toolchain-support.json',
].map((f) => join(SRC, f));

export function loadInputs({ date = new Date().toISOString().slice(0, 10) } = {}) {
  const [catalog, graph, toolchain] = INPUT_FILES.map((f) => JSON.parse(readFileSync(f, 'utf8')));
  const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  return {
    catalog,
    graph,
    toolchain,
    profiles: PROFILES,
    profileMetadata: PROFILE_METADATA,
    groups: CATALOGUE_GROUPS,
    version,
    date,
  };
}

const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const extUrl = (siteUrl, id) => `${siteUrl}ext/${id.toLowerCase()}/`;
const shortUrl = (url) => url.replace(/^https?:\/\//, '');
const isBase = (id) => /^RV(32|64|128)[IE]$/.test(id);

/* Print-safe colours for the edge tabs, dark enough for white text. */
const TAB_COLOURS = ['#283272', '#0f6466', '#6b2d6b', '#8a3a12', '#2f6b2f', '#44546a'];
const TAB_POSITIONS = 4;

const STATES = {
  ratified: { label: 'Ratified', cls: 'st-ratified' },
  frozen: { label: 'Frozen', cls: 'st-frozen' },
  development: { label: 'Development', cls: 'st-dev' },
  draft: { label: 'Draft', cls: 'st-dev' },
  withdrawn: { label: 'Withdrawn', cls: 'st-gone' },
};
const stateOf = (ext) =>
  ext.discontinued
    ? { label: 'Discontinued', cls: 'st-gone' }
    : (STATES[ext.state] ?? { label: 'Unconfirmed', cls: 'st-gone' });

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/** A 32-bit encoding split into its usual fields, fixed bits dark, operand bits grey. */
const ENCODING_SPLIT = [7, 5, 5, 3, 5, 7];

function bitRuns(bits) {
  return bits.replace(/[01]+/g, (m) => `<b>${m}</b>`).replace(/-+/g, (m) => `<i>${m}</i>`);
}

export function encodingCells(encoding) {
  const enc = String(encoding ?? '');
  // Compressed encodings are stored as 32 characters with the top half
  // unspecified; their opcode (bits 1:0) is never 11.
  if (enc.length === 32 && enc.startsWith('-'.repeat(16)) && !enc.endsWith('11')) {
    return `<span class="f16">${bitRuns(enc.slice(16))}</span>`;
  }
  if (enc.length !== 32 || /[^01-]/.test(enc)) return `<span>${esc(enc)}</span>`;
  let at = 0;
  return ENCODING_SPLIT.map((n) => {
    const part = enc.slice(at, at + n);
    at += n;
    return `<span>${bitRuns(part)}</span>`;
  }).join('<span class="sep">|</span>');
}

function folio(number, url) {
  return (
    `<footer class="folio"><span class="pn">${number}</span>` +
    `<span class="url">${esc(shortUrl(url))}</span></footer>`
  );
}

function pageRef(id, pageOf) {
  const n = pageOf.get(id);
  return n ? `<a class="ref" href="#p${n}">${esc(id)}<span class="pg">${n}</span></a>` : esc(id);
}

function toolchainRow(toolchain, id) {
  const support = extensionSupport(toolchain, id, TOOL_KEYS);
  if (!support) return { html: '', floor: false };
  let floor = false;
  const cells = support.map((s) => {
    let value = '—';
    if (s.state === 'supported') {
      value = esc(s.since) + (s.earliest ? '*' : '');
      floor ||= s.earliest;
    } else if (s.state === 'experimental') {
      value = `exp. ${esc(s.since)}${s.earliest ? '*' : ''}`;
      floor ||= s.earliest;
    }
    return `<div class="tc"><span class="tk">${esc(s.name)}</span><span class="tv">${value}</span></div>`;
  });
  return { html: `<div class="tools">${cells.join('')}</div>`, floor };
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function coverPage({ number, editionTitle, editionNote, date, version, udb, siteUrl }) {
  return `<section class="page cover" id="p${number}" data-kind="cover">
<div class="cover-kicker">RISC-V International</div>
<h1 class="cover-title">RISC-V<br>Pocket Guide</h1>
<div class="cover-rule"></div>
<div class="cover-edition">${esc(editionTitle)}</div>
<p class="cover-note">${esc(editionNote)}</p>
<dl class="cover-meta">
<div><dt>Built</dt><dd>${esc(date)}</dd></div>
<div><dt>Explorer</dt><dd>v${esc(version)}</dd></div>
<div><dt>riscv-unified-db</dt><dd>${esc(udb)}</dd></div>
</dl>
<div class="cover-url">${esc(shortUrl(siteUrl))}</div>
</section>`;
}

function howToPage({ number, siteUrl }) {
  return `<section class="page howto" id="p${number}" data-kind="howto">
<div class="kicker">Before you start</div>
<h2>How to read this guide</h2>
<h3>Each extension page</h3>
<ol class="anatomy">
<li><b>Edge tab</b> on the right names the catalogue group, so a closed guide can be thumbed by section.</li>
<li><b>Name</b>, status and version, and the ratification date when there is one.</li>
<li><b>Does</b>, <b>Use for</b>, and <b>Needs</b>: the extensions it directly requires.</li>
<li><b>Encodings</b> of up to ${INSTRUCTION_CAP} instructions; the rest are in the online explorer.</li>
<li><b>Tools</b>: the first Clang, GCC, binutils, QEMU and Linux releases that accept it.</li>
</ol>
<h3>Status</h3>
<div class="legend">
<span class="chip st-ratified">Ratified</span>
<span class="chip st-frozen">Frozen</span>
<span class="chip st-dev">Draft / Development</span>
<span class="chip st-gone">Withdrawn / Unconfirmed</span>
</div>
<h3>Encodings</h3>
<div class="enc-sample">${encodingCells('0000100----------000-----0111011')}</div>
<p class="small">Fixed bits are dark; operand bits are grey dashes. 32-bit encodings are split
funct7 | rs2 | rs1 | funct3 | rd | opcode, bit 31 first. Compressed (16-bit) encodings are shown
whole.</p>
<h3>Numbers</h3>
<p class="small">A small number beside an extension name is the page it is on. A <b>*</b> on a
tool version means the oldest release checked already had it, so support may be older. The index
is at the back.</p>
<p class="small muted">Generated from the RISC-V ISA Explorer catalogue. The specification is the
authority.</p>
${folio(number, siteUrl)}
</section>`;
}

const CHIP_GROUPS = [
  { key: 'base', label: 'Base' },
  { key: 'single', label: 'Single-letter' },
  { key: 'unpriv', label: 'Unprivileged (Z*)' },
  { key: 'priv', label: 'Privileged (S*, H)' },
];

function chipGroup(id) {
  if (isBase(id)) return 'base';
  if (id === 'H' || /^S/.test(id)) return 'priv';
  if (id.length === 1) return 'single';
  return 'unpriv';
}

/** A profile's resolved catalogue extensions, ordered by chip group. */
function orderChips(ids) {
  const letterRank = (id) => {
    const i = SINGLE_LETTER_CANONICAL_ORDER.indexOf(id.toLowerCase());
    return i === -1 ? 99 : i;
  };
  return CHIP_GROUPS.flatMap(({ key }) => {
    const members = ids.filter((id) => chipGroup(id) === key);
    return key === 'single'
      ? members.sort((a, b) => letterRank(a) - letterRank(b) || a.localeCompare(b))
      : members.sort((a, b) => a.localeCompare(b));
  });
}

function profileChunks(chips) {
  const chunks = [chips.slice(0, FIRST_PROFILE_PAGE_CHIPS)];
  for (let i = FIRST_PROFILE_PAGE_CHIPS; i < chips.length; i += PROFILE_PAGE_CHIPS) {
    chunks.push(chips.slice(i, i + PROFILE_PAGE_CHIPS));
  }
  return chunks;
}

function profilePage({ number, profile, part, parts, chunk, info, pageOf, siteUrl }) {
  const groups = CHIP_GROUPS.map(({ key, label }) => {
    const members = chunk.filter((id) => chipGroup(id) === key);
    if (!members.length) return '';
    const chips = members
      .map((id) => {
        const n = pageOf.get(id);
        return n
          ? `<a class="pchip" href="#p${n}" data-ref="${esc(id)}" data-page="${n}">` +
              `<span>${esc(id)}</span><span class="pg">${n}</span></a>`
          : `<span class="pchip absent"><span>${esc(id)}</span><span class="pg">—</span></span>`;
      })
      .join('');
    return `<div class="pgroup"><div class="pgroup-label">${esc(label)}</div><div class="pchips">${chips}</div></div>`;
  }).join('');
  const url = `${siteUrl}?profile=${encodeURIComponent(profile)}`;
  const head =
    part === 0
      ? `<div class="kicker">Profile</div>
<h2 class="pname">${esc(profile)}</h2>
<p class="pdesc">${esc(info.description)}</p>
<p class="pcounts"><b>${info.mandatory}</b> mandatory extensions · <b>${info.resolved}</b> with everything they require${info.xlen ? ` · RV${info.xlen}` : ''}</p>
<div class="march"><span class="label">-march</span><code>${info.march ? esc(info.march).replace(/_/g, '_<wbr>') : '—'}</code></div>`
      : `<div class="kicker">Profile, continued (${part + 1} of ${parts})</div>
<h2 class="pname small">${esc(profile)}</h2>`;
  return `<section class="page profile" id="p${number}" data-kind="profile" data-profile="${esc(profile)}">
${head}
${groups}
${part < parts - 1 ? '<p class="cont">Continued overleaf.</p>' : ''}
${folio(number, url)}
</section>`;
}

function extensionPage({ number, ext, groupLabel, groupIndex, node, toolchain, pageOf, siteUrl }) {
  const state = stateOf(ext);
  const colour = TAB_COLOURS[groupIndex % TAB_COLOURS.length];
  const tabTop = 8 + (groupIndex % TAB_POSITIONS) * 33;

  const chips = [`<span class="chip ${state.cls}">${esc(state.label)}</span>`];
  if (ext.version) chips.push(`<span class="chip plain">v${esc(ext.version)}</span>`);
  if (ext.ratification_date) {
    chips.push(`<span class="chip plain">Ratified ${esc(ext.ratification_date)}</span>`);
  }

  const needs = [
    ...(node?.requires ?? [])
      .map((r) => r.ext)
      .filter(Boolean)
      .map((id) => pageRef(id, pageOf)),
    ...(node?.requiresOneOf ?? [])
      .filter((r) => r.options?.length)
      .map((r) => `one of ${r.options.map((id) => pageRef(id, pageOf)).join(' / ')}`),
  ];
  const needsHtml = needs.length
    ? needs.slice(0, NEEDS_CAP).join(', ') +
      (needs.length > NEEDS_CAP ? `, +${needs.length - NEEDS_CAP} more` : '')
    : '<span class="muted">Nothing beyond the base ISA</span>';

  const instructions = Object.entries(ext.instructions ?? {});
  const shown = instructions.slice(0, INSTRUCTION_CAP);
  const more = instructions.length - shown.length;
  const encTable = instructions.length
    ? `<table class="enc"><thead><tr><th>Instruction</th><th>Encoding <span class="muted">(${instructions.length})</span></th></tr></thead><tbody>` +
      shown
        .map(
          ([mnemonic, enc]) =>
            `<tr class="enc-row"><td class="mn">${esc(mnemonic)}</td><td class="bits">${encodingCells(enc.encoding)}</td></tr>`,
        )
        .join('') +
      '</tbody></table>' +
      (more > 0 ? `<p class="more">+${more} more — see the online explorer</p>` : '')
    : '<p class="noenc muted">No instruction encodings: this extension is defined by state, CSRs or behaviour.</p>';

  const tools = toolchainRow(toolchain, ext.id);
  const token =
    !isBase(ext.id) && !NON_MARCH_IDS.has(ext.id)
      ? `<div class="token"><span class="label">-march</span><code>_${esc(ext.id.toLowerCase())}</code></div>`
      : '';
  const longName =
    ext.long_name && ext.long_name !== ext.short && ext.long_name !== ext.id
      ? `<div class="lname">${esc(ext.long_name)}</div>`
      : '';

  return `<section class="page ext" id="p${number}" data-kind="ext" data-ext="${esc(ext.id)}">
<div class="edge" style="background:${colour};top:${tabTop}mm"><span>${esc(groupLabel)}</span></div>
<div class="kicker" style="color:${colour}">${esc(groupLabel)}</div>
<h2 class="eid">${esc(ext.id)}</h2>
${ext.short && ext.short !== ext.id ? `<div class="sname">${esc(ext.short)}</div>` : ''}
${longName}
<div class="chips">${chips.join('')}</div>
<dl class="facts">
<dt>Does</dt><dd class="clamp4">${esc(ext.desc || '—')}</dd>
${ext.use ? `<dt>Use for</dt><dd class="clamp2">${esc(ext.use)}</dd>` : ''}
<dt>Needs</dt><dd class="clamp3">${needsHtml}</dd>
</dl>
${encTable}
<div class="bottom">
${tools.html}
${tools.floor ? '<p class="foot">* earliest release checked</p>' : ''}
${token}
</div>
${folio(number, extUrl(siteUrl, ext.id))}
</section>`;
}

function draftsPage({ number, rows, part, parts, siteUrl }) {
  const body = rows
    .map((ext) => {
      const state = stateOf(ext);
      return (
        `<tr><td class="did">${esc(ext.id)}</td><td><span class="chip ${state.cls}">${esc(state.label)}</span></td>` +
        `<td class="dname">${esc(ext.short || ext.name || '')}</td></tr>`
      );
    })
    .join('');
  return `<section class="page drafts" id="p${number}" data-kind="drafts">
<div class="kicker">Not yet ratified${parts > 1 ? ` (${part + 1} of ${parts})` : ''}</div>
<h2>Drafts and proposals</h2>
${part === 0 ? '<p class="small">Listed in the explorer but not ratified, so they have no page here. They may change or never be ratified.</p>' : ''}
<table class="dlist"><tbody>${body}</tbody></table>
${folio(number, siteUrl)}
</section>`;
}

function indexPage({ number, entries, part, parts, siteUrl }) {
  const column = (list) =>
    `<ol class="icol">${list
      .map(
        ({ id, page }) =>
          `<li><a href="#p${page}" data-ref="${esc(id)}" data-page="${page}"><span class="iid">${esc(id)}</span><span class="dots"></span><span class="ipg">${page}</span></a></li>`,
      )
      .join('')}</ol>`;
  return `<section class="page index" id="p${number}" data-kind="index">
<div class="kicker">Index${parts > 1 ? ` (${part + 1} of ${parts})` : ''}</div>
<h2>Extensions A–Z</h2>
<div class="icols">${column(entries.slice(0, INDEX_ROWS_PER_COLUMN))}${column(entries.slice(INDEX_ROWS_PER_COLUMN))}</div>
${folio(number, siteUrl)}
</section>`;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

const chunk = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

function profileInfo(name, { profiles, profileMetadata, graph, catalogIds, all }) {
  const members = profiles[name] ?? [];
  const base = members.find(isBase) ?? null;
  const { resolved } = resolveSelection({ selected: members, base, graph });
  const ids = resolved.filter((id) => catalogIds.has(id));
  const { march } = buildMarchString(ids, all);
  const meta = profileMetadata?.[name] ?? {};
  return {
    ids,
    march,
    mandatory: members.length,
    resolved: ids.length,
    xlen: meta.xlen ?? null,
    description: meta.description ?? '',
  };
}

/**
 * One edition of the guide.
 *
 * @param {object} inputs  as returned by loadInputs()
 * @param {string} inputs.edition  FULL_EDITION, or a profile name
 * @returns {{ html: string, pages: {number: number, kind: string, id?: string, profile?: string}[], title: string }}
 */
export function buildGuide({
  catalog,
  graph,
  toolchain,
  profiles = PROFILES,
  profileMetadata = PROFILE_METADATA,
  groups = CATALOGUE_GROUPS,
  edition = FULL_EDITION,
  date = '',
  version = '',
  siteUrl = SITE_URL,
}) {
  const full = edition === FULL_EDITION;
  if (!full && !profiles[edition]) throw new Error(`Unknown profile edition: ${edition}`);

  const groupOrder = [
    ...groups.map((g) => g.key).filter((key) => catalog[key]),
    ...Object.keys(catalog).filter((key) => !groups.some((g) => g.key === key)),
  ];
  const labels = new Map(groups.map((g) => [g.key, g.label]));
  const entries = groupOrder.flatMap((group, groupIndex) =>
    (catalog[group] ?? []).map((ext) => ({ ext, group, groupIndex })),
  );
  const all = entries.map(({ ext }) => ext);
  const catalogIds = new Set(all.map((ext) => ext.id));
  const ctx = { profiles, profileMetadata, graph, catalogIds, all };

  const profileNames = full ? Object.keys(profiles) : [edition];
  const infos = new Map(profileNames.map((name) => [name, profileInfo(name, ctx)]));

  const included = full
    ? entries.filter(({ ext }) => ext.state === 'ratified' && !ext.discontinued)
    : entries.filter(({ ext }) => infos.get(edition).ids.includes(ext.id));
  const drafts = full ? all.filter((ext) => ext.state !== 'ratified' || ext.discontinued) : [];

  // Lay out every page before rendering any, so references know their target.
  const plan = [{ kind: 'cover' }, { kind: 'howto' }];
  for (const name of profileNames) {
    const chunks = profileChunks(orderChips([...infos.get(name).ids]));
    chunks.forEach((ids, part) =>
      plan.push({ kind: 'profile', profile: name, part, parts: chunks.length, ids }),
    );
  }
  for (const entry of included) plan.push({ kind: 'ext', id: entry.ext.id, entry });
  const draftChunks = chunk(drafts, DRAFT_ROWS_PER_PAGE);
  draftChunks.forEach((rows, part) =>
    plan.push({ kind: 'drafts', rows, part, parts: draftChunks.length }),
  );
  plan.forEach((p, i) => (p.number = i + 1));

  const pageOf = new Map(plan.filter((p) => p.kind === 'ext').map((p) => [p.id, p.number]));
  const indexEntries = [...pageOf]
    .map(([id, page]) => ({ id, page }))
    .sort((a, b) => a.id.localeCompare(b.id, 'en', { sensitivity: 'base', numeric: true }));
  const indexChunks = chunk(indexEntries, INDEX_ROWS_PER_PAGE);
  indexChunks.forEach((list, part) =>
    plan.push({ kind: 'index', entries: list, part, parts: indexChunks.length, number: 0 }),
  );
  plan.forEach((p, i) => (p.number = i + 1));

  const editionTitle = full ? 'Ratified extensions' : `${edition} profile`;
  const editionNote = full
    ? `${included.length} ratified extensions and ${profileNames.length} profiles, one page each.`
    : `${infos.get(edition).resolved} extensions: the ${infos.get(edition).mandatory} the profile mandates and everything they require.`;
  const udb = String(graph?.sources?.udb?.commit ?? '').slice(0, 7) || 'unknown';

  const body = plan
    .map((p) => {
      const { number } = p;
      switch (p.kind) {
        case 'cover':
          return coverPage({ number, editionTitle, editionNote, date, version, udb, siteUrl });
        case 'howto':
          return howToPage({ number, siteUrl });
        case 'profile':
          return profilePage({
            number,
            profile: p.profile,
            part: p.part,
            parts: p.parts,
            chunk: p.ids,
            info: infos.get(p.profile),
            pageOf,
            siteUrl,
          });
        case 'ext':
          return extensionPage({
            number,
            ext: p.entry.ext,
            groupLabel: labels.get(p.entry.group) ?? p.entry.group,
            groupIndex: p.entry.groupIndex,
            node: graph?.nodes?.[p.entry.ext.id],
            toolchain,
            pageOf,
            siteUrl,
          });
        case 'drafts':
          return draftsPage({ number, rows: p.rows, part: p.part, parts: p.parts, siteUrl });
        default:
          return indexPage({ number, entries: p.entries, part: p.part, parts: p.parts, siteUrl });
      }
    })
    .join('\n');

  const title = `RISC-V Pocket Guide: ${editionTitle}`;
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${body}
</body>
</html>
`;
  const pages = plan.map(({ number, kind, id, profile }) => ({
    number,
    kind,
    ...(id ? { id } : {}),
    ...(profile ? { profile } : {}),
  }));
  return { html, pages, title };
}

/** Every edition, with the path it is published at (relative to dist/). */
export function buildAllGuides(inputs) {
  const editions = [FULL_EDITION, ...Object.keys(inputs.profiles ?? PROFILES)];
  return editions.map((edition) => ({
    edition,
    path: pocketGuidePath(edition === FULL_EDITION ? null : edition, 'html'),
    ...buildGuide({ ...inputs, edition }),
  }));
}

export { POCKET_GUIDE_DIR };

const STYLE = `
@page{size:105mm 148mm;margin:0}
*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
html,body{margin:0;padding:0;background:#fff}
body{color:#1a1a24;font:7.4pt/1.35 system-ui,-apple-system,"Segoe UI","Helvetica Neue",Arial,"Liberation Sans","DejaVu Sans",sans-serif}
@media screen{body{background:#8a8a96;padding:8mm 0}.page{margin:0 auto 6mm;box-shadow:0 1px 6px rgba(0,0,0,.35)}}
code,.bits,.mn,.enc-sample{font-family:ui-monospace,"SF Mono",Menlo,Consolas,"DejaVu Sans Mono","Liberation Mono",monospace}
a{color:inherit;text-decoration:none}
.page{position:relative;width:105mm;height:148mm;overflow:hidden;background:#fff;padding:8mm 13mm 11mm 8mm;break-after:page;page-break-after:always}
.page:last-child{break-after:auto;page-break-after:auto}
h2{margin:0;font-size:13pt;line-height:1.15;color:#283272}
h3{margin:3.2mm 0 1mm;font-size:7.6pt;text-transform:uppercase;letter-spacing:.06em;color:#283272}
.kicker{font-size:6.2pt;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:#8a5e00;margin-bottom:1mm}
.muted{color:#5a5a6a}
.small{font-size:6.8pt;margin:1mm 0}
.label{font-size:5.8pt;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#5a5a6a;margin-right:1.5mm}
.folio{position:absolute;left:8mm;right:13mm;bottom:4.5mm;display:flex;justify-content:space-between;align-items:baseline;border-top:.2mm solid #c9cbd8;padding-top:1.2mm;font-size:5.8pt;color:#5a5a6a}
.folio .pn{font-weight:700;color:#283272;font-size:7pt}
.folio .url{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;margin-left:3mm}
.chip{display:inline-block;padding:.3mm 1.6mm;border-radius:1.2mm;font-size:6.2pt;font-weight:700;border:.2mm solid currentColor;margin:0 1mm .8mm 0;white-space:nowrap}
.chip.plain{color:#3a3a4a;border-color:#c9cbd8;font-weight:600}
.st-ratified{color:#1d6b35;background:#e6f3ea}
.st-frozen{color:#1f4f96;background:#e6eef9}
.st-dev{color:#8a5300;background:#fbf0dc}
.st-gone{color:#55555f;background:#ececf0}
/* cover */
.cover{background:#283272;color:#fff;padding:14mm 11mm 10mm}
.cover-kicker{font-size:6.6pt;letter-spacing:.14em;text-transform:uppercase;color:#f2b632;font-weight:700}
.cover-title{font-size:25pt;line-height:1.05;margin:6mm 0 0;font-weight:800;color:#fff}
.cover-rule{width:22mm;height:1.4mm;background:#f2b632;margin:6mm 0 5mm}
.cover-edition{font-size:12pt;font-weight:700;color:#fff}
.cover-note{font-size:7.4pt;color:#d9dcf0;margin:2mm 0 0;max-width:72mm}
.cover-meta{position:absolute;left:11mm;right:11mm;bottom:20mm;margin:0;display:grid;grid-template-columns:1fr;gap:1.4mm}
.cover-meta div{display:flex;justify-content:space-between;border-bottom:.2mm solid rgba(255,255,255,.25);padding-bottom:.8mm}
.cover-meta dt{font-size:6.4pt;text-transform:uppercase;letter-spacing:.08em;color:#f2b632;font-weight:700}
.cover-meta dd{margin:0;font-size:7.6pt;font-family:ui-monospace,"SF Mono",Menlo,"DejaVu Sans Mono",monospace}
.cover-url{position:absolute;left:11mm;bottom:9mm;font-size:7pt;color:#f2b632}
/* how to */
.anatomy{margin:0;padding-left:4mm}
.anatomy li{margin-bottom:.8mm}
.legend{display:flex;flex-wrap:wrap}
.enc-sample{font-size:7pt;margin:1mm 0}
/* encodings */
.bits b{font-weight:700;color:#1a1a24}
.bits i,.enc-sample i{font-style:normal;color:#a3a6b8}
.enc-sample b{color:#1a1a24}
.sep{color:#c3c5d2;margin:0 .15em}
/* profile */
.pname{font-size:17pt}
.pname.small{font-size:12pt;margin-bottom:2mm}
.pdesc{margin:1mm 0 .6mm;font-size:7.2pt}
.pcounts{margin:0 0 2mm;font-size:6.8pt;color:#3a3a4a}
.march{background:#f3f4f9;border-left:.8mm solid #c98a00;padding:1.2mm 1.6mm;margin-bottom:2.2mm;font-size:5.6pt;line-height:1.3;max-height:24mm;overflow:hidden}
.march code{overflow-wrap:anywhere}
.pgroup{margin-bottom:1.6mm}
.pgroup-label{font-size:5.8pt;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#283272;margin-bottom:.6mm}
.pchips{display:grid;grid-template-columns:repeat(4,1fr);gap:.8mm}
.pchip{display:flex;justify-content:space-between;align-items:baseline;border:.2mm solid #c9cbd8;border-radius:1mm;padding:.35mm .7mm;font-size:5.5pt;letter-spacing:-.015em;font-weight:600;white-space:nowrap;overflow:hidden}
.pchip span:first-child{overflow:hidden;text-overflow:ellipsis}
.pchip .pg{color:#8a5e00;font-weight:700;margin-left:.6mm;font-size:5.2pt}
.pchip.absent{border-style:dashed;color:#5a5a6a}
.cont{position:absolute;right:13mm;bottom:10.5mm;margin:0;font-size:6pt;color:#5a5a6a;font-style:italic}
/* extension */
.edge{position:absolute;right:0;width:7mm;height:34mm;border-radius:1.6mm 0 0 1.6mm;color:#fff;display:flex;align-items:center;justify-content:center}
.edge span{writing-mode:vertical-rl;font-size:5.3pt;font-weight:700;letter-spacing:.02em;white-space:nowrap;max-height:32mm;overflow:hidden}
.eid{font-size:21pt;line-height:1.05;letter-spacing:-.01em}
.sname{font-size:8.6pt;font-weight:700;margin-top:.6mm;color:#1a1a24}
.lname{font-size:6.6pt;line-height:1.3;color:#5a5a6a;margin-top:.3mm;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2}
.chips{margin:1.6mm 0 1.2mm}
.facts{display:grid;grid-template-columns:11mm 1fr;gap:.9mm 1.6mm;margin:0 0 2mm}
.facts dt{font-size:5.8pt;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#283272;padding-top:.25mm}
.facts dd{margin:0;font-size:7pt;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical}
.clamp4{-webkit-line-clamp:4}.clamp3{-webkit-line-clamp:3}.clamp2{-webkit-line-clamp:2}
.ref .pg,.ref + .pg{font-size:5.4pt;color:#8a5e00;font-weight:700;margin-left:.3mm;vertical-align:super;line-height:0}
table{border-collapse:collapse;width:100%}
.enc th{font-size:5.8pt;text-align:left;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#283272;border-bottom:.25mm solid #283272;padding:0 0 .5mm}
.enc td{padding:.42mm 0;border-bottom:.15mm solid #e2e3ec;font-size:6.3pt;white-space:nowrap;line-height:1.25}
.enc .mn{font-weight:700;max-width:24mm;overflow:hidden;text-overflow:ellipsis;padding-right:1.5mm}
.enc .bits{font-size:5.9pt;text-align:right}
.more{margin:.8mm 0 0;font-size:6.2pt;color:#5a5a6a;font-style:italic}
.noenc{font-size:6.6pt;margin:0}
.bottom{position:absolute;left:8mm;right:13mm;bottom:11.5mm}
.tools{display:grid;grid-template-columns:repeat(5,1fr);border:.2mm solid #c9cbd8;border-radius:1mm;overflow:hidden}
.tc{padding:.6mm 1mm;border-right:.2mm solid #e2e3ec;display:flex;flex-direction:column}
.tc:last-child{border-right:0}
.tk{font-size:5.2pt;text-transform:uppercase;letter-spacing:.05em;color:#5a5a6a;font-weight:700}
.tv{font-size:7pt;font-weight:700;color:#1a1a24}
.foot{margin:.5mm 0 0;font-size:5.4pt;color:#5a5a6a}
.token{margin-top:1mm;font-size:7pt}
.token code{font-weight:700;color:#283272}
/* drafts */
.dlist td{padding:.6mm 1mm .6mm 0;border-bottom:.15mm solid #e2e3ec;font-size:6.6pt;vertical-align:baseline}
.dlist .chip{margin:0;font-size:5.4pt;padding:0 1.2mm}
.did{font-weight:700;white-space:nowrap}
.dname{color:#3a3a4a;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;max-width:44mm}
.drafts h2,.index h2{margin-bottom:1.6mm}
/* index */
.icols{display:grid;grid-template-columns:1fr 1fr;gap:0 4mm}
.icol{list-style:none;margin:0;padding:0}
.icol li{font-size:6.6pt;line-height:3.5mm;height:3.5mm}
.icol a{display:flex;align-items:baseline}
.iid{font-weight:600;white-space:nowrap}
.dots{flex:1;border-bottom:.2mm dotted #a3a6b8;margin:0 1mm;transform:translateY(-.6mm)}
.ipg{font-weight:700;color:#283272}
`;

// ---------------------------------------------------------------------------
// CLI: write every edition to dist/pocket-guide/ (the build does this too).
// ---------------------------------------------------------------------------
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] ?? join(ROOT, 'dist');
  mkdirSync(join(out, POCKET_GUIDE_DIR), { recursive: true });
  for (const guide of buildAllGuides(loadInputs())) {
    writeFileSync(join(out, guide.path), guide.html);
    console.log(`${guide.path}: ${guide.pages.length} pages`);
  }
}
