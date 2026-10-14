/**
 * Reads which RISC-V extensions a release of LLVM, GCC, binutils, QEMU or
 * Linux knows, from that release's own source, and turns a run of releases
 * into "since" versions per extension.
 *
 * Each toolchain has kept its extension list in one file, though the file and
 * its format moved over the years:
 *
 *   LLVM 14-18  llvm/lib/Support/RISCVISAInfo.cpp, two arrays:
 *               SupportedExtensions[] and SupportedExperimentalExtensions[]
 *   LLVM 19-20  RISCVFeatures.td, `RISCVExtension<"zba", 1, 0, ...>` and
 *               `RISCVExperimentalExtension<"...">`
 *   LLVM 21+    RISCVFeatures.td, the name dropped from the record and taken
 *               from the def: `def FeatureStdExtZba : RISCVExtension<1, 0, ...>`
 *   GCC 12-15   gcc/common/config/riscv/riscv-common.cc,
 *               riscv_ext_version_table[] = { {"zba", ISA_SPEC_CLASS_NONE, 1, 0}, ...
 *   GCC 16+     gcc/config/riscv/riscv-ext.def, `DEFINE_RISCV_EXT(NAME zba, ...` (NAME in a comment)
 *   binutils    bfd/elfxx-riscv.c, the riscv_supported_std*_ext[] arrays,
 *               { {"zba", ISA_SPEC_CLASS_DRAFT, 1, 0, 0}, ... (one format since 2.38)
 *   QEMU 7.x    target/riscv/cpu.c, DEFINE_PROP_BOOL("zba", ...) properties
 *   QEMU 8+     target/riscv/cpu.c, ISA_EXT_DATA_ENTRY(zba, ...), plus
 *               MULTI_EXT_CFG_BOOL("zba", ...) and MISA_EXT_INFO(RVV, "v", ...)
 *   Linux 6.6+  arch/riscv/kernel/cpufeature.c, riscv_isa_ext[] of
 *               __RISCV_ISA_EXT_DATA(zba, ...) and its _BUNDLE/_SUPERSET kin
 *
 * LLVM's experimental extensions are accepted only with
 * -menable-experimental-extensions and an exact version, and QEMU's only as
 * an "x-" property (-cpu rv64,x-zvfh=on), so both are kept apart from
 * supported ones. GCC, binutils and Linux have no such tier.
 *
 * Pure: takes file contents, touches no network or disk.
 */

