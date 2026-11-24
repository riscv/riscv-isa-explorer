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
 * Upstream work on a gap: { Id: { tool: { url, state } } }, shown in the
 * report so a gap leads somewhere. `state` says how far the work is ("on
 * main, first release Clang 24", "patch v1, 2026-11-22"). The tests fail once
 * the tool accepts the extension, so a link goes when its work has shipped.
 * Checked 2026-11-24; a gap with no entry has no upstream work found.
 */
const SPMP_GCC = {
  url: 'https://patchwork.sourceware.org/project/gcc/patch/20261122033744.173193-1-jiawei@iscas.ac.cn/',
  state: 'patch v1, 2026-11-22',
};
const SPMP_LLVM = {
  url: 'https://github.com/llvm/llvm-project/pull/207696',
  state: 'on main, first release Clang 24',
};
const SPMP_BINUTILS = {
  url: 'https://sourceware.org/git/?p=binutils-gdb.git;a=commit;h=b16f10037c4814ab03416a4ab143337591881e2b',
  state: 'on master, first release binutils 2.48',
};
const SPMP_QEMU = {
  url: 'https://patchew.org/QEMU/20260318185238.99143-1-luisccunha8@gmail.com/',
  state: 'RFC v1, 2026-03-18',
};
const GCC_MINIMAL = (commit) => ({
  url: `https://github.com/gcc-mirror/gcc/commit/${commit}`,
  state: 'on master, first release GCC 17',
});
const VLEN_QEMU = {
  url: 'https://patchew.org/QEMU/20260717094046.1600827-1-joel.bueno@openchip.com/',
  state: 'series v2, 2026-07-17 (raises the VLEN cap from 1024 to 65536)',
};
export const TRACKING = {
  Sspmp: { llvm: SPMP_LLVM, gcc: SPMP_GCC, binutils: SPMP_BINUTILS, qemu: SPMP_QEMU },
  Sspmpen: { llvm: SPMP_LLVM, gcc: SPMP_GCC, binutils: SPMP_BINUTILS, qemu: SPMP_QEMU },
  Smpmpdeleg: { llvm: SPMP_LLVM, gcc: SPMP_GCC, binutils: SPMP_BINUTILS, qemu: SPMP_QEMU },
  Zicfiss: {
    llvm: {
      url: 'https://github.com/llvm/llvm-project/pull/217794',
      state: 'on main, first release Clang 24',
    },
  },
  Zicfilp: {
    llvm: {
      url: 'https://github.com/llvm/llvm-project/pull/157015',
      state: 'pull request open since 2025-09-05',
    },
  },
  Q: {
    gcc: {
      url: 'https://patchwork.sourceware.org/project/gcc/patch/20250909033222.2302895-1-shihua@iscas.ac.cn/',
      state: 'patch v1, 2025-09-09, changes requested',
    },
  },
  Smcdeleg: { gcc: GCC_MINIMAL('320b40cca27e8983f3d290de110a3a06774850e5') },
  Ssccfg: { gcc: GCC_MINIMAL('d69c9828a50cc5309869c491a5cab08657eef1d9') },
  Ssqosid: {
    gcc: GCC_MINIMAL('be7a231d52b91d7a50dc88f628e03ce0721c1b05'),
    qemu: {
      url: 'https://patchew.org/QEMU/20261111-riscv-ssqosid-cbqri-v8-0-121f6dcfb573@kernel.org/',
      state: 'series v8, 2026-11-11',
    },
  },
  Ziccamoc: {
    gcc: GCC_MINIMAL('bab1ed6f96a90398ad55eb73978a0ea2b97adec7'),
    binutils: {
      url: 'https://sourceware.org/git/?p=binutils-gdb.git;a=commit;h=cd2166234b9e6569b1cf8a4169e58f487996c447',
      state: 'on master, first release binutils 2.48',
    },
  },
  Smctr: { gcc: GCC_MINIMAL('22fe3a35d341d2044c5ced341eec11484b36a18f') },
  Ssctr: { gcc: GCC_MINIMAL('ebe3818ac8e4390a94ee99c6501eeb14aa8b4b01') },
  Svrsw60t59b: { gcc: GCC_MINIMAL('741dd3fa641a4506e5b138ba5de9eb45ebbf6888') },
  Zalasr: { gcc: GCC_MINIMAL('d58044c97ef8b5ecd490fd897fa086028053e4a2') },
  Ziccid: {
    gcc: GCC_MINIMAL('a3ee6072ca6d72faa61f99b7aab2ead0b4a3c102'),
    binutils: {
      url: 'https://sourceware.org/git/?p=binutils-gdb.git;a=commit;h=9caf79667b214062cc9c3f5c4a58c5ac8567b0ae',
      state: 'on master, first release binutils 2.48',
    },
  },
  Sdext: {
    gcc: {
      url: 'https://patchwork.sourceware.org/project/gcc/patch/20261122033557.153193-1-jiawei@iscas.ac.cn/',
      state: 'patch v1, 2026-11-22',
    },
    binutils: {
      url: 'https://sourceware.org/git/?p=binutils-gdb.git;a=commit;h=da9f1249e9157b33218518227dd51c70395cec24',
      state: 'on master, first release binutils 2.48',
    },
    qemu: {
      url: 'https://github.com/qemu/qemu/commit/3065350ec908179c89de6901b2991883aee64f47',
      state: 'on master, first release QEMU 11.2',
    },
  },
  Zama16b: {
    binutils: {
      url: 'https://sourceware.org/git/?p=binutils-gdb.git;a=commit;h=59db9002142a655b4d5e4af7cbf0605aaddefc7e',
      state: 'on master, first release binutils 2.48',
    },
  },
  Shlcofideleg: {
    binutils: {
      url: 'https://sourceware.org/git/?p=binutils-gdb.git;a=commit;h=7d157b544f4ad3fd70fc79fad5e726df1ab03dbe',
      state: 'on master, first release binutils 2.48',
    },
  },
  Zvl2048b: { qemu: VLEN_QEMU },
  Zvl4096b: { qemu: VLEN_QEMU },
  Zvl8192b: { qemu: VLEN_QEMU },
  Zvl16384b: { qemu: VLEN_QEMU },
  Zvl32768b: { qemu: VLEN_QEMU },
  Zvl65536b: { qemu: VLEN_QEMU },
};

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
        r.tracking ? `[${r.tracking.state}](${r.tracking.url})` : '',
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
    .map(
      (t) =>
        `| ${t.name} ${t.newest} | ${t.missing.length} | ${t.experimental.length} | ${[...t.missing, ...t.experimental].filter((r) => r.tracking).length} |`,
    )
    .join('\n');
  const out = [
    `Ratified extensions with a -march token: ${result.ratified}. Not counted (with reasons in scripts/check-toolchain-gaps.mjs): ${Object.keys(NOT_GAPS).join(', ')}.`,
    '',
    '| Newest release | Not accepted | Experimental only | With upstream work |',
    '|---|---|---|---|',
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
