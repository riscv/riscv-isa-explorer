/**
 * Explains when an extension has no instruction encodings in the catalogue.
 *
 * Returns a short explanatory string when the extension's `instructions` map
 * is empty, or null when it has instructions (so the caller can render the
 * normal instruction list instead).
 *
 * The explanation is derived from fields the catalogue already carries —
 * `csrs`, `behavior`, and the extension id — so nothing new needs to be
 * maintained. Catalogue entries without instruction encodings mapped include:
 * umbrellas, VLEN parameters, behavioural guarantees, CSR-only extensions,
 * and draft or unmodeled sets (such as RV128I). Silence in the detail panel
 * reads as absent data; a short note clarifies that no instruction encodings
 * are currently available in this catalogue, noting known characteristics where
 * catalogue metadata provides them.
 *
 * Pure — takes the catalogue entry, returns a string. No React, no data
 * import. Callers pass the entry.
 */
export function noInstructionReason(ext) {
  if (!ext || Object.keys(ext.instructions || {}).length > 0) return null;

  const csrCount = Object.keys(ext.csrs || {}).length;
  const hasBehavior = Boolean(ext.behavior);
  const isVlenParam = /^Zvl\d+b$/.test(ext.id);

  if (isVlenParam) {
    return 'No instruction encodings are currently available in this catalogue; this is a VLEN parameter extension.';
  }
  if (csrCount > 0 && hasBehavior) {
    return 'No instruction encodings are currently available in this catalogue; this extension touches control/status registers.';
  }
  if (hasBehavior) {
    return 'No instruction encodings are currently available in this catalogue; a behavior description is available below.';
  }
  if (csrCount > 0) {
    const s = csrCount === 1 ? '' : 's';
    return `No instruction encodings are currently available in this catalogue; this extension touches ${csrCount} control/status register${s} (listed below).`;
  }
  return 'No instruction encodings are currently available in this catalogue.';
}
