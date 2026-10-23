import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Maximize2, X } from 'lucide-react';
import {
  accessInfo,
  conditionTerms,
  csrDependsOnXlen,
  csrFields,
  csrRows,
  csrWidth,
  formatAddress,
  groupCsrNames,
  resetLabel,
} from './csrLayout.js';

// Names longer than this many characters per bit are set vertically, the way
// the ISA manual's register diagrams label one-bit fields. That suits the side
// panel; the expanded view measures its diagram instead (expandedCharsPerBit),
// since it is three times as wide on a desktop and no wider on a phone.
const CHARS_PER_BIT = 1.6;
// A field name is 10px bold monospace, about 6px a character, plus padding.
const PX_PER_CHAR = 7;
const BITS_PER_ROW = 32;

function expandedCharsPerBit(diagramWidth) {
  return Math.max(CHARS_PER_BIT, diagramWidth / BITS_PER_ROW / PX_PER_CHAR);
}

const KIND_LEGEND = [
  { kind: 'rw', label: 'Software writable' },
  { kind: 'hw', label: 'Hardware also updates' },
  { kind: 'ro', label: 'Read-only' },
  { kind: 'cfg', label: 'Depends on configuration' },
];

function isVertical(segment, charsPerBit) {
  return segment.field && segment.field.name.length > segment.width * charsPerBit;
}

