/**
 * exportUtils.js — Export generator for the ISA Configuration Builder
 *
 * Goal: produce a complete, accurate, self-describing ISA configuration file
 * that is valuable on its own terms, not shaped to satisfy any specific
 * external validator (riscv-config is confirmed deprecated; its named
 * successor carries an explicit "work-in-progress" caution).
 *
 * COMPILER COMPATIBILITY SCOPE (per extension family):
 *   Not restated here. The summary this file emits into every export comes from
 *   COMPILER_COMPAT_NOTES in marchUtils.js, and the reasoning behind each entry
 *   is in that file's COMPILER VERIFICATION SCOPE block. A third hand-maintained
 *   copy of the same prose is how the previous one went stale.
 */

import {
  buildMarchString,
  BASE_ISA_IDS,
  BASE_ISA_PREFIX_MAP,
  absorbedByShorthand,
  COMPILER_COMPAT_NOTES,
} from './marchUtils.js';
import { buildCombinedCatalog } from './marchUtils.js';
import { resolveParams } from './isaGraph.js';
import { parameterDefinition, schemaSummary } from './isaParams.js';
import { DEPENDENCY_GRAPH } from './isaGraph.js';

// Tokens that are not valid ISA string entries (e.g. K, P are retired/placeholder)
const INVALID_ISA_TOKENS = new Set(['K', 'P']);

// Privilege / virtual-memory extension prefix patterns
function isPrivilegeTag(id) {
  return /^S[a-z0-9]/i.test(id);
}

/**
 * Generates a complete, self-describing ISA configuration YAML for the
 * selected extensions.
 *
 * The output is structured in two parts:
 *   Part 1 — Header: base ISA, extension list, -march string, inferred
 *             spec-version annotations, optional Vendor/Device fields.
 *   Part 2 — Instruction catalog (if includeInstructions is true): the full
 *             deduplicated instruction list for the selection, including
 *             encoding, match/mask, variable fields, and source extension(s).
 *
 * @param {string[]} selectedIds      — extension IDs currently in the workspace
 * @param {Array}    allExts          — full extension catalog (for catalog lookup)
 * @param {boolean}  includeInstructions — whether to append the instruction catalog
 * @returns {{ yaml: string, warnings: string[] }}
 */
/**
 * The sub-extension vocabulary riscv-config accepts, transcribed from
 * riscv_config/constants.py at version 3.18.3.
 *
 * Embedding a list from another tool is a maintenance cost, and it is taken
 * knowingly: riscv-config's ISA regex rejects the ENTIRE string when it meets a
 * name it does not know, so emitting Zaamo or Sv39 makes the file unloadable
 * rather than partially useful. Names outside this list are dropped and
 * reported in the file, so the omission is visible instead of silent.
 *
 * It knows 74 sub-extensions against our 227, so expect omissions.
 */
const RISCV_CONFIG_SUB_EXTENSIONS = new Set(["Sddbltrp", "Sdext", "Smdbltrp", "Smrnmi", "Ssdbltrp", "Svadu", "Svnapot", "Zabha", "Zacas", "Zam", "Zba", "Zbb", "Zbc", "Zbe", "Zbf", "Zbkb", "Zbkc", "Zbkx", "Zbm", "Zbp", "Zbpbo", "Zbr", "Zbs", "Zbt", "Zca", "Zcb", "Zcd", "Zcf", "Zcmop", "Zcmp", "Zcmt", "Zdinx", "Zfa", "Zfh", "Zfinx", "Zhinx", "Zhinxmin", "Zicbom", "Zicbop", "Zicboz", "Zicfilp", "Zicfiss", "Zicntr", "Zicond", "Zicsr", "Zifencei", "Zihintpause", "Zihpm", "Zimop", "Zk", "Zkn", "Zknd", "Zkne", "Zknh", "Zkr", "Zks", "Zksed", "Zksh", "Zkt", "Zmmul", "Zpn", "Zpsf", "Ztso", "Zve32f", "Zve32x", "Zve512b", "Zve64d", "Zve64f", "Zve64x", "Zvl1024b", "Zvl128b", "Zvl256b", "Zvl32b", "Zvl64b"]);

