/**
 * How to write an instruction: its assembly syntax, a concrete line an
 * assembler accepts, the C intrinsic that emits it, and a Compiler Explorer
 * link that shows either one compiled.
 *
 * No React and no data imports: the UDB record, the intrinsic record and the
 * catalogue ids are passed in. The -march string comes from isaGraph.js and
 * marchUtils.js, the same resolution the builder uses.
 *
 * The concrete examples are generated, not curated, so the operand values
 * below are chosen to be legal for every instruction that uses them, and
 * tests/instruction-usage.test.mjs feeds the whole catalogue through a real
 * assembler when one is available. A value that suits most instructions but
 * not all (an immediate of 16 is out of range for a vector simm5) is resolved
 * per instruction family here, never by hand-editing generated output.
 */

import { impliedVlen, resolveSelection, vlenExtension } from './isaGraph.js';
import { BASE_ISA_IDS, buildMarchString } from './marchUtils.js';

/* ── Upstream template fixes ────────────────────────────────────────────── */

/*
 * Operand templates UDB writes wrongly, found by assembling every example.
 * fli takes a floating-point constant rather than a register, and fcvtmod.w.d
 * only accepts the rtz rounding mode. Each entry must still differ from UDB's
 * own template: the test fails once upstream is fixed, so the entry can be
 * dropped instead of lingering.
 */
export const ASSEMBLY_FIXES = {
  ...Object.fromEntries(['fli.h', 'fli.s', 'fli.d', 'fli.q'].map((name) => [name, 'fd, imm'])),
  'fcvtmod.w.d': 'xd, fs1, rtz',
};

/** The operand template to use: UDB's, unless it is a known upstream error. */
export const operandTemplate = (mnemonic, assembly) =>
  ASSEMBLY_FIXES[String(mnemonic || '').toLowerCase()] ??
  (typeof assembly === 'string' ? assembly : null);

/* ── Syntax ─────────────────────────────────────────────────────────────── */

// UDB names integer registers xd/xs1; the specification writes rd/rs1.
const SPEC_NAMES = { xd: 'rd', xs1: 'rs1', xs2: 'rs2', xs3: 'rs3' };

const splitOperands = (assembly) =>
  String(assembly || '')
    .split(',')
    .map((operand) => operand.trim())
    .filter(Boolean);

/**
 * The instruction's syntax as the specification writes it, e.g.
 * `vaadd.vv vd, vs2, vs1[, v0.t]` or `lw rd, imm(rs1)`.
 *
 * @returns {string} '' when there is no operand template
 */
export function assemblySyntax(mnemonic, udbAssembly) {
  const name = String(mnemonic || '').toLowerCase();
  const assembly = operandTemplate(name, udbAssembly);
  if (!name || typeof assembly !== 'string') return '';
  const operands = splitOperands(assembly).map((operand) =>
    operand.replace(/\bx[ds]\d?\b/g, (reg) => SPEC_NAMES[reg] ?? reg),
  );
  if (operands.length === 0) return name;
  // `vm` is the optional mask operand: written `v0.t`, or left out.
  const masked = operands.at(-1) === 'vm';
  const shown = masked ? operands.slice(0, -1) : operands;
  if (!masked) return `${name} ${shown.join(', ')}`;
  return shown.length ? `${name} ${shown.join(', ')}[, v0.t]` : `${name} [v0.t]`;
}

/* ── A concrete line ────────────────────────────────────────────────────── */

/*
 * Register choices keep every operand distinct, so no assembler overlap rule
 * (a widening destination may not overlap its sources) can reject the line,
 * and vector groups start at multiples of 8 so they are aligned for any LMUL.
 */
const REGISTERS = {
  xd: 'a0',
  xs1: 'a1',
  xs2: 'a2',
  xs3: 'a3',
  fd: 'fa0',
  fs1: 'fa1',
  fs2: 'fa2',
  fs3: 'fa3',
  vd: 'v8',
  vs3: 'v8',
  vs2: 'v16',
  vs1: 'v24',
  r1s: 's0',
  r2s: 's1',
};

/*
 * Immediates. 16 is a legal offset for every load, store, branch and jump and
 * a legal nonzero multiple for the compressed stack-pointer forms. The
 * exceptions are families with narrower fields: vector immediates are 5 bits,
 * the Zcb byte and halfword accesses take 0-3, prefetch offsets are multiples
 * of 32, and fli takes one of its table's constants.
 */
