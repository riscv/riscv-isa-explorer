/**
 * CompareView — N extensions or N instructions in aligned columns.
 *
 * It renders whatever compareModel hands it and knows nothing about the
 * catalog: a row carries its own label, its cells, whether the items agree, and
 * the name of a renderer. Adding a field to a comparison is a change to the
 * model, not to this file.
 *
 * Dimming the rows that agree is the point of the whole feature. A wall of
 * identical values is what makes two detail panels hard to compare by eye; the
 * differences have to be the thing that stands out.
 */
import React from 'react';
import { X, Copy, Link2, GitCompare } from 'lucide-react';
import { toMarkdown } from './compareModel.js';
import { focusableWithin, nextFocus } from './focusTrap.js';
import EncodingDiagram from './EncodingDiagram.jsx';

function Cell({ row, value, bitDiff }) {
  if (row.render !== 'presence' && (value === null || value === undefined)) {
    return <span style={{ color: 'var(--riscv-text-3)' }}>—</span>;
  }

  if (row.render === 'encoding') {
    return <EncodingDiagram encoding={value} diffMask={bitDiff} />;
  }

  if (row.render === 'presence') {
    // A mark rather than the word "true": the question a presence row answers
    // is "is this in the profile", and a column of `true`/`false` reads far
    // worse across forty rows than a column of ticks and dashes.
    //
    // Colour is spent only where the profiles disagree. When every profile
    // has an extension the marks go muted, because a green tick that means
    // "same as everywhere else" is noise competing with the rows that matter.
    // In a differing row present reads green and absent reads red, so a gap
    // is findable at a glance. The tick/dash shapes carry the same
    // information, so nothing depends on telling red from green.
    const tone = row.allSame
      ? 'var(--riscv-text-3)'
      : value
        ? 'var(--riscv-success)'
        : 'var(--riscv-danger)';
    return value ? (
      <span aria-label="present" style={{ color: tone, fontWeight: row.allSame ? 400 : 700 }}>
        &#10003;
      </span>
    ) : (
      <span aria-label="absent" style={{ color: tone, fontWeight: row.allSame ? 400 : 700 }}>
        &mdash;
      </span>
    );
  }

  if (row.render === 'chips') {
    return (
      <div className="compare-chips flex flex-wrap gap-1">
        {value.map((item) => (
          <span
            key={item}
            className="px-1.5 py-0.5 rounded-sm border text-[11px] font-mono"
            style={{
              borderColor: 'var(--riscv-border-2)',
              background: 'var(--riscv-surface-2)',
              color: 'var(--riscv-text-2)',
            }}
          >
            {item}
          </span>
        ))}
      </div>
    );
  }

  if (row.render === 'link') {
    return (
      <a
        href={value}
        target="_blank"
        rel="noreferrer noopener"
        className="text-[11px] underline break-all"
        style={{ color: 'var(--riscv-gold)' }}
      >
        {value}
      </a>
    );
  }

  if (row.render === 'mono') {
    return <span className="font-mono text-[12px]">{value}</span>;
  }

  return <span className="text-[12px] leading-snug">{value}</span>;
}

