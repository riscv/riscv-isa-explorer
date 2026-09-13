/**
 * ExtensionTile — one extension in the grid.
 *
 * This lived inside RISCVExplorer as a nested `const ExtensionBlock = …`. That
 * is the React anti-pattern that made the page feel broken: a component defined
 * in a render body is a NEW function on every render, React compares element
 * types by reference, and a different reference reads as a different component
 * type. The whole subtree gets unmounted and rebuilt rather than updated.
 *
 * With 227 tiles, every click, keystroke and toggle tore down and recreated 227
 * subtrees. A user reported selections taking "seconds to minutes" on Chrome
 * under macOS. Confirmed in the browser beforehand: after a click the tile DOM
 * nodes were replaced rather than reused.
 *
 * Two things make this fast:
 *
 *   1. Defining it at module scope, so its identity is stable across renders
 *      and React updates instead of remounting.
 *   2. tilePropsAreEqual below, which compares each tile against ITS OWN state
 *      rather than against container identity. workspaceIds is a fresh Set on
 *      every change, so a shallow compare would re-render all 227 tiles; asking
 *      "did membership change for THIS id" re-renders only what changed.
 */
import React from 'react';
import { Plus, GitCompare } from 'lucide-react';
import { tilePropsAreEqual } from './tileMemo.js';