const immediate = (name, mnemonic) => {
  switch (name) {
    case 'imm':
      if (mnemonic.startsWith('v')) return '1';
      if (/^c\.(?:lbu|lhu?|sb|sh)$/.test(mnemonic)) return '2';
      if (mnemonic.startsWith('prefetch.')) return '32';
      if (mnemonic.startsWith('fli.')) return '1.0';
      return '16';
    case 'offset':
      return '16';
    case 'shamt':
    case 'uimm':
    case 'cimm':
    case 'rnum':
      return '1';
    case 'bs':
      return '0';
    case 'index':
      // cm.jt takes 0-31; cm.jalt takes 32-255.
      return mnemonic === 'cm.jalt' ? '32' : '0';
    case 'stack_adj':
      return '16';
    case 'rm':
      return 'rne';
    case 'vtypei':
      return 'e32, m1, ta, ma';
    case 'csr':
      return 'mscratch';
    case 'pred':
    case 'succ':
      return 'rw';
    case '{reg_list}':
      return '{ra, s0}';
    default:
      return null;
  }
};

const LITERAL = /^(?:sp|v0|x[0-9]+|zero|ra|rtz)$/;

/**
 * One line an assembler accepts, e.g. `vaadd.vv v8, v16, v24, v0.t`.
 *
 * @returns {string|null} null when an operand has no known concrete value
 */
export function exampleAssembly(mnemonic, udbAssembly) {
  const name = String(mnemonic || '').toLowerCase();
  const assembly = operandTemplate(name, udbAssembly);
  if (!name || typeof assembly !== 'string') return null;
  const operands = splitOperands(assembly);
  const concrete = [];
  for (const [index, operand] of operands.entries()) {
    if (operand === 'vm' && index === operands.length - 1) {
      concrete.push('v0.t');
      continue;
    }
    // `imm(xs1)`, `-stack_adj` and `(xs1)` carry punctuation around the names.
    let unknown = false;
    const value = operand.replace(/\{reg_list\}|[A-Za-z_][A-Za-z0-9_]*/g, (token) => {
      if (LITERAL.test(token)) return token;
      const resolved = REGISTERS[token] ?? immediate(token, name);
      if (resolved === null) unknown = true;
      return resolved ?? token;
    });
    if (unknown) return null;
    concrete.push(value);
  }
  return concrete.length ? `${name} ${concrete.join(', ')}` : name;
}

/* ── What the instruction needs ─────────────────────────────────────────── */

const definedByXlen = (node) => {
  if (!node || typeof node !== 'object') return null;
  if (node.xlen === 32 || node.xlen === 64) return node.xlen;
  for (const child of node.allOf ?? []) {
    const found = definedByXlen(child);
    if (found) return found;
  }
  return null;
};

const tagXlen = (extensionTags) => {
  const tags = Array.isArray(extensionTags) ? extensionTags : [];
  if (tags.length && tags.every((tag) => tag.startsWith('rv32_'))) return 32;
  if (tags.length && tags.every((tag) => tag.startsWith('rv64_'))) return 64;
  return null;
};

/**
 * 'RV32' or 'RV64' when the instruction exists at one width only, else null.
 *
 * UDB decides whenever it has a record: its definedBy says `xlen: 64` for
 * lwu and `xlen: 64` *or* Zilsd on RV32 for ld. riscv-opcodes tags are only
 * a fallback for the catalogue's own RV32 duplicates (`ld.rv32`), because
 * they over-claim: slli, rori and rev8 are tagged rv64_* for their 6-bit
 * shamt encoding, yet exist on RV32 too.
 */
export function xlenRestriction(extensionTags, metadataRecord = null) {
  const xlen = metadataRecord ? definedByXlen(metadataRecord.defined_by) : tagXlen(extensionTags);
  return xlen ? `RV${xlen}` : null;
}

/**
 * The width to build an example for. Here the tags are a safe tiebreak: the
 * width they name always has the instruction, and Zcf's c.flw needs RV32
 * though UDB puts that constraint on the extension, not the instruction.
 */
export const preferredXlen = (extensionTags, definedBy = null) =>
  definedByXlen(definedBy) ?? tagXlen(extensionTags) ?? 64;

/**
 * The extensions UDB's definedBy asks for beyond what is already selected.
 *
 * An instruction can need more than the extension it is listed under:
 * c.zext.w is Zcb *and* Zba, fleq.d is Zfa *and* D. allOf takes every branch;
 * anyOf and oneOf take nothing when a branch is already met, else the first
 * branch whose extensions the catalogue knows. Names the catalogue lacks
 * ('I') are skipped.
 */
export function requiredExtensions(definedBy, selected, catalogIds) {
  const have = new Set(selected);
  const visit = (node) => {
    if (!node || typeof node !== 'object') return [];
    if (node.extension) return visit(node.extension);
    if (typeof node.name === 'string') return catalogIds.has(node.name) ? [node.name] : [];
    if (Array.isArray(node.allOf)) return node.allOf.flatMap(visit);
    const options = node.anyOf ?? node.oneOf;
    if (Array.isArray(options)) {
      const branches = options.map(visit);
      if (branches.some((ids) => ids.length && ids.every((id) => have.has(id)))) return [];
      return branches.find((ids) => ids.length) ?? [];
    }
    return [];
  };
  return [...new Set(visit(definedBy))].filter((id) => !have.has(id));
}

