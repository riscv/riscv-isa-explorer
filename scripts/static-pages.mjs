/**
 * Static HTML for search engines and AI crawlers.
 *
 * The explorer itself is a single-page app: its index.html ships an empty
 * <div id="root"> and everything a reader sees is drawn by JavaScript. Google
 * renders that eventually; most AI crawlers never run the script, so to them
 * the site is a title and a meta description. This module writes what they can
 * read instead:
 *
 *   - one page per catalogue extension, at ext/<id lowercased>/
 *   - a sitemap listing the app and every page
 *   - a linked index of every extension, placed inside #root, which React
 *     replaces on mount
 *
 * Nothing here is committed. webpack.config.js calls it on every build, so a
 * UDB sync or a new catalogue entry reaches the pages on the next deploy with
 * no extra step. A removed entry's page disappears the same way.
 *
 * buildStaticPages() is pure: it takes the parsed data and returns strings.
 * loadInputs() reads the data files, so the build and the tests share it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOGUE_GROUPS } from '../src/evolutionModel.js';

export const SITE_URL = 'https://tech.riscv.org/isa-explorer/';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', 'src');

/** The data files a build reads, so webpack can watch them. */
export const INPUT_FILES = [
  'riscv_extensions.json',
  'isa-dependency-graph.json',
  'instruction-metadata.json',
].map((f) => join(SRC, f));

export function loadInputs() {
  const [catalog, graph, metadata] = INPUT_FILES.map((f) => JSON.parse(readFileSync(f, 'utf8')));
  return { catalog, graph, metadata, groups: CATALOGUE_GROUPS };
}

export const slugFor = (id) => id.toLowerCase();
export const pagePathFor = (id) => `ext/${slugFor(id)}/index.html`;
const pageUrlFor = (siteUrl, id) => `${siteUrl}ext/${slugFor(id)}/`;

const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

// JSON inside a <script> must not be able to close the element.
const jsonLd = (data) => JSON.stringify(data).replace(/</g, '\\u003c');

function statusLine(ext) {
  const parts = [];
  if (ext.discontinued) parts.push('Discontinued');
  else if (ext.state === 'ratified') {
    parts.push(ext.ratification_date ? `Ratified ${ext.ratification_date}` : 'Ratified');
  } else if (ext.state) parts.push(ext.state.charAt(0).toUpperCase() + ext.state.slice(1));
  else parts.push('Status not confirmed');
  if (ext.version) parts.push(`version ${ext.version}`);
  return parts.join(' · ');
}

// riscv-unified-db fills long_name with this placeholder for instructions it
// has not described yet; a blank cell says the same thing without pretending
// to be a name.
const PLACEHOLDER_NAMES = new Set(['No synopsis available']);
const instructionName = (meta) =>
  meta?.long_name && !PLACEHOLDER_NAMES.has(meta.long_name) ? meta.long_name : '';

const STYLE = `
:root{--bg:#ffffff;--fg:#1a1a24;--muted:#4a4a5a;--line:#d8d8e0;--link:#0b57a4;--code:#f3f3f7}
@media (prefers-color-scheme:dark){:root{--bg:#14141e;--fg:#ececf2;--muted:#b4b4c4;--line:#34344a;--link:#8cc4ff;--code:#1f1f2e}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:960px;margin:0 auto;padding:24px 16px 48px}
a{color:var(--link)}
h1{font-size:1.9rem;margin:.4em 0 .1em}
h2{font-size:1.15rem;margin:2em 0 .5em;border-bottom:1px solid var(--line);padding-bottom:.25em}
h3{font-size:.95rem;margin:1.2em 0 .3em;color:var(--muted)}
.muted{color:var(--muted)}
.cta{display:inline-block;margin:1em 0;padding:.5em 1em;border:1px solid var(--link);border-radius:6px;text-decoration:none;font-weight:600}
.table-wrap{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:.92rem}
th,td{text-align:left;padding:.35em .6em;border-bottom:1px solid var(--line);vertical-align:top}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code);padding:0 .25em;border-radius:3px;white-space:nowrap}
ul.inline{list-style:none;padding:0;display:flex;flex-wrap:wrap;gap:.4em 1em}
footer{margin-top:3em;font-size:.88rem}
`;

