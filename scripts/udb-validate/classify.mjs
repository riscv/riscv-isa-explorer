/**
 * Sort `udb validate cfg` reasons into the export's fault and the filled
 * values' fault (#589).
 *
 * STRUCTURAL  something the export decides: a parameter or extension missing,
 *             undefined, unknown, or a requirement between extensions unmet.
 *             Also a UDB crash. These fail the check.
 * VALUE       an IDL rule on the values fill.mjs chose ("with F,
 *             MSTATUS_FS_LEGAL_VALUES includes 3"). The export leaves values
 *             to the user, so these are reported, never failed on.
 *
 * Unknown reason shapes count as structural: a new kind of failure should be
 * looked at, not waved through.
 */

const VALUE_REASONS = [/^Parameter requirements not met/];
const STRUCTURAL_REASONS = [
  /^Parameter is required but missing/,
  /^Parameter is not defined by this config/,
  /^Parameter has no definition/,
  /^Parameter value violates the schema/,
  /is not a known extension/,
  /is not a known version/,
];

// A failing condition that tests a parameter value: `(NAME==true)`,
// `(HPM_COUNTER_EN[3]==true)`, `$array_includes?(SXLEN, 64)`. An extension
// test reads `D>=0`, with no parenthesis inside the backticks.
// `xlen=64` depends on the *XLEN parameters (a hart offering both widths has no
// single xlen), and "Condition not yet determined" means UDB could not decide
// from the values given: both are about values, not the extension list.
const VALUE_TERM =
  /`\(|\$array_|`xlen=|Condition not yet determined|`[A-Z][A-Z0-9_]+(?:\[\d+\])?\s*(?:==|!=|>=|<=|>|<)/;

/** @returns {'structural'|'value'} */
export function classifyReason(reason) {
  const text = String(reason);
  const head = text.split('\n')[0];
  if (VALUE_REASONS.some((re) => re.test(head))) return 'value';
  if (/^Extension requirement is unmet/.test(head)) {
    return VALUE_TERM.test(text) ? 'value' : 'structural';
  }
  if (STRUCTURAL_REASONS.some((re) => re.test(head))) return 'structural';
  return 'structural';
}

/** The first line of a reason, the stable part to compare against a baseline. */
export const reasonKey = (reason) => String(reason).split('\n')[0].trim();

/**
 * @param {{name: string, valid: boolean, reasons: string[], error?: string}[]} results
 * @param {Record<string, string[]>} baseline accepted structural failures, by
 *   config name, as reason keys
 */
export function compareWithBaseline(results, baseline = {}) {
  const fresh = []; // { name, reason }
  const stillKnown = [];
  const fixed = []; // baseline entries that no longer fail
  let valueFailures = 0;
  const seen = new Set();
  for (const r of results) {
    seen.add(r.name);
    const structural = [];
    if (r.error) structural.push(`UDB raised ${r.error}`);
    for (const reason of r.reasons ?? []) {
      if (classifyReason(reason) === 'value') valueFailures += 1;
      else structural.push(reasonKey(reason));
    }
    const accepted = new Set(baseline[r.name] ?? []);
    for (const key of structural) {
      if (accepted.has(key)) stillKnown.push({ name: r.name, reason: key });
      else fresh.push({ name: r.name, reason: key });
    }
    for (const key of accepted) {
      if (!structural.includes(key)) fixed.push({ name: r.name, reason: key });
    }
  }
  return { fresh, stillKnown, fixed, valueFailures, checked: seen.size };
}