/*
 * Vector crypto operates on element groups, and an LMUL=1 group has to fit in
 * one register: VLEN must be at least the element group width (vector crypto
 * spec, "Element Groups"). 128 bits for AES, SHA-2, GHASH and SM4; 256 for SM3.
 */
export const ELEMENT_GROUP_WIDTH = {
  Zvkg: 128,
  Zvkgs: 128,
  Zvkned: 128,
  Zvknha: 128,
  Zvknhb: 128,
  Zvksed: 128,
  Zvksh: 256,
};

/**
 * The -march string that enables an instruction: the extension it is listed
 * under plus whatever its definedBy adds, resolved like a builder selection.
 * `extra` adds what an example needs on top (Zvfh for a half-precision
 * intrinsic), and a vector-crypto selection is raised to the VLEN its element
 * groups need. Shown under a base ISA (add under RV32E), the example uses
 * that base; RV128I has no compiler, so it falls back like everything else.
 *
 * @returns {string|null}
 */
export function instructionMarch({
  extensionId,
  extensionTags,
  definedBy,
  catalogIds,
  extra = [],
}) {
  const base =
    BASE_ISA_IDS.has(extensionId) && extensionId !== 'RV128I'
      ? extensionId
      : `RV${preferredXlen(extensionTags, definedBy)}I`;
  const resolve = (ids) => resolveSelection({ selected: [base, ...ids], base }).resolved;
  let selected = [...new Set([extensionId, ...extra])].filter((id) => id && id !== base);
  let resolved = resolve(selected);
  const needed = requiredExtensions(definedBy, resolved, catalogIds);
  if (needed.length) resolved = resolve((selected = [...selected, ...needed]));
  const groupWidth = Math.max(0, ...resolved.map((id) => ELEMENT_GROUP_WIDTH[id] ?? 0));
  const zvl = groupWidth > (impliedVlen(resolved) ?? 0) ? vlenExtension(groupWidth) : null;
  if (zvl) resolved = resolve([...selected, zvl]);
  return buildMarchString(resolved).march;
}

/** Extensions an intrinsic's types need beyond the instruction's own. */
export const intrinsicExtensions = (prototype) =>
  /\bvfloat16|_Float16/.test(String(prototype || '')) ? ['Zvfh'] : [];

/** The ABI that matches a -march string's floating-point registers. */
export function abiForMarch(march) {
  const text = String(march || '').toLowerCase();
  const rv32 = text.startsWith('rv32');
  const singles = text.replace(/^rv(?:32|64|128)/, '').split('_')[0];
  if (singles.startsWith('e')) return rv32 ? 'ilp32e' : 'lp64e';
  const fp = /[dg]/.test(singles) ? 'd' : singles.includes('f') ? 'f' : '';
  return `${rv32 ? 'ilp32' : 'lp64'}${fp}`;
}

/* ── C source ───────────────────────────────────────────────────────────── */

// Arguments a call must pass as constants, by parameter name.
const CONSTANT_ARGS = {
  vxrm: '__RISCV_VXRM_RNU',
  frm: '__RISCV_FRM_RNE',
  uimm: '1',
  rnum: '1',
  bs: '0',
  n: '0',
};

const parsePrototype = (prototype) => {
  const text = String(prototype || '')
    .replace(/\/\/.*$/, '')
    .trim()
    .replace(/;$/, '');
  const match = text.match(/^(.*?)\b(__riscv_\w+)\s*\((.*)\)$/);
  if (!match) return null;
  const params = match[3]
    .split(',')
    .map((param) => param.trim())
    .filter((param) => param && param !== 'void')
    .map((param) => ({ decl: param, name: param.match(/(\w+)$/)?.[1] }));
  return { returns: match[1].trim(), name: match[2], params };
};

/**
 * The prototype to demonstrate for a base width: the RV64-only form on RV64
 * (so ror shows ror, not rorw), anything but it on RV32.
 */
export function prototypeFor(prototypes, xlen) {
  const list = Array.isArray(prototypes) ? prototypes : [];
  const rv64Only = (p) => /RV64 only/.test(p);
  const rv32Only = (p) => /RV32 only/.test(p);
  if (xlen === 32) return list.find((p) => !rv64Only(p)) ?? null;
  return list.find(rv64Only) ?? list.find((p) => !rv32Only(p)) ?? null;
}

/**
 * A complete C file that calls the intrinsic, or null if it cannot be parsed.
 *
 * One intrinsic can serve a register form and an immediate form (ror and
 * rori both come from __riscv_ror_32); `immediate` passes the shift as a
 * constant so the compiler picks the immediate form.
 */