/**
 * riscv-config's canonical ordering, which is not alphabetical.
 *
 * Z-extensions sort by the canonical letter of their SECOND character —
 * Zicsr before Zca, because I precedes C — and only then by the rest. Sorting
 * alphabetically produces "Z extension Zca must occur after Zicsr".
 */
const RC_LETTER_ORDER = 'IEMAFDQLCBJKTPVNSHU';
function riscvConfigSort(a, b) {
  const rank = (x) => {
    const i = RC_LETTER_ORDER.indexOf(x.charAt(1).toUpperCase());
    return i === -1 ? 99 : i;
  };
  return rank(a) - rank(b) || a.localeCompare(b);
}

/**
 * The params a UDB architecture configuration needs that no extension selection
 * implies. Transcribed from the configs riscv-arch-test ships, which are the
 * working examples of what a complete one looks like.
 *
 * WHY THIS LIST IS NOT DERIVED FROM THE SELECTION
 *
 * Every one of these is defined by Sm in UDB, which makes deriving them from the
 * chosen extensions look obvious and makes it wrong: isa-dependency-graph.json
 * gives RV32I and RV64I `requires: []`, Sm is a separate node, and no node
 * requires Sm. A derived list is therefore EMPTY for a bare RV32I selection and
 * the export would silently drop every param riscv-arch-test needs. These stay
 * unconditional; anything derived from a selection is additive on top.
 *
 * The hint beside each is a FALLBACK. When UDB defines the param the hint comes
 * from its real schema instead, so the file describes what may go there in UDB's
 * own terms rather than in ours.
 */
const UDB_REQUIRED_PARAMS = [
  ['PHYS_ADDR_WIDTH', 'physical address width in bits'],
  ['PRECISE_SYNCHRONOUS_EXCEPTIONS', 'true | false'],
  ['TRAP_ON_ECALL_FROM_M', 'true | false'],
  ['TRAP_ON_EBREAK', 'true | false'],
  ['M_MODE_ENDIANNESS', 'little | big | dynamic'],
  ['MTVAL_WIDTH', 'bits; 0 when mtval is hardwired zero'],
  ['MTVEC_ILLEGAL_WRITE_BEHAVIOR', 'retain | ignore'],
  ['MISALIGNED_LDST_EXCEPTION_PRIORITY', 'high | low'],
  ['REPORT_ENCODING_IN_MTVAL_ON_ILLEGAL_INSTRUCTION', 'true | false'],
  ['REPORT_VA_IN_MTVAL_ON_BREAKPOINT', 'true | false'],
  ['REPORT_VA_IN_MTVAL_ON_LOAD_MISALIGNED', 'true | false'],
  ['REPORT_VA_IN_MTVAL_ON_STORE_AMO_MISALIGNED', 'true | false'],
  ['REPORT_VA_IN_MTVAL_ON_INSTRUCTION_ACCESS_FAULT', 'true | false'],
  ['REPORT_VA_IN_MTVAL_ON_INSTRUCTION_MISALIGNED', 'true | false'],
  ['REPORT_VA_IN_MTVAL_ON_LOAD_ACCESS_FAULT', 'true | false'],
];

