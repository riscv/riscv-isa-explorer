/**
 * Explains why an extension defines no instruction encodings.
 *
 * Returns a short explanatory string when the extension's `instructions` map
 * is empty, or null when it has instructions (so the caller can render the
 * normal instruction list instead).
 *
 * The explanation is derived from fields the catalogue already carries —
 * `csrs`, `behavior`, and the extension id — so nothing new needs to be
 * maintained. Around 122 of the 223 catalogue entries define no instruction
 * encodings: umbrellas, VLEN parameters, behavioural guarantees, CSR-only
 * extensions, and PMA/memory-ordering rules. Silence in the detail panel
 * reads as absent data; a short note reads as a deliberate design.
 *
 * Pure — takes the catalogue entry, returns a string. No React, no data
 * import. Callers pass the entry.
 */
export function noInstructionReason(ext) {
  if (Object.keys(ext.instructions || {}).length > 0) return null;

  const csrCount = Object.keys(ext.csrs || {}).length;
  const hasBehavior = Boolean(ext.behavior);
  const isVlenParam = /^Zvl\d+b$/.test(ext.id);

  if (isVlenParam) {
    return 'Sets a minimum vector register length (VLEN parameter) — not an instruction set.';
  }
  if (csrCount > 0 && hasBehavior) {
    return 'Defines control/status registers and behavioral rules, not instruction encodings.';
  }
  if (hasBehavior) {
    return 'Defines behavioral rules, not instruction encodings.';
  }
  if (csrCount > 0) {
    const s = csrCount === 1 ? '' : 's';
    return `Defines ${csrCount} control/status register${s}, not instruction encodings.`;
  }
  return 'This extension defines no instruction encodings.';
}
