/**
 * marchUtils.js — RISC-V -march String Utilities
 *
 * Pure functions. No React. No JSON imports.
 * Callers pass the flat extension array from riscv_extensions.json.
 *
 * DATA SOURCES (documented for every design decision):
 *   [SPEC]   RISC-V Unprivileged ISA Specification, Chapter 27
 *            "ISA Extension Naming Conventions"
 *            Canonical single-letter order: Table 27.1
 *            Prefix convention: rv32 / rv64 / rv128
 *            Multi-letter ordering: sorted alphabetically, '_' prefixed
 *   [GCC]    GCC riscv-common.cc / riscv_subset_list implementation
 *            Explicit -march multi-letter rules: Zicsr, Zifencei, Zawrs...
 *   [LLVM]   LLVM RISCVISAInfo.cpp — canonical ordering + extension names
 *   [UDB]    riscv-unified-db (spec/std/isa/ext/*.yaml) — extension catalog
 *
 * COMPILER VERIFICATION SCOPE:
 *   The toolchain compatibility notes below are a guide, not an invariant.
 *   Verified against GCC 12-14 and LLVM/Clang 15-18 release notes:
 *
 *   Scalar crypto (Zk, Zkn, Zks, Zbkb, etc.):
 *     Supported since GCC ~12-13, LLVM ~14-15.
 *
 *   Vector crypto (Zvkned, Zvbb, Zvbc, Zvkg, Zvksh, Zvksed...):
 *     Ratified 2023. Supported in GCC 14+ and LLVM 18+ (mainline/non-experimental).
 *
 *   Zve* / Zvl* sub-profile tokens (Zve32x, Zve32f, Zve64x, Zve64f, Zve64d,
 *   Zvl32b, Zvl64b, Zvl128b...):
 *     Verified against riscv-unified-db requirements and Linux dt-bindings.
 *     Toolchain flags: check `riscv64-unknown-elf-gcc -march=help` or
 *     `clang --target=riscv64-unknown-elf --print-supported-extensions`.
 *
 *   Base / gc extensions (Zicsr, Zifencei, C, M, A, F, D, etc.):
 *     Universally stable across all modern RISC-V toolchains.
 *
 *   CI does compile-check the generated -march strings against clang. Rows that
 *   need a newer clang than the job provides are skipped and reported, so the
 *   check is a floor rather than full coverage — that is the remaining gap.
 */

/**
 * The compiler-compatibility summary, condensed, as the single source of truth.
 *
 * This prose used to live in three hand-maintained copies: the scope block
 * above, the header of exportUtils.js, and the comment exportUtils.js emits
 * into every exported file. They had drifted apart — the export header named
 * Zvkg where the emitted copy omitted it, while the block above lists the
 * fuller Zvk family — so a reader comparing an exported file against the
 * source got two different answers to one question. The emitted copy is
 * generated from here now, and the export header points at this rather than
 * restating it.
 *
 * The vector-crypto family is named by prefix deliberately. Enumerating a
 * handful of its members is exactly what went stale, and riscv_extensions.json
 * carries 21 of them; `Zvk*` cannot drift.
 */
export const COMPILER_COMPAT_NOTES = [
  'Scalar crypto (Zk, Zkn, Zks, Zbkb, etc.): supported since ~GCC 12-13 / LLVM 14-15.',
  'Vector crypto (the Zvk* family, plus Zvbb and Zvbc): requires GCC 14+ / non-experimental LLVM 18+.',
  'Zve/Zvl sub-profile tokens: exact min version unconfirmed — verify with your toolchain:',
  '  gcc: riscv64-unknown-elf-gcc -march=help',
  '  clang: clang --target=riscv64-unknown-elf --print-supported-extensions',
  'Non-ISA extensions excluded from this string.',
];

