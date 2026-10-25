/**
 * Read an instruction's name, candidate owners and full definedBy condition.
 *
 * Shared by the ownership report and completeness checker. Conditions are
 * preserved, not evaluated for a CPU configuration. Unsupported conditions and
 * YAML errors stop the caller instead of falling back to a directory owner.
 */
import YAML from 'yaml';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Collect each positive extension name once, in declaration order.
 * For example, A AND B lists both names, but neither alone is enough to provide
 * the instruction. A AND NOT B lists only A. Unsupported conditions throw rather
 * than returning an incomplete owner list.
 */
export function instructionOwners(predicate) {
  const owners = new Set();
  const visit = (node, extension = false, negative = false) => {
    if (!object(node)) throw new Error('expected a definedBy condition object');
    const keys = Object.keys(node);
    if (extension && Object.hasOwn(node, 'name')) {
      if (
        typeof node.name !== 'string' ||
        !node.name ||
        /\s/.test(node.name) ||
        keys.some((key) => !['name', 'version'].includes(key)) ||
        (Object.hasOwn(node, 'version') &&
          typeof node.version !== 'string' &&
          !(Array.isArray(node.version) && node.version.every((v) => typeof v === 'string')))
      ) {
        throw new Error('unsupported extension requirement');
      }
      if (!negative) owners.add(node.name);
      return;
    }
    if (keys.length !== 1) throw new Error('expected exactly one condition operator');
    const key = keys[0];
    const value = node[key];
    if (['anyOf', 'allOf', 'oneOf', 'noneOf'].includes(key)) {
      if (!Array.isArray(value) || value.length < 2) {
        throw new Error(`${key} requires at least two conditions`);
      }
      for (const child of value) {
        visit(child, extension, key === 'noneOf' ? !negative : negative);
      }
    } else if (key === 'not') {
      visit(value, extension, !negative);
    } else if (key === 'extension' && !extension) {
      visit(value, true, negative);
    } else if (key === 'xlen' && !extension && [32, 64].includes(value)) {
      // A runtime register-width condition does not name an extension owner.
    } else {
      throw new Error(`unsupported definedBy condition: ${key}`);
    }
  };
  visit(predicate);
  return [...owners];
}

export function readInstruction(text) {
  const document = YAML.parseDocument(text);
  // Unknown tags may return fallback values with only a warning.
  const issue = document.errors[0] ?? document.warnings[0];
  if (issue) throw issue;
  const instruction = document.toJS();
  if (!object(instruction) || instruction.kind !== 'instruction') {
    throw new Error('expected kind: instruction');
  }
  if (typeof instruction.name !== 'string' || !instruction.name || /\s/.test(instruction.name)) {
    throw new Error('missing or invalid instruction name');
  }
  const predicate = instruction.definedBy;
  const owners = instructionOwners(predicate);
  if (owners.length === 0) throw new Error('definedBy names no extension');
  return {
    name: instruction.name.toUpperCase(),
    owners,
    predicate,
  };
}
