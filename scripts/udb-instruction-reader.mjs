/**
 * Read an instruction's name, owners, condition and encoding forms.
 *
 * Shared by the ownership report and completeness checker. Conditions are
 * preserved, not evaluated for a CPU configuration. Unsupported condition or
 * encoding shapes and YAML errors stop the caller instead of guessing.
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

export function readInstruction(text, { includeEncodings = false } = {}) {
  const document = YAML.parseDocument(text);
  // Unknown tags may return fallback values with only a warning.
  const issue = document.errors[0] ?? document.warnings[0];
  if (issue) throw issue;
  const instruction = document.toJS();
  if (!object(instruction) || instruction.kind !== 'instruction') {
    throw new Error('expected kind: instruction');
  }
  if (typeof instruction.name !== 'string' || !/^[a-z0-9.]+$/.test(instruction.name)) {
    throw new Error('missing or invalid instruction name');
  }
  const predicate = instruction.definedBy;
  const owners = instructionOwners(predicate);
  if (owners.length === 0) throw new Error('definedBy names no extension');
  const encodings = includeEncodings ? readEncodings(instruction.encoding) : [];
  return {
    name: instruction.name.toUpperCase(),
    owners,
    predicate,
    encodings,
  };
}

function bitPattern(bits) {
  const valid =
    typeof bits === 'string' &&
    (/^[01-]{14}(00|01|10)$/.test(bits) ||
      /^[01-]{30}11$/.test(bits) ||
      /^[01-]{43}11111$/.test(bits));
  if (!valid) {
    throw new Error('encoding match must be a valid 16-, 32- or 48-bit pattern');
  }
  let match = 0n;
  let mask = 0n;
  for (const bit of bits) {
    match <<= 1n;
    mask <<= 1n;
    if (bit !== '-') mask |= 1n;
    if (bit === '1') match |= 1n;
  }
  return { match, mask };
}

function bitPositions(location, matchWidth) {
  if (Number.isInteger(location)) {
    if (location < 0 || location > 31 || location >= matchWidth) {
      throw new Error(`invalid variable location: ${location}`);
    }
    return [location];
  }
  if (typeof location !== 'string') {
    throw new Error('variable location must be an integer or string');
  }
  const positions = [];
  for (const part of location.split('|')) {
    const range = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!range) throw new Error(`unsupported variable location: ${location}`);
    const high = Number(range[1]);
    const low = Number(range[2] ?? range[1]);
    if (!Number.isSafeInteger(high) || !Number.isSafeInteger(low) || low > high) {
      throw new Error(`invalid variable location: ${location}`);
    }
    if (high >= matchWidth) throw new Error('encoding variable location exceeds match width');
    for (let bit = high; bit >= low; bit -= 1) positions.push(bit);
  }
  if (new Set(positions).size !== positions.length) {
    throw new Error(`overlapping variable location bits: ${location}`);
  }
  return positions;
}

function readVariables(value, matchWidth) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('encoding variables must be a list');
  return value.map((variable) => {
    if (!object(variable) || typeof variable.name !== 'string' || !variable.name) {
      throw new Error('encoding variable must have a name');
    }
    if (Object.hasOwn(variable, '$inherits')) {
      throw new Error(
        `unresolved inherited encoding variable: ${variable.name}; resolve UDB metadata before reading`,
      );
    }
    if (
      Object.keys(variable).some(
        (key) =>
          !['name', '$child_of', 'location', 'sign_extend', 'left_shift', 'alias', 'not'].includes(
            key,
          ),
      )
    ) {
      throw new Error(`unsupported encoding variable shape: ${variable.name}`);
    }
    const positions = bitPositions(variable.location, matchWidth);
    const notValue = variable.not === undefined ? [] : variable.not;
    const not = Array.isArray(notValue) ? notValue : [notValue];
    if (not.some((item) => !Number.isSafeInteger(item) || item < 0)) {
      throw new Error(`invalid not list for encoding variable ${variable.name}`);
    }
    const limit = 2 ** positions.length;
    if (not.some((item) => item >= limit)) {
      throw new Error(`not value out of range for encoding variable ${variable.name}`);
    }
    if (new Set(not).size === limit) {
      throw new Error(`not excludes every value for encoding variable ${variable.name}`);
    }
    return { name: variable.name, positions, not };
  });
}

function readEncodingForm(value, xlen) {
  if (!object(value) || !Object.hasOwn(value, 'match')) {
    throw new Error('encoding form must contain match');
  }
  if (Object.keys(value).some((key) => !['match', 'variables'].includes(key))) {
    throw new Error('unsupported encoding form shape');
  }
  const { match, mask } = bitPattern(value.match);
  const variables = readVariables(value.variables, value.match.length);
  return { xlen, match, mask, variables };
}

function readEncodings(encoding) {
  if (encoding === undefined) return [];
  if (!object(encoding)) throw new Error('encoding must be an object');

  if (Object.hasOwn(encoding, 'match') || Object.hasOwn(encoding, 'variables')) {
    if (Object.keys(encoding).some((key) => !['match', 'variables'].includes(key))) {
      throw new Error('unsupported encoding shape');
    }
    return [readEncodingForm(encoding, null)];
  }

  const keys = Object.keys(encoding);
  if (keys.length !== 2 || !keys.includes('RV32') || !keys.includes('RV64')) {
    throw new Error('unsupported encoding shape');
  }
  return ['RV32', 'RV64'].map((xlen) => readEncodingForm(encoding[xlen], xlen));
}
