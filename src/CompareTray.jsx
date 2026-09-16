/**
 * CompareTray — the pinned items waiting to be compared.
 *
 * Two sets rather than one. Extensions and instructions are compared
 * separately, and keeping a set each is what lets someone pin an instruction
 * without silently throwing away the extensions they had lined up. The
 * alternative — one set that changes kind — needs a confirmation dialog on
 * every switch to avoid destroying work.
 *
 * Hidden entirely when nothing is pinned: a permanently docked empty bar is a
 * control for a mode the user has not asked to be in.
 */
import React from 'react';
import { GitCompare, X, Trash2, ArrowRight } from 'lucide-react';
import { COMPARE_MAX, parseInstructionKey } from './compareModel.js';

const chipLabel = (kind, key) => {
  if (kind === 'ext' || kind === 'profile') return key;
  const parsed = parseInstructionKey(key);
  return parsed ? parsed.mnemonic : key;
};

const chipTitle = (kind, key) => {
  if (kind === 'ext' || kind === 'profile') return `Remove ${key} from the comparison`;
  const parsed = parseInstructionKey(key);
  return parsed
    ? `Remove ${parsed.mnemonic} (${parsed.extId}) from the comparison`
    : `Remove ${key} from the comparison`;
};

export default function CompareTray({
  extIds,
  instrKeys,
  profileNames,
  visible,
  kind,
  onKindChange,
  onRemove,
  onClear,
  onOpen,
}) {
  const counts = { ext: extIds.size, instr: instrKeys.size, profile: profileNames.size };
  
  // Hidden with the mode off, but the pin sets are untouched — flipping the
  // mode back on brings the same comparison straight back.
  if (!visible) return null;
  if (counts.ext === 0 && counts.instr === 0 && counts.profile === 0) return null;

  const active =
    kind === 'instr' ? [...instrKeys] : kind === 'profile' ? [...profileNames] : [...extIds];
  const canCompare = active.length >= 2;

  const tab = (value, label) => {
    const isSelected = kind === value;
    const count = counts[value];
    return (
      <button
        key={value}
        type="button"
        onClick={() => onKindChange(value)}
        className="riscv-dock-tab"
        aria-pressed={isSelected}
      >
        <span>{label}</span>
        {count > 0 && (
          <span
            className="riscv-dock-badge"
            style={{
              background: isSelected ? 'var(--riscv-violet)' : 'var(--riscv-tint-3)',
              color: isSelected ? '#ffffff' : 'var(--riscv-text-3)',
            }}
          >
            {count}
          </span>
        )}
      </button>
    );
  };

  return (
    <div
      role="region"
      aria-label="Comparison tray"
      className="riscv-compare-dock"
    >
      {/* Category Segmented Control */}
      <div className="riscv-dock-tab-group shrink-0">
        {tab('ext', 'Extensions')}
        {tab('instr', 'Instructions')}
        {tab('profile', 'Profiles')}
      </div>

      {/* Vertical Divider */}
      <div className="h-5 w-px shrink-0" style={{ background: 'var(--riscv-border-2)' }} />

      {/* Pinned Chips Container (Comfortably handles 1 to 6 items) */}
      <div className="flex items-center gap-1.5 overflow-x-auto py-1 px-0.5" style={{ flex: 1, minWidth: 160, scrollbarWidth: 'none' }}>
        {active.length === 0 ? (
          <span className="text-[11px] italic px-1" style={{ color: 'var(--riscv-text-3)' }}>
            No {kind === 'ext' ? 'extensions' : kind === 'instr' ? 'instructions' : 'profiles'} pinned yet.
          </span>
        ) : (
          active.map((key) => (
            <span
              key={key}
              className="riscv-dock-chip shrink-0"
            >
              <span className="font-semibold tracking-wide">{chipLabel(kind, key)}</span>
              <button
                type="button"
                onClick={() => onRemove(kind, key)}
                title={chipTitle(kind, key)}
                aria-label={chipTitle(kind, key)}
                className="riscv-dock-chip-x"
              >
                <X size={11} />
              </button>
            </span>
          ))
        )}
      </div>

      {/* Action Controls */}
      <div className="flex items-center gap-2 shrink-0">
        {active.length > 0 && (
          <button
            type="button"
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold rounded-lg transition-all duration-200 cursor-pointer border active:scale-95 shadow-xs"
            style={{
              background: 'var(--riscv-report-tint)',
              color: 'var(--riscv-danger)',
              borderColor: 'var(--riscv-report-edge)',
            }}
            onClick={() => onClear(kind)}
            title="Clear all pinned items in this category"
          >
            <Trash2 size={12} style={{ color: 'var(--riscv-danger)' }} />
            <span className="hidden sm:inline">Clear</span>
          </button>
        )}

        <button
          type="button"
          className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-[12px] font-bold rounded-xl transition-all duration-200 shadow-md"
          style={{
            background: canCompare
              ? 'linear-gradient(to right, #f59e0b, #f5c542)'
              : 'var(--riscv-surface)',
            color: canCompare ? '#0f172a' : 'var(--riscv-text-3)',
            border: canCompare ? 'none' : '1px solid var(--riscv-border)',
            boxShadow: canCompare ? '0 4px 14px rgba(245, 197, 66, 0.3)' : 'none',
            cursor: canCompare ? 'pointer' : 'not-allowed',
            opacity: canCompare ? 1 : 0.45,
          }}
          onClick={onOpen}
          disabled={!canCompare}
          title={canCompare ? 'Launch side-by-side comparison' : 'Pin at least 2 items to compare'}
          // A disabled button leaves the tab order, so `title` alone never
          // reaches a screen reader — the requirement has to be in the name.
          aria-label={
            canCompare
              ? `Compare ${active.length} pinned items side by side`
              : `Compare — pin at least 2 items first, ${active.length} pinned`
          }
        >
          <GitCompare size={13} className="shrink-0" />
          <span>Compare ({active.length})</span>
          {canCompare && <ArrowRight size={12} className="opacity-80" />}
        </button>

        <span className="text-[10px] font-mono tracking-tight hidden lg:inline" style={{ color: 'var(--riscv-text-3)' }}>
          {active.length}/{COMPARE_MAX}
        </span>
      </div>
    </div>
  );
}

