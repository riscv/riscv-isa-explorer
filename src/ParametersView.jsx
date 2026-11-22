/**
 * ParametersView.jsx — the builder's Parameters tab (#600).
 *
 * Every UDB parameter the configuration has, with an editor for its type and
 * the parameter model's verdict (src/paramModel.js): whether UDB requires it,
 * whether an extension fixes or narrows it, and whether the value breaks its
 * schema or a UDB rule. Values are written through onSetParam into the same
 * paramChoices the rest of the builder uses, in the stored form from
 * paramEditing.js, so saving, share links and the UDB export carry them.
 *
 * Every editor is a top-level component: a component declared inside another's
 * render body remounts its subtree on every keystroke.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Copy,
  Download,
  Eraser,
  Redo2,
  Save,
  Search,
  Trash2,
  Undo2,
  Upload,
} from 'lucide-react';
import { paramQuestion } from './askAi.js';
import { parameterDefinition, parameterNames } from './isaParams.js';
import { impliedVlen, resolveParams, resolveSelection, vlenExtension } from './isaGraph.js';
import { BASE_ISA_IDS } from './marchUtils.js';
import { importUdbConfig, NOT_CHECKED_HERE } from './udbImport.js';
import {
  LOG_LIMIT,
  clearLog,
  loadHistory,
  pushMove,
  redoMove,
  saveHistory,
  undoMove,
  errorEntries,
  errorMap,
  loadLog,
  BACKUP_MAX_BYTES,
  backupFile,
  extensionDiff,
  readBackup,
  loadSeen,
  logFile,
  logGroups,
  saveSeen,
  logText,
  logTime,
  saveLog,
  valueEntry,
} from './paramLog.js';
import {
  builderParamStates,
  editorFor,
  formatValue,
  fromStored,
  groupOf,
  labelOf,
  parseInput,
  toStored,
} from './paramEditing.js';

const FILTERS = [
  { key: 'unset', label: 'Unset' },
  { key: 'invalid', label: 'Invalid' },
  { key: 'all', label: 'All' },
  { key: 'fixed', label: 'Fixed' },
  { key: 'conditional', label: 'Conditional' },
];

const chip = (active) => ({
  padding: '4px 10px',
  borderRadius: 999,
  fontSize: 11.5,
  fontWeight: 600,
  cursor: 'pointer',
  border: `1px solid ${active ? 'var(--riscv-gold)' : 'var(--riscv-border-2)'}`,
  background: active ? 'rgba(245,197,66,0.12)' : 'var(--riscv-surface-2)',
  color: active ? 'var(--riscv-text)' : 'var(--riscv-text-2)',
});
const control = {
  padding: '4px 8px',
  borderRadius: 6,
  fontSize: 12,
  background: 'var(--riscv-surface-2)',
  border: '1px solid var(--riscv-border-2)',
  color: 'var(--riscv-text)',
  fontFamily: 'JetBrains Mono, monospace',
};
const toggle = (on, disabled) => ({
  ...control,
  padding: '3px 9px',
  cursor: disabled ? 'not-allowed' : 'pointer',
  opacity: disabled ? 0.5 : 1,
  borderColor: on ? 'var(--riscv-gold)' : 'var(--riscv-border-2)',
  background: on ? 'rgba(245,197,66,0.16)' : 'var(--riscv-surface-2)',
});

function BooleanEditor({ value, onSet, label }) {
  return (
    <div role="group" aria-label={label} style={{ display: 'flex', gap: 4 }}>
      {[true, false].map((b) => (
        <button
          key={String(b)}
          type="button"
          aria-pressed={value === b}
          onClick={() => onSet(value === b ? null : b)}
          style={toggle(value === b)}
        >
          {String(b)}
        </button>
      ))}
    </div>
  );
}

function EnumEditor({ value, options, onSet, label }) {
  const current = value === undefined || value === null ? '' : String(fromStored(value));
  return (
    <select
      aria-label={label}
      value={current}
      onChange={(e) => {
        if (e.target.value === '') return onSet(null);
        const picked = options.find((o) => String(o) === e.target.value);
        // Our data keeps enum integers above 2^53 as strings; store them exact.
        const numeric = options.some((o) => typeof o === 'number');
        onSet(
          numeric && typeof picked === 'string' && /^\d+$/.test(picked)
            ? toStored(BigInt(picked))
            : picked,
        );
      }}
      style={{ ...control, maxWidth: 260 }}
    >
      <option value="">unset</option>
      {options.map((o) => (
        <option key={String(o)} value={String(o)}>
          {String(o)}
        </option>
      ))}
    </select>
  );
}

// Text editors keep what is being typed locally and commit on blur or Enter,
// so a half-typed number is never stored, and an invalid entry says why.
function TextEditor({ value, editor, onSet, label, placeholder }) {
  const shown = formatValue(value);
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState(null);
  const commit = () => {
    if (draft === null) return;
    const parsed = parseInput(draft, editor);
    if (parsed.error) {
      setError(parsed.error);
      return;
    }
    setError(null);
    setDraft(null);
    onSet(parsed.unset ? null : parsed.value);
  };
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2 }}>
      <input
        aria-label={label}
        aria-invalid={error ? true : undefined}
        value={draft ?? shown}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          // Escape cancels what is being typed, and stops there: the builder
          // closes on Escape, and losing it mid-edit lost the whole panel.
          // With nothing typed, Escape still reaches the builder.
          if (e.key === 'Escape' && (draft !== null || error)) {
            e.stopPropagation();
            setDraft(null);
            setError(null);
          }
        }}
        style={{ ...control, width: '100%', maxWidth: 300, minWidth: 0 }}
      />
      {error && <span style={{ fontSize: 11, color: 'var(--riscv-danger)' }}>{error}</span>}
    </span>
  );
}

function EnumListEditor({ value, options, onSet, label }) {
  const list = Array.isArray(fromStored(value)) ? fromStored(value).map(String) : [];
  return (
    <div role="group" aria-label={label} style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {options.map((o) => {
        const on = list.includes(String(o));
        return (
          <button
            key={String(o)}
            type="button"
            aria-pressed={on}
            onClick={() => {
              const next = on ? list.filter((x) => x !== String(o)) : [...list, String(o)];
              const typed = options.filter((x) => next.includes(String(x)));
              onSet(typed.length ? typed : null);
            }}
            style={toggle(on)}
          >
            {String(o)}
          </button>
        );
      })}
    </div>
  );
}

function BitmapEditor({ value, editor, onSet, label }) {
  const current = Array.isArray(value) ? value : null;
  const bits = Array.from({ length: editor.length }, (_, i) =>
    i in editor.fixed ? editor.fixed[i] : (current?.[i] ?? false),
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div
        role="group"
        aria-label={label}
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, 22px)',
          gap: 3,
          maxWidth: 16 * 25,
        }}
      >
        {bits.map((on, i) => {
          const locked = i in editor.fixed;
          return (
            <button
              key={i}
              type="button"
              aria-pressed={on}
              aria-label={`${label} bit ${i}${locked ? ', fixed by the schema' : ''}`}
              title={locked ? `bit ${i}: fixed to ${on} by UDB` : `bit ${i}`}
              disabled={locked}
              onClick={() => {
                const next = bits.slice();
                next[i] = !on;
                onSet(next);
              }}
              style={{
                ...toggle(on, locked),
                padding: 0,
                width: 22,
                height: 20,
                fontSize: 9.5,
              }}
            >
              {i}
            </button>
          );
        })}
      </div>
      <span style={{ fontSize: 11, color: 'var(--riscv-text-2)' }}>
        {current
          ? `${bits.filter(Boolean).length} of ${editor.length} set`
          : 'unset: click a bit to start'}
        {current && (
          <button
            type="button"
            onClick={() => onSet(null)}
            style={{ ...control, marginLeft: 8, padding: '1px 6px', fontSize: 11 }}
          >
            clear
          </button>
        )}
      </span>
    </div>
  );
}

function ParamEditor({ p, stored, onSet }) {
  const definition = parameterDefinition(p.name);
  const editor = editorFor(definition?.schema);
  const label = `${p.name} value`;
  if (p.kind === 'fixed') {
    // Focusable, so a keyboard can select a fixed row too (and ask about it).
    return (
      <span
        tabIndex={0}
        aria-label={`${p.name} is fixed at ${formatValue(toStored(p.value))}`}
        style={{ ...control, display: 'inline-block', opacity: 0.85 }}
      >
        {formatValue(toStored(p.value))}
      </span>
    );
  }
  switch (editor.kind) {
    case 'boolean':
      return <BooleanEditor value={stored} onSet={onSet} label={label} />;
    case 'enum':
      return <EnumEditor value={stored} options={editor.options} onSet={onSet} label={label} />;
    case 'enum-list':
      return <EnumListEditor value={stored} options={editor.options} onSet={onSet} label={label} />;
    case 'bitmap':
      return <BitmapEditor value={stored} editor={editor} onSet={onSet} label={label} />;
    case 'integer': {
      const range =
        editor.min !== undefined && editor.max !== undefined
          ? `${editor.min} to ${editor.max > 0xffffffffn ? `0x${editor.max.toString(16)}` : editor.max}`
          : 'whole number';
      return (
        <TextEditor
          key={formatValue(stored)}
          value={stored}
          editor={editor}
          onSet={onSet}
          label={label}
          placeholder={range}
        />
      );
    }
    case 'list':
      return (
        <TextEditor
          key={formatValue(stored)}
          value={stored}
          editor={editor}
          onSet={onSet}
          label={label}
          placeholder="comma-separated"
        />
      );
    default:
      return (
        <TextEditor
          key={formatValue(stored)}
          value={stored}
          editor={editor}
          onSet={onSet}
          label={label}
          placeholder="text"
        />
      );
  }
}

// UDB's names use Markdown code spans (`misa.A` mutability); show them as code.
function InlineCode({ text }) {
  return String(text)
    .split(/(`[^`]+`)/)
    .map((part, i) =>
      part.startsWith('`') && part.endsWith('`') && part.length > 1 ? (
        <code key={i} style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.95em' }}>
          {part.slice(1, -1)}
        </code>
      ) : (
        <React.Fragment key={i}>{part}</React.Fragment>
      ),
    );
}

function stateLine(p) {
  if (p.kind === 'fixed') return `fixed by ${p.constraint.from.join(', ')}`;
  if (p.kind === 'constrained') {
    const want = [].concat(p.constraint.value).join(', ');
    const what =
      p.constraint.kind === 'includes'
        ? `must include ${want}`
        : p.constraint.kind === 'oneOf'
          ? `one of ${want}`
          : p.constraint.kind === 'greaterThanOrEqual'
            ? `at least ${want}`
            : `${p.constraint.kind} ${want}`;
    return `${what} (${p.constraint.from.join(', ')})`;
  }
  if (p.scope === null) return 'only once another parameter allows it';
  return null;
}

function ParamRow({ p, stored, onSetParam, selected, onSelect, current }) {
  const definition = parameterDefinition(p.name);
  const state = stateLine(p);
  const invalid = p.errors.length > 0;
  return (
    <div
      id={`param-${p.name}`}
      // Clicking or tabbing into a row selects it: the row the Ask AI chip
      // asks about.
      onFocus={onSelect ? () => onSelect(p.name) : undefined}
      onClick={onSelect ? () => onSelect(p.name) : undefined}
      aria-current={selected ? 'true' : undefined}
      data-last-set={current ? 'true' : undefined}
      style={{
        display: 'grid',
        // One column on a phone, two side by side when there is room.
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))',
        gap: '6px 16px',
        alignItems: 'start',
        padding: '10px 12px',
        borderTop: '1px solid var(--riscv-tint-2)',
        borderLeft: `3px solid ${invalid ? 'var(--riscv-danger)' : p.set ? 'var(--riscv-gold)' : 'transparent'}`,
        // A value you set is tinted, so a long list shows at a glance what
        // has been done; an invalid one is tinted red. The left edge carries
        // the same meaning without relying on colour alone.
        background: invalid
          ? 'var(--riscv-param-invalid-bg)'
          : stored !== undefined
            ? 'var(--riscv-param-set-bg)'
            : 'transparent',
        position: 'relative',
        outline: selected ? '2px solid var(--riscv-gold)' : 'none',
        outlineOffset: -2,
        cursor: 'default',
      }}
    >
      {current && (
        <>
          <span className="param-current-bar" aria-hidden="true" />
          <span className="sr-only">Last change.</span>
        </>
      )}
      {/* The tint and outline, in words. */}
      {(selected || stored !== undefined) && (
        <span className="sr-only">
          {[selected && 'Selected.', stored !== undefined && 'Set by you.']
            .filter(Boolean)
            .join(' ')}
        </span>
      )}
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 12,
            fontWeight: 700,
            color: 'var(--riscv-text)',
            wordBreak: 'break-all',
          }}
        >
          {p.name}
        </div>
        {definition?.long_name && (
          <div style={{ fontSize: 12, color: 'var(--riscv-text-2)', marginTop: 2 }}>
            <InlineCode text={definition.long_name} />
          </div>
        )}
        {state && (
          <div style={{ fontSize: 11, color: 'var(--riscv-text-2)', marginTop: 3 }}>{state}</div>
        )}
        {definition?.description && (
          <details style={{ marginTop: 4 }}>
            <summary style={{ fontSize: 11, color: 'var(--riscv-text-2)', cursor: 'pointer' }}>
              UDB description
            </summary>
            <div
              style={{
                fontSize: 11.5,
                color: 'var(--riscv-text-2)',
                whiteSpace: 'pre-wrap',
                marginTop: 4,
                maxWidth: 640,
              }}
            >
              {definition.description.trim()}
            </div>
          </details>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <ParamEditor p={p} stored={stored} onSet={(v) => onSetParam(p.name, v)} />
        </div>
        {p.errors.map((e) => (
          <div
            key={e}
            role="alert"
            style={{ fontSize: 11.5, color: 'var(--riscv-danger)', maxWidth: 420 }}
          >
            {e}
          </div>
        ))}
      </div>
    </div>
  );
}