function DiagramRow({ row, active, onHover, onPick, charsPerBit }) {
  const tall = row.segments.some((segment) => isVertical(segment, charsPerBit));
  return (
    <div
      className="riscv-csr-row"
      style={{ gridTemplateColumns: `repeat(${row.bits}, minmax(0, 1fr))` }}
    >
      {row.segments.map((segment) => {
        const { field } = segment;
        const span =
          segment.high === segment.low ? `${segment.high}` : `${segment.high}:${segment.low}`;
        const kind = field ? accessInfo(field.type).kind : 'gap';
        const vertical = isVertical(segment, charsPerBit);
        return (
          <div
            key={`${segment.high}-${segment.low}`}
            title={
              field
                ? `${field.name} [${span}] · ${accessInfo(field.type).meaning}`
                : `Bits ${span}: no field described here`
            }
            className={`riscv-csr-cell riscv-csr-cell--${kind}${field && active === field.name ? ' is-active' : ''}`}
            style={{ gridColumn: `span ${segment.width}`, minHeight: tall ? 84 : 44 }}
            onMouseEnter={field ? () => onHover(field.name) : undefined}
            onMouseLeave={field ? () => onHover(null) : undefined}
            onClick={field ? () => onPick(field.name) : undefined}
          >
            <span className="riscv-csr-bits">
              <span>{segment.high}</span>
              {segment.width > 1 && <span>{segment.low}</span>}
            </span>
            {field && (
              <span className={`riscv-csr-name${vertical ? ' is-vertical' : ''}`}>
                {field.name}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

const CHIP = 'riscv-csr-pick';
const CHIP_OFF = '';
const CHIP_ON = 'is-on';

/**
 * The extension's CSRs as chips, numbered families folded into one chip that
 * opens a strip of its members. The family holding the selected CSR opens by
 * itself, so a search hit on pmpaddr12 lands with its family visible.
 */
export function CsrChipList({ csrs, selected, onSelect }) {
  const items = useMemo(() => groupCsrNames(Object.keys(csrs)), [csrs]);
  const [openKey, setOpenKey] = useState(null);
  const selectedFamily = items.find(
    (item) => item.kind === 'family' && item.members.some((m) => m.name === selected),
  );
  const open = openKey ?? selectedFamily?.key ?? null;
  const openFamily = items.find((item) => item.key === open);

  const tip = (name) => {
    const csr = csrs[name] || {};
    return [csr.desc, csr.address, csr.priv_mode && `${csr.priv_mode}-mode`]
      .filter(Boolean)
      .join(' · ');
  };

  return (
    <>
      <div className="flex flex-wrap gap-1">
        {items.map((item) =>
          item.kind === 'family' ? (
            <button
              type="button"
              key={item.key}
              aria-expanded={open === item.key}
              onClick={() => setOpenKey(open === item.key ? '' : item.key)}
              title={`${item.members.length} registers: ${tip(item.members[0].name)}`}
              className={`${CHIP} riscv-csr-family ${selectedFamily === item ? CHIP_ON : CHIP_OFF}`}
            >
              {item.label.toUpperCase()}
              <span className="riscv-csr-family-count">{item.members.length}</span>
            </button>
          ) : (
            <button
              type="button"
              key={item.name}
              aria-pressed={selected === item.name}
              onClick={() => onSelect(item.name)}
              title={tip(item.name) || undefined}
              className={`${CHIP} ${selected === item.name ? CHIP_ON : CHIP_OFF}`}
            >
              {item.name.toUpperCase()}
            </button>
          ),
        )}
      </div>
      {openFamily && (
        <div
          className="riscv-csr-members"
          role="group"
          aria-label={`${openFamily.label.toUpperCase()} registers`}
        >
          {openFamily.members.map((member) => (
            <button
              type="button"
              key={member.name}
              aria-pressed={selected === member.name}
              aria-label={member.name.toUpperCase()}
              title={tip(member.name) || undefined}
              onClick={() => onSelect(member.name)}
              className={`${CHIP} ${selected === member.name ? CHIP_ON : CHIP_OFF}`}
            >
              {member.index}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/*
 * `xlen` and `onXlenChange` are optional: given them, the caller owns the
 * RV32/RV64 choice, so the panel and its expanded view show the same width.
 * `onExpand` adds an Expand button; `expanded` marks the copy inside the
 * full-width dialog, which has no Expand of its own.
 */
export default function CsrDetails({
  name,
  csr,
  owners = [],
  onClose,
  onExpand,
  expanded = false,
  headingId,
  xlen: xlenProp,
  onXlenChange,
}) {
  const [xlenOwn, setXlenOwn] = useState(64);
  const xlen = xlenProp ?? xlenOwn;
  const setXlen = onXlenChange ?? setXlenOwn;
  const [active, setActive] = useState(null);
  const rowRefs = useRef(new Map());
  const diagramRef = useRef(null);
  const [diagramWidth, setDiagramWidth] = useState(0);
  useEffect(() => {
    const node = diagramRef.current;
    if (!expanded || !node || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(([entry]) => setDiagramWidth(entry.contentRect.width));
    observer.observe(node);
    return () => observer.disconnect();
  }, [expanded]);
  const charsPerBit = expanded ? expandedCharsPerBit(diagramWidth) : CHARS_PER_BIT;
  const width = csrWidth(csr, xlen);
  const { fields, otherXlen } = useMemo(() => csrFields(csr, xlen), [csr, xlen]);
  const rows = useMemo(() => csrRows(fields, width), [fields, width]);
  const placed = fields.filter((field) => field.range);
  const kinds = new Set(placed.map((field) => accessInfo(field.type).kind));
  const hasGap = rows.some((row) => row.segments.some((segment) => !segment.field));
  const lengthLabel = csr?.length === 'MXLEN' ? `MXLEN (${width} bits)` : `${width} bits`;

  const pick = (fieldName) => {
    setActive(fieldName);
    rowRefs.current.get(fieldName)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  return (
    <section
      aria-label={`${name} CSR details`}
      className={`riscv-csr${expanded ? ' is-expanded' : ' mt-3'}`}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 id={headingId} className="riscv-csr-title">
            <span className="font-mono">{name.toUpperCase()}</span>
            {csr?.desc && <span className="riscv-csr-desc">{csr.desc}</span>}
          </h4>
          <dl className="riscv-csr-meta">
            <div>
              <dt>Address</dt>
              <dd className="font-mono">{formatAddress(csr?.address)}</dd>
            </div>
            {csr?.priv_mode && (
              <div>
                <dt>Mode</dt>
                <dd>{csr.priv_mode}</dd>
              </div>
            )}
            <div>
              <dt>Width</dt>
              <dd>{lengthLabel}</dd>
            </div>
            {owners.length > 0 && (
              <div>
                <dt>Listed with</dt>
                <dd>{owners.join(', ')}</dd>
              </div>
            )}
          </dl>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {onExpand && !expanded && (
            <button
              type="button"
              className="inline-flex items-center gap-1 px-2 py-1 riscv-btn riscv-btn-violet"
              onClick={onExpand}
              aria-label={`Expand ${name.toUpperCase()} details to full view`}
              title="Expand to full view"
            >
              <Maximize2 size={12} aria-hidden="true" />
              Expand
            </button>
          )}
          <button
            type="button"
            className="riscv-btn p-1"
            onClick={onClose}
            aria-label={
              expanded
                ? `Close expanded ${name.toUpperCase()} view`
                : `Close ${name.toUpperCase()} details`
            }
            title={expanded ? 'Close expanded view (Esc)' : 'Close'}
          >
            <X size={14} />
          </button>
        </div>
      </header>

      {csrDependsOnXlen(csr) && (
        <div className="riscv-csr-xlen" role="group" aria-label="Register width">
          {[32, 64].map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={xlen === value}
              onClick={() => {
                setXlen(value);
                setActive(null);
              }}
            >
              RV{value}
            </button>
          ))}
        </div>
      )}

      {placed.length > 0 && (
        <>
          <div
            ref={diagramRef}
            className="riscv-csr-diagram"
            role="img"
            aria-label={`${name.toUpperCase()} bit layout, ${width} bits: ${placed
              .map(
                (field) =>
                  `${field.name} ${field.range.high}${field.range.high === field.range.low ? '' : `-${field.range.low}`}`,
              )
              .join(', ')}`}
          >
            {rows.map((row) => (
              <DiagramRow
                key={row.high}
                row={row}
                active={active}
                onHover={setActive}
                onPick={pick}
                charsPerBit={charsPerBit}
              />
            ))}
          </div>
          <ul className="riscv-csr-legend" aria-label="Access types">
            {KIND_LEGEND.filter(({ kind }) => kinds.has(kind)).map(({ kind, label }) => (
              <li key={kind}>
                <span className={`riscv-csr-swatch riscv-csr-cell--${kind}`} aria-hidden="true" />
                {label}
              </li>
            ))}
            {hasGap && (
              <li>
                <span className="riscv-csr-swatch riscv-csr-cell--gap" aria-hidden="true" />
                No field described
              </li>
            )}
          </ul>
        </>
      )}

      {fields.length > 0 && (
        <div className="riscv-csr-table-wrap">
          <table className="riscv-csr-table">
            <thead>
              <tr>
                <th scope="col">Bits</th>
                <th scope="col">Field</th>
                <th scope="col">Access</th>
                <th scope="col">Reset</th>
                <th scope="col">Present when</th>
              </tr>
            </thead>
            <tbody>
              {fields.map((field) => {
                const access = accessInfo(field.type);
                const terms = conditionTerms(field.defined_by, xlen);
                const bits = field.range
                  ? field.range.high === field.range.low
                    ? `${field.range.high}`
                    : `${field.range.high}:${field.range.low}`
                  : '—';
                return (
                  <tr
                    key={field.name}
                    ref={(node) => {
                      if (node) rowRefs.current.set(field.name, node);
                      else rowRefs.current.delete(field.name);
                    }}
                    className={active === field.name ? 'is-active' : undefined}
                    onMouseEnter={() => setActive(field.name)}
                    onMouseLeave={() => setActive(null)}
                  >
                    <td className="font-mono whitespace-nowrap">{bits}</td>
                    <td className="font-mono font-semibold">{field.name}</td>
                    <td>
                      <span
                        className={`riscv-csr-chip riscv-csr-cell--${access.kind}`}
                        title={access.meaning}
                      >
                        {access.label}
                      </span>
                    </td>
                    <td className="whitespace-nowrap">
                      <span
                        className={
                          /^\d+$/.test(String(field.reset)) ? 'font-mono' : 'riscv-csr-muted'
                        }
                      >
                        {resetLabel(field.reset)}
                      </span>
                    </td>
                    <td>
                      {terms.length === 0 ? (
                        <span className="riscv-csr-muted">Always</span>
                      ) : (
                        <span className="riscv-csr-terms">
                          {terms.map((term) => (
                            <span key={term} className="riscv-csr-term">
                              {term}
                            </span>
                          ))}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="riscv-csr-notes">
        {otherXlen > 0 && (
          <p>
            {otherXlen} {otherXlen === 1 ? 'field exists' : 'fields exist'} only in RV
            {xlen === 64 ? 32 : 64}.
          </p>
        )}
        {placed.length !== fields.length && (
          <p>Fields marked — have a position that depends on the configuration.</p>
        )}
        {!csr?.fields && <p>Field data is not available in the current catalogue source.</p>}
        {csr?.fields && Object.keys(csr.fields).length === 0 && (
          <p>The source defines this CSR but does not provide a field map yet.</p>
        )}
        <p>
          From riscv-unified-db. &ldquo;Config&rdquo; access and reset values depend on the
          implementation&rsquo;s parameters.{' '}
          {csr?.source && (
            <a href={csr.source} target="_blank" rel="noreferrer">
              View source
            </a>
          )}
        </p>
      </div>
    </section>
  );
}
