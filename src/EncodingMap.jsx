import React from 'react';
import { Grid3x3, X } from 'lucide-react';
import { barWidth, buildEncodingMap, FREE_SLOT_KINDS } from './encodingMap.js';

/**
 * The RISC-V opcode map, drawn from the catalogue.
 *
 * Derived at runtime from src/riscv_extensions.json, the same source the tiles
 * and the builder read. There is no generated asset behind this and nothing to
 * regenerate: sync the catalogue and the map follows.
 *
 * Plain markup and CSS grid, no charting library. The layout is a 4x8 table and
 * the quantities are small integers, so d3 would have added 87 KB or more to
 * compute what a division already does.
 *
 * Density is a bar, not a colour wash. The first version shaded the whole cell
 * and it failed on both counts. Contrast collapsed exactly where the data
 * mattered most, because --riscv-gold is bright on the dark theme, so the
 * busiest cells became pale plates under pale text: OP-V measured 2.56:1
 * against a 4.5:1 floor, and seven more cells failed with it. And colour is a
 * poor channel for quantity, so JAL with 1, MADD with 4 and MISC-MEM with 7
 * were indistinguishable. A bar on a constant surface fixes both: the text
 * contrast no longer varies with the data at all, and the number is right there
 * beside the bar when the bar is too short to compare.
 */

const CATEGORY_LABEL = {
  vendor: 'custom',
  reserved: 'reserved',
  wide: '> 32-bit',
  unassigned: 'unassigned',
};

const CATEGORY_COLOUR = {
  vendor: 'var(--riscv-accent-4)',
  reserved: 'var(--riscv-text-3)',
  wide: 'var(--riscv-accent-8)',
  unassigned: 'var(--riscv-text-3)',
};

function Cell({ cell, total, selected, onSelect }) {
  const isFree = cell.count === 0;
  const colour = CATEGORY_COLOUR[cell.category] ?? 'var(--riscv-text-3)';
  const label = CATEGORY_LABEL[cell.category] ?? 'unassigned';
  return (
    <button
      type="button"
      onClick={() => onSelect(selected ? null : cell)}
      title={`${cell.name} · opcode 0x${cell.opcode.toString(16).padStart(2, '0')} · inst[6:5]=${cell.colBits} inst[4:2]=${cell.rowBits} · ${cell.count} instruction${cell.count === 1 ? '' : 's'}`}
      className="slot-cell text-left rounded px-2 py-1.5"
      style={{
        borderStyle: isFree ? 'dashed' : 'solid',
        borderColor: isFree ? colour : 'var(--riscv-border-2)',
        ...(selected ? { outline: '2px solid var(--riscv-gold)', outlineOffset: 1 } : null),
      }}
    >
      <div className="flex items-baseline justify-between gap-1">
        <span
          className="font-mono text-[10.5px] leading-tight truncate"
          style={{ color: 'var(--riscv-text)' }}
        >
          {cell.name}
        </span>
        <span className="font-mono text-[9px] shrink-0" style={{ color: 'var(--riscv-text-3)' }}>
          0x{cell.opcode.toString(16).padStart(2, '0')}
        </span>
      </div>

      {isFree ? (
        <div className="font-mono text-[9.5px] mt-1 truncate" style={{ color: colour }}>
          {/* The slot named "reserved" would otherwise read "reserved / reserved". */}
          {label === cell.name.toLowerCase() ? '—' : label}
        </div>
      ) : (
        <div className="flex items-center gap-1.5 mt-1">
          <span className="slot-bar-track" aria-hidden="true">
            <span className="slot-bar-fill" style={{ width: `${barWidth(cell.count, total)}%` }} />
          </span>
          {/* Fixed width, or the number steals track from its own bar: a cell
              showing 349 had a 189px track while one showing 4 had 201px, so
              equal shares rendered as unequal lengths and the busiest cells got
              the shortest tracks. */}
          <span className="slot-count font-mono text-[10px] tabular-nums">{cell.count}</span>
        </div>
      )}
    </button>
  );
}