// ============================================================================
// Canonical single-letter extension ordering
// ============================================================================
// Source: RISC-V Unprivileged ISA Specification, §27.11
// "The canonical order for single-letter extensions is: I, E, M, A, F, D, G, Q,
//  C, B, J, T, P, V, N, H, S, U."
// Note: 'G' is a historical shorthand macro (IMAFD + Zicsr + Zifencei).
//       'B' was ratified March 2024 (Zba + Zbb + Zbs).
//       'E' is an alternative base to 'I' (RV32E, RV64E: 16 GPRs).
export const SINGLE_LETTER_CANONICAL_ORDER = [
  'i',
  'e',
  'm',
  'a',
  'f',
  'd',
  'q',
  'c',
  'b',
  'j',
  't',
  'p',
  'v',
  'n',
  'h',
  's',
  'u',
];

// Mapping from canonical base extension ID (in riscv_extensions.json) to prefix string
export const BASE_ISA_PREFIX_MAP = {
  RV32I: { xlen: 32, base: 'i', id: 'RV32I' },
  RV64I: { xlen: 64, base: 'i', id: 'RV64I' },
  RV32E: { xlen: 32, base: 'e', id: 'RV32E' },
  RV64E: { xlen: 64, base: 'e', id: 'RV64E' },
  RV128I: { xlen: 128, base: 'i', id: 'RV128I' },
};

export const BASE_ISA_IDS = new Set(Object.keys(BASE_ISA_PREFIX_MAP));

// ============================================================================
// Dependencies and conflicts
// ============================================================================
/**
 * These used to be hand-written tables here, covering ~21 extensions. They are
 * now derived from src/isa-dependency-graph.json, which carries a node for every
 * catalog extension and a citation on every edge.
 *
 * Re-exported in the flat `{id: [ext]}` shape the existing callers expect. New
 * code should prefer resolveSelection() from ./isaGraph.js, which reports what
 * it implied and why instead of returning a bare set.
 */
// Imported, not `export ... from`: a re-export creates no local binding, and
// isIncompatible()/dependsOnIncompatible() below reference these directly.
import { SMART_DEPENDENCIES, INCOMPATIBLE_WITH } from './isaGraph.js';

export { SMART_DEPENDENCIES, INCOMPATIBLE_WITH };

// ============================================================================
// Architectural tags that are not -march ISA options
// ============================================================================

const SPEC_VERSION_TAG_PATTERN = /^(Sm|Ss)\d+p\d+$/;

// Non-ISA / platform specification entries that live in the catalog for
// browsing but must never be emitted as -march tokens.
// Source: Server SoC / Platform Specs (not in unprivileged/privileged ISA specs)
const NON_ISA_EXTENSION_IDS = new Set(['RERI', 'HTI']);

/**
 * Tags that exist in riscv_extensions.json as UI/category labels or
 * architectural headings, but are NOT valid GCC/LLVM -march options.
 *
 * - 'P': Packed-SIMD is an architectural category in the UI catalog.
 *        The ratified standard extensions are P-ext proposal subsets.
 * - 'V': The Vector extension umbrella in the UI. GCC/LLVM accept 'v' only
 *        when accompanied by appropriate Zve* flags or on GCC 14+.
 *        We exclude bare 'v' when Zve* explicit tokens are present to avoid
 *        toolchain collision, but permit it if no Zve* sub-extension is selected.
 * - 'K': Scalar Crypto category tag in the UI catalog. Standard compiler
 *        options use the ratified Zk* tokens (Zkn, Zks, Zk, Zbkb, etc.).
 * - 'S': Supervisor-mode architectural privilege level tag.
 * - 'U': User-mode architectural privilege level tag.
 *
 * [DATA] Cross-checked against our riscv_extensions.json catalog descriptions.
 */
/**
 * Sv32/Sv39/Sv48/Sv57 are address-translation MODES, not extensions. They name
 * the page-table depth a hart supports and are selected at runtime through the
 * `satp` MODE field — the same category as S and U above.
 *
 * Verified against clang 21: `-march=rv64imafdc_sv39` is rejected with
 * "unsupported standard supervisor-level extension 'sv'" (the parser reads `sv`
 * plus version `39`), while every other Sv* extension — Svbare, Svade, Svadu,
 * Svnapot, Svpbmt, Svinval — is accepted. Emitting them produced an invalid
 * -march for all four ratified profiles, each of which mandates Sv39.
 */
