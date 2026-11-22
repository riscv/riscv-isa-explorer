/**
 * paramLog.js — the Parameters tab's activity log, undo history and backup.
 *
 * Every change made in the tab, and every error that appears or clears as a
 * result, as a list of timestamped entries. Kept in sessionStorage: it
 * survives a reload in the same tab and is gone when the tab closes, and the
 * Clear button empties it. Pure module: no React.
 */
import { formatValue } from './paramEditing.js';

export const LOG_KEY = 'riscv-param-log-v1';
export const LOG_LIMIT = 500;

/** @typedef {{t: number, kind: string, name?: string, target?: string, text: string}} LogEntry */

// sessionStorage, or null. Reading the property itself throws where storage
// is blocked (Safari with site data blocked), so it is reached through here,
// never as a bare default argument evaluated outside a try.
export function session() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export const LOG_KINDS = new Set([
  'set',
  'change',
  'clear',
  'error',
  'ok',
  'vlen',
  'import',
  'session',
  'undo',
  'redo',
  'reset',
  'ext',
  'backup',
  'restore',
]);
const TEXT_MAX = 2000;

/** An entry as this page writes it, or null: storage and backups are not trusted. */
export function cleanEntry(e, knownParams = null) {
  if (!e || typeof e !== 'object' || !LOG_KINDS.has(e.kind)) return null;
  if (typeof e.text !== 'string' || !Number.isFinite(e.t)) return null;
  const name =
    typeof e.name === 'string' && e.name.length <= 80 && (!knownParams || knownParams.has(e.name))
      ? e.name
      : null;
  return {
    t: e.t,
    kind: e.kind,
    text: e.text.slice(0, TEXT_MAX),
    ...(name ? { name } : {}),
    ...(e.target === '#vlen' ? { target: e.target } : {}),
  };
}

