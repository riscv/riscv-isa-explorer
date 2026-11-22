/**
 * paramRules.js — UDB's parameter rules, evaluated in the browser (#596).
 *
 * 70 of UDB's parameters carry `requirements`: 18 written as data (if/then
 * trees, the same shape as definedBy) and 52 as IDL code. This module evaluates
 * both. The IDL side is a parser for the subset UDB's parameter rules use:
 *
 *   statements   `A -> B;`  `-> B;` (B must hold)  `B;`
 *   loops        `for (U32 i = 0; i < 32; i++) { ... }`, unrolled
 *   operators    -> || && ! == != < <= > >=, parentheses
 *   terms        NAME, NAME[i], NAME[hi:lo], true, false, "string",
 *                123, 0xff_ff, 32'hffff (sized literals, as BigInt)
 *   functions    implemented?(ExtensionName::X), $array_includes?(NAME, v),
 *                $array_size(NAME), xlen()
 *
 * Anything else throws at parse time, and tests/param-rules.test.mjs parses
 * every rule in src/isa-params.json, so a new construct upstream fails the tests
 * rather than being silently skipped.
 *
 * Evaluation is three-valued: true, false, or null when it depends on a value
 * not set yet (or on xlen(), which a configuration does not fix). `&&`, `||` and
 * `->` short-circuit on a decided side, so `false && unknown` is false. A rule
 * is broken only when it evaluates to false; unknown is "not decided yet".
 *
 * Pure module. No React, no data import: callers pass the definitions.
 */

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

