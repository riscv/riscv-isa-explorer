/**
 * The Parameters tab's activity log, undo history and backup
 * (src/paramLog.js), and the Ask AI question for a selected parameter
 * (src/askAi.js). The panel itself (src/ParametersView.jsx) is checked in a
 * browser; its wiring is checked here by source.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  LOG_LIMIT,
  loadLog,
  saveLog,
  clearLog,
  valueEntry,
  errorEntries,
  logGroups,
  logText,
  logFile,
  saveSeen,
  loadSeen,
  extensionDiff,
  HISTORY_LIMIT,
  loadHistory,
  saveHistory,
  pushMove,
  undoMove,
  redoMove,
  backupFile,
  readBackup,
  BACKUP_MAX_BYTES,
} from '../src/paramLog.js';
import { paramLabel, paramQuestion } from '../src/askAi.js';
import { builderParamStates } from '../src/paramEditing.js';
import { parameterNames } from '../src/isaParams.js';

// A sessionStorage stand-in, plus one that refuses every call.
const memory = () => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
};
const broken = {
  getItem() {
    throw new Error('blocked');
  },
  setItem() {
    throw new Error('blocked');
  },
  removeItem() {
    throw new Error('blocked');
  },
};

// ---------------------------------------------------------------------------
// The log
// ---------------------------------------------------------------------------

test('the log survives a reload, is capped, and blocked storage never throws', () => {
  const store = memory();
  const many = Array.from({ length: LOG_LIMIT + 20 }, (_, i) => ({
    t: i,
    kind: 'set',
    text: `x${i}`,
  }));
  saveLog(many, store);
  const back = loadLog(store);
  assert.equal(back.length, LOG_LIMIT);
  assert.equal(back.at(-1).text, `x${LOG_LIMIT + 19}`, 'the newest are kept');
  clearLog(store);
  assert.deepEqual(loadLog(store), []);
  store.setItem('riscv-param-log-v1', '{not json');
  assert.deepEqual(loadLog(store), []);
  assert.doesNotThrow(() => saveLog(many, broken));
  assert.deepEqual(loadLog(broken), []);
  assert.doesNotThrow(() => clearLog(broken));
});

test('value entries say set, change or clear, with 64-bit values exact', () => {
  assert.equal(valueEntry('A', undefined, 40, 1).text, 'A = 40');
  assert.equal(valueEntry('A', undefined, 40, 1).kind, 'set');
  assert.equal(valueEntry('A', [0], [0, 3], 1).text, 'A [0] → [0, 3]');
  assert.equal(valueEntry('A', true, null, 1).kind, 'clear');
  assert.equal(valueEntry('A', true, null, 1).text, 'A (was true)');
  assert.equal(
    valueEntry('A', undefined, { $int: '9223372036854775808' }, 1).text,
    'A = 9223372036854775808',
  );
});

test('errors that appear, change or clear are logged once', () => {
  const before = { A: 'bad', B: 'old' };
  const after = { B: 'new', C: 'worse' };
  const out = errorEntries(before, after, 5);
  assert.deepEqual(out.map((e) => `${e.kind} ${e.name}`).sort(), ['error B', 'error C', 'ok A']);
  assert.deepEqual(errorEntries(after, after, 5), [], 'nothing changed, nothing logged');
});

test('groups: one per action with the errors it caused, newest group first', () => {
  const entries = [
    { t: 1, kind: 'session', text: 'opened' },
    { t: 2, kind: 'set', name: 'A', text: 'A = 1' },
    { t: 2, kind: 'error', name: 'A', text: 'A: bad' },
    { t: 3, kind: 'change', name: 'A', text: 'A 1 → 2' },
    { t: 3, kind: 'ok', name: 'A', text: 'A is valid now' },
  ];
  const g = logGroups(entries);
  assert.equal(g.length, 3);
  assert.deepEqual(
    g[0].map((e) => e.kind),
    ['change', 'ok'],
    'newest first, action before effect',
  );
  assert.deepEqual(
    g[1].map((e) => e.kind),
    ['set', 'error'],
  );
  // An error with no action before it still gets a group of its own.
  assert.equal(logGroups([{ t: 1, kind: 'error', text: 'x' }]).length, 1);
});

test('the text and file forms read oldest first, the file with full local dates', () => {
  const entries = [
    { t: Date.UTC(2026, 0, 2, 3, 4, 5), kind: 'set', text: 'A = 1' },
    { t: Date.UTC(2026, 0, 2, 3, 4, 9), kind: 'error', text: 'A: bad' },
  ];
  assert.ok(logText(entries).indexOf('A = 1') < logText(entries).indexOf('A: bad'));
  const f = logFile(entries, new Date(Date.UTC(2026, 0, 2, 3, 5)));
  assert.match(f.filename, /^riscv-parameter-log-\d{4}-\d{2}-\d{2}\.txt$/);
  assert.match(
    f.text,
    /^# RISC-V ISA Explorer: parameter activity log\n# exported .* \(UTC[+-]\d{2}:\d{2}\), 2 entries\n/,
  );
  assert.match(f.text, /\n\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} {2}set {5}A = 1\n/);
});

// ---------------------------------------------------------------------------
// Extension changes made elsewhere
// ---------------------------------------------------------------------------

test('returning after extension changes gives one line: what changed and its effect', () => {
  const store = memory();
  const before = ['RV64I', 'M'];
  const s1 = builderParamStates(before, {});
  saveSeen(before, s1, store);
  const after = ['RV64I', 'M', 'S', 'U', 'Sv39'];
  const s2 = builderParamStates(after, { SXLEN: [32] });
  const line = extensionDiff(loadSeen(store), after, s2);
  assert.match(line, /^\+S \+Sv39 \+U · \d+ parameters added/);
  assert.match(line, /1 now invalid/, 'Sv39 makes SXLEN [32] invalid');
  assert.equal(extensionDiff(loadSeen(store), before, s1), null, 'same extensions: no line');
  assert.match(extensionDiff({ ids: after, required: [], errors: {} }, before, s1), /^−S −Sv39 −U/);
  assert.equal(loadSeen(broken), null);
});

// ---------------------------------------------------------------------------
// Undo / redo
// ---------------------------------------------------------------------------

test('undo and redo walk the last 30 moves, and a new move drops the redo path', () => {
  let h = { past: [], future: [] };
  for (let i = 0; i < HISTORY_LIMIT + 5; i++)
    h = pushMove(h, { kind: 'param', name: 'A', before: i, after: i + 1 });
  assert.equal(h.past.length, HISTORY_LIMIT, 'only 30 kept');
  assert.equal(h.past[0].before, 5, 'the oldest dropped');
  let r = undoMove(h);
  assert.equal(r.move.after, HISTORY_LIMIT + 5);
  r = undoMove(r.history);
  assert.equal(r.history.future.length, 2);
  const redone = redoMove(r.history);
  assert.equal(redone.move.after, HISTORY_LIMIT + 4);
  const branched = pushMove(r.history, { kind: 'vlen', before: 128, after: 256 });
  assert.deepEqual(branched.future, [], 'a new move discards what could be redone');
  assert.equal(undoMove({ past: [], future: [] }).move, null);
  assert.equal(redoMove({ past: [], future: [] }).move, null);
});

test('a stored history keeps only well-formed moves', () => {
  const store = memory();
  saveHistory(
    {
      past: [
        { kind: 'param', name: 'A', before: 1, after: 2 },
        { kind: 'nonsense' },
        null,
        { kind: 'reset', before: { A: 1 } },
        { kind: 'vlen', before: null, after: 256 },
      ],
      future: [{ kind: 'param' }],
    },
    store,
  );
  const h = loadHistory(store);
  assert.deepEqual(
    h.past.map((m) => m.kind),
    ['param', 'reset', 'vlen'],
  );
  assert.deepEqual(h.future, []);
  assert.deepEqual(loadHistory(broken), { past: [], future: [] });
});

// ---------------------------------------------------------------------------
// Backup and restore
// ---------------------------------------------------------------------------

const KNOWN = {
  knownIds: new Set(['RV64I', 'M', 'F', 'D']),
  knownParams: new Set(parameterNames()),
};

test('a backup restores the configuration, the values (64-bit exact) and the log', () => {
  const values = {
    PHYS_ADDR_WIDTH: 40,
    ARCH_ID_VALUE: { $int: '9223372036854775809' },
    MTVEC_MODES: [0, 1],
    M_MODE_ENDIANNESS: 'little',
    MARCHID_IMPLEMENTED: true,
  };
  const entries = [{ t: 1, kind: 'set', name: 'PHYS_ADDR_WIDTH', text: 'PHYS_ADDR_WIDTH = 40' }];
  const f = backupFile({ ids: ['RV64I', 'M'], values, entries }, new Date(Date.UTC(2026, 0, 2)));
  assert.match(f.filename, /^riscv-parameters-\d{4}-\d{2}-\d{2}-\d{4}\.json$/, 'date and time');
  const r = readBackup(f.text, KNOWN);
  assert.equal(r.ok, true);
  assert.deepEqual(r.ids, ['M', 'RV64I']);
  assert.deepEqual(r.values, values);
  assert.deepEqual(r.log, entries);
  assert.deepEqual(r.dropped, []);
});

test('a file that is not a backup is refused, with the reason', () => {
  assert.match(readBackup('{', KNOWN).error, /not JSON/);
  assert.match(readBackup('[]', KNOWN).error, /not a parameter backup/);
  assert.match(readBackup('null', KNOWN).error, /not a parameter backup/);
  assert.match(readBackup('{"format":"something-else"}', KNOWN).error, /not a parameter backup/);
  const future = JSON.stringify({ format: 'riscv-isa-explorer-parameters', version: 9 });
  assert.match(readBackup(future, KNOWN).error, /version 9/);
  assert.match(readBackup('x'.repeat(BACKUP_MAX_BYTES + 1), KNOWN).error, /too large/);
  const empty = JSON.stringify({
    format: 'riscv-isa-explorer-parameters',
    version: 1,
    extensions: ['Xnope'],
  });
  assert.match(readBackup(empty, KNOWN).error, /no extensions the catalogue knows/);
});

test('a hostile or damaged backup loads only what this page could have written', () => {
  const doc = {
    format: 'riscv-isa-explorer-parameters',
    version: 1,
    extensions: ['RV64I', 'RV64I', 'Xevil', 42, { a: 1 }],
    parameters: {
      PHYS_ADDR_WIDTH: 40,
      NOT_A_PARAM: 1,
      M_MODE_ENDIANNESS: { toString: 'x' },
      MTVEC_MODES: [[0]],
      ARCH_ID_VALUE: { $int: '12; drop' },
      MARCHID_IMPLEMENTED: 'x'.repeat(10000),
      ['__proto__']: { polluted: true },
    },
    log: [
      { t: 1, kind: 'set', text: 'ok' },
      { t: 'x', kind: 'set', text: 'bad time' },
      { t: 2, kind: '<script>', text: 'bad kind' },
      { t: 3, kind: 'set', text: 'y'.repeat(5000), name: 'NOT_A_PARAM', target: 'elsewhere' },
    ],
  };
  const r = readBackup(JSON.stringify(doc), KNOWN);
  assert.equal(r.ok, true);
  assert.deepEqual(r.ids, ['RV64I'], 'duplicates and non-strings dropped');
  assert.deepEqual(Object.keys(r.values), ['PHYS_ADDR_WIDTH']);
  assert.equal({}.polluted, undefined, 'no prototype pollution');
  assert.equal(r.log.length, 2);
  assert.equal(r.log[1].text.length, 2000, 'long text clamped');
  assert.equal(r.log[1].name, undefined, 'unknown names dropped');
  assert.equal(r.log[1].target, undefined);
  for (const what of [
    'extension Xevil',
    'parameter NOT_A_PARAM',
    'the value of M_MODE_ENDIANNESS',
    'the value of MTVEC_MODES',
    'the value of ARCH_ID_VALUE',
    'the value of MARCHID_IMPLEMENTED',
  ]) {
    assert.ok(r.dropped.includes(what), `${what} not reported: ${r.dropped.join('; ')}`);
  }
});

// ---------------------------------------------------------------------------
// Ask AI, and the wiring
// ---------------------------------------------------------------------------

test('the Ask AI question names the parameter as the specifications do', () => {
  assert.equal(
    paramLabel('MSTATUS_FS_LEGAL_VALUES'),
    'mstatus.FS legal values',
    'code spans removed',
  );
  assert.equal(
    paramQuestion('MSTATUS_FS_LEGAL_VALUES'),
    'In RISC-V, what does the mstatus.FS legal values parameter (MSTATUS_FS_LEGAL_VALUES in riscv-unified-db) control?',
  );
  assert.equal(
    paramQuestion('MSTATUS_FS_LEGAL_VALUES', {
      error: 'If F is implemented, Dirty must be supported.',
    }),
    'In RISC-V, why must the mstatus.FS legal values parameter (MSTATUS_FS_LEGAL_VALUES) satisfy this rule: If F is implemented, Dirty must be supported?',
  );
  assert.match(paramQuestion('NO_SUCH_PARAM'), /what does NO_SUCH_PARAM control/);
});

test('the panel: shortcut guards, stable keys, the chip left as it is', () => {
  const view = fs.readFileSync(new URL('../src/ParametersView.jsx', import.meta.url), 'utf8');
  assert.match(view, /composedPath\?\.\(\)\[0\]/, 'Ctrl+Z in the Ask AI chat stays its own');
  assert.match(view, /isContentEditable/);
  assert.match(view, /historyRef\.current/, 'quick double undo reads the latest history');
  assert.doesNotMatch(view, /key=\{`\$\{group\[0\]\.t\}-\$\{g\}`\}/, 'log keys must not shift');
  assert.match(view, /<span className="sr-only">Last change\.<\/span>/);
  const launcher = fs.readFileSync(new URL('../src/AskAiLauncher.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(
    launcher,
    /ask-ai-btn--context/,
    'the chip behaves as it does everywhere else',
  );
});

test('stored log entries are cleaned on load: unknown kinds, bad times and long text', () => {
  const store = memory();
  store.setItem(
    'riscv-param-log-v1',
    JSON.stringify([
      { t: 1, kind: 'set', text: 'ok', name: 'PHYS_ADDR_WIDTH' },
      { t: 2, kind: 7, text: 'numeric kind' },
      { t: 'later', kind: 'set', text: 'bad time' },
      null,
      { t: 3, kind: 'vlen', text: 'v', target: '#vlen' },
      { t: 4, kind: 'set', text: 'z'.repeat(9000), target: '#elsewhere' },
    ]),
  );
  const back = loadLog(store);
  assert.deepEqual(
    back.map((e) => e.t),
    [1, 3, 4],
  );
  assert.equal(back[1].target, '#vlen');
  assert.equal(back[2].target, undefined);
  assert.equal(back[2].text.length, 2000);
  assert.doesNotThrow(() => logText(back), 'copy and export never meet a bad entry');
});

test('a backup needs exactly one base ISA', () => {
  const bases = new Set(['RV32I', 'RV64I', 'RV32E', 'RV64E', 'RV128I']);
  const known = { ...KNOWN, knownIds: new Set([...KNOWN.knownIds, 'RV32I']), bases };
  const make = (extensions) =>
    JSON.stringify({ format: 'riscv-isa-explorer-parameters', version: 1, extensions });
  assert.match(readBackup(make(['M']), known).error, /no base ISA/);
  assert.match(readBackup(make(['RV64I', 'RV32I', 'M']), known).error, /more than one base/);
  assert.equal(readBackup(make(['RV64I', 'M']), known).ok, true);
});

test('a whole-configuration move (restore, import) survives in the stored history', () => {
  const store = memory();
  const move = {
    kind: 'config',
    label: 'restore',
    before: { ids: ['RV64I'], values: {} },
    after: { ids: ['RV64I', 'M'], values: { PHYS_ADDR_WIDTH: 40 } },
  };
  saveHistory(pushMove({ past: [], future: [] }, move), store);
  assert.deepEqual(loadHistory(store).past, [move]);
  saveHistory({ past: [{ kind: 'config', before: {} }], future: [] }, store);
  assert.deepEqual(loadHistory(store).past, [], 'a damaged configuration move is dropped');
});

test('the panel guards undo against changes made elsewhere, and predicts VLEN', () => {
  const view = fs.readFileSync(new URL('../src/ParametersView.jsx', import.meta.url), 'utf8');
  assert.match(view, /const stillApplies = \(move, direction\)/);
  assert.match(view, /skipped: \$\{describe\(move\)\} changed elsewhere since/);
  assert.match(view, /const predictVlen = \(bits\)/, 'a VLEN pick is logged as it resolves');
  assert.match(view, /floor stays \$\{from\}: a selected vector extension requires it/);
  assert.match(view, /replaceConfig\('restore'/, 'restore can be undone');
  assert.match(view, /replaceConfig\('import'/, 'a UDB import can be undone');
  assert.match(view, /file\.size > BACKUP_MAX_BYTES/, 'size checked before reading');
  assert.match(view, /e\.isComposing/);
});