function extLink(id, ids, siteUrl) {
  return ids.has(id) ? `<a href="${esc(pageUrlFor(siteUrl, id))}">${esc(id)}</a>` : esc(id);
}

function linkList(list, ids, siteUrl) {
  return `<ul class="inline">${list.map((id) => `<li>${extLink(id, ids, siteUrl)}</li>`).join('')}</ul>`;
}

function renderPage({ ext, groupLabel, node, requiredBy, metadata, ids, siteUrl }) {
  const url = pageUrlFor(siteUrl, ext.id);
  const appUrl = `${siteUrl}?ext=${encodeURIComponent(ext.id)}`;
  const heading = ext.short && ext.short !== ext.id ? `${ext.id}: ${ext.short}` : ext.id;
  const title = `${heading} | RISC-V ISA Explorer`;
  const description = ext.desc || ext.long_name || ext.short || ext.id;
  const sections = [];

  const requires = (node?.requires ?? []).map((r) => r.ext).filter(Boolean);
  const oneOf = (node?.requiresOneOf ?? []).map((r) => r.options ?? []).filter((o) => o.length);
  const conflicts = (node?.conflicts ?? []).map((r) => r.ext).filter(Boolean);
  if (requires.length || oneOf.length || conflicts.length || requiredBy.length) {
    const rows = [];
    if (requires.length) rows.push(`<h3>Requires</h3>${linkList(requires, ids, siteUrl)}`);
    for (const options of oneOf) {
      rows.push(`<h3>Requires one of</h3>${linkList(options, ids, siteUrl)}`);
    }
    if (conflicts.length)
      rows.push(`<h3>Incompatible with</h3>${linkList(conflicts, ids, siteUrl)}`);
    if (requiredBy.length) rows.push(`<h3>Required by</h3>${linkList(requiredBy, ids, siteUrl)}`);
    sections.push(`<h2>Dependencies</h2>${rows.join('')}`);
  }

  if (ext.members?.length) {
    sections.push(`<h2>Members</h2>${linkList(ext.members, ids, siteUrl)}`);
  }

  const instructions = Object.entries(ext.instructions ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  if (instructions.length) {
    const rows = instructions
      .map(([mnemonic, enc]) => {
        const name = instructionName(metadata[mnemonic.toLowerCase()]);
        return (
          `<tr><td><code>${esc(mnemonic)}</code></td><td>${esc(name)}</td>` +
          `<td><code>${esc(enc.encoding)}</code></td>` +
          `<td><code>${esc(enc.match)}</code></td><td><code>${esc(enc.mask)}</code></td></tr>`
        );
      })
      .join('');
    sections.push(
      `<h2>Instructions (${instructions.length})</h2><div class="table-wrap"><table>` +
        '<thead><tr><th>Mnemonic</th><th>Name</th><th>Encoding</th><th>Match</th><th>Mask</th></tr></thead>' +
        `<tbody>${rows}</tbody></table></div>`,
    );
  } else {
    sections.push(
      '<h2>Instructions</h2><p class="muted">No instruction encodings are listed for this extension in the catalogue.</p>',
    );
  }

  const csrs = Object.entries(ext.csrs ?? {});
  if (csrs.length) {
    const rows = csrs
      .map(
        ([name, csr]) =>
          `<tr><td><code>${esc(name)}</code></td><td><code>${esc(csr.address)}</code></td>` +
          `<td>${esc(csr.priv_mode)}</td><td>${esc(csr.desc)}</td></tr>`,
      )
      .join('');
    sections.push(
      `<h2>Control and status registers (${csrs.length})</h2><div class="table-wrap"><table>` +
        '<thead><tr><th>Name</th><th>Address</th><th>Mode</th><th>Description</th></tr></thead>' +
        `<tbody>${rows}</tbody></table></div>`,
    );
  }

  const structured = {
    '@context': 'https://schema.org',
    '@type': 'DefinedTerm',
    name: ext.id,
    alternateName: ext.short || undefined,
    description,
    url,
    inDefinedTermSet: { '@type': 'DefinedTermSet', name: 'RISC-V ISA extensions', url: siteUrl },
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="RISC-V ISA Explorer">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
<script type="application/ld+json">${jsonLd(structured)}</script>
<style>${STYLE}</style>
</head>
<body>
<main>
<p class="muted"><a href="${esc(siteUrl)}">RISC-V ISA Explorer</a> · ${esc(groupLabel)}</p>
<h1>${esc(heading)}</h1>
<p class="muted">${esc(statusLine(ext))}</p>
${ext.desc ? `<p>${esc(ext.desc)}</p>` : ''}
${ext.use ? `<p><strong>Typical use:</strong> ${esc(ext.use)}</p>` : ''}
${ext.url ? `<p><a href="${esc(ext.url)}">Specification</a></p>` : ''}
<a class="cta" href="${esc(appUrl)}">Open ${esc(ext.id)} in the explorer</a>
${sections.join('\n')}
<footer class="muted">
<p>Generated from the <a href="https://github.com/riscv/riscv-isa-explorer">RISC-V ISA Explorer</a> catalogue, which is synced from <a href="https://github.com/riscv/riscv-unified-db">riscv-unified-db</a> and checked against <a href="https://github.com/riscv/riscv-opcodes">riscv-opcodes</a>. The specification is the authority.</p>
</footer>
</main>
</body>
</html>
`;
}

/**
 * @returns {{ pages: {path: string, html: string}[], sitemap: string, indexHtml: string }}
 */
export function buildStaticPages({ catalog, graph, metadata, groups, siteUrl = SITE_URL }) {
  const labels = new Map(groups.map((g) => [g.key, g.label]));
  const entries = Object.entries(catalog).flatMap(([group, list]) =>
    list.map((ext) => ({ group, ext })),
  );
  const ids = new Set(entries.map(({ ext }) => ext.id));
  const nodes = graph.nodes ?? {};

  const requiredBy = new Map();
  for (const [id, node] of Object.entries(nodes)) {
    for (const r of node.requires ?? []) {
      if (!r.ext) continue;
      if (!requiredBy.has(r.ext)) requiredBy.set(r.ext, []);
      requiredBy.get(r.ext).push(id);
    }
  }

  const pages = entries.map(({ group, ext }) => ({
    path: pagePathFor(ext.id),
    html: renderPage({
      ext,
      groupLabel: labels.get(group) ?? group,
      node: nodes[ext.id],
      requiredBy: (requiredBy.get(ext.id) ?? []).sort(),
      metadata,
      ids,
      siteUrl,
    }),
  }));

  const urls = [siteUrl, ...entries.map(({ ext }) => pageUrlFor(siteUrl, ext.id))];
  const sitemap =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map((u) => `  <url><loc>${esc(u)}</loc></url>`).join('\n') +
    '\n</urlset>\n';

  // Catalogue order, grouped as the app groups them. React replaces this on
  // mount, so a reader with JavaScript sees it only for the moment before the
  // bundle runs; a crawler without JavaScript sees a linked index of every page.
  const groupSections = Object.entries(catalog)
    .filter(([, list]) => list.length)
    .map(
      ([group, list]) =>
        `<h2>${esc(labels.get(group) ?? group)}</h2><ul>` +
        list
          .map(
            (ext) =>
              `<li><a href="ext/${esc(slugFor(ext.id))}/">${esc(ext.id)}</a>` +
              `${ext.short && ext.short !== ext.id ? `: ${esc(ext.short)}` : ''}</li>`,
          )
          .join('') +
        '</ul>',
    )
    .join('');
  const indexHtml =
    '<main class="static-index"><h1>RISC-V ISA Explorer</h1>' +
    '<p>An interactive reference for RISC-V extensions, profiles and per-instruction encodings. ' +
    'Pick a base ISA or a ratified profile, add extensions, and get a dependency-resolved ' +
    'configuration with a valid -march string.</p>' +
    `<p>The catalogue lists ${entries.length} extensions:</p>${groupSections}</main>`;

  return { pages, sitemap, indexHtml };
}