const TOKEN = [
  ['ws', /^(?:\s+|#[^\n]*)/],
  ['sized', /^\d+'[hdb][0-9a-fA-F_]+/],
  ['num', /^(?:0x[0-9a-fA-F_]+|\d[\d_]*)/],
  ['str', /^"[^"]*"/],
  ['fn', /^(?:\$array_includes\?|\$array_size|implemented\?|xlen)/],
  ['ext', /^ExtensionName::[A-Za-z0-9_]+/],
  ['kw', /^(?:for|U32|true|false)\b/],
  ['id', /^[A-Za-z_][A-Za-z0-9_]*/],
  ['op', /^(?:->|\|\||&&|==|!=|<=|>=|\+\+|[<>!()[\]{};:,=])/],
];

function lex(text) {
  const out = [];
  let rest = text;
  while (rest.length) {
    let matched = false;
    for (const [type, re] of TOKEN) {
      const m = re.exec(rest);
      if (!m) continue;
      if (type !== 'ws') out.push({ type, value: m[0] });
      rest = rest.slice(m[0].length);
      matched = true;
      break;
    }
    if (!matched) throw new Error(`IDL: unexpected "${rest.slice(0, 20)}"`);
  }
  return out;
}

function literal(token) {
  const v = token.value.replace(/_/g, '');
  if (token.type === 'sized') {
    const [, base, digits] = /^\d+'([hdb])(.+)$/.exec(v);
    const prefix = { h: '0x', d: '', b: '0b' }[base];
    return BigInt(prefix + digits);
  }
  return BigInt(v);
}

// ---------------------------------------------------------------------------
// Parser: statements -> AST
// ---------------------------------------------------------------------------

/** @returns {object[]} a list of expressions, each of which must hold */
export function parseIdl(text) {
  const tokens = lex(text);
  let i = 0;
  const peek = (value) => tokens[i] && (value === undefined || tokens[i].value === value);
  const next = () => tokens[i++];
  const expect = (value) => {
    const t = next();
    if (!t || t.value !== value) throw new Error(`IDL: expected "${value}", got "${t?.value}"`);
    return t;
  };

  const primary = () => {
    const t = next();
    if (!t) throw new Error('IDL: unexpected end');
    if (t.value === '(') {
      const e = implication();
      expect(')');
      return e;
    }
    if (t.value === '!') return { op: '!', arg: primary() };
    if (t.value === 'true' || t.value === 'false') return { lit: t.value === 'true' };
    if (t.type === 'num' || t.type === 'sized') return { lit: literal(t) };
    if (t.type === 'str') return { lit: t.value.slice(1, -1) };
    if (t.type === 'fn') {
      expect('(');
      let node;
      if (t.value === 'implemented?') node = { ext: next().value.replace('ExtensionName::', '') };
      else if (t.value === '$array_includes?') {
        const param = next().value;
        expect(',');
        node = { includes: param, value: implication() };
      } else if (t.value === '$array_size') node = { size: next().value };
      else node = { xlen: true };
      expect(')');
      return node;
    }
    if (t.type === 'id') {
      if (peek('[')) {
        next();
        const index = implication();
        if (peek(':')) {
          next();
          const lo = implication();
          expect(']');
          return { param: t.value, hi: index, lo };
        }
        expect(']');
        return { param: t.value, index };
      }
      return { param: t.value };
    }
    throw new Error(`IDL: unexpected "${t.value}"`);
  };
  const comparison = () => {
    const left = primary();
    if (tokens[i] && ['==', '!=', '<', '<=', '>', '>='].includes(tokens[i].value)) {
      const op = next().value;
      return { op, left, right: primary() };
    }
    return left;
  };
  const conj = () => {
    let e = comparison();
    while (peek('&&')) {
      next();
      e = { op: '&&', left: e, right: comparison() };
    }
    return e;
  };
  const disj = () => {
    let e = conj();
    while (peek('||')) {
      next();
      e = { op: '||', left: e, right: conj() };
    }
    return e;
  };
  function implication() {
    const left = disj();
    if (peek('->')) {
      next();
      return { op: '->', left, right: implication() };
    }
    return left;
  }

  // A loop variable is substituted into its body, which is then parsed as
  // statements once per value: `for (U32 i = 3; i < 32; i++)` unrolls to 29.
  const substitute = (node, name, value) => {
    if (!node || typeof node !== 'object') return node;
    if (node.param === name && Object.keys(node).length === 1) return { lit: BigInt(value) };
    const out = Array.isArray(node) ? [] : {};
    for (const [k, v] of Object.entries(node)) out[k] = substitute(v, name, value);
    return out;
  };

  const statements = () => {
    const out = [];
    while (i < tokens.length && !peek('}')) {
      if (peek('for')) {
        next();
        expect('(');
        expect('U32');
        const name = next().value;
        expect('=');
        const from = Number(literal(next()));
        expect(';');
        if (next().value !== name) throw new Error('IDL: loop condition must test its variable');
        const cmp = next().value;
        const to = Number(literal(next())) + (cmp === '<=' ? 1 : 0);
        if (cmp !== '<' && cmp !== '<=') throw new Error(`IDL: loop bound "${cmp}"`);
        expect(';');
        next(); // the variable
        expect('++');
        expect(')');
        expect('{');
        const body = statements();
        expect('}');
        for (let v = from; v < to; v++) out.push(...body.map((s) => substitute(s, name, v)));
        continue;
      }
      if (peek('->')) {
        next();
        out.push(implication());
      } else {
        out.push(implication());
      }
      if (peek(';')) next();
    }
    return out;
  };

  const result = statements();
  if (i !== tokens.length) throw new Error(`IDL: unexpected "${tokens[i].value}"`);
  return result;
}

// ---------------------------------------------------------------------------
// Evaluation, three-valued
// ---------------------------------------------------------------------------

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const big = (v) => {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^(?:0x[0-9a-f]+|\d+)$/i.test(v)) return BigInt(v);
  return v;
};

function value(node, ctx) {
  if ('lit' in node) return node.lit;
  if (node.xlen) return null;
  if (node.ext) return ctx.extensions.has(node.ext);
  if (node.size) return has(ctx.params, node.size) ? (ctx.params[node.size] ?? []).length : null;
  if (node.includes) {
    if (!has(ctx.params, node.includes)) return null;
    const want = value(node.value, ctx);
    if (want === null) return null;
    const list = ctx.params[node.includes];
    if (!Array.isArray(list)) return null;
    return list.some((x) => (typeof want === 'bigint' ? big(x) === want : x === want));
  }
  if (node.param !== undefined) {
    if (!has(ctx.params, node.param)) return null;
    let v = ctx.params[node.param];
    if (node.index) {
      const at = value(node.index, ctx);
      return Array.isArray(v) && at !== null ? (v[Number(at)] ?? null) : null;
    }
    if (node.hi) {
      const hi = value(node.hi, ctx);
      const lo = value(node.lo, ctx);
      v = big(v);
      if (typeof v !== 'bigint' || hi === null || lo === null) return null;
      return (v >> lo) & ((1n << (hi - lo + 1n)) - 1n);
    }
    return big(v);
  }
  return evaluate(node, ctx);
}

/** @returns {true|false|null} */
export function evaluate(node, ctx) {
  switch (node.op) {
    case '!': {
      const v = evaluate(node.arg, ctx);
      return v === null ? null : !v;
    }
    case '&&': {
      const l = evaluate(node.left, ctx);
      if (l === false) return false;
      const r = evaluate(node.right, ctx);
      if (r === false) return false;
      return l === null || r === null ? null : true;
    }
    case '||': {
      const l = evaluate(node.left, ctx);
      if (l === true) return true;
      const r = evaluate(node.right, ctx);
      if (r === true) return true;
      return l === null || r === null ? null : false;
    }
    case '->': {
      const l = evaluate(node.left, ctx);
      if (l === false) return true;
      const r = evaluate(node.right, ctx);
      if (r === true) return true;
      return l === null || r === null ? null : false;
    }
    case '==':
    case '!=':
    case '<':
    case '<=':
    case '>':
    case '>=': {
      const l = value(node.left, ctx);
      const r = value(node.right, ctx);
      if (l === null || r === null) return null;
      const a = big(l);
      const b = big(r);
      switch (node.op) {
        case '==':
          return a === b;
        case '!=':
          return a !== b;
        case '<':
          return a < b;
        case '<=':
          return a <= b;
        case '>':
          return a > b;
        default:
          return a >= b;
      }
    }
    default: {
      const v = value(node, ctx);
      if (v === null || typeof v === 'boolean') return v;
      return null;
    }
  }
}

// Data rules: the same tree shape as definedBy, plus if/then.
function evaluateData(node, ctx) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) return evaluate3All(node.map((n) => evaluateData(n, ctx)));
  if (node.if) {
    const cond = evaluateData(node.if, ctx);
    if (cond === false) return true;
    const then = evaluateData(node.then, ctx);
    if (then === true) return true;
    return cond === null || then === null ? null : false;
  }
  if (node.allOf) return evaluate3All(node.allOf.map((n) => evaluateData(n, ctx)));
  if (node.anyOf) return evaluate3Any(node.anyOf.map((n) => evaluateData(n, ctx)));
  if (node.noneOf) {
    const v = evaluate3Any(node.noneOf.map((n) => evaluateData(n, ctx)));
    return v === null ? null : !v;
  }
  if (node.not) {
    const v = evaluateData(node.not, ctx);
    return v === null ? null : !v;
  }
  if (node.extension) return extensionTest(node.extension, ctx);
  if (node.param) return paramTest(node.param, ctx);
  return null;
}
const evaluate3All = (rs) => (rs.includes(false) ? false : rs.includes(null) ? null : true);
const evaluate3Any = (rs) => (rs.includes(true) ? true : rs.includes(null) ? null : false);
function extensionTest(node, ctx) {
  if (node.allOf) return evaluate3All(node.allOf.map((n) => extensionTest(n, ctx)));
  if (node.anyOf) return evaluate3Any(node.anyOf.map((n) => extensionTest(n, ctx)));
  if (node.noneOf) {
    const v = evaluate3Any(node.noneOf.map((n) => extensionTest(n, ctx)));
    return v === null ? null : !v;
  }
  return typeof node.name === 'string' ? ctx.extensions.has(node.name) : null;
}
function paramTest(node, ctx) {
  if (node.allOf) return evaluate3All(node.allOf.map((n) => paramTest(n, ctx)));
  if (node.anyOf) return evaluate3Any(node.anyOf.map((n) => paramTest(n, ctx)));
  if (typeof node.name !== 'string' || !has(ctx.params, node.name)) return null;
  let v = ctx.params[node.name];
  if (node.index !== undefined) v = Array.isArray(v) ? v[node.index] : undefined;
  // `size: true` tests the list's length: {name: MTVEC_MODES, size: true, equal: 1}.
  if (node.size) v = Array.isArray(v) ? v.length : undefined;
  if (v === undefined) return null;
  if ('equal' in node) return big(v) === big(node.equal);
  if ('notEqual' in node) return big(v) !== big(node.notEqual);
  if ('includes' in node) return Array.isArray(v) && v.some((x) => big(x) === big(node.includes));
  if ('oneOf' in node) return node.oneOf.includes(v);
  if ('greaterThan' in node) return big(v) > big(node.greaterThan);
  if ('greaterThanOrEqual' in node) return big(v) >= big(node.greaterThanOrEqual);
  if ('lessThan' in node) return big(v) < big(node.lessThan);
  if ('lessThanOrEqual' in node) return big(v) <= big(node.lessThanOrEqual);
  return null;
}

const parsed = new Map();
/** The parsed statements of a definition's IDL rule, cached. */
export function idlStatements(definition) {
  const text = definition?.requirements?.['idl()'];
  if (!text) return [];
  if (!parsed.has(text)) parsed.set(text, parseIdl(text));
  return parsed.get(text);
}

/**
 * Check one parameter's requirements.
 *
 * @param {object} definition the UDB definition (src/isa-params.json)
 * @param {{extensions: Set<string>, params: Record<string, unknown>}} ctx
 * @returns {{holds: true|false|null, reason?: string}}
 */
export function checkRequirements(definition, ctx) {
  const req = definition?.requirements;
  if (!req) return { holds: true };
  const reason = String(req.reason ?? '').trim() || undefined;
  let holds;
  if (req['idl()']) {
    holds = evaluate3All(idlStatements(definition).map((s) => evaluate(s, ctx)));
  } else {
    const { reason: _r, ...tree } = req;
    holds = evaluateData(tree, ctx);
  }
  return reason ? { holds, reason } : { holds };
}