/** "1 value", "2 values". */
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Save text as a file through a temporary link. */
function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const VLEN_CHOICES = [32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];

/**
 * The guaranteed vector length (#606), moved here from the Configuration
 * view's Implementation Parameters card so parameters live in one place. It
 * changes extensions, not a value: VLEN has no -march flag, so the floor is a
 * Zvl*b extension, and the -march string follows.
 */
// The log's target for a VLEN change: the VLEN section, not a parameter row.
const VLEN_TARGET = '#vlen';

function VlenPicker({ ids, onSetVlen, current }) {
  const vlen = impliedVlen(ids);
  return (
    <section
      aria-labelledby="vlen-title"
      data-last-set={current ? 'true' : undefined}
      style={{
        position: 'relative',
        marginBottom: 16,
        padding: '10px 12px',
        borderRadius: 10,
        border: '1px solid var(--riscv-border)',
        background: 'var(--riscv-surface)',
      }}
    >
      {current && (
        <>
          <span className="param-current-bar" aria-hidden="true" />
          <span className="sr-only">Last change.</span>
        </>
      )}
      <h3 id="vlen-title" style={{ margin: '0 0 6px', fontSize: 13, color: 'var(--riscv-text)' }}>
        Vector length (VLEN):{' '}
        {vlen ? (
          <span style={{ color: 'var(--riscv-text)' }}>at least {vlen} bits</span>
        ) : (
          <span style={{ fontWeight: 500, color: 'var(--riscv-text-2)' }}>
            not constrained; no vector extension selected
          </span>
        )}
      </h3>
      <div
        role="group"
        aria-label="Guaranteed VLEN"
        style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}
      >
        {VLEN_CHOICES.map((bits) => {
          const active = vlen === bits;
          return (
            <button
              key={bits}
              type="button"
              aria-pressed={active}
              onClick={() => onSetVlen(active ? null : bits)}
              title={
                active
                  ? `VLEN is at least ${bits}. Click to clear it (removes ${vlenExtension(bits)}).`
                  : `Set VLEN to at least ${bits}${vlen && bits < vlen ? `, lowering it from ${vlen}` : ''}`
              }
              style={toggle(active)}
            >
              {bits}
            </button>
          );
        })}
      </div>
      <p style={{ margin: '6px 0 0', fontSize: 11.5, color: 'var(--riscv-text-2)', maxWidth: 820 }}>
        There is no VLEN flag: vector length is expressed by the Zvl*b extensions, so this changes
        the configuration and its -march string. Click a value to set the floor, or the selected one
        to clear it. A vector extension may hold the floor higher (Zve64x requires Zvl64b), in which
        case the higher value stands. The VLEN parameter below is the implementation&apos;s actual
        length, at least this floor.
      </p>
    </section>
  );
}

