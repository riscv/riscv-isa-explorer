/**
 * sandboxModel.js — Custom Extension Sandbox logic.
 *
 * Pure functions. No React. No catalog import — callers pass the instruction
 * database when validation needs it, same discipline as marchUtils.js.
 *
 * DATA PROVENANCE: This module produces no authoritative data. It generates
 * instruction templates from the RISC-V specification's base instruction
 * formats (R/I/S/B/U/J) and validates user-defined encodings against the
 * existing catalog using the same BigInt arithmetic the Encoder Validator uses.
 * Every validation result traces back to real catalog data.
 */

import {
  encodingToMatchMask,
  matchMaskToEncoding,
  patternsOverlap,
  isSubsetPattern,
  overlapExampleWord,
  toHex32,
} from './encodingUtils.js';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Maximum custom extensions in one sandbox. */
export const MAX_EXTENSIONS = 8;

/** Maximum instructions per custom extension. */
export const MAX_INSTRUCTIONS = 32;

/** localStorage key. Separate from the builder state — they are independent. */
export const SANDBOX_STORAGE_KEY = 'riscv-landscape-sandbox';

// ---------------------------------------------------------------------------
// Custom opcode slots
// ---------------------------------------------------------------------------

/**
 * The four custom opcode slots the specification reserves for non-standard
 * extensions. These are the ONLY safe slots for custom instructions — using
 * anything else risks colliding with future standard extensions.
 *
 * Source: RISC-V ISA Manual, Chapter 34 "RV32/64G Instruction Set Listings",
 * Table 34.1. The seven low bits are the major opcode, with inst[1:0]=11
 * for 32-bit instructions.
 */
export const OPCODES = [
  { value: 0x03, name: 'LOAD', type: 'standard' },
  { value: 0x07, name: 'LOAD-FP', type: 'standard' },
  { value: 0x0b, name: 'custom-0', type: 'custom' },
  { value: 0x0f, name: 'MISC-MEM', type: 'standard' },
  { value: 0x13, name: 'OP-IMM', type: 'standard' },
  { value: 0x17, name: 'AUIPC', type: 'standard' },
  { value: 0x1b, name: 'OP-IMM-32', type: 'standard' },
  { value: 0x1f, name: '48b', type: 'instruction-length' },
  { value: 0x23, name: 'STORE', type: 'standard' },
  { value: 0x27, name: 'STORE-FP', type: 'standard' },
  { value: 0x2b, name: 'custom-1', type: 'custom' },
  { value: 0x2f, name: 'AMO', type: 'standard' },
  { value: 0x33, name: 'OP', type: 'standard' },
  { value: 0x37, name: 'LUI', type: 'standard' },
  { value: 0x3b, name: 'OP-32', type: 'standard' },
  { value: 0x3f, name: '64b', type: 'instruction-length' },
  { value: 0x43, name: 'MADD', type: 'standard' },
  { value: 0x47, name: 'MSUB', type: 'standard' },
  { value: 0x4b, name: 'NMSUB', type: 'standard' },
  { value: 0x4f, name: 'NMADD', type: 'standard' },
  { value: 0x53, name: 'OP-FP', type: 'standard' },
  { value: 0x57, name: 'OP-V', type: 'standard' },
  { value: 0x5b, name: 'custom-2', type: 'custom' },
  { value: 0x5f, name: '48b', type: 'instruction-length' },
  { value: 0x63, name: 'BRANCH', type: 'standard' },
  { value: 0x67, name: 'JALR', type: 'standard' },
  { value: 0x6b, name: 'reserved', type: 'reserved' },
  { value: 0x6f, name: 'JAL', type: 'standard' },
  { value: 0x73, name: 'SYSTEM', type: 'standard' },
  { value: 0x77, name: 'OP-VE', type: 'standard' },
  { value: 0x7b, name: 'custom-3', type: 'custom' },
  { value: 0x7f, name: '>=80b', type: 'instruction-length' },
].map((op) => ({ ...op, bits: op.value.toString(2).padStart(7, '0') }));

// ---------------------------------------------------------------------------
// Instruction format templates
// ---------------------------------------------------------------------------

/**
 * Standard instruction formats from the RISC-V specification.
 *
 * Each template pre-fills the 32-bit pattern with the correct field layout for
 * its format type, using `custom-0` as the default opcode. The opcode bits are
 * replaced when the user picks a different custom slot.
 *
 * Fields are defined by [startBit, endBit] inclusive, MSB-first (bit 31 = index 0).
 *
 * Source: RISC-V ISA Manual, Chapter 2, Figure 2.2 "RISC-V base instruction formats."
 */
