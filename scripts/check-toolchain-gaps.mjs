#!/usr/bin/env node
/**
 * Report the ratified extensions each toolchain's newest release does not
 * accept yet.
 *
 *   node scripts/check-toolchain-gaps.mjs [--json]
 *
 * scripts/sync_toolchain_support.mjs keeps src/toolchain-support.json current,
 * which says when each tool caught up. Nothing read it the other way round:
 * which ratified extensions a tool still lacks, and for how long. This does,
 * and .github/workflows/check-toolchain-gaps.yml keeps one issue current with
 * the result.
 *
 * Reads only committed data, so it needs no network. Exit codes are a contract
 * with the workflow: 0 no gaps, 1 gaps (the last line is `complete: false`),
 * 2 the data could not be read.
 *
 * Linux is reported apart. The kernel lists the extensions it uses or reports
 * to user space, so many ratified names never appear there and need nothing
 * from it; a missing Linux entry is a lead, not a defect.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marchToken } from '../src/toolchainSupport.js';

/* The tools whose missing entries are real gaps, in report order. */
export const GAP_TOOLS = ['llvm', 'gcc', 'binutils', 'qemu'];
/* Reported, but as leads rather than gaps (see the header). */
export const LEAD_TOOLS = ['linux'];

/*
 * Ratified catalogue entries that carry a -march token but are not extensions
 * any tool is expected to accept. Each needs its reason; the tests fail when
 * an id leaves the catalogue or a tool starts accepting it, so the list cannot
 * quietly hide a real gap.
 */
const PRIV_VERSION =
  'a privileged-specification version the profiles name, not an extension tools take in -march';
export const NOT_GAPS = {
  Sm1p11: PRIV_VERSION,
  Sm1p12: PRIV_VERSION,
  Sm1p13: PRIV_VERSION,
  Ss1p11: PRIV_VERSION,
  Ss1p12: PRIV_VERSION,
  Ss1p13: PRIV_VERSION,
  RERI: 'a non-ISA specification (RAS error records, read through memory-mapped registers)',
  HTI: 'a non-ISA specification (the interface between a hart and its trace encoder)',
};

/*
 * Upstream work on a gap: { Id: { tool: 'https://…' } }. Shown in the report
 * so a gap leads somewhere. The tests fail once the tool accepts the extension,
 * so a link is dropped when its work has landed.
 */
export const TRACKING = {};

const TOOL_NAMES = {
  llvm: 'Clang',
  gcc: 'GCC',
  binutils: 'binutils',
  qemu: 'QEMU',
  linux: 'Linux',
};

/* Every catalogue entry, in file order. */
export function flattenCatalogue(catalogue) {
  return Object.values(catalogue)
    .flat()
    .filter((ext) => ext && ext.id);
}

/* "2y 04m" from a YYYY-MM ratification date to `now`; null when unknown. */
export function ageSince(yyyymm, now) {
  const m = String(yyyymm ?? '').match(/^(\d{4})-(\d{2})/);
  if (!m) return null;
  const months =
    (now.getUTCFullYear() - Number(m[1])) * 12 + (now.getUTCMonth() + 1 - Number(m[2]));
  if (months < 0) return null;
  return `${Math.floor(months / 12)}y ${String(months % 12).padStart(2, '0')}m`;
}

/*
 * The gaps, per tool. Only ratified entries with a -march token count: an id
 * with no entry in the data (S, U, Sv39…) is not something -march takes, so
 * "not accepted" would be a false answer for it.
 */
export function toolchainGaps(data, catalogue, { now = new Date() } = {}) {
  const ratified = flattenCatalogue(catalogue).filter(
    (ext) => ext.state === 'ratified' && data.extensions[marchToken(ext.id)],
  );
  const rows = (key) => {
    const missing = [];
    const experimental = [];
    for (const ext of ratified) {
      if (NOT_GAPS[ext.id]) continue;
      const entry = data.extensions[marchToken(ext.id)][key] ?? {};
      if (entry.supported) continue;
      const row = {
        id: ext.id,
        ratified: ext.ratification_date ?? null,
        open: ageSince(ext.ratification_date, now),
        parts: entry.parts ?? null,
        tracking: TRACKING[ext.id]?.[key] ?? null,
      };
      if (entry.experimental) experimental.push({ ...row, since: entry.experimental });
      else missing.push(row);
    }
    // Oldest first: the longest-open gap is the one to look at.
    const byDate = (a, b) =>
      String(a.ratified ?? '9999').localeCompare(String(b.ratified ?? '9999'));
    return { missing: missing.sort(byDate), experimental: experimental.sort(byDate) };
  };
  const tool = (key) => {
    const newest = data.tools[key].releases.at(-1);
    return {
      key,
      name: TOOL_NAMES[key] ?? key,
      newest: newest.version,
      date: newest.date,
      ...rows(key),
    };
  };
  return {
    ratified: ratified.length,
    gaps: GAP_TOOLS.map(tool),
    leads: LEAD_TOOLS.map(tool),
    stale: staleEntries(data, ratified),
  };
}

