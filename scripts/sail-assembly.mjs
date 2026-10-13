/**
 * Finds where sail-riscv defines each instruction, from the model's own
 * assembly mappings.
 *
 * Sail rarely spells a mnemonic out in full. A clause such as
 *
 *   mapping clause assembly = LOAD(imm, rs1, rd, is_unsigned, width)
 *     <-> "l" ^ width_mnemonic(width) ^ maybe_u(is_unsigned) ^ spc() ^ ...
 *
 * covers lb, lh, lw, ld, lbu, lhu and lwu. So each clause's mnemonic part (the
 * pieces before the first spc()) is compiled into a regular expression, with
 * every helper mapping replaced by the strings it can produce, and catalogue
 * mnemonics are matched against those. The constructor (LOAD) then names the
 * execute clause, and when the helper is an enum mapping (MVV_VAADD <->
 * "vaadd.vv") the enum names the match arm inside it, which is the line the
 * link points to.
 *
 * Pure: takes file contents, touches no disk, so the tests can feed it text.
 */

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const stripComment = (line) => line.replace(/\/\/.*$/, '');

/* Splits `a ^ f(b ^ c) ^ "d"` on the top-level carets. */
function splitConcat(expression) {
  const parts = [];
  let depth = 0;
  let inString = false;
  let current = '';
  for (let i = 0; i < expression.length; i++) {
    const ch = expression[i];
    if (inString) {
      current += ch;
      if (ch === '\\') current += expression[++i] ?? '';
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === '^' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/*
 * Every string-valued mapping, as name -> [{ token, value }]. Covers both the
 * block form (`mapping width_mnemonic : word_width <-> string = { ... }`) and
 * the scattered one (`mapping clause name = A <-> "x"`). `token` is the other
 * side of the entry when it is an enum constant, used to find match arms.
 */
export function parseStringMappings(files) {
  const mappings = new Map();
  const add = (name, left, right) => {
    const literal = [left, right].map((side) => side.trim().match(/^"((?:[^"\\]|\\.)*)"$/));
    const index = literal.findIndex(Boolean);
    if (index < 0) return;
    const other = (index === 0 ? right : left).trim();
    const entry = {
      token: /^[A-Z][A-Z0-9_]+$/.test(other) ? other : null,
      value: literal[index][1],
    };
    if (!mappings.has(name)) mappings.set(name, []);
    mappings.get(name).push(entry);
  };

  for (const text of Object.values(files)) {
    const lines = text.split('\n').map(stripComment);
    for (let i = 0; i < lines.length; i++) {
      const block = lines[i].match(/^(?:private\s+)?mapping\s+(\w+)\s*:.*=\s*\{\s*$/);
      if (block) {
        for (i++; i < lines.length && !/^\s*\}/.test(lines[i]); i++) {
          const entry = lines[i].match(/^\s*(.+?)\s*<->\s*(.+?)\s*,?\s*$/);
          if (entry) add(block[1], entry[1], entry[2]);
        }
        continue;
      }
      const scattered = lines[i].match(
        /^(?:private\s+)?mapping\s+clause\s+(\w+)\s*=\s*(.+?)\s*<->\s*(.+?)\s*$/,
      );
      if (scattered && scattered[1] !== 'assembly' && scattered[1] !== 'encdec') {
        add(scattered[1], scattered[2], scattered[3]);
      }
    }
  }
  return mappings;
}

/*
 * Every `mapping clause assembly`, with its file, line, constructor and the
 * full right-hand side (which may run over several lines). Both forms count:
 * `CTOR(...) <-> expr` and the one-way `forwards CTOR(...) => expr when ...`
 * used for aliases such as vabs.v; `backwards` clauses only parse text.
 */
export function parseAssemblyClauses(files) {
  const clauses = [];
  for (const [file, text] of Object.entries(files)) {
    const lines = text.split('\n').map(stripComment);
    for (let i = 0; i < lines.length; i++) {
      if (!/^mapping\s+clause\s+assembly\s*=/.test(lines[i])) continue;
      let body = lines[i];
      for (let j = i + 1; j < lines.length && /^(\s+\S|<->)/.test(lines[j]); j++) {
        body += ` ${lines[j]}`;
      }
      body = body.replace(/^mapping\s+clause\s+assembly\s*=\s*/, '');
      const forwards = body.match(/^forwards\s+/);
      if (/^backwards\b/.test(body)) continue;
      if (forwards) body = body.slice(forwards[0].length);
      const arrowText = forwards ? '=>' : '<->';
      const arrow = body.indexOf(arrowText);
      const head = body.match(/^(\w+)/);
      if (arrow < 0 || !head) continue;
      clauses.push({
        file,
        line: i + 1,
        constructor: head[1],
        constants: [...body.slice(0, arrow).matchAll(/\b([A-Z][A-Z0-9_]+)\b/g)]
          .map((m) => m[1])
          .filter((name) => name !== head[1]),
        expression: body
          .slice(arrow + arrowText.length)
          .replace(/\swhen\s.*$/, '')
          .trim(),
      });
    }
  }
  return clauses;
}

/*
 * Compiles a clause's mnemonic part into { regex, helpers, literalLength }, or
 * null when it calls a helper the parser cannot expand. Such a clause is left
 * out rather than matched with a wildcard: a wildcard clause matches mnemonics
 * from other extensions and links them to the wrong code.
 */
export function compileMnemonic(expression, mappings) {
  let source = '';
  let literalLength = 0;
  const helpers = [];
  for (const part of splitConcat(expression)) {
    const literal = part.match(/^"((?:[^"\\]|\\.)*)"$/);
    if (literal) {
      const [word, ...rest] = literal[1].split(' ');
      source += escapeRegExp(word);
      literalLength += word.length;
      if (rest.length) break;
      continue;
    }
    const call = part.match(/^(\w+)\s*\(/);
    if (!call || /^(spc|sep|opt_spc)$/.test(call[1])) break;
    if (/^dec_bits/.test(call[1])) {
      source += '(\\d+)';
      helpers.push(null);
    } else if (mappings.has(call[1])) {
      const values = [...new Set(mappings.get(call[1]).map((e) => e.value.split(' ')[0]))];
      source += `(${values
        .sort((a, b) => b.length - a.length)
        .map(escapeRegExp)
        .join('|')})`;
      helpers.push(call[1]);
    } else {
      return null;
    }
  }
  if (!source) return null;
  return { regex: new RegExp(`^${source}$`), helpers, literalLength };
}

/*
 * The execute clauses, by constructor: [{ file, line, end, head }] where end
 * is the clause's closing line, so match arms can be searched inside it. A
 * constructor can have several, one per operation constant in its head
 * (`execute F_UN_RM_FF_TYPE_D(rs1, rm, rd, FCVT_S_D)`).
 */
export function parseExecuteClauses(files) {
  const clauses = new Map();
  for (const [file, text] of Object.entries(files)) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const head = lines[i].match(/^function\s+clause\s+execute\s*\(?\s*(\w+)/);
      if (!head) continue;
      let end = i;
      while (end + 1 < lines.length && !/^\S/.test(lines[end + 1])) end++;
      if (end + 1 < lines.length && /^\}/.test(lines[end + 1])) end++;
      if (!clauses.has(head[1])) clauses.set(head[1], []);
      clauses.get(head[1]).push({ file, line: i + 1, end: end + 1, head: lines[i] });
    }
  }
  return clauses;
}