export default function EncodingMap({
  open,
  onClose,
  catalog,
  sandboxExtensions = [],
  onSelectExtension,
  onOpenSandbox,
}) {
  const map = React.useMemo(
    () => (open ? buildEncodingMap(catalog, sandboxExtensions) : null),
    [open, catalog, sandboxExtensions],
  );
  const [selected, setSelected] = React.useState(null);
  const dialogRef = React.useRef(null);
  const triggerRef = React.useRef(null);

  // Same keyboard contract as the Encoder Validator: Escape closes, focus is
  // trapped and wraps, and it returns to whatever opened the dialog.
  React.useEffect(() => {
    if (!open) return undefined;
    const opener = document.activeElement;
    triggerRef.current = opener instanceof HTMLElement && opener !== document.body ? opener : null;

    const FOCUSABLE =
      'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusable = () =>
      [...(dialogRef.current?.querySelectorAll(FOCUSABLE) ?? [])].filter(
        (el) => el.offsetWidth > 0 || el.offsetHeight > 0,
      );

    focusable()[0]?.focus();

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const outside = !dialogRef.current?.contains(active);
      if (e.shiftKey && (active === first || outside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || outside)) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      triggerRef.current?.focus?.();
    };
  }, [open, onClose]);

  React.useEffect(() => {
    if (!open) setSelected(null);
  }, [open]);

  if (!open || !map) return null;

  const { cells, quadrants, totals } = map;
  const free = totals.freeByKind;
  const freeTotal = Object.values(free).reduce((a, b) => a + b, 0);
  const rows = [0, 1, 2, 3, 4, 5, 6, 7];
  const cols = [0, 1, 2, 3];
  const at = (row, col) => cells.find((c) => c.row === row && c.col === col);

  return (
    <div className="fixed inset-0 z-50">
      <div
        className="absolute inset-0"
        style={{ background: 'rgba(7,7,14,0.85)', backdropFilter: 'blur(4px)' }}
        onClick={onClose}
        role="presentation"
      />
      <div className="absolute inset-0 p-3 md:p-8 flex items-start justify-center overflow-y-auto">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="encoding-map-title"
          aria-describedby="encoding-map-desc"
          className="animate-scale-in w-full max-w-5xl riscv-card overflow-hidden"
          style={{ boxShadow: '0 0 60px rgba(0,0,0,0.8), 0 0 0 1px rgba(245,197,66,0.15)' }}
        >
          <div
            className="p-4 flex items-start justify-between gap-3"
            style={{ borderBottom: '1px solid var(--riscv-border)' }}
          >
            <div className="min-w-0">
              <h3
                id="encoding-map-title"
                className="font-bold flex items-center gap-2"
                style={{ color: 'var(--riscv-text)', fontSize: 14 }}
              >
                <Grid3x3 size={15} style={{ color: 'var(--riscv-gold)' }} />
                <span>Encoding Map</span>
              </h3>
              <p
                id="encoding-map-desc"
                className="text-[12px] mt-1"
                style={{ color: 'var(--riscv-text-3)' }}
              >
                The base 32-bit opcode map. Every cell implies{' '}
                <span className="font-mono">inst[1:0]=11</span>. Slot names and categories come from
                the specification; the counts and bars come from this site&rsquo;s catalogue, so a
                bar is a slot&rsquo;s share of the instruction definitions we carry, not a measure
                of how much encoding space it consumes.
              </p>
            </div>
            <button
              type="button"
              className="riscv-btn p-1.5 shrink-0"
              onClick={onClose}
              aria-label="Close the encoding map"
            >
              <X size={15} />
            </button>
          </div>

          <div className="p-4">
            <div
              className="flex flex-wrap gap-x-5 gap-y-1 text-[12px] mb-1"
              style={{ color: 'var(--riscv-text-2)' }}
            >
              <span>
                <strong style={{ color: 'var(--riscv-text)' }}>
                  {totals.occupiedSlots}/{totals.totalSlots}
                </strong>{' '}
                major opcodes assigned to standard 32-bit classes
              </span>
              <span>
                <strong style={{ color: 'var(--riscv-text)' }}>{totals.thirtyTwoBit}</strong> 32-bit
                definitions
              </span>
              <span>
                <strong style={{ color: 'var(--riscv-text)' }}>{totals.compressed}</strong> with{' '}
                <span className="font-mono">inst[1:0]≠11</span>
              </span>
              <span>
                busiest is{' '}
                <strong style={{ color: 'var(--riscv-text)' }}>{totals.busiest.name}</strong>, with{' '}
                {totals.busiest.count} of them (
                {((totals.busiest.count / totals.thirtyTwoBit) * 100).toFixed(1)}%)
              </span>
            </div>

            {/* "23 of 32 assigned" invites the wrong conclusion on its own: the
                remaining nine are allocated too, just not to standard classes. */}
            <p className="text-[11.5px] mb-4" style={{ color: 'var(--riscv-text-3)' }}>
              The other {freeTotal} are not spare capacity. {free.vendor ?? 0} are custom opcodes,
              set aside for non-standard extensions and avoided by future standard ones,{' '}
              {free.wide ?? 0} are reserved for instructions longer than 32 bits, and{' '}
              {free.reserved ?? 0} is reserved outright. None is available for a new standard 32-bit
              extension.
            </p>

            <div className="overflow-x-auto -mx-1 px-1">
              <div className="min-w-[560px]">
                {/* Column headers: inst[6:5]. */}
                <div className="encoding-grid mb-1.5">
                  <div
                    className="font-mono text-[9.5px] self-end pb-0.5"
                    style={{ color: 'var(--riscv-text-3)' }}
                  >
                    inst[4:2]
                  </div>
                  {cols.map((col) => (
                    <div
                      key={col}
                      className="font-mono text-[10px] text-center"
                      style={{ color: 'var(--riscv-text-2)' }}
                    >
                      <span style={{ color: 'var(--riscv-text-3)' }}>inst[6:5]=</span>
                      {col.toString(2).padStart(2, '0')}
                    </div>
                  ))}
                </div>

                {rows.map((row) => (
                  <div key={row} className="encoding-grid mb-1.5">
                    <div
                      className="font-mono text-[10px] flex items-center justify-end pr-1"
                      style={{ color: 'var(--riscv-text-2)' }}
                    >
                      {row.toString(2).padStart(3, '0')}
                    </div>
                    {cols.map((col) => {
                      const cell = at(row, col);
                      return (
                        <Cell
                          key={cell.opcode}
                          cell={cell}
                          total={totals.thirtyTwoBit}
                          selected={selected?.opcode === cell.opcode}
                          onSelect={setSelected}
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>

            <div
              className="mt-3 flex flex-wrap gap-x-4 gap-y-1 items-center text-[10.5px]"
              style={{ color: 'var(--riscv-text-3)' }}
            >
              {['vendor', 'wide', 'reserved'].map((kind) => (
                <span key={kind} className="flex items-center gap-1">
                  <span
                    aria-hidden="true"
                    style={{
                      display: 'inline-block',
                      width: 10,
                      height: 10,
                      border: `1px dashed ${CATEGORY_COLOUR[kind]}`,
                      borderRadius: 2,
                    }}
                  />
                  {CATEGORY_LABEL[kind]}
                </span>
              ))}
            </div>

            <div
              className="mt-3 flex flex-wrap gap-2 items-center text-[11px]"
              style={{ color: 'var(--riscv-text-3)' }}
            >
              {/* Not "compressed". RISC-V uses the low bits to encode
                  instruction length, so inst[1:0]!=11 means "not 32 bits", which
                  is a wider statement than "the C extension" once Zc* and other
                  16-bit encodings are in the dataset. */}
              <span>Definitions outside the 32-bit map:</span>
              {quadrants.map((q) => (
                <span
                  key={q.quadrant}
                  className="px-2 py-0.5 rounded border font-mono"
                  style={{
                    background: 'var(--riscv-tint-2)',
                    borderColor: 'var(--riscv-border)',
                    color: 'var(--riscv-text-2)',
                  }}
                >
                  inst[1:0]={q.quadrant.toString(2).padStart(2, '0')} · {q.count}
                </span>
              ))}
            </div>

            {/* Name the dataset. Without this the counts read as properties of
                the ISA, which they are not: a different selection of upstream
                files, or a different upstream revision, gives different numbers.
                The slot names and categories above are not affected, being
                architectural. */}
            <p className="mt-3 text-[10.5px]" style={{ color: 'var(--riscv-text-3)' }}>
              Counts are instruction definitions in this site&rsquo;s catalogue, built from the
              ratified files of{' '}
              <a
                href="https://github.com/riscv/riscv-opcodes"
                target="_blank"
                rel="noreferrer noopener"
                style={{ color: 'var(--riscv-gold)' }}
              >
                riscv-opcodes
              </a>{' '}
              plus corrections recorded in the repository. One definition can constrain anything
              from a handful of encodings to a large region of the slot, so these are not a measure
              of encoding-space consumption.
            </p>

            {selected && (
              <div
                className="mt-4 rounded border p-3"
                style={{ background: 'var(--riscv-surface-2)', borderColor: 'var(--riscv-border)' }}
              >
                <div className="flex items-baseline justify-between gap-3 mb-2 flex-wrap">
                  <h4
                    className="font-mono text-[13px] font-bold"
                    style={{ color: 'var(--riscv-gold)' }}
                  >
                    {selected.name}{' '}
                    <span className="font-normal" style={{ color: 'var(--riscv-text-3)' }}>
                      opcode 0x{selected.opcode.toString(16).padStart(2, '0')} · inst[6:5]=
                      {selected.colBits} inst[4:2]={selected.rowBits}
                    </span>
                  </h4>
                  <span className="text-[11px]" style={{ color: 'var(--riscv-text-3)' }}>
                    {selected.count} instruction{selected.count === 1 ? '' : 's'}
                  </span>
                </div>

                {selected.count === 0 ? (
                  <div>
                    <p className="text-[12px]" style={{ color: 'var(--riscv-text-2)' }}>
                      <span
                        className="font-mono"
                        style={{ color: CATEGORY_COLOUR[selected.category] }}
                      >
                        {CATEGORY_LABEL[selected.category]}
                      </span>
                      {'. '}
                      {FREE_SLOT_KINDS[selected.category] ?? 'Not allocated by the specification.'}
                    </p>
                    {selected.category === 'vendor' && onOpenSandbox && (
                      <div
                        className="mt-2.5 pt-2.5 border-t"
                        style={{ borderColor: 'var(--riscv-border)' }}
                      >
                        <button
                          type="button"
                          onClick={() => onOpenSandbox()}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-semibold border transition-all"
                          style={{
                            background: 'rgba(59,130,246,0.1)',
                            borderColor: 'rgba(59,130,246,0.3)',
                            color: 'var(--riscv-accent-4, #60a5fa)',
                          }}
                        >
                          Design custom instruction in Extension Sandbox →
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <>
                    <div className="flex flex-wrap gap-1 mb-2">
                      {selected.extensions.map((id) => (
                        <button
                          key={id}
                          type="button"
                          onClick={() => {
                            onSelectExtension?.(id);
                            onClose();
                          }}
                          title={`Open ${id}`}
                          className="px-1.5 py-0.5 rounded border font-mono text-[11px] hover:opacity-80"
                          style={{
                            background: 'var(--riscv-gold-dim)',
                            borderColor: 'var(--riscv-gold-glow)',
                            color: 'var(--riscv-gold)',
                          }}
                        >
                          {id}
                        </button>
                      ))}
                    </div>
                    <div className="flex flex-wrap gap-1 max-h-40 overflow-y-auto">
                      {selected.instructions.map((i) => (
                        <span
                          key={i.mnemonic}
                          className="px-1.5 py-0.5 rounded border font-mono text-[11px]"
                          title={i.isSandbox ? 'Sandbox Instruction' : undefined}
                          style={
                            i.isSandbox
                              ? {
                                  background: 'rgba(59,130,246,0.1)',
                                  borderColor: 'rgba(59,130,246,0.3)',
                                  color: 'var(--riscv-accent-4, #60a5fa)',
                                }
                              : {
                                  background: 'var(--riscv-tint-2)',
                                  borderColor: 'var(--riscv-border)',
                                  color: 'var(--riscv-text-2)',
                                }
                          }
                        >
                          {i.mnemonic}
                        </span>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