/* NOT_GAPS and TRACKING entries that no longer describe the data. */
export function staleEntries(data, ratified) {
  const stale = [];
  const byId = new Map(ratified.map((ext) => [ext.id, ext]));
  const tools = [...GAP_TOOLS, ...LEAD_TOOLS];
  for (const id of Object.keys(NOT_GAPS)) {
    if (!byId.has(id)) {
      stale.push(`NOT_GAPS.${id}: no longer a ratified -march entry in the catalogue`);
      continue;
    }
    const entry = data.extensions[marchToken(id)];
    for (const key of tools) {
      if (entry[key]?.supported || entry[key]?.experimental) {
        stale.push(`NOT_GAPS.${id}: ${TOOL_NAMES[key]} accepts it now, so it may be a real gap`);
      }
    }
  }
  for (const [id, links] of Object.entries(TRACKING)) {
    for (const key of Object.keys(links)) {
      const entry = data.extensions[marchToken(id)]?.[key];
      if (!byId.has(id) || !tools.includes(key))
        stale.push(`TRACKING.${id}.${key}: not a gap this report covers`);
      else if (entry?.supported)
        stale.push(`TRACKING.${id}.${key}: ${TOOL_NAMES[key]} accepts it now`);
    }
  }
  return stale;
}

function table(rows, { experimental = false } = {}) {
  const head = experimental
    ? [
        '| Extension | Ratified | Open for | Experimental since | Upstream work |',
        '|---|---|---|---|---|',
      ]
    : ['| Extension | Ratified | Open for | Upstream work |', '|---|---|---|---|'];
  const note = (r) => (r.parts ? ` (every part since ${r.parts.since})` : '');
  return [
    ...head,
    ...rows.map((r) =>
      [
        '',
        `${r.id}${note(r)}`,
        r.ratified ?? '?',
        r.open ?? '?',
        ...(experimental ? [r.since] : []),
        r.tracking ? `[link](${r.tracking})` : '',
        '',
      ]
        .join(' | ')
        .trim(),
    ),
  ].join('\n');
}

function section(t, lead) {
  const lines = [`### ${t.name} ${t.newest} (${t.date})`, ''];
  if (!t.missing.length && !t.experimental.length)
    return [...lines, 'Accepts every ratified extension.', ''].join('\n');
  if (t.missing.length) {
    lines.push(
      `${t.missing.length} ${lead ? 'not listed' : 'not accepted'}:`,
      '',
      table(t.missing),
      '',
    );
  }
  if (t.experimental.length) {
    lines.push(
      `${t.experimental.length} accepted only as experimental:`,
      '',
      table(t.experimental, { experimental: true }),
      '',
    );
  }
  return lines.join('\n');
}

export function formatReport(result) {
  const count = (t) => t.missing.length + t.experimental.length;
  const summary = [...result.gaps, ...result.leads]
    .map((t) => `| ${t.name} ${t.newest} | ${t.missing.length} | ${t.experimental.length} |`)
    .join('\n');
  const out = [
    `Ratified extensions with a -march token: ${result.ratified}. Not counted (with reasons in scripts/check-toolchain-gaps.mjs): ${Object.keys(NOT_GAPS).join(', ')}.`,
    '',
    '| Newest release | Not accepted | Experimental only |',
    '|---|---|---|',
    summary,
    '',
    '## Gaps',
    '',
    ...result.gaps.map((t) => section(t, false)),
    '## Linux (leads, not gaps)',
    '',
    'The kernel lists the extensions it uses or reports to user space, so many ratified names never appear there and need nothing from it. Read these as leads.',
    '',
    ...result.leads.map((t) => section(t, true)),
  ];
  if (result.stale.length) {
    out.push('## Stale entries in the script', '', ...result.stale.map((s) => `- ${s}`), '');
  }
  out.push(`complete: ${result.gaps.every((t) => count(t) === 0)}`);
  return out.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  let result;
  try {
    const read = (f) =>
      JSON.parse(fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8'));
    result = toolchainGaps(read('toolchain-support.json'), read('riscv_extensions.json'));
  } catch (err) {
    console.error(`check-toolchain-gaps: ${err.message}`);
    process.exit(2);
  }
  console.log(
    process.argv.includes('--json') ? JSON.stringify(result, null, 2) : formatReport(result),
  );
  process.exit(result.gaps.every((t) => !t.missing.length && !t.experimental.length) ? 0 : 1);
}