function ExtensionTile({
  data,
  colorClass,
  matchesSearch,
  selectedExtId,
  workspaceIds,
  compareIds,
  compareMode,
  lockedExtensions,
  builderMode,
  isHighlighted,
  isDimmed,
  onSelect,
  onToggleWorkspace,
  onToggleCompare,
}) {
  const isDiscontinued = data.discontinued === 1;
  const isSelected = selectedExtId === data.id;
  const highlighted = isHighlighted(data.id) || matchesSearch || isSelected;
  const dimmed = isDimmed(data.id) && !matchesSearch && !isSelected;
  const inWorkspace = workspaceIds.has(data.id);
  // Derived from `data` rather than passed in, so tilePropsAreEqual needs no
  // new comparison: it already returns false when `data` changes identity.
  const instructionCount = Object.keys(data.instructions || {}).length;
  const inCompare = compareIds.has(data.id);

  return (
    <div
      id={`ext-${data.id}`}
      role="button"
      tabIndex={dimmed ? -1 : 0}
      onClick={() => onSelect(data)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onSelect(data);
        } else if (e.key === ' ') {
          e.preventDefault();
          if (builderMode && !isDiscontinued) {
            onToggleWorkspace(data.id);
          } else {
            onSelect(data);
          }
        }
      }}
      className={[
        'ext-tile group relative rounded-lg border cursor-pointer select-none',
        isSelected ? 'ext-tile-active' : '',
        highlighted && !isSelected ? 'ext-tile-highlighted' : '',
        dimmed ? 'opacity-20 grayscale pointer-events-none' : '',
        isDiscontinued && !dimmed
          ? 'border-[var(--riscv-border-2)] bg-[var(--riscv-surface)]'
          : !dimmed
            ? colorClass
            : '',
      ].join(' ')}
      style={{
        padding: '10px',
        // Amber glow ring when in the builder
        ...(inWorkspace && !isDiscontinued
          ? {
              borderColor: 'rgba(245,197,66,0.55)',
              boxShadow: '0 0 0 1px rgba(245,197,66,0.2), inset 0 0 12px rgba(245,197,66,0.04)',
            }
          : {}),
        transition: 'border-color 0.2s, box-shadow 0.2s',
      }}
    >
      {/* Corner controls. One flex row rather than three absolutely-positioned
          elements fighting over the same point. */}
      <div className="absolute top-1.5 right-1.5 flex items-center gap-1">
        {isDiscontinued && (
          <span
            className="px-1.5 py-0.5 rounded text-[9px] font-mono uppercase tracking-wider"
            style={{
              background: 'rgba(255,77,107,0.12)',
              color: '#ff7a8a',
              border: '1px solid rgba(255,77,107,0.25)',
            }}
          >
            EOL
          </span>
        )}

        {/* Unlike the workspace "+" button below, this is intentionally NOT
            gated on !isDiscontinued. Comparison is read-only inspection, not
            ISA configuration — you cannot build a shippable config from an
            EOL extension, but comparing one against its successor is a
            legitimate use, and parseComparePermalink already resolves
            discontinued extensions from a `?cmp=` link. Gating this button
            would make them pinnable by URL but not by mouse.

            It IS gated on compareMode: the pin is a secondary affordance for a
            mode the user has asked to be in, and 227 tiles each carrying an
            always-visible extra control is the clutter that mode exists to
            avoid. */}
        {compareMode && (
          <button
            type="button"
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              onToggleCompare(data.id);
            }}
            className="workspace-tile-btn ext-tile-compare"
            aria-pressed={inCompare}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 18,
              height: 18,
              borderRadius: 5,
              border: `1px solid ${inCompare ? 'var(--riscv-violet)' : 'var(--riscv-border-2)'}`,
              background: inCompare ? 'var(--riscv-violet)' : 'var(--riscv-surface-2)',
              color: inCompare ? '#ffffff' : 'var(--riscv-text-3)',
              boxShadow: inCompare ? '0 0 10px rgba(139, 124, 248, 0.4)' : 'none',
              cursor: 'pointer',
              transition: 'all 0.15s ease',
              padding: 0,
            }}
            title={inCompare ? `Remove ${data.id} from comparison` : `Pin ${data.id} to comparison`}
          >
            <GitCompare size={9} strokeWidth={inCompare ? 2.5 : 2} />
          </button>
        )}

        {builderMode &&
          !isDiscontinued &&
          !data.isSandbox &&
          Boolean(onToggleWorkspace) &&
          (() => {
            const isLocked = inWorkspace && lockedExtensions.has(data.id);
            const lockedBy = isLocked ? lockedExtensions.get(data.id) : [];

            // Amber says "you can add this"; green says "it is in". Using one colour
            // for both made a full configuration a wall of undifferentiated amber.
            // Locked tiles stay dimmed to read as unavailable.
            const accent = '#f5c542';
            return (
              <button
                type="button"
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  // The handler reports lock rejections itself.
                  onToggleWorkspace(data.id);
                }}
                className="workspace-tile-btn"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 18,
                  height: 18,
                  borderRadius: 5,
                  border: `1px solid ${
                    isLocked
                      ? 'rgba(245,197,66,0.3)'
                      : inWorkspace
                        ? 'var(--riscv-check-edge)'
                        : 'rgba(245,197,66,0.6)'
                  }`,
                  background: inWorkspace
                    ? isLocked
                      ? 'rgba(245,197,66,0.08)'
                      : 'var(--riscv-check-fill)'
                    : 'rgba(245,197,66,0.14)',
                  backdropFilter: 'blur(4px)',
                  boxShadow: inWorkspace || isLocked ? 'none' : '0 0 0 2px rgba(245,197,66,0.12)',
                  color: isLocked
                    ? 'rgba(245,197,66,0.5)'
                    : inWorkspace
                      ? 'var(--riscv-check)'
                      : accent,
                  cursor: isLocked ? 'not-allowed' : 'pointer',
                  transition: 'all 0.15s',
                  padding: 0,
                }}
                title={
                  isLocked
                    ? `Required by ${lockedBy.join(', ')} — remove dependent first`
                    : inWorkspace
                      ? `Remove ${data.id} from ISA Configuration Builder`
                      : `Add ${data.id} to ISA Configuration Builder`
                }
              >
                {inWorkspace ? (
                  <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
                    <path
                      d="M1.5 4.5L3.5 6.5L7.5 2.5"
                      stroke="currentColor"
                      strokeWidth="1.75"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                ) : (
                  <Plus size={9} />
                )}
              </button>
            );
          })()}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 mb-1 pr-6">
        <span
          className="font-mono font-semibold text-[12px] leading-tight break-all"
          style={{ letterSpacing: '0.02em' }}
        >
          {data.name}
        </span>
        {data.isSandbox && (
          <span
            className="px-1 py-[1px] mt-px rounded text-[8.5px] font-mono uppercase tracking-wider font-semibold shrink-0"
            style={{
              background: 'rgba(59,130,246,0.15)',
              color: 'var(--riscv-accent-4, #60a5fa)',
              border: '1px solid rgba(59,130,246,0.35)',
              lineHeight: 1,
            }}
          >
            Sandbox
          </span>
        )}
      </div>
      {/* The short label, not `desc`. The tile is 190px wide - about 32
          characters a line, 65 in the two-line clamp - so a full description
          truncates into a fragment here. `desc` is shown in the details panel
          when a tile is selected, where there is room for it.

          The instruction count shares this row rather than the name row above:
          the corner controls are absolutely positioned over the name row's
          right edge, so a count there would sit under the compare and "+"
          buttons. */}
      <div className="flex items-end justify-between gap-2">
        <div
          className="text-[11px] leading-snug line-clamp-2"
          style={{ color: 'var(--riscv-text-2)' }}
        >
          {data.short || data.desc}
        </div>
        {/* Shown only when there are instructions to count. 122 of the 223
            catalogue entries define none — Ziccamoa is a PMA rule, Sspmp is
            CSR-only — and for those an empty list is the correct answer, not a
            missing one. Printing "0" across more than half the grid would read
            as absent data. Absence of the figure carries the same meaning
            without the false alarm.

            The number is this entry's OWN map, so the `members` bundles report
            their union: Zvknc reads 27, Zce 54. */}
        {instructionCount > 0 && (
          <span
            className="font-mono text-[10px] leading-none shrink-0"
            style={{ color: 'var(--riscv-text-2)' }}
            // A bare numeral means nothing read aloud, and nothing on hover.
            aria-label={`${instructionCount} instructions`}
            title={`${instructionCount} instructions`}
          >
            {instructionCount}
          </span>
        )}
      </div>
    </div>
  );
}

export default React.memo(ExtensionTile, tilePropsAreEqual);
