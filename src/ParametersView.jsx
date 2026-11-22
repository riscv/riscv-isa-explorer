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
import React, { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { parameterDefinition } from './isaParams.js';
import { impliedVlen, resolveParams, vlenExtension } from './isaGraph.js';
import { importUdbConfig, NOT_CHECKED_HERE } from './udbImport.js';
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
    return (
      <span style={{ ...control, display: 'inline-block', opacity: 0.85 }}>
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

function ParamRow({ p, stored, onSetParam }) {
  const definition = parameterDefinition(p.name);
  const state = stateLine(p);
  const invalid = p.errors.length > 0;
  return (
    <div
      id={`param-${p.name}`}
      style={{
        display: 'grid',
        // One column on a phone, two side by side when there is room.
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))',
        gap: '6px 16px',
        alignItems: 'start',
        padding: '10px 12px',
        borderTop: '1px solid var(--riscv-tint-2)',
        borderLeft: `3px solid ${invalid ? 'var(--riscv-danger)' : p.set ? 'var(--riscv-gold)' : 'transparent'}`,
      }}
    >
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
        <ParamEditor p={p} stored={stored} onSet={(v) => onSetParam(p.name, v)} />
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

const VLEN_CHOICES = [32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];

/**
 * The guaranteed vector length (#606), moved here from the Configuration
 * view's Implementation Parameters card so parameters live in one place. It
 * changes extensions, not a value: VLEN has no -march flag, so the floor is a
 * Zvl*b extension, and the -march string follows.
 */
function VlenPicker({ ids, onSetVlen }) {
  const vlen = impliedVlen(ids);
  return (
    <section
      aria-labelledby="vlen-title"
      style={{
        marginBottom: 16,
        padding: '10px 12px',
        borderRadius: 10,
        border: '1px solid var(--riscv-border)',
        background: 'var(--riscv-surface)',
      }}
    >
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
                ? `Readable${report.name ? `: ${report.name}` : ''}. ${report.ids.length} extensions, ${Object.keys(report.paramChoices).length} parameter values.`
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

export default function ParametersView({ ids, values, onSetParam, catalog, onImport, onSetVlen }) {
  const [filter, setFilter] = useState('unset');
  const [query, setQuery] = useState('');
  const result = useMemo(() => builderParamStates(ids, values), [ids, values]);

  const shown = useMemo(() => {
    if (!result) return [];
    const q = query.trim().toLowerCase();
    return result.params.filter((p) => {
      if (p.scope === false) return false;
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
  }, [result, filter, query]);

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
    <ImportPanel catalog={catalog} hasConfig={ids.length > 0} onImport={onImport} />
  );
  if (!result) {
    return (
      <section style={{ maxWidth: 1100, margin: '0 auto' }}>
        {importer}
        <p style={{ color: 'var(--riscv-text-2)', fontSize: 13 }}>
          Pick a base ISA first, or import a UDB config: parameters depend on the base.
        </p>
      </section>
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
    <section aria-labelledby="params-title" style={{ maxWidth: 1100, margin: '0 auto' }}>
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
        schema and UDB&apos;s rules. Values you set go into the UDB config export in place of TODO.
        This checks consistency with UDB, not hardware compliance.
      </p>
      {importer}
      <ConflictNotice ids={ids} />
      {onSetVlen && <VlenPicker ids={ids} onSetVlen={onSetVlen} />}
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
            onChange={(e) => setQuery(e.target.value)}
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
            <span style={{ fontWeight: 500, color: 'var(--riscv-text-2)' }}>· {params.length}</span>
          </summary>
          {params.map((p) => (
            <ParamRow key={p.name} p={p} stored={values?.[p.name]} onSetParam={onSetParam} />
          ))}
        </details>
      ))}
    </section>
  );
}