/* name -> 'supported' | 'experimental', from LLVM 14-18's RISCVISAInfo.cpp. */
export function parseLlvmIsaInfo(text) {
  const result = new Map();
  for (const [array, status] of [
    ['SupportedExtensions', 'supported'],
    ['SupportedExperimentalExtensions', 'experimental'],
  ]) {
    const start = text.search(new RegExp(`\\b${array}\\[\\]\\s*=\\s*\\{`));
    if (start < 0) continue;
    const end = text.indexOf('};', start);
    for (const m of text.slice(start, end).matchAll(/\{\s*"([a-z0-9]+)"\s*,/g)) {
      result.set(m[1], status);
    }
  }
  return result;
}

/* name -> status, from LLVM 19+'s RISCVFeatures.td (both record styles). */
export function parseLlvmFeatures(text) {
  const result = new Map();
  const defs = /def\s+FeatureStdExt(\w+)\s*:\s*RISCV(Experimental)?Extension<\s*("([a-z0-9]+)")?/g;
  for (const m of text.matchAll(defs)) {
    result.set(m[4] ?? m[1].toLowerCase(), m[2] ? 'experimental' : 'supported');
  }
  // Zvl64b..Zvl65536b come from a loop over powers of two, not one def each.
  const loop = text.match(
    /foreach\s+i\s*=\s*\{\s*(\d+)\s*-\s*(\d+)\s*\}\s*in\s*\{\s*defvar\s+I\s*=\s*!shl\(1,\s*i\);\s*def\s+FeatureStdExtZvl#I#b/,
  );
  if (loop) {
    for (let i = Number(loop[1]); i <= Number(loop[2]); i++)
      result.set(`zvl${2 ** i}b`, 'supported');
  }
  return result;
}

/* name -> 'supported', from GCC 12-15's riscv-common.cc. */
export function parseGccCommon(text) {
  const result = new Map();
  const start = text.search(/riscv_ext_version_table\[\]\s*=\s*\{/);
  if (start < 0) return result;
  const end = text.indexOf('};', start);
  for (const m of text.slice(start, end).matchAll(/\{\s*"([a-z0-9]+)"\s*,/g)) {
    result.set(m[1], 'supported');
  }
  return result;
}

/* name -> 'supported', from GCC 16+'s riscv-ext.def. */
export function parseGccExtDef(text) {
  const result = new Map();
  for (const m of text.matchAll(
    /DEFINE_RISCV_EXT\s*\(\s*(?:\/\*\s*NAME\s*\*\/\s*)?([a-z0-9]+)\s*,/g,
  )) {
    result.set(m[1], 'supported');
  }
  return result;
}

/*
 * Given releases oldest-first, each with its name -> status map, the current
 * standing of one extension: { supported?, experimental? }, each the first
 * release of the unbroken run that reaches the newest release. An extension
 * that was experimental in 16-17 and supported from 18 gives
 * { experimental: '16', supported: '18' }. One dropped since (LLVM's old
 * experimental Zbe) gives {}, because the newest release no longer takes it.
 */
export function standing(releases, token) {
  const result = {};
  let i = releases.length - 1;
  const status = (r) => r.extensions.get(token);
  if (i >= 0 && status(releases[i]) === 'supported') {
    while (i >= 0 && status(releases[i]) === 'supported') i--;
    result.supported = releases[i + 1].version;
  }
  if (i >= 0 && status(releases[i]) === 'experimental') {
    while (i >= 0 && status(releases[i]) === 'experimental') i--;
    result.experimental = releases[i + 1].version;
  }
  return result;
}

/* name -> 'supported', from binutils' bfd/elfxx-riscv.c. Vendor arrays
   (riscv_supported_vendor_x_ext) are left out. */
export function parseBinutils(text) {
  const result = new Map();
  const starts = text.matchAll(/riscv_supported_std\w*_ext\[\]\s*=\s*\{/g);
  for (const start of starts) {
    const end = text.indexOf('};', start.index);
    for (const m of text.slice(start.index, end).matchAll(/\{\s*"([a-z0-9]+)"\s*,/g)) {
      result.set(m[1], 'supported');
    }
  }
  return result;
}

/* QEMU's older names for extensions that have since been renamed. */
const QEMU_ALIASES = { epmp: ['smepmp'], aia: ['smaia', 'ssaia'] };

/*
 * name -> status, from QEMU's target/riscv/cpu.c. A user property without
 * "x-" means supported; with it, experimental. ISA_EXT_DATA_ENTRY lists what
 * goes in the device tree's riscv,isa, which also includes experimental
 * extensions in some releases, so on its own it counts as supported only when
 * no "x-" property says otherwise. Properties such as "mmu" or "pmp" are read
 * too; they match no extension and are simply never looked up.
 *
 * The returned Map also carries `properties`: name -> the experimental
 * property as QEMU spells it, so a renamed one keeps its real name (Smaia was
 * `x-aia` in 7.x, not `x-smaia`).
 */
export function parseQemu(text) {
  const plain = new Set();
  const experimental = new Map(); // name -> property
  const listed = new Set();
  const names = (raw) => QEMU_ALIASES[raw.toLowerCase()] ?? [raw.toLowerCase()];
  const props =
    /(?:DEFINE_PROP_BOOL|MULTI_EXT_CFG_BOOL)\(\s*"([A-Za-z0-9-]+)"|MISA_EXT_INFO\(\s*\w+\s*,\s*"([a-z0-9-]+)"/g;
  for (const m of text.matchAll(props)) {
    const property = m[1] ?? m[2];
    if (property.startsWith('x-')) {
      for (const name of names(property.slice(2))) experimental.set(name, property);
    } else {
      for (const name of names(property)) plain.add(name);
    }
  }
  for (const m of text.matchAll(
    /ISA_(EXPERIMENTAL_|INTERNAL_)?EXT_DATA_ENTRY\(\s*([a-z0-9_]+)\s*,/g,
  )) {
    if (m[1] === 'EXPERIMENTAL_') experimental.set(m[2], `x-${m[2]}`);
    else listed.add(m[2]);
  }
  const result = new Map();
  result.properties = new Map();
  for (const name of listed) if (!experimental.has(name)) result.set(name, 'supported');
  for (const [name, property] of experimental) {
    if (plain.has(name)) continue;
    result.set(name, 'experimental');
    result.properties.set(name, property);
  }
  for (const name of plain) result.set(name, 'supported');
  return result;
}

/*
 * The base ISAs a release supports, as -march tokens, added to `extensions`.
 * Each tool lists `i` and `e` once, but RV64E came later than RV32E almost
 * everywhere, and RV128I is in none of the compilers, so the bases are read
 * per XLEN from each tool's own restriction:
 *
 *   LLVM      14-16 reject e on RV64 ("standard user-level extension 'e'
 *             requires 'rv32'"); 17 dropped the check
 *   GCC       RV64E needs the lp64e ABI, which arrived in 14 (riscv.cc)
 *   binutils  "rv%d does not support the `e' extension" until it was removed
 *   QEMU      a dedicated RV32E or RV64E CPU type; the plain `e` property
 *             before them is not taken as proof of emulation. RV128I is the
 *             experimental `-cpu x-rv128` (single-threaded TCG only)
 *   Linux     no E at all; RV32 and RV64 kernels both take I
 *
 * `texts` is every file fetched for the release. Returns the options to
 * record for experimental bases (QEMU's x-rv128).
 */
export function addBases(key, extensions, texts) {
  const all = texts.join('\n');
  const options = new Map();
  if (extensions.has('i')) {
    extensions.set('rv32i', extensions.get('i'));
    extensions.set('rv64i', extensions.get('i'));
  }
  const e = extensions.get('e');
  const rv64e = {
    llvm: e && !all.includes("extension 'e' requires 'rv32'"),
    gcc: e && /ABI_LP64E/.test(all),
    binutils: e && !all.includes("does not support the `e' extension"),
    qemu: /TYPE_RISCV_CPU_RV64E\b/.test(all),
    linux: false,
  }[key];
  const rv32e = key === 'qemu' ? /TYPE_RISCV_CPU_RV32E\b/.test(all) : key !== 'linux' && Boolean(e);
  if (rv32e) extensions.set('rv32e', 'supported');
  if (rv64e) extensions.set('rv64e', 'supported');
  if (key === 'qemu') {
    // Drop the bare letter: without a dedicated CPU type it proves nothing.
    extensions.delete('e');
    if (/TYPE_RISCV_CPU_BASE128\b/.test(all)) {
      extensions.set('rv128i', 'experimental');
      // QEMU refuses it under multi-threaded TCG (checked on 10.0).
      options.set('rv128i', '-cpu x-rv128 -accel tcg,thread=single');
    }
  }
  return options;
}

/*
 * What QEMU provides without naming it. Its V takes a vlen= of 128 up to
 * RV_VLEN_MAX (target/riscv/cpu.h), so V brings each Zvl<N>b in that range.
 * And whatever a supported extension requires (in the catalogue's dependency
 * graph) must be there too, or QEMU could not offer it: V brings Zve64d.
 * `requires` maps a token to every token it transitively requires.
 * Returns token -> the token it came with, for the tooltip.
 */
export function addQemuImplied(extensions, cpuHeader, requires) {
  const impliedBy = new Map();
  const add = (token, status, from) => {
    const current = extensions.get(token);
    if (current === 'supported' || (current === 'experimental' && status === 'experimental'))
      return;
    extensions.set(token, status);
    impliedBy.set(token, from);
  };
  const max = Number(cpuHeader.match(/#define\s+RV_VLEN_MAX\s+(\d+)/)?.[1] ?? 0);
  const v = extensions.get('v');
  if (v && max >= 128) {
    for (let vlen = 128; vlen <= max; vlen *= 2) add(`zvl${vlen}b`, v, 'v');
  }
  // Supported first, so an extension that is both required by a supported
  // one and by an experimental one counts as supported. Credit goes to V when
  // V brings it, else to the named extension that requires the least, the
  // closest thing to "part of".
  const named = [...extensions].filter(([token]) => !impliedBy.has(token));
  for (const status of ['supported', 'experimental']) {
    const sources = named
      .filter(([, s]) => s === status)
      .map(([token]) => token)
      .sort(
        (a, b) =>
          (b === 'v') - (a === 'v') ||
          (requires.get(a)?.length ?? 0) - (requires.get(b)?.length ?? 0),
      );
    for (const token of sources) {
      for (const required of requires.get(token) ?? []) add(required, status, token);
    }
  }
  return impliedBy;
}

/* name -> 'supported', from Linux's arch/riscv/kernel/cpufeature.c (6.6+). */
export function parseLinux(text) {
  const result = new Map();
  for (const m of text.matchAll(/__RISCV_ISA_EXT_[A-Z_]+\(\s*([a-z0-9]+)\s*,/g)) {
    result.set(m[1], 'supported');
  }
  return result;
}

/*
 * The extensions LLVM accepts and assembles but generates no code for, from
 * llvm/docs/RISCVUsage.rst (LLVM 16+): the "Assembly Support" rows of its
 * extension table, and RV32E and RV64E when its base-ISA section still says
 * they are "supported by the assembly-based tools only". The -march table
 * cannot tell these apart from fully supported extensions.
 */
export function parseLlvmUsage(text) {
  const assemblyOnly = new Set();
  for (const m of text.matchAll(/^\s+``([A-Za-z0-9]+)``\s+Assembly Support/gm)) {
    assemblyOnly.add(m[1].toLowerCase());
  }
  if (
    /RV32E\s+and\s+RV64E\s+are\s+supported\s+by\s+the\s+assembly-based\s+tools\s+only/.test(text)
  ) {
    assemblyOnly.add('rv32e');
    assemblyOnly.add('rv64e');
  }
  return assemblyOnly;
}

/*
 * The releases, oldest first, whose table lists clearly fewer extensions
 * than the release before: more than `share` of them and more than `floor`.
 * Upstream rarely removes extensions, so a drop like that usually means the
 * file changed format and the parser kept only part of it, which standing()
 * would otherwise read as support withdrawn.
 */
export function suspiciousDrops(releases, { share = 0.1, floor = 5 } = {}) {
  const drops = [];
  for (let i = 1; i < releases.length; i++) {
    const before = releases[i - 1].extensions.size;
    const after = releases[i].extensions.size;
    if (before - after > floor && before - after > before * share) {
      drops.push({ version: releases[i].version, before, after });
    }
  }
  return drops;
}