export const INSTRUCTION_FORMATS = {
  R: {
    label: 'R-type (register-register)',
    fields: [
      { name: 'funct7', bits: [31, 25], variable: true },
      { name: 'rs2', bits: [24, 20], variable: true },
      { name: 'rs1', bits: [19, 15], variable: true },
      { name: 'funct3', bits: [14, 12], variable: true },
      { name: 'rd', bits: [11, 7], variable: true },
    ],
  },
  I: {
    label: 'I-type (immediate)',
    fields: [
      { name: 'imm12', bits: [31, 20], variable: true },
      { name: 'rs1', bits: [19, 15], variable: true },
      { name: 'funct3', bits: [14, 12], variable: true },
      { name: 'rd', bits: [11, 7], variable: true },
    ],
  },
  S: {
    label: 'S-type (store)',
    fields: [
      { name: 'imm12hi', bits: [31, 25], variable: true },
      { name: 'rs2', bits: [24, 20], variable: true },
      { name: 'rs1', bits: [19, 15], variable: true },
      { name: 'funct3', bits: [14, 12], variable: true },
      { name: 'imm12lo', bits: [11, 7], variable: true },
    ],
  },
  U: {
    label: 'U-type (upper immediate)',
    fields: [
      { name: 'imm20', bits: [31, 12], variable: true },
      { name: 'rd', bits: [11, 7], variable: true },
    ],
  },
  R4: {
    label: 'R4-type (fused multiply-add)',
    fields: [
      { name: 'rs3', bits: [31, 27], variable: true },
      { name: 'funct2', bits: [26, 25], variable: true },
      { name: 'rs2', bits: [24, 20], variable: true },
      { name: 'rs1', bits: [19, 15], variable: true },
      { name: 'funct3', bits: [14, 12], variable: true },
      { name: 'rd', bits: [11, 7], variable: true },
    ],
  },
  // B and J types from the base ISA spec (Figure 2.2).
  // Present here so cloneFromCatalogInstruction can infer them from variable_fields
  // (bimm12hi/lo → B, jimm20 → J) and so updateInstrField can preserve field names
  // when a user edits a cloned branch or jump instruction's encoding.
  B: {
    label: 'B-type (branch)',
    fields: [
      { name: 'bimm12hi', bits: [31, 25], variable: true },
      { name: 'rs2', bits: [24, 20], variable: true },
      { name: 'rs1', bits: [19, 15], variable: true },
      { name: 'funct3', bits: [14, 12], variable: true },
      { name: 'bimm12lo', bits: [11, 7], variable: true },
    ],
  },
  J: {
    label: 'J-type (unconditional jump)',
    fields: [
      { name: 'jimm20', bits: [31, 12], variable: true },
      { name: 'rd', bits: [11, 7], variable: true },
    ],
  },
};

/**
 * Build a 32-character encoding template from a format and a custom opcode.
 *
 * Fixed bits get `0`/`1`; variable fields get `-`. The opcode (bits [6:0])
 * is always fixed. For R-type, funct3 and funct7 start variable — the user
 * fixes them to define their specific instruction.
 */
export function buildTemplate(formatKey, opcodeValue = 0x0b) {
  const format = INSTRUCTION_FORMATS[formatKey];
  if (!format) return null;

  // Start with 32 variable bits
  const bits = new Array(32).fill('-');

  // Fix the opcode (bits 6:0 → indices 25..31 in MSB-first order)
  for (let i = 0; i < 7; i++) {
    bits[31 - i] = (opcodeValue >> i) & 1 ? '1' : '0';
  }

  return {
    encoding: bits.join(''),
    variable_fields: format.fields.filter((f) => f.variable).map((f) => f.name),
    format: formatKey,
  };
}

// ---------------------------------------------------------------------------
// Extension creation
// ---------------------------------------------------------------------------

/**
 * Extract the major 7-bit opcode values used by an extension's instructions.
 * @param {object} extensionCatalogEntry
 * @returns {number[]} array of unique opcode numbers e.g. [0x57, 0x07, 0x27]
 */
