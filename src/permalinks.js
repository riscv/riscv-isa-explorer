/*
 * Resolving the explorer's own links: ?ext=Zba opens an extension (#94) and
 * ?insn=C.JAL an instruction (#633). Pure: the catalogue is passed in, so
 * tests/permalinks.test.mjs can walk every extension and every instruction
 * without rendering anything.
 */

export const EXTENSION_PARAM = 'ext';
export const INSTRUCTION_PARAM = 'insn';

/** "c.jal rd" -> "C.JAL": the key instructions are matched on. */
export const normalizeMnemonicKey = (value) =>
  String(value ?? '')
    .trim()
    .toUpperCase()
    .split(/\s+/)[0];

/** Case-insensitive: people type ?ext=zba as readily as ?ext=Zba. */
export function findExtensionById(pool, id) {
  const wanted = String(id ?? '')
    .trim()
    .toLowerCase();
  if (!wanted) return null;
  return pool.find((ext) => ext.id.toLowerCase() === wanted) ?? null;
}

/** The instruction as the extension lists it, or null if it does not. */
export function instructionInExtension(ext, mnemonic) {
  const wanted = normalizeMnemonicKey(mnemonic);
  if (!wanted || !ext?.instructions) return null;
  const key = Object.keys(ext.instructions).find((m) => normalizeMnemonicKey(m) === wanted);
  return key ? { mnemonic: key, ...ext.instructions[key] } : null;
}

/**
 * What a ?insn= link opens: with ?ext= too, that extension, provided it lists
 * the instruction; otherwise the first extension in `pool` that does. Null when
 * nothing resolves, so the link opens as it would without the parameter.
 */
export function resolveInstructionLink(pool, search) {
  const params = new URLSearchParams(search);
  const mnemonic = params.get(INSTRUCTION_PARAM);
  if (!normalizeMnemonicKey(mnemonic)) return null;
  const extParam = params.get(EXTENSION_PARAM);
  const candidates = extParam ? [findExtensionById(pool, extParam)] : pool;
  for (const ext of candidates) {
    const instruction = instructionInExtension(ext, mnemonic);
    if (instruction) return { ext, instruction };
  }
  return null;
}

/** The query string that opens `extId`, and `mnemonic` in it when given. */
export function permalinkSearch(extId, mnemonic = null) {
  const params = new URLSearchParams();
  params.set(EXTENSION_PARAM, extId);
  if (mnemonic) params.set(INSTRUCTION_PARAM, mnemonic);
  return `?${params}`;
}
