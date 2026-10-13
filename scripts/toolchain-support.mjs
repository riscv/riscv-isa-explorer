/**
 * Reads which RISC-V extensions a release of LLVM or GCC accepts in -march,
 * from that release's own source, and turns a run of releases into "since"
 * versions per extension.
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
 *
 * LLVM's experimental extensions are accepted only with
 * -menable-experimental-extensions and an exact version, so they are kept
 * apart from supported ones. GCC has no such tier.
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