/**
 * Shorthand extensions that ABSORB their members in an ISA string.
 *
 * These are not ordinary dependencies. D depends on F and both belong in the
 * string; Zkn is a *name for* its members, so listing both is malformed. The
 * riscv-config validator (riscv/riscv-config, isa_validator.py) rejects it:
 *
 *   "Zkn is a superset of Zbkb, Zbkc, Zbkx, Zkne, Zknd, Zknh. In presence of
 *    Zkn the subsets must be ignored in the ISA string."
 *
 * clang accepts the redundant form, which is why a toolchain check never
 * noticed. The members stay in the dependency graph — selecting Zkn genuinely
 * does give you Zbkb — they are simply not spelled out in -march.
 */
export const SHORTHAND_BUNDLES = {
  Zkn: ['Zbkb', 'Zbkc', 'Zbkx', 'Zknd', 'Zkne', 'Zknh'],
  Zks: ['Zbkb', 'Zbkc', 'Zbkx', 'Zksed', 'Zksh'],
  Zk: ['Zbkb', 'Zbkc', 'Zbkx', 'Zknd', 'Zkne', 'Zknh', 'Zkn', 'Zkr', 'Zkt'],
};

/**
 * Which shorthand, if any, covers each selected sub-extension.
 *
 * A shorthand must not sit in an ISA string beside its own members, so both the
 * -march encoder and the riscv-config export need to know which members a given
 * selection absorbs, and by what. That was answered by three copies of the same
 * loop, which is a correctness risk rather than untidiness: the bundles overlap,
 * so the answer depended on which copy assigned a shared member last.
 *
 * Zbkb and Zknd belong to both Zkn and Zk. Iterating SHORTHAND_BUNDLES in
 * declaration order gives them to Zk; iterating it reversed gives them to Zkn.
 * Reordering that object would have silently changed the output, untested.
 *
 * The rule is therefore stated here rather than emerging from key order: the
 * widest bundle wins. Assigning in ascending member count achieves it, because
 * a bundle containing another lists it and then some -- Zk has nine members and
 * lists Zkn, which has six.
 *
 * That reasoning covers containment. Siblings that overlap without containing
 * each other -- Zk and Zks both claim Zbkb, neither contains the other -- have
 * no natural winner, and the rule simply picks the larger. That is fine and
 * deliberate: both bundles are in the string, both legitimately cover Zbkb, and
 * what matters is that it is omitted exactly once and attributed the same way
 * every run. The rule is chosen for determinism there, not correctness.
 *
 * `bundles` is injectable only so the order-independence claim is testable:
 * pass the same bundles in a different key order and the result must match.
 * Production callers omit it.
 *
 * @param {string[]} selectedIds
 * @param {Record<string, string[]>} [bundles=SHORTHAND_BUNDLES]
 * @returns {Map<string, string>} member id -> the shorthand that absorbs it
 */
export function absorbedByShorthand(selectedIds, bundles = SHORTHAND_BUNDLES) {
  const selected = new Set(selectedIds || []);
  const absorbed = new Map();
  const entries = Object.entries(bundles)
    .filter(([shorthand]) => selected.has(shorthand))
    .sort((a, b) => a[1].length - b[1].length);
  for (const [shorthand, members] of entries) {
    for (const member of members) absorbed.set(member, shorthand);
  }
  return absorbed;
}

/** The satp MODE values, kept separate so the exclusion reason can be accurate. */
export const SATP_MODE_IDS = new Set(['Sv32', 'Sv39', 'Sv48', 'Sv57']);

export const NON_MARCH_IDS = new Set([
  'K',
  'N',
  'P',
  'S',
  'U', // privilege levels and UI grouping tags
  ...SATP_MODE_IDS,
]); // B removed — ratified, decode-accept + explicit-encode