export function getExtensionMajorOpcodes(extensionCatalogEntry) {
  if (!extensionCatalogEntry || !extensionCatalogEntry.instructions) return [];
  const opcodes = new Set();
  for (const inst of Object.values(extensionCatalogEntry.instructions)) {
    if (inst && inst.match) {
      try {
        const matchVal = typeof inst.match === 'bigint' ? inst.match : BigInt(inst.match);
        // Skip 16-bit compressed instructions: inst[1:0] !== 11 means this is a C-extension
        // encoding, not a 32-bit major opcode slot. Reading bits[6:0] of a 16-bit match
        // produces opcode values like 0x71 that are not in the OPCODES table and break
        // the allowed-opcodes list for Mode-B additions to any Zc*/C extension.
        if (Number(matchVal & 0x3n) !== 3) continue;
        opcodes.add(Number(matchVal & 0x7fn));
      } catch {
        /* ignore malformed match */
      }
    } else if (inst && inst.encoding && inst.encoding.length === 32) {
      const opBits = inst.encoding.slice(25);
      if (/^[01]{7}$/.test(opBits) && parseInt(opBits.slice(5), 2) === 3) {
        opcodes.add(parseInt(opBits, 2));
      }
    }
  }
  return Array.from(opcodes);
}

/**
 * Create a new sandbox extension (Mode A: Custom Vendor or Mode B: Addition to Standard Extension).
 */
export function createExtension(
  name = '',
  isOfficial = false,
  mode = 'custom',
  baseExtData = null,
) {
  if (mode === 'addition' && baseExtData) {
    const primaryOpcode =
      typeof baseExtData.primaryOpcode === 'number'
        ? baseExtData.primaryOpcode
        : typeof baseExtData.opcode === 'number'
          ? baseExtData.opcode
          : null;
    if (primaryOpcode == null) {
      return null;
    }

    // Use a unique proposal ID (${baseExtData.id}__sandbox) that never collides
    // with real catalog extension IDs (which cannot contain double underscores per
    // RISC-V naming conventions). This ensures the proposal cannot shadow the real
    // extension in extensionSearchIndexById. In SandboxPanel, createStandardAddition
    // enforces at most one addition proposal per base extension.
    const proposalId = `${baseExtData.id}__sandbox`;
    return {
      id: proposalId,
      mode: 'addition',
      baseExtensionId: baseExtData.id,
      isOfficial: true,
      name: baseExtData.name || baseExtData.id,
      desc: baseExtData.desc || '',
      opcode: primaryOpcode,
      tags:
        Array.isArray(baseExtData.tags) && baseExtData.tags.length > 0
          ? [...baseExtData.tags]
          : [`rv_${baseExtData.id.toLowerCase()}`],
      instructions: [],
    };
  }

  const prefix = isOfficial ? 'Z' : 'X';
  const id = name || `${prefix}ext${Date.now().toString(36).slice(-4)}`;
  const enforcedId = enforcePrefix(id, isOfficial, false);
  return {
    id: enforcedId,
    mode: 'custom',
    baseExtensionId: null,
    isOfficial,
    name: name || '',
    desc: '',
    opcode: 0x0b,
    tags: [`rv_${enforcedId.toLowerCase()}`],
    instructions: [],
  };
}

/**
 * Extract all distinct instruction encodings across the catalog.
 *
 * Keyed by `${mnemonic}|${match}|${mask}` so polymorphic encodings across
 * base ISAs (e.g. RV32 vs RV64 SLLI) survive into the collision corpus.
 */
export function allInstructionEncodings(catalog) {
  const entries = [];
  (function walk(node) {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') {
      if (node.id && node.desc) entries.push(node);
      Object.values(node).forEach(walk);
    }
  })(catalog);

  const byEncoding = new Map();
  for (const ext of entries) {
    for (const [mnemonic, details] of Object.entries(ext.instructions || {})) {
      if (!details || details.match == null || details.mask == null) continue;
      const match = BigInt(details.match);
      const mask = BigInt(details.mask);
      const key = `${mnemonic}|${match}|${mask}`;
      const existing = byEncoding.get(key);
      if (existing) {
        if (!existing.extensions.includes(ext.id)) existing.extensions.push(ext.id);
        continue;
      }
      byEncoding.set(key, { mnemonic, match, mask, extensions: [ext.id] });
    }
  }
  return [...byEncoding.values()];
}

/**
 * Clone an existing catalog instruction into a candidate instruction for standard addition.
 */