export function loadLog(storage = session()) {
  try {
    const raw = storage?.getItem(LOG_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed
          .map((e) => cleanEntry(e))
          .filter(Boolean)
          .slice(-LOG_LIMIT)
      : [];
  } catch {
    return [];
  }
}

export function saveLog(entries, storage = session()) {
  try {
    storage?.setItem(LOG_KEY, JSON.stringify(entries.slice(-LOG_LIMIT)));
  } catch {
    // Storage blocked or full: the log still works for this page.
  }
}

export function clearLog(storage = session()) {
  try {
    storage?.removeItem(LOG_KEY);
  } catch {
    // Nothing stored, nothing to clear.
  }
}

const show = (stored) => {
  const v = formatValue(stored);
  return Array.isArray(stored) ? `[${v}]` : v;
};

/** The entry for a value change: set, change or clear. */
export function valueEntry(name, before, after, t = Date.now()) {
  if (after === null || after === undefined) {
    return { t, kind: 'clear', name, text: `${name} (was ${show(before)})` };
  }
  if (before === null || before === undefined) {
    return { t, kind: 'set', name, text: `${name} = ${show(after)}` };
  }
  return { t, kind: 'change', name, text: `${name} ${show(before)} → ${show(after)}` };
}

/** name -> first error, for the parameters a state reports as invalid. */
export function errorMap(states) {
  const out = {};
  for (const p of states?.params ?? []) if (p.errors.length) out[p.name] = p.errors[0];
  return out;
}

/** Entries for errors that appeared, changed or cleared between two states. */
export function errorEntries(before, after, t = Date.now()) {
  const out = [];
  for (const [name, error] of Object.entries(after)) {
    if (before[name] !== error) out.push({ t, kind: 'error', name, text: `${name}: ${error}` });
  }
  for (const name of Object.keys(before)) {
    if (!(name in after)) out.push({ t, kind: 'ok', name, text: `${name} is valid now` });
  }
  return out;
}

/**
 * The log in groups, one per action, newest group first: an action (set,
 * change, clear, vlen, reset, undo, redo, import, session) and the error and
 * ok lines it caused, in the order they happened.
 */
export function logGroups(entries) {
  const groups = [];
  for (const e of entries) {
    const consequence = e.kind === 'error' || e.kind === 'ok';
    if (consequence && groups.length) groups[groups.length - 1].push(e);
    else groups.push([e]);
  }
  return groups.reverse();
}

const time = (t) => new Date(t).toTimeString().slice(0, 8);

/** The log as plain text, for Copy: oldest first, as a log file reads. */
export function logText(entries) {
  return entries.map((e) => `${time(e.t)}  ${e.kind.padEnd(6)}  ${e.text}`).join('\n');
}

export { time as logTime };

// Local date and time, with the zone offset: a file outlives the session, so
// each line carries its full date, and the header says which zone that is.
const pad = (n) => String(n).padStart(2, '0');
const localStamp = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const zone = (d) => {
  const m = -d.getTimezoneOffset();
  return `UTC${m >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(m) / 60))}:${pad(Math.abs(m) % 60)}`;
};

/** The log as a file to download: a header, then the entries, oldest first. */
export function logFile(entries, now = new Date()) {
  const lines = [
    '# RISC-V ISA Explorer: parameter activity log',
    `# exported ${localStamp(now)} (${zone(now)}), ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`,
    '',
    ...entries.map((e) => `${localStamp(e.t)}  ${e.kind.padEnd(7)} ${e.text}`),
  ];
  return {
    filename: `riscv-parameter-log-${localStamp(now).slice(0, 10)}.txt`,
    text: `${lines.join('\n')}\n`,
  };
}

// ---------------------------------------------------------------------------
// What the Parameters tab last saw, so a return after extension changes made
// elsewhere can be explained in one line.
// ---------------------------------------------------------------------------

export const SEEN_KEY = 'riscv-param-seen-v1';

export function saveSeen(ids, states, storage = session()) {
  try {
    storage?.setItem(
      SEEN_KEY,
      JSON.stringify({
        ids: [...ids].sort(),
        required: (states?.params ?? []).filter((p) => p.scope === true).map((p) => p.name),
        errors: errorMap(states),
      }),
    );
  } catch {
    // Storage blocked: the next visit just has nothing to compare with.
  }
}

export function loadSeen(storage = session()) {
  try {
    const seen = JSON.parse(storage?.getItem(SEEN_KEY) ?? 'null');
    return seen && Array.isArray(seen.ids) ? seen : null;
  } catch {
    return null;
  }
}

/**
 * One line for extension changes since the tab last looked, or null when the
 * extensions are the same: "+Sv39 +H −Zihpm · 52 parameters added, 1 removed
 * · 1 now invalid".
 */
export function extensionDiff(seen, ids, states) {
  const before = new Set(seen.ids);
  const after = new Set(ids);
  const added = [...after].filter((id) => !before.has(id)).sort();
  const removed = [...before].filter((id) => !after.has(id)).sort();
  if (!added.length && !removed.length) return null;
  const was = new Set(seen.required ?? []);
  const now = (states?.params ?? []).filter((p) => p.scope === true).map((p) => p.name);
  const nowSet = new Set(now);
  const paramsAdded = now.filter((n) => !was.has(n)).length;
  const paramsRemoved = [...was].filter((n) => !nowSet.has(n)).length;
  const newlyInvalid = Object.keys(errorMap(states)).filter(
    (n) => !(n in (seen.errors ?? {})),
  ).length;
  const exts = [...added.map((id) => `+${id}`), ...removed.map((id) => `−${id}`)].join(' ');
  const parts = [exts];
  if (paramsAdded || paramsRemoved) {
    parts.push(
      [
        paramsAdded && `${paramsAdded} parameter${paramsAdded === 1 ? '' : 's'} added`,
        paramsRemoved && `${paramsRemoved} removed`,
      ]
        .filter(Boolean)
        .join(', '),
    );
  }
  if (newlyInvalid) parts.push(`${newlyInvalid} now invalid`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Undo / redo: the last 30 moves, kept with the log for the session.
// A move is {kind: 'param', name, before, after}, {kind: 'vlen', before,
// after} or {kind: 'reset', before: {name: value}}.
// ---------------------------------------------------------------------------

export const HISTORY_KEY = 'riscv-param-history-v1';
export const HISTORY_LIMIT = 30;

export function loadHistory(storage = session()) {
  try {
    const h = JSON.parse(storage?.getItem(HISTORY_KEY) ?? 'null');
    if (h && Array.isArray(h.past) && Array.isArray(h.future)) {
      // Only moves this page writes; a damaged entry is dropped, not replayed.
      const move = (m) =>
        m &&
        ((m.kind === 'param' && typeof m.name === 'string') ||
          m.kind === 'vlen' ||
          (m.kind === 'reset' && m.before && typeof m.before === 'object') ||
          (m.kind === 'config' &&
            Array.isArray(m.before?.ids) &&
            Array.isArray(m.after?.ids) &&
            m.before.values &&
            m.after.values));
      return {
        past: h.past.filter(move).slice(-HISTORY_LIMIT),
        future: h.future.filter(move).slice(0, HISTORY_LIMIT),
      };
    }
  } catch {
    // Fall through to an empty history.
  }
  return { past: [], future: [] };
}

export function saveHistory(history, storage = session()) {
  try {
    storage?.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {
    // Storage blocked: undo still works for this page.
  }
}

/** A new move: kept (the oldest beyond 30 dropped), and the redo path discarded. */
export function pushMove(history, move) {
  return { past: [...history.past, move].slice(-HISTORY_LIMIT), future: [] };
}

/** @returns {{move: object|null, history: object}} the move to reverse */
export function undoMove(history) {
  if (!history.past.length) return { move: null, history };
  const move = history.past[history.past.length - 1];
  return {
    move,
    history: { past: history.past.slice(0, -1), future: [move, ...history.future] },
  };
}

/** @returns {{move: object|null, history: object}} the move to apply again */
export function redoMove(history) {
  if (!history.future.length) return { move: null, history };
  const [move, ...future] = history.future;
  return { move, history: { past: [...history.past, move], future } };
}

// ---------------------------------------------------------------------------
// Backup: the configuration, its parameter values and the log in one JSON
// file, to keep or share, and restore later.
// ---------------------------------------------------------------------------

export const BACKUP_FORMAT = 'riscv-isa-explorer-parameters';
export const BACKUP_VERSION = 1;

/** The backup file: values in the builder's stored form (64-bit as {$int}). */
export function backupFile({ ids, values, entries }, now = new Date()) {
  const doc = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exported: now.toISOString(),
    extensions: [...ids].sort(),
    parameters: values ?? {},
    log: entries ?? [],
  };
  const pad = (n) => String(n).padStart(2, '0');
  // Date and time, so several backups on one day do not overwrite each other.
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return { filename: `riscv-parameters-${stamp}.json`, text: `${JSON.stringify(doc, null, 2)}\n` };
}

// Limits for reading a backup someone else made: it is untrusted input.
export const BACKUP_MAX_BYTES = 2 * 1024 * 1024;

// A parameter value as the builder stores it: a boolean, a finite number, a
// short string, {$int: "digits"}, or a list of those. Anything else (objects,
// prototypes, deep nesting) is not a value this page wrote.
function storedValue(v, depth = 0) {
  if (typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') return v.length <= 256;
  if (Array.isArray(v)) return depth === 0 && v.length <= 128 && v.every((x) => storedValue(x, 1));
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    return (
      keys.length === 1 &&
      keys[0] === '$int' &&
      typeof v.$int === 'string' &&
      /^-?\d{1,40}$/.test(v.$int)
    );
  }
  return false;
}

/**
 * Read a backup back. Unknown extensions and parameters, and values this page
 * could not have written, are dropped and named rather than refusing the file.
 *
 * @param {string} text
 * @param {{knownIds: Set<string>, knownParams: Set<string>}} known
 * @returns {{ok: true, ids: string[], values: object, log: object[], dropped: string[], exported: string|null}
 *   | {ok: false, error: string}}
 */
export function readBackup(text, { knownIds, knownParams, bases = null }) {
  if (typeof text !== 'string' || text.length > BACKUP_MAX_BYTES) {
    return { ok: false, error: 'This file is too large to be a parameter backup.' };
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, error: 'This is not a parameter backup: the file is not JSON.' };
  }
  if (!doc || typeof doc !== 'object' || doc.format !== BACKUP_FORMAT) {
    return { ok: false, error: 'This is not a parameter backup from the RISC-V ISA Explorer.' };
  }
  if (doc.version !== BACKUP_VERSION) {
    return {
      ok: false,
      error: `This backup is version ${String(doc.version).slice(0, 10)}; this page reads version ${BACKUP_VERSION}.`,
    };
  }
  const dropped = [];
  const ids = [];
  for (const id of Array.isArray(doc.extensions) ? doc.extensions : []) {
    if (typeof id === 'string' && knownIds.has(id)) {
      if (!ids.includes(id)) ids.push(id);
    } else dropped.push(`extension ${String(id).slice(0, 40)}`);
  }
  const values = {};
  const params =
    doc.parameters && typeof doc.parameters === 'object' && !Array.isArray(doc.parameters)
      ? doc.parameters
      : {};
  for (const [name, value] of Object.entries(params)) {
    if (!knownParams.has(name)) dropped.push(`parameter ${name.slice(0, 60)}`);
    else if (!storedValue(value)) dropped.push(`the value of ${name}`);
    else values[name] = value;
  }
  const log = (Array.isArray(doc.log) ? doc.log : [])
    .map((e) => cleanEntry(e, knownParams))
    .filter(Boolean)
    .slice(-LOG_LIMIT);
  if (!ids.length)
    return { ok: false, error: 'This backup has no extensions the catalogue knows.' };
  if (bases) {
    const found = ids.filter((id) => bases.has(id));
    if (found.length === 0) {
      return { ok: false, error: 'This backup has no base ISA (RV32I, RV64I, ...).' };
    }
    if (found.length > 1) {
      return { ok: false, error: `This backup has more than one base ISA (${found.join(', ')}).` };
    }
  }
  return {
    ok: true,
    ids,
    values,
    log,
    dropped,
    exported: typeof doc.exported === 'string' ? doc.exported.slice(0, 40) : null,
  };
}