export function intrinsicSource(header, prototype, { immediate = false } = {}) {
  const parsed = parsePrototype(prototype);
  if (!parsed || !header) return null;
  const constants = immediate ? { ...CONSTANT_ARGS, shamt: '1' } : CONSTANT_ARGS;
  const params = parsed.params.filter((p) => !(p.name in constants));
  const args = parsed.params.map((p) => constants[p.name] ?? p.name);
  const call = `${parsed.name}(${args.join(', ')})`;
  const body = parsed.returns === 'void' ? `  ${call};` : `  return ${call};`;
  const signature = params.length ? params.map((p) => p.decl).join(', ') : 'void';
  return `#include <${header}>\n\n${parsed.returns} f(${signature}) {\n${body}\n}\n`;
}

/** True when the instruction's operands include an immediate. */
export const takesImmediate = (mnemonic, udbAssembly) =>
  /\b(?:imm|uimm|shamt|simm)\b/.test(operandTemplate(mnemonic, udbAssembly) ?? '');

/** A complete C file that emits one assembly line through inline asm. */
export function inlineAsmSource(line) {
  if (!line) return null;
  return `void f(void) {\n  __asm__ volatile("${line}");\n}\n`;
}

/* ── Compiler Explorer ──────────────────────────────────────────────────── */

// Pinned rather than trunk so a link opened next year shows the same result.
export const COMPILER_EXPLORER_COMPILERS = { 32: 'rv32-cclang2310', 64: 'rv64-cclang2310' };

/*
 * Extensions the pinned clang only takes as experimental, which needs the
 * exact version clang implements written into -march. The catalogue does not
 * carry clang's version numbers, so these get no link rather than one that
 * opens on an error. Re-check this list whenever the compiler above changes.
 */
export const COMPILER_EXPLORER_UNSUPPORTED = new Set([
  'zibi',
  'zicfilp',
  'zicfiss',
  'zvabd',
  'zvfofp8min',
]);

/** True when the pinned compiler accepts every extension in `march`. */
export const compilerExplorerSupports = (march) =>
  Boolean(march) &&
  !String(march)
    .toLowerCase()
    .replace(/^rv(?:32|64)[a-z]*/, '')
    .split('_')
    .some((ext) => COMPILER_EXPLORER_UNSUPPORTED.has(ext));

const base64 = (text) => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

/*
 * The compiler options a Compiler Explorer link uses for `march`.
 * -ffreestanding keeps clang on its own headers: the site's glibc sysroot is
 * built for lp64d only, so a hosted stdint.h fails for any -march without D
 * (every Zvk*, Zb* and Zk* example) on a missing gnu/stubs-lp64.h.
 */
export const compilerOptions = (march) =>
  `-O2 -ffreestanding -march=${march} -mabi=${abiForMarch(march)}`;

/**
 * A godbolt.org link that opens `source` compiled for `march`, using the
 * documented /clientstate/<base64 JSON> entry point.
 */
export function compilerExplorerUrl({ source, march }) {
  if (!source || !compilerExplorerSupports(march)) return null;
  const xlen = String(march).toLowerCase().startsWith('rv32') ? 32 : 64;
  const state = {
    sessions: [
      {
        id: 1,
        language: 'c',
        source,
        compilers: [{ id: COMPILER_EXPLORER_COMPILERS[xlen], options: compilerOptions(march) }],
      },
    ],
  };
  return `https://godbolt.org/clientstate/${encodeURIComponent(base64(JSON.stringify(state)))}`;
}

/*
 * Links into the two reference models, from src/instruction-references.json
 * (sync:references). Each is null when that model does not implement the
 * instruction yet; the commit is returned either way so the panel can say
 * which version it checked.
 */
export function referenceLinks(references, mnemonic) {
  const entry = references?.instructions?.[String(mnemonic || '').toLowerCase()] || {};
  const { sail, spike, act } = references || {};
  const blob = (model, file) => `https://github.com/${model.repo}/blob/${model.commit}/${file}`;
  return {
    sail: {
      url: sail && entry.sail ? `${blob(sail, sail.files[entry.sail[0]])}#L${entry.sail[1]}` : null,
      commit: sail?.commit?.slice(0, 7) ?? null,
    },
    spike: {
      url: spike && entry.spike ? blob(spike, `riscv/insns/${entry.spike}.h`) : null,
      commit: spike?.commit?.slice(0, 7) ?? null,
    },
    // Some tests are split into numbered parts; the link opens the first.
    act: {
      url: act && entry.act ? blob(act, `tests/${entry.act[0]}`) : null,
      commit: act?.commit?.slice(0, 7) ?? null,
      parts: entry.act?.[1] ?? 0,
    },
  };
}