export function cloneFromCatalogInstruction(catalogInstr, _targetOpcode = null) {
  if (!catalogInstr) return null;
  if (catalogInstr.encoding && catalogInstr.encoding.length !== 32) {
    return null;
  }
  let matchVal = null;
  if (catalogInstr.match != null) {
    matchVal =
      typeof catalogInstr.match === 'bigint' ? catalogInstr.match : BigInt(catalogInstr.match);
    if (Number(matchVal & 0x3n) !== 3) {
      return null;
    }
  }
  let encoding = catalogInstr.encoding;
  if (!encoding && matchVal != null && catalogInstr.mask != null) {
    const k = typeof catalogInstr.mask === 'bigint' ? catalogInstr.mask : BigInt(catalogInstr.mask);
    encoding = matchMaskToEncoding(matchVal, k);
  }
  if (!encoding || encoding.length !== 32 || encoding.slice(30) !== '11') {
    // Silently substituting an R-type template while keeping the cloned instruction's
    // mnemonic and clonedFrom label is misleading — the exported JSON would misrepresent
    // a 16-bit instruction as a 32-bit one. Return null so the UI can reject the clone
    // and filter the sibling list to only offer 32-bit instructions.
    return null;
  }

  const parsed = encodingToMatchMask(encoding);

  const varFields = Array.isArray(catalogInstr.variable_fields)
    ? [...catalogInstr.variable_fields]
    : [];

  // Infer format from variable_fields, covering all six base formats.
  // This determines which field names updateInstrField preserves on bit-edits.
  let format = 'R';
  if (varFields.some((f) => f.startsWith('bimm12'))) {
    format = 'B';
  } else if (varFields.includes('jimm20')) {
    format = 'J';
  } else if (varFields.includes('imm12') || varFields.includes('imm12hi')) {
    format = varFields.includes('imm12hi') ? 'S' : 'I';
  } else if (varFields.includes('imm20')) {
    format = 'U';
  } else if (varFields.includes('rs3')) {
    format = 'R4';
  }

  return {
    mnemonic: `${catalogInstr.mnemonic || 'INSTR'}_NEW`,
    clonedFrom: catalogInstr.mnemonic || '',
    encoding,
    variable_fields: varFields.length > 0 ? varFields : ['rd', 'rs1', 'rs2'],
    match: parsed.match !== null ? toHex32(parsed.match) : toHex32(catalogInstr.match ?? 0n),
    mask: parsed.mask !== null ? toHex32(parsed.mask) : toHex32(catalogInstr.mask ?? 0n),
    format,
    notes: `Candidate instruction based on ${catalogInstr.mnemonic || 'sibling standard instruction'}`,
  };
}

/**
 * Create a new sandbox instruction from a format template.
 */
export function createInstruction(formatKey = 'R', opcodeValue = 0x0b) {
  const template = buildTemplate(formatKey, opcodeValue);
  if (!template) return null;

  const { match, mask } = encodingToMatchMask(template.encoding);

  return {
    mnemonic: '',
    encoding: template.encoding,
    variable_fields: [...template.variable_fields],
    match: match !== null ? toHex32(match) : '',
    mask: mask !== null ? toHex32(mask) : '',
    format: formatKey,
    notes: '',
  };
}

// ---------------------------------------------------------------------------
// Naming conventions
// ---------------------------------------------------------------------------

/**
 * Enforce the `X` prefix for non-standard extensions per RISC-V convention.
 *
 * Source: RISC-V ISA Manual §27 "ISA Extension Naming Conventions" —
 * "Non-standard extensions are named using a single X followed by an
 * alphabetical name."
 */
export function enforcePrefix(id, isOfficial, isAddition = false) {
  if (isAddition) return id ? id.trim() : '';
  if (!id) return isOfficial ? 'Z' : 'X';
  const trimmed = id.trim();
  if (isOfficial) {
    if (/^[ZzSs]/.test(trimmed)) {
      return trimmed[0].toUpperCase() + trimmed.slice(1);
    }
    return 'Z' + trimmed;
  } else {
    if (/^[Xx]/.test(trimmed)) {
      return 'X' + trimmed.slice(1);
    }
    return 'X' + trimmed;
  }
}

/**
 * Validate an extension ID.
 * Returns null if valid, or a diagnostic string if not.
 */
export function validateExtensionId(id, isOfficial, isAddition = false) {
  if (!id || !id.trim()) return 'Extension ID is required.';
  if (isAddition) return null;
  if (id.length < 2) return 'Extension ID needs at least one character after the prefix.';
  if (isOfficial) {
    if (!/^[ZS]/i.test(id)) return 'Official standard extensions usually start with "Z" or "S".';
    if (!/^[ZS][a-zA-Z0-9_]+$/.test(id))
      return 'Extension ID may only contain letters, digits, and underscores.';
  } else {
    if (!/^X/i.test(id)) return 'Non-standard extensions must start with "X" (RISC-V ISA §27).';
    if (!/^X[a-zA-Z0-9_]+$/.test(id))
      return 'Extension ID may only contain letters, digits, and underscores.';
  }
  return null;
}

/**
 * Validate a mnemonic.
 * Returns null if valid, or a diagnostic string.
 */