export default function CompareView({
  open,
  model,
  onClose,
  onRemoveItem,
  onCopyMarkdown,
  onCopyLink,
  expandDeps,
  onToggleExpandDeps,
}) {
  const [differencesOnly, setDifferencesOnly] = React.useState(false);
  const dialogRef = React.useRef(null);
  const restoreFocusRef = React.useRef(null);

  // Held in a ref, not a dependency, so a caller passing an inline arrow
  // (a new function identity on every parent render) cannot re-run this
  // effect. A re-run while open steals focus: the cleanup restores focus to
  // the trigger behind the modal, then the effect immediately re-focuses the
  // dialog container, yanking focus away from whatever the user was doing —
  // e.g. every parent render while a toast is counting down to auto-clear.
  const onCloseRef = React.useRef(onClose);
  React.useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  React.useEffect(() => {
    if (!open) return undefined;
    restoreFocusRef.current = document.activeElement;
    dialogRef.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      // Hold Tab inside the dialog. Without this it walks out into the page
      // behind the backdrop, which is still focusable and now invisible.
      if (e.key !== 'Tab') return;
      const target = nextFocus(
        focusableWithin(dialogRef.current),
        document.activeElement,
        e.shiftKey,
      );
      if (target) {
        e.preventDefault();
        target.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const restore = restoreFocusRef.current;
      if (restore && typeof restore.focus === 'function') restore.focus();
    };
  }, [open]);

  if (!open || !model || model.columns.length === 0) return null;

  // Agreement is context, difference is the signal.
  const rows = differencesOnly ? model.rows.filter((r) => !r.allSame) : model.rows;
  const differing = model.rows.filter((r) => !r.allSame).length;
  const heading =
    model.kind === 'instr'
      ? 'Instruction Comparison'
      : model.kind === 'profile'
        ? 'Profile Comparison'
        : 'Extension Comparison';
  const colMinWidth = model.kind === 'instr' ? '330px' : '260px';
  const gridColumns = `minmax(140px, 180px) repeat(${model.columns.length}, minmax(${colMinWidth}, 1fr))`;

  return (
    <div className="fixed inset-0 z-50">
      {/* Backdrop */}
      <div
        className="absolute inset-0"
        style={{ background: 'rgba(7,7,14,0.85)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}
        onClick={onClose}
        role="presentation"
      />

      <div className="absolute inset-0 p-3 md:p-6 lg:p-8 flex items-start justify-center">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="compare-view-title"
          tabIndex={-1}
          className="animate-scale-in riscv-card w-full h-full flex flex-col overflow-hidden"
          style={{
            boxShadow: '0 0 70px rgba(0,0,0,0.85), 0 0 0 1px rgba(245,197,66,0.18)',
            borderRadius: 20,
          }}
        >
          {/* Header Bar */}
          <div
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 px-5 py-3.5"
            style={{
              borderBottom: '1px solid var(--riscv-border-2)',
              background: 'var(--riscv-surface)',
            }}
          >
            <div className="flex items-center gap-3 flex-wrap min-w-0">
              <h2
                id="compare-view-title"
                className="text-[14px] font-bold uppercase tracking-wider inline-flex items-center gap-2"
                style={{ color: 'var(--riscv-violet)' }}
              >
                <GitCompare size={16} /> {heading}
              </h2>

              <span
                className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-mono"
                style={{
                  background: differing > 0 ? 'rgba(139, 124, 248, 0.12)' : 'var(--riscv-surface-2)',
                  color: differing > 0 ? 'var(--riscv-violet)' : 'var(--riscv-text-3)',
                  border: `1px solid ${differing > 0 ? 'rgba(139, 124, 248, 0.3)' : 'var(--riscv-border-2)'}`,
                }}
              >
                <strong>{differing}</strong> of {model.rows.length} {model.kind === 'profile' ? 'rows' : 'attributes'} differ
              </span>

              {model.kind === 'profile' && (
                <span className="text-[11px] font-mono hidden md:inline" style={{ color: 'var(--riscv-text-3)' }}>
                  {model.expandedDependencies ? '(with implied extensions)' : '(as listed in the specification)'}
                </span>
              )}
            </div>

            {/* Toolbar Controls */}
            <div className="flex flex-wrap items-center gap-3 ml-auto">
              {/* Differences Only Precision Switch */}
              <button
                type="button"
                role="switch"
                aria-checked={differencesOnly}
                onClick={() => setDifferencesOnly((v) => !v)}
                className="inline-flex items-center gap-2 text-[12px] font-medium cursor-pointer select-none"
                style={{ color: 'var(--riscv-text-2)' }}
              >
                <span className="riscv-switch" data-checked={differencesOnly}>
                  <span className="riscv-switch-thumb" />
                </span>
                <span>Differences only</span>
              </button>

              {/* Profile Implied Extensions Switch */}
              {model.kind === 'profile' && (
                <button
                  type="button"
                  role="switch"
                  aria-checked={Boolean(expandDeps)}
                  onClick={() => onToggleExpandDeps(!expandDeps)}
                  className="inline-flex items-center gap-2 text-[12px] font-medium cursor-pointer select-none"
                  style={{ color: 'var(--riscv-text-2)' }}
                  title="Expand lists through the dependency graph to show what a conforming implementation provides"
                >
                  <span className="riscv-switch" data-checked={Boolean(expandDeps)}>
                    <span className="riscv-switch-thumb" />
                  </span>
                  <span>Include implied</span>
                </button>
              )}

              <div className="h-4 w-px mx-0.5" style={{ background: 'var(--riscv-border-2)' }} />

              {/* Actions */}
              <button
                type="button"
                className="riscv-btn px-2.5 py-1.5 text-[11px] inline-flex items-center gap-1.5 font-medium"
                onClick={() => onCopyMarkdown(toMarkdown(model, { differencesOnly }))}
                title="Copy comparison as Markdown table"
              >
                <Copy size={12} className="opacity-75" />
                <span>Markdown</span>
              </button>

              <button
                type="button"
                className="riscv-btn px-2.5 py-1.5 text-[11px] inline-flex items-center gap-1.5 font-medium"
                onClick={onCopyLink}
                title="Copy shareable permalink for this comparison"
              >
                <Link2 size={12} className="opacity-75" />
                <span>Share Link</span>
              </button>

              <button
                type="button"
                className="riscv-btn p-1.5"
                onClick={onClose}
                aria-label="Close comparison"
              >
                <X size={15} />
              </button>
            </div>
          </div>

          {/* Grid View */}
          <div className="flex-1 overflow-auto">
            <div className="compare-grid" style={{ gridTemplateColumns: gridColumns }}>
              <div className="compare-head compare-attr" />
              {model.columns.map((col) => (
                <div key={col.key} className="compare-head">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 pr-1">
                      <div
                        className="font-mono text-[13px] font-bold truncate"
                        style={{ color: 'var(--riscv-text)' }}
                      >
                        {col.label}
                      </div>
                      {col.sublabel && col.sublabel !== col.label && (
                        <div className="text-[11px] font-mono mt-0.5 truncate" style={{ color: 'var(--riscv-text-3)' }}>
                          {col.sublabel}
                        </div>
                      )}
                    </div>
                    {onRemoveItem && (
                      <button
                        type="button"
                        onClick={() => onRemoveItem(model.kind, col.key)}
                        title={`Remove ${col.label} from comparison`}
                        aria-label={`Remove ${col.label} from comparison`}
                        className="riscv-dock-chip-x p-1 shrink-0"
                      >
                        <X size={12} />
                      </button>
                    )}
                  </div>
                </div>
              ))}

              {rows.map((row) => (
                <React.Fragment key={row.key}>
                  <div
                    className={`compare-attr compare-cell ${row.allSame ? 'compare-same' : 'compare-diff'}`}
                  >
                    {row.label}
                  </div>
                  {row.cells.map((value, i) => (
                    <div
                      key={`${row.key}-${model.columns[i].key}`}
                      className={`compare-cell ${row.allSame ? 'compare-same' : 'compare-diff'}`}
                    >
                      <Cell row={row} value={value} bitDiff={model.bitDiff} />
                    </div>
                  ))}
                </React.Fragment>
              ))}
            </div>

            {rows.length === 0 && (
              <div className="p-12 text-center space-y-2">
                <div className="text-sm font-semibold" style={{ color: 'var(--riscv-text-2)' }}>
                  All attributes are identical
                </div>
                <div className="text-[12px]" style={{ color: 'var(--riscv-text-3)' }}>
                  These items agree on every compared attribute. Toggle off "Differences only" to view the full specification.
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