/** Extensions that demand values no setting can satisfy at once. */
function ConflictNotice({ ids }) {
  const conflicts = resolveParams(ids).filter((c) => c.conflict);
  if (!conflicts.length) return null;
  return (
    <div
      role="alert"
      style={{
        marginBottom: 16,
        padding: '10px 12px',
        borderRadius: 10,
        border: '1px solid var(--riscv-danger)',
        background: 'var(--riscv-surface)',
        fontSize: 12.5,
        color: 'var(--riscv-text)',
      }}
    >
      <strong style={{ color: 'var(--riscv-danger)' }}>Conflicting parameter requirements</strong>
      <ul style={{ margin: '4px 0 0', paddingLeft: 18, listStyle: 'disc' }}>
        {conflicts.map((c) => (
          <li key={c.name}>
            <code style={{ fontFamily: 'JetBrains Mono, monospace' }}>{c.name}</code>: {c.conflict}
          </li>
        ))}
      </ul>
    </div>
  );
}

const REPORT_COLOR = {
  errors: 'var(--riscv-danger)',
  invalid: 'var(--riscv-danger)',
  warnings: 'var(--riscv-text)',
  info: 'var(--riscv-text-2)',
};

/**
 * Import a UDB config (#604): a file or pasted text, checked by the same
 * parameter model as the tab, and loaded only on an explicit second step when
 * it would replace a configuration.
 */