// ============================================================================
// Data provenance — displayed in ISA Workspace footer
// ============================================================================
/**
 * Where the catalogue's facts come from, rendered as links by WorkspacePanel.
 *
 * This is an array of {label, source, url} rows because a consumer maps over
 * it. It was briefly replaced by an object of prose strings, which threw
 * "DATA_PROVENANCE.map is not a function" and unmounted the whole app the
 * moment the builder panel opened. The prose duplicated the DATA SOURCES block
 * at the top of this file; the rows do not, so the rows are what belongs here.
 */
export const DATA_PROVENANCE = [
  {
    label: 'Instruction Encodings',
    source: 'riscv/riscv-opcodes',
    url: 'https://github.com/riscv/riscv-opcodes',
  },
  {
    label: 'Extension Metadata & Profiles',
    source: 'RISC-V ISA Manual',
    url: 'https://github.com/riscv/riscv-isa-manual',
  },
  {
    label: '-march Naming Rules',
    source: 'RISC-V ISA Spec §27 · GCC 12+ / LLVM convention',
    url: 'https://github.com/riscv/riscv-isa-manual',
  },
];

// ============================================================================
// G expansion components
// ============================================================================
// RISC-V ISA Spec §27: G = IMAFD + Zicsr + Zifencei
// We always expand 'g' to explicit tokens because toolchains vary in whether
// 'g' implies Zicsr/Zifencei (GCC 11- did not; GCC 12+ does). Explicit tokens
// are unambiguous and accepted by all versions.
export const G_EXPANSION_TOKENS = ['i', 'm', 'a', 'f', 'd', 'zicsr', 'zifencei'];

// ============================================================================
// Helper: build lookup map from allExts
// ============================================================================
function buildLookup(allExts) {
  const m = new Map();
  for (const ext of allExts) {
    if (ext && ext.id) {
      m.set(ext.id.toLowerCase(), ext);
    }
  }
  return m;
}

/**
 * Is `extId` architecturally invalid alongside `otherId`?
 *
 * INCOMPATIBLE_WITH is evaluated in both directions, so a single entry
 * (RV32E -> F) covers both "E base excludes F" and "F excludes E base".
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function isIncompatible(a, b) {
  return (INCOMPATIBLE_WITH[a] || []).includes(b) || (INCOMPATIBLE_WITH[b] || []).includes(a);
}

/**
 * Does `extId` transitively depend on something incompatible with `baseId`?
 *
 * Walks SMART_DEPENDENCIES so that excluding a prerequisite also excludes
 * everything built on it: with an E base, F is incompatible, so D (which
 * requires F) and Q (which requires D) must be excluded too.
 *
 * @param {string} baseId
 * @param {string} extId
 * @returns {boolean}
 */
function dependsOnIncompatible(baseId, extId, seen = new Set()) {
  if (seen.has(extId)) return false;
  seen.add(extId);
  for (const dep of SMART_DEPENDENCIES[extId] || []) {
    if (isIncompatible(baseId, dep)) return true;
    if (dependsOnIncompatible(baseId, dep, seen)) return true;
  }
  return false;
}

// ============================================================================
// parseMarchString
// ============================================================================
/**
 * Umbrella / naming prefix tags in the catalog that are not architectural extensions.
 * Trailing digits on these (e.g. zve32, zve64) are incomplete names/typos, not version suffixes.
 */
const UMBRELLA_PREFIX_IDS = new Set(['zv', 'zve', 'zvf', 'zvk', 'zvw']);

/**
 * Parse an incoming -march string (e.g. from user input or external tools)
 * into a set of resolved extension IDs matching our riscv_extensions.json catalog.
 *
 * Rules handled:
 *   1. 'rv32' / 'rv64' / 'rv128' prefix sets XLEN and base ISA.
 *   2. 'g' macro expanded to IMAFD + Zicsr + Zifencei with an explicit warning.
 *   3. 'b' expands to Zba + Zbb + Zbs (ratified Bitmanip, March 2024).
 *   4. Multi-letter tokens split by '_' and mapped to catalog entries.
 *   5. Version suffixes (e.g. i2p0, m2p0, zba1p0 per Spec §27) are parsed cleanly.
 *
 * @param {string} marchStr e.g. "rv64gc_zba_zbb_zicsr_zifencei"
 * @param {Array}  allExts  Flat array from riscv_extensions.json
 * @returns {{
 *   xlen: number|null,
 *   resolvedIds: string[],
 *   unknownTokens: string[],
 *   warnings: string[],
 *   gExpanded: boolean,
 * }}
 */
