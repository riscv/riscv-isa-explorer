/**
 * EncodingDiagram — one 32-bit instruction encoding, drawn bit by bit.
 *
 * Moved out of risc_v_visualizer.jsx when the comparison view became a second
 * consumer. It was always self-contained: React and four lucide icons, with its
 * field helpers declared in its own body.
 *
 * `diffMask` is how comparison marks the bits that differ between the
 * instructions on screen. It is optional, and without it this renders exactly
 * as it did as a private component.
 */
import React from 'react';
import { ArrowRight, Binary, ChevronLeft, ChevronRight } from 'lucide-react';

export default function EncodingDiagram({ encoding, diffMask }) {
  const scrollRef = React.useRef(null);
  const rafRef = React.useRef(null);
  const dragRef = React.useRef(null);
  const [scrollState, setScrollState] = React.useState({
    scrollLeft: 0,
    scrollWidth: 0,
    clientWidth: 0,
  });

  const normalized = String(encoding || '').replace(/\s+/g, '');
  if (normalized.length !== 32) {
    return (
      <div
        className="font-mono text-[12px] bg-(--riscv-surface-2) border border-(--riscv-border-2) rounded-sm px-2 py-1 break-all"
        style={{ color: 'var(--riscv-text-2)' }}
      >
        {encoding}
      </div>
    );
  }

  // RISC-V standard R-type field ranges (bit index from MSB=0):
  // bit 31..25 → funct7 (i=0..6)
  // bit 24..20 → rs2    (i=7..11)
  // bit 19..15 → rs1    (i=12..16)
  // bit 14..12 → funct3 (i=17..19)
  // bit 11..7  → rd     (i=20..24)
  // bit 6..0   → opcode (i=25..31)
  const getFieldClass = (i, isVar) => {
    if (isVar) return 'enc-var';
    if (i <= 6) return 'enc-funct7';
    if (i <= 11) return 'enc-rs2';
    if (i <= 16) return 'enc-rs1';
    if (i <= 19) return 'enc-funct3';
    if (i <= 24) return 'enc-rd';
    return 'enc-opcode';
  };

  const getFieldName = (i) => {
    if (i <= 6) return 'funct7';
    if (i <= 11) return 'rs2';
    if (i <= 16) return 'rs1';
    if (i <= 19) return 'funct3';
    if (i <= 24) return 'rd';
    return 'opcode';
  };

  // Build field label spans for the legend row
  const FIELD_LABELS = [
    { name: 'funct7', from: 0, to: 6, cls: 'enc-funct7' },
    { name: 'rs2', from: 7, to: 11, cls: 'enc-rs2' },
    { name: 'rs1', from: 12, to: 16, cls: 'enc-rs1' },
    { name: 'funct3', from: 17, to: 19, cls: 'enc-funct3' },
    { name: 'rd', from: 20, to: 24, cls: 'enc-rd' },
    { name: 'opcode', from: 25, to: 31, cls: 'enc-opcode' },
  ];

  const updateScrollState = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setScrollState((prev) => {
      const next = {
        scrollLeft: el.scrollLeft,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      };
      if (
        prev.scrollLeft === next.scrollLeft &&
        prev.scrollWidth === next.scrollWidth &&
        prev.clientWidth === next.clientWidth
      ) {
        return prev;
      }
      return next;
    });
  }, []);

  React.useEffect(() => {
    updateScrollState();
    const el = scrollRef.current;
    if (!el) return;

    const onScroll = () => {
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        updateScrollState();
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });

    const onResize = () => updateScrollState();
    window.addEventListener('resize', onResize);

    return () => {
      el.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [updateScrollState, normalized]);

  const maxScrollLeft = Math.max(0, scrollState.scrollWidth - scrollState.clientWidth);
  const canScroll = maxScrollLeft > 0;
  const atLeft = scrollState.scrollLeft <= 0;
  const atRight = scrollState.scrollLeft >= maxScrollLeft - 1;
  const scrollProgress = canScroll ? scrollState.scrollLeft / maxScrollLeft : 0;
  const thumbRatio = canScroll ? Math.min(1, scrollState.clientWidth / scrollState.scrollWidth) : 1;
  const thumbLeftPct = (1 - thumbRatio) * scrollProgress * 100;
  const thumbWidthPct = thumbRatio * 100;

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div
          className="flex items-center gap-2 text-[11px] uppercase tracking-wider font-semibold"
          style={{ color: 'var(--riscv-text-3)' }}
        >
          <Binary size={11} />
          <span>Bit Fields</span>
          {canScroll && (
            <span
              className="inline-flex items-center gap-1 normal-case tracking-normal"
              style={{ color: 'var(--riscv-gold)' }}
            >
              scroll <ArrowRight size={11} />
            </span>
          )}
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            className="riscv-btn p-1 disabled:opacity-30"
            onClick={() => scrollRef.current?.scrollBy({ left: -220, behavior: 'smooth' })}
            disabled={!canScroll || atLeft}
            data-tooltip="Scroll left"
            aria-label="Scroll left"
          >
            <ChevronLeft size={13} />
          </button>
          <button
            type="button"
            className="riscv-btn p-1 disabled:opacity-30"
            onClick={() => scrollRef.current?.scrollBy({ left: 220, behavior: 'smooth' })}
            disabled={!canScroll || atRight}
            data-tooltip="Scroll right"
            aria-label="Scroll right"
          >
            <ChevronRight size={13} />
          </button>
        </div>
      </div>

      <div ref={scrollRef} className="overflow-x-auto">
        <div className="block w-full">
          {/* Bit cells */}
          {/* All 32 bits share the available width rather than each taking a
              fixed 20px. At 20px the row was 640px wide, which does not fit the
              detail panel, so reading an encoding meant scrolling a 32-cell
              strip through a window a dozen cells wide — the one view where
              seeing the whole word at once is the entire point.
              minmax(0,1fr) lets the cells shrink; the min-width below keeps
              them legible, and the scroller survives underneath it for
              viewports narrower than that floor. */}
          <div className="riscv-bit-row grid w-full rounded-md border border-(--riscv-border-2) overflow-hidden">
            {normalized.split('').map((bit, i) => {
              const isVar = bit === '-';
              const isGroupEnd = (i + 1) % 4 === 0 && i !== 31;
              const value = isVar ? 'x' : bit;
              const fieldCls = getFieldClass(i, isVar);
              const fieldName = getFieldName(i);
              const isDiff = Array.isArray(diffMask) && diffMask[i] === true;
              return (
                <div
                  key={`${i}-${bit}`}
                  data-diff={isDiff ? '1' : undefined}
                  className={[
                    'riscv-bit-cell h-7 flex items-center justify-center font-mono font-medium border-r',
                    fieldCls,
                    i === 31 ? 'border-r-0' : isGroupEnd ? 'border-r-2' : '',
                    isDiff ? 'riscv-bit-diff' : '',
                  ].join(' ')}
                  /* Native title, not the site's data-tooltip. The custom
                     tooltip is a ::after pseudo-element, so it is a descendant
                     of whatever clips it — and this diagram renders inside the
                     Selected Details panel and the comparison dialog, both
                     overflow-hidden. Roughly nine of the thirty-two cells sit
                     within a tooltip's width of an edge, so their labels were
                     cut off, including the funct7 bits where "which field is
                     this" is most often the question. A title renders in
                     browser chrome and cannot be clipped. */
                  title={
                    isDiff
                      ? `bit[${31 - i}] — ${fieldName} — differs`
                      : `bit[${31 - i}] — ${fieldName}`
                  }
                >
                  {value}
                </div>
              );
            })}
          </div>

          {/* Bit number labels */}
          <div
            className="mt-1 flex justify-between text-[10px] font-mono px-0.5"
            style={{ color: 'var(--riscv-text-3)' }}
          >
            <span>31</span>
            <span>0</span>
          </div>

          {/* Field legend row */}
          <div className="mt-2 flex gap-1.5 flex-wrap">
            {FIELD_LABELS.map(({ name, cls }) => (
              <span
                key={name}
                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-[10px] font-mono font-bold border ${cls}`}
              >
                {name}
              </span>
            ))}
          </div>
        </div>
      </div>

      {canScroll && (
        <div
          className="mt-2 h-1.5 rounded-full relative cursor-pointer"
          style={{ background: 'var(--riscv-border)', border: '1px solid var(--riscv-border-2)' }}
          onClick={(e) => {
            const el = scrollRef.current;
            if (!el) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const x = Math.min(Math.max(0, e.clientX - rect.left), rect.width);
            const next = (x / rect.width) * maxScrollLeft;
            el.scrollTo({ left: next, behavior: 'smooth' });
          }}
          role="presentation"
          data-tooltip="Click to scroll"
        >
          <div
            className="absolute top-0 bottom-0 rounded-full cursor-grab active:cursor-grabbing"
            style={{
              left: `${thumbLeftPct}%`,
              width: `${thumbWidthPct}%`,
              background: 'var(--riscv-gold)',
              opacity: 0.5,
            }}
            onPointerDown={(e) => {
              const el = scrollRef.current;
              if (!el) return;
              e.stopPropagation();
              const track = e.currentTarget.parentElement;
              if (!track) return;
              const trackRect = track.getBoundingClientRect();
              dragRef.current = {
                pointerId: e.pointerId,
                startX: e.clientX,
                startScrollLeft: el.scrollLeft,
                trackWidth: trackRect.width,
              };
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              const el = scrollRef.current;
              const drag = dragRef.current;
              if (!el || !drag || drag.pointerId !== e.pointerId) return;
              const dx = e.clientX - drag.startX;
              const delta = (dx / drag.trackWidth) * maxScrollLeft;
              el.scrollLeft = Math.min(maxScrollLeft, Math.max(0, drag.startScrollLeft + delta));
            }}
            onPointerUp={(e) => {
              const drag = dragRef.current;
              if (!drag || drag.pointerId !== e.pointerId) return;
              dragRef.current = null;
              try {
                e.currentTarget.releasePointerCapture(e.pointerId);
              } catch {
                // no-op
              }
            }}
          />
        </div>
      )}
    </div>
  );
}