function ImportPanel({ catalog, hasConfig, onImport }) {
  const [text, setText] = useState('');
  const [report, setReport] = useState(null);
  const [confirming, setConfirming] = useState(false);

  const check = async (source) => {
    setConfirming(false);
    let doc;
    try {
      // Loaded on demand, so the parser is not in the page until it is used.
      const { parse } = await import('yaml');
      doc = parse(source, { intAsBigInt: true });
    } catch (e) {
      setReport({
        ok: false,
        errors: [`Not valid YAML: ${String(e.message).split('\n')[0]}`],
        warnings: [],
        info: [],
      });
      return;
    }
    setReport(importUdbConfig(doc, catalog));
  };

  return (
    <details
      open={!hasConfig}
      style={{
        marginBottom: 16,
        borderRadius: 10,
        border: '1px solid var(--riscv-border)',
        background: 'var(--riscv-surface)',
      }}
    >
      <summary
        style={{
          padding: '10px 12px',
          cursor: 'pointer',
          fontSize: 13,
          fontWeight: 700,
          color: 'var(--riscv-text)',
        }}
      >
        Import a UDB config
      </summary>
      <div style={{ padding: '0 12px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <p style={{ margin: 0, fontSize: 12, color: 'var(--riscv-text-2)' }}>
          A fully configured riscv-unified-db architecture configuration, such as a riscv-arch-test
          DUT config or this builder&apos;s own UDB export. It is read here, in your browser, and
          not sent anywhere.
        </p>
        <input
          type="file"
          accept=".yaml,.yml,text/yaml"
          aria-label="UDB config file"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const content = await file.text();
            setText(content);
            check(content);
          }}
          style={{ fontSize: 12, color: 'var(--riscv-text-2)', maxWidth: '100%' }}
        />
        <textarea
          aria-label="UDB config text"
          placeholder="…or paste the YAML here"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setReport(null);
            setConfirming(false);
          }}
          rows={5}
          style={{ ...control, width: '100%', boxSizing: 'border-box', fontSize: 11.5 }}
        />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button
            type="button"
            onClick={() => check(text)}
            disabled={!text.trim()}
            style={toggle(false, !text.trim())}
          >
            Check
          </button>
          {report?.ok && !confirming && (
            <button
              type="button"
              onClick={() => (hasConfig ? setConfirming(true) : onImport(report))}
              style={toggle(true)}
            >
              Load into builder
            </button>
          )}
          {confirming && (
            <>
              <span style={{ fontSize: 12, color: 'var(--riscv-text)' }}>
                Replace the current configuration and its values?
              </span>
              <button
                type="button"
                onClick={() => {
                  setConfirming(false);
                  onImport(report);
                }}
                style={toggle(true)}
              >
                Replace
              </button>
              <button type="button" onClick={() => setConfirming(false)} style={toggle(false)}>
                Cancel
              </button>
            </>
          )}
        </div>
        {report && (
          <div
            role="status"
            style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}
          >
            <strong style={{ color: report.ok ? 'var(--riscv-text)' : 'var(--riscv-danger)' }}>
              {report.ok
                ? `Readable${report.name ? `: ${report.name}` : ''}. ${plural(report.ids.length, 'extension')}, ${Object.keys(report.paramChoices).length} parameter values.`
                : 'This file cannot be loaded.'}
            </strong>
            {report.invalid?.length > 0 && (
              <span style={{ color: 'var(--riscv-text)' }}>
                Invalid values load as they are; fix them in this tab afterwards:
              </span>
            )}
            {['errors', 'invalid', 'warnings', 'info'].map((kind) =>
              report[kind]?.length ? (
                <ul
                  key={kind}
                  aria-label={kind}
                  style={{
                    margin: 0,
                    paddingLeft: 18,
                    listStyle: 'disc',
                    color: REPORT_COLOR[kind],
                  }}
                >
                  {report[kind].map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              ) : null,
            )}
            {report.ok && <span style={{ color: 'var(--riscv-text-2)' }}>{NOT_CHECKED_HERE}</span>}
          </div>
        )}
      </div>
    </details>
  );
}

// The newest group that is a change rather than a "session opened" line: the
// cyan line goes under it, marking the last change.
const lastChangeGroup = (groups) => {
  const i = groups.findIndex((group) => group[0].kind !== 'session');
  return i === -1 ? 0 : i;
};

// Whether this page load has written its "opened" line to the log yet.
let sessionSummarised = false;

const LOG_COLOR = {
  backup: '#7dd3fc',
  restore: '#7dd3fc',
  ext: '#7dd3fc',
  reset: '#ffb86b',
  undo: '#d7b4ff',
  redo: '#d7b4ff',
  set: '#7ee2a8',
  change: '#f5c542',
  clear: '#b5bac4',
  error: '#ff8fa3',
  ok: '#7ee2a8',
  vlen: '#8ab4ff',
  import: '#8ab4ff',
  session: '#b5bac4',
};

/**
 * The activity log (prototype): every change made in this tab and every error
 * it causes or clears, newest at the bottom like a terminal. It stays dark in
 * both themes, so its colours are checked against one background.
 */