export function parseMarchString(marchStr, allExts) {
  const out = {
    xlen: null,
    resolvedIds: [],
    unknownTokens: [],
    warnings: [],
    gExpanded: false,
  };

  if (!marchStr || typeof marchStr !== 'string') {
    out.warnings.push('Input is empty or not a string.');
    return out;
  }

  const lookup = buildLookup(allExts);
  let s = marchStr.trim().toLowerCase();

  if (!s.startsWith('rv')) {
    out.warnings.push('Expected string to start with "rv" (e.g. rv64gc_zba).');
    return out;
  }
  s = s.slice(2);

  const xlenMatch = s.match(/^(32|64|128)/);
  if (!xlenMatch) {
    out.warnings.push('Could not parse XLEN — expected 32, 64, or 128 after "rv".');
    return out;
  }
  out.xlen = parseInt(xlenMatch[1], 10);
  s = s.slice(xlenMatch[1].length);

  // Split on '_'. Part before first '_' contains concatenated single-letter extensions.
  const parts = s.split('_');
  const tokens = [];

  // Expand single-letter head (may include 'g' and optional version suffixes e.g. i2p0, m2p0 per RISC-V Spec §27)
  const headRe = /([a-z])(\d+p\d+|\d+)?/g;
  let lastHeadIndex = 0;
  let headMatch;
  const headStr = parts[0] || '';
  while ((headMatch = headRe.exec(headStr)) !== null) {
    if (headMatch.index > lastHeadIndex) {
      tokens.push(headStr.slice(lastHeadIndex, headMatch.index));
    }
    const ch = headMatch[1];
    if (ch === 'g') {
      out.gExpanded = true;
      out.warnings.push(
        '"g" expanded to: ' +
          G_EXPANSION_TOKENS.join(', ') +
          '. Source: RISC-V ISA Spec §27 + GCC 12+/LLVM. ' +
          'Encoder will always emit explicit tokens, never "g".',
      );
      for (const t of G_EXPANSION_TOKENS) tokens.push(t);
    } else if (ch === 'b') {
      out.warnings.push(
        '"b" expanded to: zba, zbb, zbs. Source: Ratified B extension (March 2024). ' +
          'Encoder will emit explicit Z-extensions for broader toolchain compatibility.',
      );
      tokens.push('zba', 'zbb', 'zbs', 'b');
    } else {
      tokens.push(ch);
    }
    lastHeadIndex = headRe.lastIndex;
  }
  if (lastHeadIndex < headStr.length) {
    tokens.push(headStr.slice(lastHeadIndex));
  }

  // Multi-letter tokens
  for (let i = 1; i < parts.length; i++) {
    if (parts[i]) tokens.push(parts[i]);
  }

  // Resolve each token
  const resolvedSet = new Set();
  for (const token of tokens) {
    if (!token) continue;

    // Base ISA letters ('i' or 'e') combine with parsed xlen
    if ((token === 'i' || token === 'e') && out.xlen) {
      const baseId = `rv${out.xlen}${token}`;
      if (lookup.has(baseId)) {
        resolvedSet.add(lookup.get(baseId).id);
        continue;
      }
    }

    // Exact match in catalog
    if (lookup.has(token)) {
      const resolved = lookup.get(token);
      // Reject UI-grouping / non-march catalog entries — treat as unknown
      if (NON_MARCH_IDS.has(resolved.id) || NON_ISA_EXTENSION_IDS.has(resolved.id)) {
        out.unknownTokens.push(token);
        out.warnings.push(
          `"${token.toUpperCase()}" is in the extension catalog but is NOT a valid -march token ` +
            `(UI grouping tag or non-ISA entry). It has been ignored.`,
        );
        continue;
      }
      resolvedSet.add(resolved.id);
      continue;
    }

    // Fallback: strip version suffix (RISC-V Spec §27: e.g. zba1p0 -> zba, zicsr2p0 -> zicsr).
    // Umbrella prefix tags (e.g. zve32, zve64) must NOT match umbrellas via trailing digits.
    const versionMatch = token.match(/^([a-z][a-z0-9]*?)(\d+p\d+|\d+)$/);
    if (versionMatch) {
      const stripped = versionMatch[1];
      const version = versionMatch[2];
      const isBitwidthOrUmbrella =
        UMBRELLA_PREFIX_IDS.has(stripped) ||
        (!version.includes('p') && [32, 64, 128, 256, 512, 1024].includes(parseInt(version, 10)));

      if (!isBitwidthOrUmbrella && lookup.has(stripped)) {
        const resolved = lookup.get(stripped);
        if (!NON_MARCH_IDS.has(resolved.id) && !NON_ISA_EXTENSION_IDS.has(resolved.id)) {
          resolvedSet.add(resolved.id);
          continue;
        }
      }
    }

    out.unknownTokens.push(token);
  }

  out.resolvedIds = Array.from(resolvedSet);
  return out;
}