export function validateMnemonic(mnemonic) {
  if (!mnemonic || !mnemonic.trim()) return 'Mnemonic is required.';
  if (!/^[A-Za-z][A-Za-z0-9_.]*$/.test(mnemonic.trim())) {
    return 'Mnemonic must start with a letter and contain only letters, digits, dots, and underscores.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Validation — the core of the sandbox
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ValidationDiagnostic
 * @property {'error'|'warning'|'info'} severity
 * @property {string} message
 * @property {string} [conflictWith] mnemonic of the conflicting instruction
 * @property {string} [conflictExt] extension of the conflicting instruction
 * @property {string} [example] example 32-bit word that matches both patterns
 */

/**
 * Validate a single sandbox instruction against the full instruction database
 * and other sandbox instructions.
 *
 * This reuses the exact same BigInt conflict-detection arithmetic that the
 * Encoder Validator uses, guaranteeing identical results.
 *
 * @param {object} instr — the sandbox instruction to validate
 * @param {Array} catalogInstructions — from distinctInstructions(catalog)
 * @param {Array} otherSandboxInstructions — from other sandbox extensions
 * @param {object} [extContext] — context of the parent extension ({ mode, baseExtensionId, allowedOpcodes })
 * @returns {ValidationDiagnostic[]}
 */
export function validateInstruction(
  instr,
  catalogInstructions = [],
  otherSandboxInstructions = [],
  extContext = null,
) {
  const diagnostics = [];

  // 1. Encoding format check
  const enc = (instr.encoding || '').replace(/\s+/g, '');
  if (enc.length !== 32) {
    diagnostics.push({
      severity: 'error',
      message: `Encoding must be exactly 32 bits (got ${enc.length}).`,
    });
    return diagnostics;
  }
  if (!/^[01-]{32}$/.test(enc)) {
    diagnostics.push({
      severity: 'error',
      message: "Encoding may only contain 0, 1, and - (don't-care).",
    });
    return diagnostics;
  }

  // 2. Parse match/mask
  const { match, mask, error } = encodingToMatchMask(enc);
  if (error || match === null || mask === null) {
    diagnostics.push({ severity: 'error', message: error || 'Could not derive match/mask.' });
    return diagnostics;
  }

  // 3. Opcode space check — is this in custom, reserved, or standard?
  const OPCODE_BITS = 0x7fn;
  const opcodeFullyFixed = (mask & OPCODE_BITS) === OPCODE_BITS;
  const opcodeVal = Number(match & OPCODE_BITS);
  const isModeAddition = extContext && extContext.mode === 'addition';

  // Guard: 16-bit compressed encodings have inst[1:0] != 11. The OPCODES table is
  // exclusively for 32-bit major opcodes; reading bits[6:0] of a 16-bit match produces
  // fabricated values (e.g. 0x71 from Zcb) that opInfo.find() returns undefined for.
  // Without this guard, both the isModeAddition and vendor branches are skipped entirely
  // (all wrapped in `opInfo &&`) and the instruction passes opcode classification silently.
  const is32bit = Number(match & 0x3n) === 3;
  if (!is32bit) {
    diagnostics.push({
      severity: 'error',
      message:
        'This encoding sits in the 16-bit compressed instruction space (inst[1:0] \u2260 11). ' +
        'The sandbox models 32-bit base instructions. A compressed encoding cannot be ' +
        'validated or exported as a standard 32-bit instruction. Set bits [1:0] to 11 ' +
        'to target 32-bit opcode space.',
    });
    // Still continue to the collision check — a badly-formed encoding can still
    // alias a catalog pattern, and reporting that is useful.
  }

  const opInfo = opcodeFullyFixed && is32bit ? OPCODES.find((c) => c.value === opcodeVal) : null;

  if (!opcodeFullyFixed) {
    diagnostics.push({
      severity: 'error',
      message:
        'Opcode bits [6:0] are not fully specified. An encoding with variable ' +
        'opcode bits spans more than one opcode slot, so it cannot be shown to ' +
        'sit inside the custom space. Fix all seven bits to classify it.',
    });
  } else if (is32bit && !opInfo) {
    // Fully-fixed opcode bits, 32-bit instruction, but no match in the OPCODES table.
    diagnostics.push({
      severity: 'warning',
      message: `Opcode 0x${opcodeVal.toString(16).padStart(2, '0')} is not a recognized RISC-V major opcode. It may be a non-standard or future-reserved value.`,
    });
  } else if (opInfo && opInfo.type === 'instruction-length') {
    diagnostics.push({
      severity: 'error',
      message: `Opcode 0x${opcodeVal.toString(16).padStart(2, '0')} (${opInfo.name}) is designated for expanded instruction-length encodings (${opInfo.name} instructions) per RISC-V ISA specification. It is not a valid 32-bit instruction opcode slot.`,
    });
  } else if (isModeAddition) {
    if (opInfo && opInfo.type === 'custom') {
      diagnostics.push({
        severity: 'error',
        message: `Opcode 0x${opcodeVal.toString(16).padStart(2, '0')} (${opInfo.name}) is in CUSTOM space. Custom opcode slots (custom-0..custom-3) are strictly reserved for non-standard vendor extensions and must never be used for standard extensions (RISC-V ISA \u00a727).`,
      });
    } else if (opInfo && opInfo.type === 'reserved') {
      diagnostics.push({
        severity: 'info',
        message: `Opcode 0x${opcodeVal.toString(16).padStart(2, '0')} is in RESERVED space set aside for future standard extensions.`,
      });
    } else if (opInfo && opInfo.type === 'standard') {
      const allowed = Array.isArray(extContext.allowedOpcodes) ? extContext.allowedOpcodes : [];
      if (!allowed.includes(opcodeVal)) {
        diagnostics.push({
          severity: 'warning',
          message: `Opcode 0x${opcodeVal.toString(16).padStart(2, '0')} (${opInfo.name}) belongs to standard space outside ${extContext.baseExtensionId || 'the target extension'}. Standard additions should target ${extContext.baseExtensionId || 'the extension'}'s existing opcode space or reserved space.`,
        });
      }
    }
  } else if (opInfo && opInfo.type !== 'custom') {
    const isStandard = opInfo.type === 'standard';
    diagnostics.push({
      severity: isStandard ? 'error' : 'warning',
      message: `Opcode 0x${opcodeVal.toString(16).padStart(2, '0')} (${opInfo.name}) is in ${opInfo.type.toUpperCase()} space. Using this space risks colliding with ${isStandard ? 'existing' : 'future'} ratified extensions.`,
    });
  }

  // 4. Conflict check against the full standard catalog
  for (const existing of catalogInstructions) {
    if (existing.match == null || existing.mask == null) continue;

    const eMatch = typeof existing.match === 'bigint' ? existing.match : BigInt(existing.match);
    const eMask = typeof existing.mask === 'bigint' ? existing.mask : BigInt(existing.mask);

    if (!patternsOverlap(match, mask, eMatch, eMask)) continue;

    const identicalMask = mask === eMask;
    const identicalMatch = (match & mask) === (eMatch & eMask);
    const identical = identicalMask && identicalMatch;

    const example = toHex32(overlapExampleWord(match, mask, eMatch, eMask));

    if (identical) {
      diagnostics.push({
        severity: 'error',
        message: `Identical encoding to existing instruction "${existing.mnemonic}" (${(existing.extensions || []).join(', ')}).`,
        conflictWith: existing.mnemonic,
        conflictExt: (existing.extensions || [])[0],
        example,
      });
    } else if (isSubsetPattern(match, mask, eMatch, eMask)) {
      diagnostics.push({
        severity: 'error',
        message: `Every word matching this instruction also matches "${existing.mnemonic}" (${(existing.extensions || []).join(', ')}). Proposed is a subset of existing.`,
        conflictWith: existing.mnemonic,
        conflictExt: (existing.extensions || [])[0],
        example,
      });
    } else if (isSubsetPattern(eMatch, eMask, match, mask)) {
      diagnostics.push({
        severity: 'error',
        message: `Every word matching "${existing.mnemonic}" (${(existing.extensions || []).join(', ')}) also matches this instruction. Existing is a subset of proposed.`,
        conflictWith: existing.mnemonic,
        conflictExt: (existing.extensions || [])[0],
        example,
      });
    } else {
      diagnostics.push({
        severity: 'error',
        message: `Partial overlap with "${existing.mnemonic}" (${(existing.extensions || []).join(', ')}). Some words decode as both instructions.`,
        conflictWith: existing.mnemonic,
        conflictExt: (existing.extensions || [])[0],
        example,
      });
    }
  }

  // 5. Conflict check against other sandbox instructions
  for (const other of otherSandboxInstructions) {
    if (!other.encoding || other === instr) continue;
    const otherParsed = encodingToMatchMask(other.encoding);
    if (otherParsed.match == null || otherParsed.mask == null) continue;

    if (patternsOverlap(match, mask, otherParsed.match, otherParsed.mask)) {
      const example = toHex32(overlapExampleWord(match, mask, otherParsed.match, otherParsed.mask));
      diagnostics.push({
        severity: 'error',
        message: `Encoding conflict with sandbox instruction "${other.mnemonic || '(unnamed)'}". Example overlap: ${example}.`,
        conflictWith: other.mnemonic,
        example,
      });
    }
  }

  // 6. Variable field sanity — warn if no variable fields at all
  const varCount = enc.split('').filter((b) => b === '-').length;
  if (varCount === 0) {
    diagnostics.push({
      severity: 'info',
      message:
        'All 32 bits are fixed. This instruction can only encode one operation with no operands.',
    });
  }

  // 7. Mnemonic check
  const mnemonicDiag = validateMnemonic(instr.mnemonic);
  if (mnemonicDiag) {
    diagnostics.push({ severity: 'warning', message: mnemonicDiag });
  }

  // Duplicate normalized key check among sibling sandbox instructions
  if (instr.mnemonic) {
    const myKey = instr.mnemonic.toLowerCase().replace(/\./g, '_');
    const dupKeySibling = (otherSandboxInstructions || []).find((other) => {
      if (!other || !other.mnemonic || other === instr) return false;
      return other.mnemonic.toLowerCase().replace(/\./g, '_') === myKey;
    });
    if (dupKeySibling) {
      diagnostics.push({
        severity: 'error',
        message:
          dupKeySibling.mnemonic.toLowerCase() === instr.mnemonic.toLowerCase()
            ? `Duplicate mnemonic "${instr.mnemonic}". Each instruction in an extension must have a unique mnemonic, or it will overwrite earlier definitions in export.`
            : `Mnemonic "${instr.mnemonic}" normalizes to the same riscv-opcodes key ("${myKey}") as "${dupKeySibling.mnemonic}". They will overwrite each other in export.`,
      });
    }
  }

  return diagnostics;
}

// ---------------------------------------------------------------------------
// Export — riscv-opcodes JSON format
// ---------------------------------------------------------------------------

/**
 * Export a sandbox extension as riscv-opcodes compatible JSON.
 *
 * This is the format toolchain engineers paste into their fork of riscv-opcodes.
 * Each key is the mnemonic lowercased with `.` → `_`, matching the convention
 * documented in the project README.
 *
 * Source: riscv-opcodes repository format, as consumed by this project's own
 * sync pipeline (scripts/sync_instructions.mjs).
 */
export function toRiscvOpcodesJson(extension) {
  if (!extension || !Array.isArray(extension.instructions)) return {};

  const extTags =
    extension.mode === 'addition'
      ? Array.isArray(extension.tags) && extension.tags.length > 0
        ? [...extension.tags]
        : [extension.baseExtensionId || extension.id]
      : [`rv_${(extension.id || '').toLowerCase()}`];

  const out = {};
  for (const instr of extension.instructions) {
    if (!instr.mnemonic) continue;
    const key = instr.mnemonic.toLowerCase().replace(/\./g, '_');
    const parsed = encodingToMatchMask(instr.encoding);

    out[key] = {
      encoding: instr.encoding || '',
      variable_fields: [...(instr.variable_fields || [])],
      extension: extTags,
      match: parsed.match !== null ? toHex32(parsed.match) : '',
      mask: parsed.mask !== null ? toHex32(parsed.mask) : '',
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Persistence — localStorage
// ---------------------------------------------------------------------------

/**
 * Save sandbox state to localStorage.
 */
export function saveSandbox(extensions) {
  try {
    const data = JSON.stringify(extensions || []);
    window.localStorage.setItem(SANDBOX_STORAGE_KEY, data);
  } catch {
    // Storage unavailable or quota exceeded — degrade silently
  }
}

/**
 * Load sandbox state from localStorage. Validates shape; does not trust blindly.
 */
export function loadSandbox() {
  try {
    const raw = window.localStorage.getItem(SANDBOX_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, MAX_EXTENSIONS).map(normalizeSandboxExt).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Normalize and validate a single sandbox extension object from any untrusted
 * source (localStorage, URL parameter, clipboard). This is the single source
 * of truth for shape validation across all three deserialization paths.
 *
 * Returns null if the object is fundamentally invalid (no id). Otherwise returns
 * a fully-typed object with safe defaults for every field.
 */
export function normalizeSandboxExt(ext) {
  if (!ext || typeof ext !== 'object' || !ext.id) return null;
  const isAddition = ext.mode === 'addition';

  let opcode = null;
  if (typeof ext.opcode === 'number' && Number.isFinite(ext.opcode)) {
    opcode = ext.opcode;
  } else if (typeof ext.opcode === 'string' && ext.opcode.trim() !== '') {
    const trimmed = ext.opcode.trim();
    const parsed =
      trimmed.startsWith('0x') || trimmed.startsWith('0X')
        ? parseInt(trimmed, 16)
        : parseInt(trimmed, 10);
    if (Number.isFinite(parsed)) {
      opcode = parsed;
    }
  }

  // An addition proposal requires a valid numeric opcode; drop it if absent/invalid
  if (isAddition && opcode == null) {
    return null;
  }
  const finalOpcode = opcode ?? 0x0b;

  const rawId = String(ext.id);
  const enforcedId = enforcePrefix(rawId, !!ext.isOfficial, isAddition);
  return {
    id: enforcedId,
    mode: isAddition ? 'addition' : 'custom',
    baseExtensionId: ext.baseExtensionId
      ? String(ext.baseExtensionId)
      : isAddition
        ? rawId.replace(/__sandbox$/, '')
        : null,
    isOfficial: !!ext.isOfficial,
    name: String(ext.name || ''),
    desc: String(ext.desc || ''),
    opcode: finalOpcode,
    tags:
      Array.isArray(ext.tags) && ext.tags.length > 0
        ? ext.tags.map(String)
        : [`rv_${enforcedId.toLowerCase()}`],
    instructions: (Array.isArray(ext.instructions) ? ext.instructions : [])
      .filter((i) => i && typeof i === 'object')
      .slice(0, MAX_INSTRUCTIONS)
      .map((i) => ({
        mnemonic: String(i.mnemonic || ''),
        clonedFrom: i.clonedFrom ? String(i.clonedFrom) : '',
        encoding: String(i.encoding || ''),
        variable_fields: Array.isArray(i.variable_fields) ? i.variable_fields : [],
        match: String(i.match || ''),
        mask: String(i.mask || ''),
        format: String(i.format || 'R'),
        notes: String(i.notes || ''),
      })),
  };
}

// ---------------------------------------------------------------------------
// Serialisation — URL permalink
// ---------------------------------------------------------------------------

function toBase64Url(base64) {
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(base64url) {
  let b64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  return b64;
}

/**
 * Serialize sandbox state to a compact URL parameter value.
 * Uses CompressionStream (deflate-raw) for high compression, falling back to JSON.
 */
export async function serializeSandboxAsync(extensions) {
  if (!extensions || extensions.length === 0) return '';
  try {
    const jsonStr = JSON.stringify(extensions);
    // Use native browser compression (very smart/modern way to avoid pako/lz-string)
    if (typeof CompressionStream !== 'undefined') {
      const stream = new Blob([jsonStr]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      const compressed = await new Response(stream).arrayBuffer();
      const bytes = new Uint8Array(compressed);
      let binaryStr = '';
      // chunked to avoid max arguments limits
      for (let i = 0; i < bytes.length; i += 1024) {
        binaryStr += String.fromCharCode(...bytes.subarray(i, i + 1024));
      }
      return 'c:' + toBase64Url(btoa(binaryStr));
    }
    return toBase64Url(btoa(jsonStr));
  } catch {
    return '';
  }
}

/**
 * Deserialize a sandbox URL parameter back to state.
 */
export async function deserializeSandboxAsync(value) {
  if (!value || typeof value !== 'string') return [];
  try {
    let jsonStr = '';
    if (value.startsWith('c:')) {
      // Compressed
      const binaryStr = atob(fromBase64Url(value.slice(2)));
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      jsonStr = await new Response(stream).text();
    } else {
      // Fallback uncompressed
      jsonStr = atob(fromBase64Url(value));
    }

    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, MAX_EXTENSIONS).map(normalizeSandboxExt).filter(Boolean);
  } catch {
    return [];
  }
}

// Fallback synchronous versions for tests
export function serializeSandbox(extensions) {
  if (!extensions || extensions.length === 0) return '';
  try {
    return toBase64Url(btoa(JSON.stringify(extensions)));
  } catch {
    return '';
  }
}

export function deserializeSandbox(value) {
  if (!value || typeof value !== 'string') return [];
  // Compressed (c:) payloads require async decompression — cannot decode synchronously.
  // Return [] here so the caller falls back to localStorage; the async path in
  // RISCVExplorer will resolve c: links after the initial render.
  if (value.startsWith('c:')) return [];
  try {
    const jsonStr = atob(fromBase64Url(value));
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, MAX_EXTENSIONS).map(normalizeSandboxExt).filter(Boolean);
  } catch {
    return [];
  }
}