function IconButton({ label, onClick, disabled, danger, children }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      style={{
        ...logButton,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 26,
        padding: 0,
        opacity: disabled ? 0.45 : 1,
        ...(danger ? { borderColor: '#ff8fa3', color: '#ff8fa3', background: '#2a1218' } : {}),
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      {children}
    </button>
  );
}

function ParamLog({
  entries,
  onClear,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  setCount,
  onReset,
  onBackup,
  onRestoreFile,
  pendingRestore,
  onConfirmRestore,
  onCancelRestore,
  onRestoreError,
  onJump,
}) {
  // Reset and clear destroy work, so each takes two clicks: the first arms it
  // and says, in words, what the second will do. Escape or a pause disarms.
  const [arming, setArming] = useState(null); // 'reset' | 'clear' | null
  useEffect(() => {
    if (!arming) return undefined;
    const t = setTimeout(() => setArming(null), 6000);
    return () => clearTimeout(t);
  }, [arming]);
  // A short message for things that happened without a log line: a refused
  // copy, a file that could not be read. Announced to screen readers.
  const [notice, setNotice] = useState(null);
  useEffect(() => {
    if (!notice) return undefined;
    const t = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(t);
  }, [notice]);
  const restoreButton = useRef(null);
  useEffect(() => {
    if (pendingRestore) restoreButton.current?.focus();
  }, [pendingRestore]);
  const list = useRef(null);
  const fileInput = useRef(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    // Newest first: keep the latest line in view.
    if (list.current) list.current.scrollTop = 0;
  }, [entries.length]);
  const errorsNow = entries.filter((e) => e.kind === 'error').length;
  return (
    <aside
      aria-label="Parameter activity log"
      className="param-log"
      style={{
        borderRadius: 10,
        border: '1px solid #2a2f3a',
        background: '#0d1117',
        color: '#d6dae1',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 11.5,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      <div
        onKeyDown={(e) => {
          if (e.key === 'Escape' && arming) {
            e.stopPropagation();
            setArming(null);
          }
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 8,
          padding: '8px 10px',
          borderBottom: '1px solid #2a2f3a',
          whiteSpace: 'nowrap',
        }}
      >
        <span aria-hidden="true" style={{ color: '#7ee2a8' }}>
          ●
        </span>
        <strong style={{ fontSize: 12, color: '#f0f3f6' }}>activity log</strong>
        <span style={{ color: '#b5bac4' }}>
          {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
          {errorsNow ? ` · ${errorsNow} ${errorsNow === 1 ? 'error' : 'errors'} logged` : ''}
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <IconButton
            label={
              arming === 'reset'
                ? `Click again to reset all ${setCount} parameter value${setCount === 1 ? '' : 's'} (undo brings them back)`
                : 'Reset all parameter values'
            }
            onClick={() => {
              if (arming === 'reset') {
                setArming(null);
                onReset();
              } else setArming('reset');
            }}
            disabled={!setCount}
            danger={arming === 'reset'}
          >
            <Eraser size={14} />
          </IconButton>
          <span
            aria-hidden="true"
            style={{ width: 1, alignSelf: 'stretch', background: '#2a2f3a' }}
          />
          <IconButton label="Undo the last change (Ctrl/⌘+Z)" onClick={onUndo} disabled={!canUndo}>
            <Undo2 size={14} />
          </IconButton>
          <IconButton label="Redo (Shift+Ctrl/⌘+Z)" onClick={onRedo} disabled={!canRedo}>
            <Redo2 size={14} />
          </IconButton>
          <IconButton
            label={copied ? 'Copied' : 'Copy the log as text'}
            disabled={!entries.length}
            onClick={() => {
              const refused = () =>
                setNotice(
                  'Copy failed: the browser did not allow clipboard access. Use export instead.',
                );
              if (!navigator.clipboard?.writeText) return refused();
              navigator.clipboard.writeText(logText(entries)).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              }, refused);
            }}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </IconButton>
          <IconButton
            label="Back up the configuration, parameters and log (.json)"
            onClick={onBackup}
          >
            <Save size={14} />
          </IconButton>
          <IconButton label="Restore from a backup file" onClick={() => fileInput.current?.click()}>
            <Upload size={14} />
          </IconButton>
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            aria-hidden="true"
            tabIndex={-1}
            style={{ display: 'none' }}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              // Checked before reading: a huge file is refused, not loaded.
              if (file.size > BACKUP_MAX_BYTES) {
                onRestoreError('This file is too large to be a parameter backup.');
                return;
              }
              try {
                onRestoreFile(await file.text());
              } catch {
                onRestoreError('The file could not be read.');
              }
            }}
          />
          <IconButton
            label="Export the log as a text file"
            disabled={!entries.length}
            onClick={() => {
              const { filename, text } = logFile(entries);
              download(filename, text, 'text/plain');
            }}
          >
            <Download size={14} />
          </IconButton>
          <IconButton
            label={
              arming === 'clear'
                ? 'Click again to empty the log (the undo history stays)'
                : 'Clear the log'
            }
            onClick={() => {
              if (arming === 'clear') {
                setArming(null);
                onClear();
              } else setArming('clear');
            }}
            disabled={!entries.length}
            danger={arming === 'clear'}
          >
            <Trash2 size={14} />
          </IconButton>
        </span>
      </div>
      {(arming || notice) && (
        <div
          role="status"
          style={{
            padding: '6px 10px',
            borderBottom: '1px solid #2a2f3a',
            color: arming ? '#ffc2cd' : '#f0f3f6',
            whiteSpace: 'normal',
          }}
        >
          {arming === 'reset' &&
            `Click reset again to clear all ${setCount} parameter value${setCount === 1 ? '' : 's'}. Undo brings them back. Esc cancels.`}
          {arming === 'clear' &&
            'Click clear again to empty the log. The undo history stays. Esc cancels.'}
          {!arming && notice}
        </div>
      )}
      {pendingRestore && (
        <div
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              onCancelRestore();
            }
          }}
          role="alert"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 8,
            padding: '8px 10px',
            borderBottom: '1px solid #2a2f3a',
            color: pendingRestore.error ? '#ffc2cd' : '#f0f3f6',
          }}
        >
          {pendingRestore.error ? (
            <>
              <span>{pendingRestore.error}</span>
              <button type="button" onClick={onCancelRestore} style={logButton}>
                dismiss
              </button>
            </>
          ) : (
            <>
              <span>
                Restore {pendingRestore.ids.length} extensions and{' '}
                {Object.keys(pendingRestore.values).length} values
                {pendingRestore.exported
                  ? ` from the backup of ${pendingRestore.exported.slice(0, 10)}`
                  : ''}
                ? It replaces the current configuration; undo brings it back.
                {pendingRestore.dropped.length > 0 && (
                  <> Left out: {pendingRestore.dropped.join(', ')}.</>
                )}
              </span>
              <button
                ref={restoreButton}
                type="button"
                onClick={onConfirmRestore}
                style={logButton}
              >
                restore
              </button>
              <button type="button" onClick={onCancelRestore} style={logButton}>
                cancel
              </button>
            </>
          )}
        </div>
      )}
      <ol
        ref={list}
        role="log"
        aria-live="polite"
        aria-label="Activity log, newest first"
        tabIndex={0}
        style={{ listStyle: 'none', margin: 0, padding: '8px 10px', overflowY: 'auto', flex: 1 }}
      >
        {entries.length === 0 && (
          <li style={{ color: '#b5bac4' }}>
            Nothing yet. Every value you set, and every error it causes, appears here. The log lasts
            for this browser tab.
          </li>
        )}
        {logGroups(entries).map((group, g, groups) => (
          // One group per action, newest first: the action, then the errors
          // it caused or cleared. A cyan line separates it from the one before.
          <li
            key={`${group[0].t}-${group[0].kind}-${group[0].text}`}
            style={{
              // Cyan only between the latest action and the rest; a faint line
              // between older ones.
              borderTop:
                g === 0
                  ? 'none'
                  : g === lastChangeGroup(groups) + 1
                    ? '1px solid #22d3ee'
                    : '1px solid rgba(230, 234, 240, 0.18)',
              // One shorthand: React drops a paddingLeft mixed with a changing padding.
              padding: g === 0 ? '0 0 4px 8px' : '4px 0 4px 8px',
              position: 'relative',
            }}
          >
            {/* The same blinking bar as the row of the last parameter set:
                the latest action here, and where it landed in the list. */}
            {g === lastChangeGroup(groups) && group[0].kind !== 'session' && (
              <span className="param-current-bar param-current-bar--log" aria-hidden="true" />
            )}
            <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {group.map((e, i) => (
                <li
                  key={`${e.t}-${e.kind}-${e.text}-${i}`}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '62px 54px 1fr',
                    gap: 6,
                    padding: '1px 0',
                  }}
                >
                  <span style={{ color: '#8b93a1' }}>{logTime(e.t)}</span>
                  <span style={{ color: LOG_COLOR[e.kind] ?? '#d6dae1' }}>{e.kind}</span>
                  <span
                    style={{
                      wordBreak: 'break-word',
                      color: e.kind === 'error' ? '#ffc2cd' : '#d6dae1',
                    }}
                  >
                    {(e.target ?? e.name) && onJump ? (
                      <button
                        type="button"
                        onClick={() => onJump(e.target ?? e.name)}
                        title="Show this in the list"
                        className="param-log-jump"
                      >
                        {e.text}
                      </button>
                    ) : (
                      e.text
                    )}
                  </span>
                </li>
              ))}
            </ol>
          </li>
        ))}
      </ol>
    </aside>
  );
}