// ============================================================================
// buildMarchString
// ============================================================================
/**
 * Generate a canonical RISC-V -march string from selected extension IDs.
 *
 * Rules (RISC-V Unprivileged ISA Spec §27.11): [SPEC]
 *   1. Prefix:  rv{xlen}{base}
 *   2. Single-letter: canonical order (SINGLE_LETTER_CANONICAL_ORDER)
 *   3. Multi-letter: sorted alphabetically, each preceded by '_'
 *
 * @param {string[]} selectedIds
 * @param {Array}    _allExts
 * @returns {{ march: string|null, excluded: {id,reason}[], warnings: string[] }}
 */
export function buildMarchString(selectedIds, _allExts) {
  const out = { march: null, excluded: [], warnings: [] };

  if (!selectedIds || selectedIds.length === 0) {
    out.warnings.push('No extensions selected.');
    return out;
  }

  // 1. Detect Base ISA
  const baseId = selectedIds.find((id) => BASE_ISA_IDS.has(id));
  if (!baseId) {
    out.warnings.push(
      'Cannot generate a valid -march string without a base ISA. ' +
        'Please select RV32I, RV64I, RV32E, RV64E, or RV128I.',
    );
    return out;
  }
  const baseInfo = BASE_ISA_PREFIX_MAP[baseId];

  // 2. Partition into single-letter and multi-letter extensions
  const singles = [];
  const multis = [];

  // A shorthand and its members must not both appear. riscv-config rejects
  // "Zkn is a superset of Zbkb, Zbkc, Zbkx, Zkne, Zknd, Zknh. In presence of
  // Zkn the subsets must be ignored in the ISA string." clang tolerates the
  // redundant form, so this is invisible to a toolchain check.
  //
  // Deliberately narrow. It is NOT "drop anything implied by something else" —
  // D implies F and both belong in the string. Only these three shorthands
  // absorb their members.
  const absorbed = absorbedByShorthand(selectedIds); // member -> shorthand covering it

  for (const id of selectedIds) {
    if (BASE_ISA_IDS.has(id)) continue;

    if (absorbed.has(id)) {
      out.excluded.push({
        id,
        reason: `Covered by ${absorbed.get(id)} — a shorthand must not list its own members`,
      });
      continue;
    }

    if (SPEC_VERSION_TAG_PATTERN.test(id)) {
      out.excluded.push({
        id,
        reason: 'Privileged spec version compliance tag — not an -march option',
      });
      continue;
    }
    const isSandboxExt =
      id.includes('__') ||
      id.endsWith('__sandbox') ||
      (Array.isArray(_allExts) && _allExts.some((e) => e && e.id === id && e.isSandbox));
    if (isSandboxExt) {
      out.excluded.push({
        id,
        reason:
          'Sandbox extension proposal — not a ratified standard or compiler-supported extension',
      });
      continue;
    }
    if (NON_ISA_EXTENSION_IDS.has(id)) {
      out.excluded.push({ id, reason: 'Non-ISA specification tag — not an architecture option' });
      continue;
    }
    if (NON_MARCH_IDS.has(id)) {
      // Two different reasons live in NON_MARCH_IDS, and telling a user that
      // Sv39 is a "UI grouping tag" is simply wrong — it is a real
      // architectural feature, just not one -march can express.
      out.excluded.push({
        id,
        reason: SATP_MODE_IDS.has(id)
          ? 'Address-translation mode selected via the satp MODE field — not an -march extension'
          : 'UI grouping tag / Non-ISA tag — not a valid -march token',
      });
      continue;
    }
    if (id.toLowerCase() === 'b') {
      out.excluded.push({
        id: 'B',
        reason:
          'Ratified but pending broad toolchain support for single-letter "b". Explicit Zba_Zbb_Zbs emitted instead.',
      });
      continue;
    }

    // 'i' and 'e' name base ISAs, not extensions. The selected base's letter is
    // already in the rv{xlen}{base} prefix; the other one is mutually exclusive
    // with it (RV32E/RV64E and RVxxI cannot be combined).
    const baseLetter = id.toLowerCase();
    if (baseLetter === 'i' || baseLetter === 'e') {
      if (baseLetter !== baseInfo.base) {
        out.excluded.push({
          id,
          reason: `Mutually exclusive with base ISA ${baseInfo.id} — the I and E base ISAs cannot be combined`,
        });
        out.warnings.push(
          `"${id}" was dropped: it names a base ISA that is mutually exclusive with ${baseInfo.id}.`,
        );
      }
      continue;
    }

    // Architecturally invalid alongside the selected base, either directly or
    // because it depends on something that is. Excluding F for an E base while
    // keeping D would emit a configuration whose dependency is unsatisfied —
    // clang rejects exactly that ("ILP32E cannot be used with the D ISA
    // extension"), so the exclusion must cascade through SMART_DEPENDENCIES.
    if (isIncompatible(baseInfo.id, id) || dependsOnIncompatible(baseInfo.id, id)) {
      out.excluded.push({
        id,
        reason: `Architecturally incompatible with base ISA ${baseInfo.id}`,
      });
      out.warnings.push(
        `"${id}" is not architecturally valid with ${baseInfo.id} and has been excluded ` +
          `from the generated -march string.`,
      );
      continue;
    }

    const token = id.toLowerCase();
    if (id.length === 1) singles.push(token);
    else multis.push(token);
  }

  // Sort single-letter by canonical order
  singles.sort((a, b) => {
    const ia = SINGLE_LETTER_CANONICAL_ORDER.indexOf(a);
    const ib = SINGLE_LETTER_CANONICAL_ORDER.indexOf(b);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });

  // Sort multi-letter alphabetically
  multis.sort();

  // Deduplicate tokens
  const uniqSingles = [...new Set(singles)];
  const uniqMultis = [...new Set(multis)];

  const prefix = `rv${baseInfo.xlen}${baseInfo.base}`;
  const singleStr = uniqSingles.join('');
  const multiStr = uniqMultis.length > 0 ? '_' + uniqMultis.join('_') : '';

  out.march = `${prefix}${singleStr}${multiStr}`;
  return out;
}

