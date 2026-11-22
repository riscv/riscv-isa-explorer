/**
 * askAi.js — the question the Ask AI chip asks about a selected parameter,
 * the same way it asks about a selected extension or instruction.
 *
 * kapa takes one thing: a query to pre-fill, sent or not. So "aware of the
 * parameters" means asking well about them:
 *
 *  - Name the parameter the way the specifications do. kapa retrieves over the
 *    ISA manual and friends, where `mstatus.FS legal values` appears and
 *    `MSTATUS_FS_LEGAL_VALUES` (riscv-unified-db's id) mostly does not; the id
 *    still goes in, in parentheses, for the UDB pages kapa also indexes.
 *  - One intent per question (see the note on askAiContext in
 *    risc_v_visualizer.jsx): what it controls, or why a rule fails, not both.
 *  - Say "RISC-V": the model has read every other architecture too.
 */
import { parameterDefinition } from './isaParams.js';

// UDB's long names use Markdown code spans; kapa wants plain text.
const plain = (text) =>
  String(text ?? '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

/** How a parameter is named in a question: its long name, else its id. */
export function paramLabel(name) {
  const long = plain(parameterDefinition(name)?.long_name);
  return long && long.toLowerCase() !== name.toLowerCase() ? long : name;
}

/**
 * The question a row's Ask AI button sends.
 * @param {string} name a UDB parameter
 * @param {{error?: string}} [state] the row's first error, when it has one
 */
export function paramQuestion(name, { error } = {}) {
  const label = paramLabel(name);
  const ref = label === name ? name : `the ${label} parameter (${name} in riscv-unified-db)`;
  if (error) {
    const rule = plain(error).replace(/\.$/, '');
    const subject = label === name ? name : `the ${label} parameter (${name})`;
    return `In RISC-V, why must ${subject} satisfy this rule: ${rule}?`;
  }
  return `In RISC-V, what does ${ref} control?`;
}