const logButton = {
  padding: '2px 8px',
  borderRadius: 5,
  border: '1px solid #3a4150',
  background: '#161b22',
  color: '#d6dae1',
  fontFamily: 'inherit',
  fontSize: 11,
  cursor: 'pointer',
};

export default function ParametersView({
  ids,
  values,
  onSetParam,
  catalog,
  onImport,
  onSetVlen,
  onAskContext,
}) {
  // Opens on All: every parameter stays on screen, and the ones you set are
  // tinted, so the list shows what has been done rather than hiding it.
  const [filter, setFilterState] = useState('all');
  // Rows changed under the current filter stay in view until the filter or
  // the search changes: under Unset, a row you set would otherwise vanish
  // under the cursor before you could see it.
  const [kept, setKept] = useState(() => new Set());
  const setFilter = (next) => {
    setKept(new Set());
    setFilterState(next);
  };
  const keep = (name) => setKept((prev) => (prev.has(name) ? prev : new Set(prev).add(name)));
  const [query, setQuery] = useState('');
  const result = useMemo(() => builderParamStates(ids, values), [ids, values]);

  // The activity log: entries for this browser tab's session.
  const [entries, setEntries] = useState(() => loadLog());
  const log = (added) => {
    if (!added.length) return;
    setEntries((prev) => {
      const next = [...prev, ...added].slice(-LOG_LIMIT);
      saveLog(next);
      return next;
    });
  };
  // Undo / redo: the last 30 moves, kept for the session like the log.
  const [history, setHistory] = useState(() => loadHistory());
  // The latest history, read by every move: two quick clicks must not both
  // see the history from before the first, or one move is applied twice.
  const historyRef = useRef(history);
  const record = (next) => {
    historyRef.current = next;
    setHistory(next);
    saveHistory(next);
  };
  const vlenText = (from, to) =>
    `floor ${from ?? 'none'} → ${to ?? 'none'}${to ? ` (${vlenExtension(to)})` : ''}`;
  const now = () => Date.now();

  // What a VLEN pick resolves to, as the builder will resolve it: a vector
  // extension can hold the floor above the pick (Zve64x requires Zvl64b), and
  // a change that does not happen must not be logged or recorded as one.
  const predictVlen = (bits) => {
    const desired = new Set(ids);
    for (const w of VLEN_CHOICES) if (bits === null || w > bits) desired.delete(`Zvl${w}b`);
    if (bits !== null) desired.add(`Zvl${bits}b`);
    const base = [...desired].find((x) => BASE_ISA_IDS.has(x)) ?? null;
    return impliedVlen(resolveSelection({ selected: [...desired], base }).resolved) ?? null;
  };

  // Each move checks that what it is about to reverse is still what it left:
  // a value or the extensions may have been changed elsewhere since (the
  // Configuration view, a share link), and undo must never act on a state it
  // did not produce. A move that no longer applies is dropped, and said so.
  const sameStored = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const sameIds = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  const stillApplies = (move, direction) => {
    const expect = direction === 'undo' ? 'after' : 'before';
    if (move.kind === 'param') return sameStored(values?.[move.name], move[expect]);
    if (move.kind === 'vlen') return (impliedVlen(ids) ?? null) === move[expect];
    if (move.kind === 'reset') {
      return Object.keys(move.before).every((n) =>
        direction === 'undo' ? values?.[n] === undefined : sameStored(values?.[n], move.before[n]),
      );
    }
    if (move.kind === 'config') {
      const side = move[expect];
      return sameIds(ids, side.ids) && sameStored(values ?? {}, side.values);
    }
    return false;
  };
  const describe = (move) =>
    move.kind === 'param'
      ? move.name
      : move.kind === 'vlen'
        ? 'the VLEN floor'
        : move.kind === 'reset'
          ? 'the reset'
          : 'the configuration';
  const apply = (move, direction) => {
    if (!stillApplies(move, direction)) {
      log([
        {
          t: now(),
          kind: direction,
          text: `skipped: ${describe(move)} changed elsewhere since, so it was left as it is`,
        },
      ]);
      return;
    }
    const value = direction === 'undo' ? move.before : move.after;
    if (move.kind === 'reset') {
      const names = Object.keys(move.before);
      log([
        {
          t: now(),
          kind: direction,
          text: `reset: ${direction === 'undo' ? 'restored' : 'cleared'} ${plural(names.length, 'value')}`,
        },
      ]);
      for (const name of names) onSetParam(name, direction === 'undo' ? move.before[name] : null);
    } else if (move.kind === 'vlen') {
      const from = direction === 'undo' ? move.after : move.before;
      log([
        { t: now(), kind: direction, target: VLEN_TARGET, text: `vlen ${vlenText(from, value)}` },
      ]);
      onSetVlen(value);
    } else if (move.kind === 'config') {
      log([
        {
          t: now(),
          kind: direction,
          text: `${move.label}: ${direction === 'undo' ? 'back to the previous' : 'again the'} configuration (${plural(value.ids.length, 'extension')}, ${plural(Object.keys(value.values).length, 'value')})`,
        },
      ]);
      onImport({ ids: value.ids, paramChoices: value.values, source: 'history' });
    } else {
      const entry = valueEntry(move.name, values?.[move.name], value);
      log([{ ...entry, kind: direction, text: `${entry.kind} ${entry.text}` }]);
      onSetParam(move.name, value ?? null);
    }
  };
  const undo = () => {
    const { move, history: next } = undoMove(historyRef.current);
    if (!move) return;
    record(next);
    apply(move, 'undo');
  };
  const redo = () => {
    const { move, history: next } = redoMove(historyRef.current);
    if (!move) return;
    record(next);
    apply(move, 'redo');
  };
  // The selected row: highlighted, and the Ask AI chip's question, the same
  // way a selected extension or instruction sets it elsewhere in the app.
  const [selected, setSelected] = useState(null);
  const setParam = (name, value) => {
    keep(name);
    setSelected(name);
    const before = values?.[name];
    if (sameStored(before, value)) return;
    log([valueEntry(name, before, value)]);
    record(
      pushMove(historyRef.current, {
        kind: 'param',
        name,
        before: before ?? null,
        after: value ?? null,
      }),
    );
    onSetParam(name, value);
  };
  // Clears every value set in the tab, as one move undo can reverse.
  const resetParams = () => {
    const before = { ...(values ?? {}) };
    const names = Object.keys(before);
    if (!names.length) return;
    log([{ t: now(), kind: 'reset', text: `cleared ${plural(names.length, 'value')}` }]);
    record(pushMove(historyRef.current, { kind: 'reset', before }));
    for (const name of names) onSetParam(name, null);
  };
  const setVlen = (bits) => {
    const from = impliedVlen(ids) ?? null;
    const to = predictVlen(bits);
    if (to === from) {
      log([
        {
          t: now(),
          kind: 'vlen',
          target: VLEN_TARGET,
          text:
            bits !== null && from !== null && bits < from
              ? `floor stays ${from}: a selected vector extension requires it`
              : `floor stays ${from ?? 'none'}`,
        },
      ]);
      return;
    }
    log([{ t: now(), kind: 'vlen', target: VLEN_TARGET, text: vlenText(from, to) }]);
    record(pushMove(historyRef.current, { kind: 'vlen', before: from, after: to }));
    onSetVlen(to);
  };
  // Ctrl/⌘+Z and Shift+Ctrl/⌘+Z, except while typing, where the field's own
  // undo belongs to the field.
  const undoRef = useRef(undo);
  const redoRef = useRef(redo);
  undoRef.current = undo;
  redoRef.current = redo;
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== 'z') return;
      if (e.defaultPrevented || e.isComposing) return;
      // The real target, through shadow roots: the Ask AI chat's input lives
      // in one, and its own undo must stay its own.
      const t = (e.composedPath?.()[0] ?? e.target) || null;
      const editable =
        t &&
        (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) ||
          t.isContentEditable ||
          ['textbox', 'combobox', 'searchbox'].includes(t.getAttribute?.('role')));
      if (editable) return;
      if (e.target && e.target !== t && e.target.shadowRoot) return;
      e.preventDefault();
      if (e.shiftKey) redoRef.current();
      else undoRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // From a log line to the thing it names: the VLEN section, or the
  // parameter's row, shown even if the current filter or search hides it.
  const jumpTo = (target) => {
    if (target === VLEN_TARGET) {
      document
        .getElementById('vlen-title')
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    if (!result?.params.some((p) => p.name === target && p.scope !== false)) return;
    setQuery('');
    keep(target);
    setSelected(target);
    requestAnimationFrame(() => {
      const row = document.getElementById(`param-${target}`);
      row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      row?.querySelector('button, input, select, [tabindex]')?.focus({ preventScroll: true });
    });
  };

  // A configuration replaced as a whole (restore, UDB import) is one move
  // undo can reverse: nothing that was there before is lost.
  const replaceConfig = (label, next, source) => {
    record(
      pushMove(historyRef.current, {
        kind: 'config',
        label,
        before: { ids: [...ids], values: { ...(values ?? {}) } },
        after: { ids: [...next.ids], values: { ...next.values } },
      }),
    );
    onImport({ ids: next.ids, paramChoices: next.values, source });
  };

  // Backup and restore: the configuration, its values and the log, as JSON.
  const [pendingRestore, setPendingRestore] = useState(null);
  const backup = () => {
    const { filename, text } = backupFile({ ids, values, entries });
    download(filename, text, 'application/json');
    log([
      {
        t: now(),
        kind: 'backup',
        text: `${filename}: ${plural(ids.length, 'extension')}, ${plural(Object.keys(values ?? {}).length, 'value')}`,
      },
    ]);
  };
  const restoreFile = (text) => {
    const knownIds = new Set((catalog ?? []).map((e) => e.id));
    const read = readBackup(text, {
      knownIds,
      knownParams: new Set(parameterNames()),
      bases: BASE_ISA_IDS,
    });
    setPendingRestore(read.ok ? read : { error: read.error });
  };
  const confirmRestore = () => {
    const r = pendingRestore;
    setPendingRestore(null);
    if (!r || r.error) return;
    // The current log is kept; the backup's log follows a marker, then the
    // restore itself, so both histories stay readable.
    const day = r.exported ? r.exported.slice(0, 10) : 'an unknown date';
    log([
      ...(r.log.length
        ? [{ t: now(), kind: 'session', text: `log from the backup of ${day} follows` }, ...r.log]
        : []),
      {
        t: now(),
        kind: 'restore',
        text:
          `${plural(r.ids.length, 'extension')}, ${plural(Object.keys(r.values).length, 'value')} from the backup of ${day}` +
          (r.dropped.length ? ` · left out: ${r.dropped.join(', ')}` : ''),
      },
    ]);
    replaceConfig('restore', { ids: r.ids, values: r.values }, 'backup');
  };
  const importConfig = (report) => {
    log([
      {
        t: now(),
        kind: 'import',
        text:
          `${report.name || 'UDB config'}: ${plural(report.ids.length, 'extension')}, ${plural(Object.keys(report.paramChoices).length, 'value')}` +
          (report.invalid?.length ? `, ${report.invalid.length} invalid` : ''),
      },
    ]);
    replaceConfig('import', { ids: report.ids, values: report.paramChoices }, 'udb');
  };
  // The last parameter a value was set on (set, change, clear, undo, redo):
  // its row carries a blinking bar, so the list shows where you are. Taken
  // from the log, so it survives a reload with it.
  const lastSetName = useMemo(() => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      // A VLEN change has no parameter name; it targets the VLEN section.
      const target = e.target ?? e.name;
      if (target && e.kind !== 'error' && e.kind !== 'ok') return target;
    }
    return null;
  }, [entries]);
  const selectedError = result?.params.find((p) => p.name === selected)?.errors[0] ?? null;
  useEffect(() => {
    if (!onAskContext) return;
    onAskContext(
      selected
        ? { query: paramQuestion(selected, { error: selectedError ?? undefined }), submit: true }
        : null,
    );
  }, [selected, selectedError, onAskContext]);
  useEffect(() => () => onAskContext?.(null), [onAskContext]);

  // Errors that appear or clear after a change are logged against it. The
  // first state seen is the baseline: it is summarised once, not replayed.
  const previousErrors = useRef(null);
  useEffect(() => {
    if (!result) return;
    const now = errorMap(result);
    if (previousErrors.current === null) {
      previousErrors.current = now;
      // Back in the tab after the extensions changed elsewhere: say what
      // changed and what it did to the parameters, so no invalid row or jump
      // in the counts is left unexplained.
      const seen = loadSeen();
      const diff = seen ? extensionDiff(seen, ids, result) : null;
      if (diff)
        log([{ t: Date.now(), kind: 'ext', text: diff }, ...errorEntries(seen.errors, now)]);
      saveSeen(ids, result);
      // Summarised once per page load, not on every return to the tab.
      if (sessionSummarised) return;
      sessionSummarised = true;
      const s = result.summary;
      log([
        {
          t: Date.now(),
          kind: 'session',
          text: `opened: ${s.set} of ${s.required} required set, ${s.invalid} invalid`,
        },
      ]);
      return;
    }
    log(errorEntries(previousErrors.current, now));
    previousErrors.current = now;
    saveSeen(ids, result);
    // Only the model's result drives this; log is a fresh closure each render.
  }, [result]);

  const shown = useMemo(() => {
    if (!result) return [];
    const q = query.trim().toLowerCase();
    return result.params.filter((p) => {
      if (p.scope === false) return false;
      if (kept.has(p.name)) return true;
      if (filter === 'unset' && !(p.scope === true && !p.set)) return false;
      if (filter === 'invalid' && p.errors.length === 0) return false;
      if (filter === 'fixed' && p.kind !== 'fixed') return false;
      if (filter === 'conditional' && p.scope !== null) return false;
      if (filter === 'all' && p.scope !== true) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        labelOf(p.name).toLowerCase().includes(q) ||
        groupOf(p.name).toLowerCase().includes(q)
      );
    });
  }, [result, filter, query, kept]);

  const groups = useMemo(() => {
    const map = new Map();
    for (const p of shown) {
      const g = groupOf(p.name);
      if (!map.has(g)) map.set(g, []);
      map.get(g).push(p);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [shown]);

  const importer = catalog && onImport && (
    <ImportPanel catalog={catalog} hasConfig={ids.length > 0} onImport={importConfig} />
  );
  const logPanel = (
    <ParamLog
      entries={entries}
      canUndo={history.past.length > 0}
      canRedo={history.future.length > 0}
      onUndo={undo}
      onRedo={redo}
      setCount={Object.keys(values ?? {}).length}
      onBackup={backup}
      onRestoreFile={restoreFile}
      pendingRestore={pendingRestore}
      onConfirmRestore={confirmRestore}
      onCancelRestore={() => setPendingRestore(null)}
      onRestoreError={(message) => setPendingRestore({ error: message })}
      onJump={jumpTo}
      onReset={resetParams}
      onClear={() => {
        clearLog();
        setEntries([]);
      }}
    />
  );
  if (!result) {
    return (
      <div className="params-layout">
        <section style={{ minWidth: 0 }}>
          {importer}
          <p style={{ color: 'var(--riscv-text-2)', fontSize: 13 }}>
            Pick a base ISA first, import a UDB config, or restore a parameter backup from the log:
            parameters depend on the base.
          </p>
        </section>
        {logPanel}
      </div>
    );
  }
  const { summary } = result;
  const counts = {
    unset: summary.required - summary.set,
    invalid: summary.invalid,
    all: summary.required,
    fixed: result.params.filter((p) => p.kind === 'fixed' && p.scope !== false).length,
    conditional: result.params.filter((p) => p.scope === null).length,
  };

  return (
    <div className="params-layout">
      <section aria-labelledby="params-title" style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 12 }}>
          <h2 id="params-title" style={{ margin: 0, fontSize: 18, color: 'var(--riscv-text)' }}>
            Parameters
          </h2>
          <span role="status" style={{ fontSize: 13, color: 'var(--riscv-text-2)' }}>
            {summary.set} of {summary.required} required parameters set
            {summary.invalid ? ` · ${summary.invalid} invalid` : ''}
          </span>
        </div>
        <p
          style={{
            fontSize: 12.5,
            color: 'var(--riscv-text-2)',
            margin: '6px 0 14px',
            maxWidth: 820,
          }}
        >
          What riscv-unified-db requires for this configuration, with each value checked against its
          schema and UDB&apos;s rules. Values you set go into the UDB config export in place of
          TODO. This checks consistency with UDB, not hardware compliance.
        </p>
        {importer}
        <ConflictNotice ids={ids} />
        {onSetVlen && (
          <VlenPicker ids={ids} onSetVlen={setVlen} current={lastSetName === VLEN_TARGET} />
        )}
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 8,
            alignItems: 'center',
            marginBottom: 12,
          }}
        >
          <div role="group" aria-label="Show" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                aria-pressed={filter === f.key}
                onClick={() => setFilter(f.key)}
                style={chip(filter === f.key)}
              >
                {f.label} {counts[f.key]}
              </button>
            ))}
          </div>
          <label style={{ position: 'relative', marginLeft: 'auto' }}>
            <Search
              size={13}
              aria-hidden="true"
              style={{ position: 'absolute', left: 8, top: 7, color: 'var(--riscv-text-2)' }}
            />
            <input
              type="search"
              aria-label="Search parameters"
              placeholder="Search parameters"
              value={query}
              onChange={(e) => {
                setKept(new Set());
                setQuery(e.target.value);
              }}
              style={{ ...control, paddingLeft: 26, width: 220, fontFamily: 'inherit' }}
            />
          </label>
        </div>
        {groups.length === 0 && (
          <p style={{ fontSize: 13, color: 'var(--riscv-text-2)' }}>
            {filter === 'unset' ? 'Every required parameter is set.' : 'No parameters match.'}
          </p>
        )}
        {groups.map(([group, params]) => (
          <details
            key={group}
            open
            style={{
              marginBottom: 10,
              borderRadius: 10,
              border: '1px solid var(--riscv-border)',
              background: 'var(--riscv-surface)',
            }}
          >
            <summary
              style={{
                padding: '10px 12px',
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: 700,
                color: 'var(--riscv-text)',
              }}
            >
              {group}{' '}
              <span style={{ fontWeight: 500, color: 'var(--riscv-text-2)' }}>
                · {params.length}
              </span>
            </summary>
            {params.map((p) => (
              <ParamRow
                key={p.name}
                p={p}
                stored={values?.[p.name]}
                onSetParam={setParam}
                selected={selected === p.name}
                onSelect={setSelected}
                current={lastSetName === p.name}
              />
            ))}
          </details>
        ))}
      </section>
      {logPanel}
    </div>
  );
}