/*
 * Builds the lookup: mnemonic -> { file, line } or null. When several clauses
 * match, the one with more literal text wins. `locate.skipped` names the
 * constructors whose clause could not be compiled, for the sync to report.
 */
export function sailLocator(files) {
  const mappings = parseStringMappings(files);
  const executes = parseExecuteClauses(files);
  const parsed = parseAssemblyClauses(files).map((clause) => ({
    ...clause,
    pattern: compileMnemonic(clause.expression, mappings),
  }));
  const compiled = parsed.filter((clause) => clause.pattern);
  const fileLines = Object.fromEntries(
    Object.entries(files).map(([file, text]) => [file, text.split('\n')]),
  );

  const armLine = (execute, tokens) => {
    const lines = fileLines[execute.file];
    for (const token of tokens) {
      const arm = new RegExp(`^\\s*${escapeRegExp(token)}\\s*(?:=>|\\|)`);
      for (let i = execute.line; i < execute.end; i++) {
        if (arm.test(stripComment(lines[i]))) return i + 1;
      }
    }
    return null;
  };

  const locate = (mnemonic) => {
    let best = null;
    for (const clause of compiled) {
      const match = clause.pattern.regex.exec(mnemonic);
      if (!match || (best && best.clause.pattern.literalLength >= clause.pattern.literalLength))
        continue;
      best = { clause, match };
    }
    if (!best) return null;

    const { clause, match } = best;
    const tokens = [...clause.constants];
    clause.pattern.helpers.forEach((helper, index) => {
      if (!helper) return;
      const value = match[index + 1];
      for (const entry of mappings.get(helper)) {
        if (entry.token && entry.value.split(' ')[0] === value) tokens.unshift(entry.token);
      }
    });
    const candidates = executes.get(clause.constructor);
    if (!candidates) return { file: clause.file, line: clause.line };
    const named = (execute) =>
      tokens.some((token) => new RegExp(`\\b${escapeRegExp(token)}\\b`).test(execute.head));
    const execute = candidates.find(named) ?? candidates[0];
    if (candidates.length > 1 && named(execute)) return { file: execute.file, line: execute.line };
    for (const each of [execute, ...candidates]) {
      const arm = armLine(each, tokens);
      if (arm) return { file: each.file, line: arm };
    }
    return { file: execute.file, line: execute.line };
  };
  locate.skipped = parsed.filter((clause) => !clause.pattern).map((clause) => clause.constructor);
  return locate;
}