/**
 * Build a deduplicated instruction catalog for the selected extensions.
 *
 * ATTRIBUTION RULE (True Owner Algorithm):
 *   Instructions in riscv_extensions.json are often nested inside parent
 *   extensions for legacy "browsing convenience" (e.g. Zicsr instructions
 *   are duplicated inside RV32E/RV32I/RV64I). However, each instruction
 *   carries an `extension` tag (e.g. "rv_zicsr").
 *   This algorithm statically resolves the "True Owner" of every tag across
 *   the entire catalog (e.g. rv_zicsr belongs to Zicsr, rv_i belongs to the
 *   selected base ISA). An instruction is ONLY included if its True Owner
 *   was explicitly selected, and it is strictly attributed to that True Owner.
 *
 * DEDUPLICATION KEY: uppercase(mnemonic) + "||" + normalized encoding
 *
 * @param {string[]} selectedIds
 * @param {Array}    allExts
 * @returns {Array<{
 *   key: string,
 *   mnemonic: string,
 *   encoding: string,
 *   variable_fields: Array,
 *   match: string,
 *   mask: string,
 *   sources: Array<{ extId: string, extName: string }>,
 *   primaryExtId: string,
 * }>}
 */
export function buildCombinedCatalog(selectedIds, allExts) {
  if (!selectedIds || selectedIds.length === 0) return [];

  const lookup = buildLookup(allExts);
  const selectedBaseId = selectedIds.find((id) => BASE_ISA_IDS.has(id));

  // 1. Determine the True Owner for each tag in the catalog
  const tagToTrueOwner = new Map();
  for (const ext of allExts) {
    if (!ext.tags) continue;
    for (const tag of ext.tags) {
      const t = tag.toLowerCase();

      // Base ISA tags belong to whichever base ISA the user actually selected
      if (['rv_i', 'rv64_i', 'rv32_e', 'rv64_e'].includes(t)) {
        if (selectedBaseId) tagToTrueOwner.set(t, lookup.get(selectedBaseId.toLowerCase()));
        continue;
      }

      // For standard extensions, the True Owner is the extension whose ID matches the tag natively
      const stripped = t.replace(/^rv(32|64)?_/, '');
      if (ext.id.toLowerCase() === stripped) {
        tagToTrueOwner.set(t, ext);
      } else if (!tagToTrueOwner.has(t)) {
        // Fallback if no exact match is found
        tagToTrueOwner.set(t, ext);
      }
    }
  }

  const byKey = new Map();

  // 2. Iterate over selected extensions and process their nested instructions
  for (const id of selectedIds) {
    const ext = lookup.get(id.toLowerCase());
    if (!ext?.instructions) continue;

    for (const [mnemonic, details] of Object.entries(ext.instructions)) {
      const instrTags = Array.isArray(details?.extension) ? details.extension : [];

      // Resolve the True Owner of this specific instruction
      let trueOwner = null;
      for (const tag of instrTags) {
        const owner = tagToTrueOwner.get(tag.toLowerCase());
        if (owner) {
          trueOwner = owner;
          break;
        }
      }
      // If we somehow couldn't resolve a true owner, fallback to the extension it was nested inside
      if (!trueOwner) trueOwner = ext;

      // CRITICAL: If the True Owner wasn't explicitly selected by the user, EXCLUDE IT.
      // This prevents "ghost" Zicsr instructions from appearing when only RV32I is selected.
      if (!selectedIds.some((sel) => sel.toLowerCase() === trueOwner.id.toLowerCase())) {
        continue;
      }

      const upperMnem = mnemonic.toUpperCase();
      const normEncoding = (details?.encoding || '').replace(/\s+/g, '');
      const dedupKey = `${upperMnem}||${normEncoding}`;

      if (byKey.has(dedupKey)) {
        const entry = byKey.get(dedupKey);
        if (!entry.sources.some((s) => s.extId === trueOwner.id)) {
          entry.sources.push({ extId: trueOwner.id, extName: trueOwner.name || trueOwner.id });
        }
      } else {
        byKey.set(dedupKey, {
          key: dedupKey,
          mnemonic: upperMnem,
          encoding: normEncoding,
          variable_fields: Array.isArray(details?.variable_fields) ? details.variable_fields : [],
          match: details?.match || '',
          mask: details?.mask || '',
          sources: [{ extId: trueOwner.id, extName: trueOwner.name || trueOwner.id }],
          primaryExtId: trueOwner.id,
        });
      }
    }
  }

  // Sort: mnemonic A→Z, then encoding for identical mnemonics
  return Array.from(byKey.values()).sort((a, b) => {
    const m = a.mnemonic.localeCompare(b.mnemonic);
    return m !== 0 ? m : a.encoding.localeCompare(b.encoding);
  });
}