export function buildIsaConfigYaml(selectedIds, allExts, options = {}) {
  // Historically the third argument was a boolean. Kept working, but the
  // default flipped: the instruction catalogue was 5,781 of 5,974 lines in a
  // real export, all of it reconstructible from the extension list. A config
  // file people review, commit and mail should not be 177 KB of derived data.
  const {
    includeInstructions = false,
    format = 'landscape',
    // Values the user picked for oneOf parameters. A constraint list without
    // the pick is not a configuration — the point of choosing is that the
    // choice survives leaving the tool.
    paramChoices = {},
  } = typeof options === 'boolean' ? { includeInstructions: options } : options;
  const warnings = [];

  if (!selectedIds || selectedIds.length === 0) {
    return { yaml: '', warnings: ['No extensions selected.'] };
  }

  // 1. Identify base ISA
  let baseInfo = null;
  for (const id of selectedIds) {
    if (BASE_ISA_IDS.has(id)) {
      baseInfo = { id, ...BASE_ISA_PREFIX_MAP[id] };
      break;
    }
  }
  if (!baseInfo) {
    return { yaml: '', warnings: ['No base ISA selected.'] };
  }

  // 2. Partition extensions
  const singleLetters = [];
  const zExts = [];
  const privExts = [];
  const allExtTokens = []; // ordered list for the extensions: block

  let hasZicsrOrZifencei = false;
  let hasSupervisor = false;

  for (const id of selectedIds) {
    if (BASE_ISA_IDS.has(id)) continue;

    const idUpper = id.toUpperCase();

    if (idUpper === 'ZICSR' || idUpper === 'ZIFENCEI') hasZicsrOrZifencei = true;
    if (idUpper === 'S' || isPrivilegeTag(id)) hasSupervisor = true;

    if (INVALID_ISA_TOKENS.has(idUpper)) continue;

    if (isPrivilegeTag(id)) {
      // Still listed separately under privilege_extensions for readability, but
      // NOT skipped here: leaving them out made isa_string omit 14 extensions
      // that march carried, while the comment beside it claimed it held them
      // all. Two fields describing one configuration must not disagree.
      privExts.push(id);
      allExtTokens.push(id);
      zExts.push(id.charAt(0).toUpperCase() + id.slice(1).toLowerCase());
      continue;
    }

    if (id.length === 1) {
      if (idUpper === 'I' || idUpper === 'E') {
        if (idUpper !== baseInfo.base.toUpperCase()) {
          warnings.push(
            `"${id}" was dropped: it names a base ISA that is mutually exclusive with ${baseInfo.id}.`,
          );
        }
        continue;
      }
      singleLetters.push(idUpper);
      allExtTokens.push(idUpper);
    } else {
      const formatted = id.charAt(0).toUpperCase() + id.slice(1).toLowerCase();
      zExts.push(formatted);
      allExtTokens.push(formatted);
    }
  }

  // 3. Sort single letters canonically (RISC-V Unprivileged ISA §27)
  const CANONICAL_ORDER = [
    'I',
    'E',
    'M',
    'A',
    'F',
    'D',
    'Q',
    'L',
    'C',
    'J',
    'T',
    'V',
    'N',
    'H',
    'S',
    'U',
  ];
  const canonMap = Object.fromEntries(CANONICAL_ORDER.map((c, i) => [c, i]));
  singleLetters.sort((a, b) => {
    const ia = canonMap[a] ?? 999,
      ib = canonMap[b] ?? 999;
    return ia !== ib ? ia - ib : a.localeCompare(b);
  });
  const filteredSingles = singleLetters.filter((l) => l !== baseInfo.base.toUpperCase());

  // 4. Sort Z-extensions alphabetically
  zExts.sort((a, b) => a.localeCompare(b));

  // 5. Build the ISA march-like string
  const basePrefix = `RV${baseInfo.xlen}${baseInfo.base.toUpperCase()}`;
  const singlesStr = filteredSingles.join('');
  const zStr = zExts.length > 0 ? zExts.join('_') : '';
  const isaString = `${basePrefix}${singlesStr}${zStr ? (singlesStr ? '_' : '') + zStr : ''}`;

  // 6. Infer spec-version annotations
  // These are informational annotations derived from which extensions are
  // present. They are NOT enum-validated fields for any specific tool.
  const userSpecVersion = hasZicsrOrZifencei ? '2.3' : '2.2';
  const privSpecVersion = hasSupervisor ? '1.11' : '1.10';

  // 7. Build -march string (compiler flag)
  // Compatibility: scalar crypto ~GCC12-13/LLVM14-15; vector crypto GCC14+/LLVM18+;
  // Zve/Zvl version floor unconfirmed. See marchUtils.js COMPILER VERIFICATION SCOPE.
  const marchRes = buildMarchString(selectedIds, allExts);
  const marchString = marchRes.march || 'none';

  // 8. Build all extensions list for YAML
  const allExtsList = [baseInfo.id, ...filteredSingles, ...zExts, ...privExts];

  // 9. Assemble YAML
  const lines = [];
  const udbCommit = (DEPENDENCY_GRAPH?.sources?.udb?.commit ?? 'unknown').slice(0, 12);

  // — File header comments —
  // ── UDB architecture-configuration format ─────────────────────────────────
  // The format riscv-unified-db validates (spec/schemas/config_schema.json) and
  // riscv-arch-test consumes as a DUT config. Unlike riscv-config above, this
  // one is current rather than deprecated.
  //
  // It describes an IMPLEMENTATION, not a specification: an extension list with
  // pinned versions, plus params that say how the hardware behaves. Only part
  // of it is derivable from a selection, and the output separates the three
  // kinds so a reader knows which is which:
  //
  //   GENERATED    the dependency closure and the base width
  //   CONSTRAINED  params the chosen extensions force; changing them fails tests
  //   TODO         implementation choices no catalogue can know
  //
  // The TODO block is the point. Hand-writing one of these, nobody can tell
  // which params are forced by their extension picks and which are free.
  if (format === 'udb') {
    const versionOf = new Map(allExts.map((e) => [e.id, e.version]));
    const stateOf = new Map(allExts.map((e) => [e.id, e.state]));

    const u = [];
    u.push(`# UDB architecture configuration`);
    u.push(`# Schema: riscv-unified-db spec/schemas/config_schema.json`);
    u.push(`#`);
    u.push(`# Usable as a riscv-arch-test DUT config. Place beside a test_config.yaml`);
    u.push(`# pointing at it, then:`);
    u.push(`#   make CONFIG_FILES=config/cores/<vendor>/<dut>/test_config.yaml`);
    u.push(`#`);
    u.push(`# Generated by RISC-V ISA Explorer from riscv-unified-db ${udbCommit}.`);
    u.push(`# Reproducible: no timestamp, so re-exporting an unchanged selection`);
    u.push(`# produces an identical file.`);
    u.push(`#`);
    u.push(`# THIS FILE IS NOT COMPLETE. The params under TODO are implementation`);
    u.push(`# choices and must come from your core's design document. Tests will`);
    u.push(`# produce false failures until they are filled in.`);
    u.push(``);
    u.push(`$schema: config_schema.json#`);
    u.push(`kind: architecture configuration`);
    u.push(`type: fully configured`);
    u.push(`name: ""        # TODO your core or chip`);
    u.push(`description: ""  # TODO one line describing this configuration`);
    u.push(``);
    u.push(`# GENERATED — the dependency closure of your selection. Computed from the`);
    u.push(`# UDB dependency graph, so transitively required extensions are already`);
    u.push(`# here; that closure is the part most often got wrong by hand.`);
    u.push(`implemented_extensions:`);

    const unversioned = [];
    const unratified = [];
    for (const id of allExtsList) {
      const udbName = BASE_ISA_IDS.has(id) ? baseInfo.base.toUpperCase() : id;
      const v = versionOf.get(id);
      if (!v) {
        unversioned.push(id);
        u.push(`  # ${udbName}: no version in UDB — add one by hand before this will validate`);
        continue;
      }
      const notRatified = stateOf.get(id) && stateOf.get(id) !== 'ratified';
      if (notRatified) unratified.push(id);
      u.push(
        `  - { name: ${udbName}, version: "= ${v}" }` +
          (notRatified ? `   # ${stateOf.get(id).toUpperCase()} — version may still change` : ''),
      );
    }

    u.push(``);
    u.push(`params:`);
    u.push(`  # GENERATED — from the base ISA you selected.`);
    u.push(`  MXLEN: ${baseInfo.xlen}`);

    const constrained = resolveParams(selectedIds);
    if (constrained.length) {
      u.push(``);
      u.push(`  # CONSTRAINED — forced by the extensions above. Changing any of these`);
      u.push(`  # contradicts your own extension list and will fail tests.`);
      for (const prm of constrained) {
        if (prm.conflict) {
          warnings.push(`Parameter conflict: ${prm.conflict}`);
          u.push(`  # CONFLICT ${prm.name}: ${prm.conflict}`);
          continue;
        }
        const from = `required by ${prm.from.join(', ')}`;
        const why = prm.reason ? `${prm.reason}; ${from}` : from;
        // What the param IS, in UDB's words, above what this selection makes it.
        // Without it a reader meets a bare name and a number and cannot tell
        // whether the number is even the right shape without opening unified-db.
        const def = parameterDefinition(prm.name);
        if (def) {
          const label = def.long_name ? `${def.long_name}: ` : '';
          u.push(`  # ${label}${schemaSummary(def.schema)}`);
        }
        if (prm.kind === 'equal') {
          u.push(`  ${prm.name}: ${prm.value}   # ${why}`);
        } else if (prm.kind === 'greaterThanOrEqual') {
          u.push(`  ${prm.name}: ${prm.value}   # at least this; ${why}`);
        } else if (prm.kind === 'includes') {
          // A list param that must CONTAIN these values, not equal them: the
          // core may support more modes than the extension forces.
          const must = [].concat(prm.value).join(', ');
          u.push(`  ${prm.name}:   # TODO a list including ${must}; ${why}`);
        } else if (prm.kind === 'oneOf') {
          const allowed = [].concat(prm.value).join(', ');
          // The builder lets a user pick one of these, and the landscape export
          // has always recorded that pick. Emitting TODO here regardless threw
          // the choice away and asked them to make it again in a text editor.
          if (Object.prototype.hasOwnProperty.call(paramChoices, prm.name)) {
            const picked = paramChoices[prm.name];
            const rendered = typeof picked === 'string' ? JSON.stringify(picked) : picked;
            u.push(`  ${prm.name}: ${rendered}   # your choice of [${allowed}]; ${why}`);
          } else {
            u.push(`  ${prm.name}:   # TODO one of [${allowed}]; ${why}`);
          }
        } else {
          const allowed = [].concat(prm.value).join(', ');
          u.push(`  ${prm.name}:   # TODO ${prm.kind}: ${allowed}; ${why}`);
        }
      }
    }

    u.push(``);
    u.push(`  # TODO — implementation choices. No extension list implies these, and`);
    u.push(`  # they are what makes the difference between a config that reflects your`);
    u.push(`  # core and one that merely parses. Values come from your design document.`);
    // Latent rather than live: no graph constraint currently names one of the
    // floor params. If one ever does, the same key would be emitted in both the
    // CONSTRAINED and TODO blocks, and duplicate keys make the document invalid
    // YAML rather than merely untidy. Cheaper to make impossible than to detect.
    const alreadyEmitted = new Set(constrained.map((prm) => prm.name));
    for (const [name, fallback] of UDB_REQUIRED_PARAMS) {
      if (alreadyEmitted.has(name)) continue;
      const def = parameterDefinition(name);
      const hint = def ? schemaSummary(def.schema) : fallback;
      const label = def?.long_name ? `${def.long_name}; ` : '';
      u.push(`  ${name}:   # ${label}${hint}`);
    }

    if (unversioned.length) {
      warnings.push(
        `${unversioned.length} extension(s) have no UDB version and were emitted as comments: ` +
          unversioned.join(', '),
      );
    }
    if (unratified.length) {
      warnings.push(
        `${unratified.length} extension(s) are not ratified; their pinned versions may change: ` +
          unratified.join(', '),
      );
    }
    warnings.push(
      'Params under TODO must be filled from your design document before running tests.',
    );

    return { yaml: u.join('\n') + '\n', warnings };
  }

  // ── riscv-config format ────────────────────────────────────────────────────
  // RISC-V International's own validator (riscv/riscv-config). Its schema
  // requires exactly five fields per hart — ISA, User_Spec_Version,
  // Privilege_Spec_Version, supported_xlen, physical_addr_sz — under a hart
  // key, with Vendor and Device at the top level.
  //
  // Two of those we cannot know: physical_addr_sz is an implementation choice,
  // and the spec versions here are inferred. They are emitted with values that
  // parse, and flagged, rather than omitted — a file that fails to load teaches
  // the user nothing about what is missing.
  if (format === 'riscv-config') {
    const rc = [];
    rc.push(`# riscv-config ISA specification`);
    rc.push(`# Validate with:  riscv-config -ispec this-file.yaml`);
    rc.push(`#`);
    rc.push(`# Generated by RISC-V ISA Explorer from riscv-unified-db ${udbCommit}.`);
    rc.push(`# Reproducible: no timestamp, so re-exporting an unchanged selection`);
    rc.push(`# produces an identical file.`);
    rc.push(`#`);
    rc.push(`# TWO FIELDS NEED YOUR INPUT — marked TODO below. They are implementation`);
    rc.push(`# choices this tool cannot derive from an extension selection.`);
    rc.push(``);
    rc.push(`Vendor: ""   # TODO your organization`);
    rc.push(`Device: ""   # TODO your core or chip`);
    rc.push(`hart_ids: [0]`);
    rc.push(`hart0:`);
    // Build the string riscv-config will actually accept: its vocabulary, its
    // ordering, and the first sub-extension attached directly to the letters.
    // V is a shorthand for Zve64d plus a 128-bit VLEN floor, so riscv-config
    // treats listing both as an error outright: "V and Zve* cannot exist
    // together". clang tolerates the redundant form, which is why -march keeps
    // it, but this format must not. Same rule as Zkn absorbing Zbkb.
    // riscv-config orders the single letters IEMAFDQLCBJKTPVNSHU — S before H,
    // where our -march order (ISA manual §27) puts H first. Emitting our order
    // gets "Alphabet 'H' should occur after 'S'".
    const rcSingles = [...filteredSingles]
      .sort((a, b) => RC_LETTER_ORDER.indexOf(a) - RC_LETTER_ORDER.indexOf(b))
      .join('');
    const vPresent = rcSingles.includes('V');
    const shorthandAbsorbed = absorbedByShorthand(selectedIds);
    const rcCandidates = zExts.filter((z) => {
      if (vPresent && /^Zv(e|l)/i.test(z)) return false;
      if (shorthandAbsorbed.has(z)) return false;
      return true;
    });
    const rcKnown = rcCandidates
      .filter((z) => RISCV_CONFIG_SUB_EXTENSIONS.has(z))
      .sort(riscvConfigSort);
    const rcDropped = rcCandidates.filter((z) => !RISCV_CONFIG_SUB_EXTENSIONS.has(z)).sort();
    const rcAbsorbed = vPresent ? zExts.filter((z) => /^Zv(e|l)/i.test(z)).sort() : [];
    const rcIsa =
      `${basePrefix}${rcSingles}${rcKnown.length ? rcKnown[0] : ''}` +
      rcKnown
        .slice(1)
        .map((z) => `_${z}`)
        .join('');

    rc.push(`  # riscv-config Capitalises sub-extensions, attaches the first directly to`);
    rc.push(`  # the base letters, and orders them by the canonical letter of the second`);
    rc.push(`  # character — Zicsr before Zca — none of which matches -march.`);
    rc.push(`  ISA: ${rcIsa}`);
    rc.push(
      `  physical_addr_sz: 32          # TODO physical address width for your implementation`,
    );
    rc.push(`  User_Spec_Version: "${userSpecVersion}"        # inferred from the selection`);
    rc.push(`  Privilege_Spec_Version: "${privSpecVersion}"   # inferred from the selection`);
    rc.push(`  supported_xlen: [${baseInfo.xlen}]`);

    if (rcAbsorbed.length) {
      rc.push(``);
      rc.push(`# ${rcAbsorbed.length} vector sub-extension(s) folded into V, which is a shorthand`);
      rc.push(`# for Zve64d plus a 128-bit VLEN floor. riscv-config rejects a string`);
      rc.push(`# carrying both: ${rcAbsorbed.join(', ')}`);
    }

    // Report the fold from the map that performed it. Grouping the bundles
    // separately contradicted it: with Zk and Zkn both selected, Zbkb was
    // absorbed once, by Zk, yet reported as folded into Zkn and again into Zk.
    const foldedBy = new Map(); // shorthand -> the members it actually absorbed
    for (const z of zExts) {
      const shorthand = shorthandAbsorbed.get(z);
      if (!shorthand) continue;
      if (!foldedBy.has(shorthand)) foldedBy.set(shorthand, []);
      foldedBy.get(shorthand).push(z);
    }
    for (const [shorthand, covered] of [...foldedBy].sort((a, b) => a[0].localeCompare(b[0]))) {
      covered.sort();
      rc.push(``);
      rc.push(
        `# ${covered.length} sub-extension(s) folded into ${shorthand}, which is a shorthand`,
      );
      rc.push(`# for its member subsets. riscv-config rejects a string`);
      rc.push(`# carrying both: ${covered.join(', ')}`);
    }

    if (rcDropped.length) {
      rc.push(``);
      rc.push(`# ${rcDropped.length} extension(s) are omitted from the ISA string above.`);
      rc.push(`# riscv-config 3.18.3 knows 74 sub-extensions and rejects the whole string`);
      rc.push(`# on meeting one it does not, so these are dropped to keep the file`);
      rc.push(`# loadable. They ARE part of your configuration — see the landscape export.`);
      for (const d of rcDropped) rc.push(`#   ${d}`);
    }

    const rcParams = resolveParams(selectedIds);
    if (rcParams.length) {
      rc.push(``);
      rc.push(`# Parameters the selection constrains, from riscv-unified-db. riscv-config`);
      rc.push(`# does not define fields for all of these, so they are carried as comments`);
      rc.push(`# rather than invented keys that would fail its schema.`);
      for (const prm of rcParams) {
        const val = Array.isArray(prm.value) ? prm.value.join(' | ') : prm.value;
        rc.push(`#   ${prm.name}: ${prm.kind} ${val}   (required by ${prm.from.join(', ')})`);
        if (prm.conflict) rc.push(`#     CONFLICT: ${prm.conflict}`);
      }
    }
    rc.push(``);
    return { yaml: rc.join('\n'), warnings };
  }

  lines.push(`# ISA Configuration — generated by RISC-V ISA Explorer`);
  lines.push(`# https://github.com/riscv/riscv-isa-explorer`);
  lines.push(`#`);
  lines.push(`# Deliberately reproducible: the same selection produces a byte-identical`);
  lines.push(`# file. There is no generation timestamp, because two exports of one`);
  lines.push(`# configuration differing on a date defeats diffing and version control.`);
  lines.push(`#`);
  lines.push(`# source:`);
  lines.push(`#   dependencies and parameters — riscv-unified-db ${udbCommit}`);
  lines.push(`#   instruction encodings      — riscv/riscv-opcodes`);
  lines.push(`#   extension catalogue        — ${allExts.length} entries`);
  lines.push(``);

  // — Part 1: Header —
  // ##########################################################################
  // Part 1: ISA Configuration Header
  // ##########################################################################
  lines.push(``);
  lines.push(`vendor: ""   # Optional — your organization name (e.g. "SiFive", "Qualcomm")`);
  lines.push(`device: ""   # Optional — your core/chip name  (e.g. "U74", "Oryon")`);
  lines.push(``);
  lines.push(`base_isa: ${basePrefix}   # Base ISA only (e.g. RV64I, RV32E)`);
  lines.push(`isa_string: ${isaString}   # Full ISA descriptor (base + all selected extensions)`);
  lines.push(`xlen: ${baseInfo.xlen}`);
  lines.push(``);
  lines.push(`# Compiler -march flag. Toolchain compatibility varies by extension family:`);
  for (const note of COMPILER_COMPAT_NOTES) lines.push(`#   ${note}`);
  lines.push(`march: ${marchString}`);
  lines.push(``);
  lines.push(`# INFERRED, not chosen. Derived from which extensions are present`);
  lines.push(`# (Zicsr/Zifencei → User Spec 2.3+; supervisor extensions → Priv Spec 1.11+).`);
  lines.push(`# The rule is coarse. Set these yourself if the exact version matters.`);
  lines.push(`user_spec_version: "${userSpecVersion}"        # inferred`);
  lines.push(`privilege_spec_version: "${privSpecVersion}"   # inferred`);
  lines.push(``);
  lines.push(`# Implementation parameters the selection constrains, from`);
  lines.push(`# riscv-unified-db. -march can express only VLEN, and only obliquely`);
  lines.push(`# through the Zvl*b extensions, so these are the part of the`);
  lines.push(`# configuration a compiler flag cannot carry.`);
  lines.push(`#`);
  lines.push(`#   greaterThanOrEqual — a floor; the largest wins`);
  lines.push(`#   includes           — the value must offer at least these`);
  lines.push(`#   oneOf              — pick one; each extension narrows the field`);
  lines.push(`#   equal              — fixed`);
  const params = resolveParams(selectedIds);
  if (params.length === 0) {
    lines.push(`parameters: {}   # nothing in this selection constrains one`);
  } else {
    lines.push(`parameters:`);
    for (const prm of params) {
      lines.push(`  ${prm.name}:`);
      lines.push(`    constraint: ${prm.kind}`);
      const value = Array.isArray(prm.value)
        ? `[${prm.value.map((v) => (typeof v === 'string' ? JSON.stringify(v) : v)).join(', ')}]`
        : typeof prm.value === 'string'
          ? JSON.stringify(prm.value)
          : prm.value;
      lines.push(`    value: ${value}`);
      lines.push(`    required_by: [${prm.from.join(', ')}]`);
      if (prm.kind === 'oneOf' && Object.prototype.hasOwnProperty.call(paramChoices, prm.name)) {
        const picked = paramChoices[prm.name];
        lines.push(`    chosen: ${typeof picked === 'string' ? JSON.stringify(picked) : picked}`);
      }
      if (prm.reason) lines.push(`    reason: ${JSON.stringify(prm.reason)}`);
      // A conflict is left in the file on purpose: silently dropping it would
      // produce a configuration that looks valid and is not.
      if (prm.conflict) lines.push(`    CONFLICT: ${JSON.stringify(prm.conflict)}`);
    }
  }
  lines.push(``);
  lines.push(`extensions:`);
  for (const ext of allExtsList) {
    lines.push(`  - ${ext}`);
  }

  if (privExts.length > 0) {
    lines.push(``);
    lines.push(`# Note: the following are privilege/virtual-memory descriptors.`);
    lines.push(`# They belong in a separate privilege-spec config document if your`);
    lines.push(`# toolchain requires that distinction.`);
    lines.push(`privilege_extensions:`);
    for (const ext of privExts) {
      lines.push(`  - ${ext}`);
    }
  }

  // — Part 2: Instruction catalog —
  if (includeInstructions) {
    const catalog = buildCombinedCatalog(selectedIds, allExts);

    lines.push(``);
    lines.push(`# ##########################################################################`);
    lines.push(`# Part 2: Full Instruction Catalog (${catalog.length} instructions)`);
    lines.push(`#`);
    lines.push(`# Deduplicated by mnemonic + encoding. Instructions shared across multiple`);
    lines.push(`# extensions list all source extensions under defined_by.`);
    lines.push(`# ##########################################################################`);
    lines.push(``);
    lines.push(`instructions:`);

    for (const instr of catalog) {
      lines.push(`  - mnemonic: ${instr.mnemonic}`);
      lines.push(`    encoding: "${instr.encoding}"`);
      lines.push(`    match: "${instr.match}"`);
      lines.push(`    mask: "${instr.mask}"`);
      if (instr.variable_fields && instr.variable_fields.length > 0) {
        lines.push(`    variable_fields: [${instr.variable_fields.join(', ')}]`);
      }
      lines.push(`    defined_by: [${instr.sources.map((s) => s.extId).join(', ')}]`);
    }
  }

  lines.push(``); // trailing newline
  return { yaml: lines.join('\n'), warnings };
}
