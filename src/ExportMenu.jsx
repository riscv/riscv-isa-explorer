/**
 * ExportMenu.jsx — the one "Export Configuration YAML" menu.
 *
 * The builder's toolbar and its panel each had their own copy, and they
 * drifted: the toolbar's offered no UDB config and called the exporter with a
 * bare boolean, so the Parameters tab's values never reached its file (#611).
 * Both places render this component now, so they cannot disagree again.
 */
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Package, X } from 'lucide-react';
import { EXPORT_FORMATS, exportFilename, exportOptions } from './exportFormats.js';

// Below this width the toolbar clips an absolutely placed menu (it is a
// horizontal scroll container, under a backdrop filter that also traps fixed
// positioning), so the menu becomes a sheet portalled to the body.
const NARROW = '(max-width: 640px)';
const isNarrow = () => {
  try {
    return window.matchMedia(NARROW).matches;
  } catch {
    return false;
  }
};

export default function ExportMenu({
  ids,
  allExts,
  paramChoices,
  totalInstructions = 0,
  onClose,
  onExported,
  className,
  style,
}) {
  // On for a small selection; off once the catalogue would dominate the file.
  const [includeInstructions, setIncludeInstructions] = useState(totalInstructions <= 100);

  const download = async (format) => {
    // The export schemas and parameter definitions are large and matter only
    // when someone exports, so they load here rather than with the page.
    const { buildIsaConfigYaml } = await import('./exportUtils.js');
    const list = Array.from(ids);
    const { yaml } = buildIsaConfigYaml(
      list,
      allExts,
      exportOptions(format, { includeInstructions, paramChoices }),
    );
    const url = URL.createObjectURL(new Blob([yaml], { type: 'text/yaml' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = exportFilename(format, list, allExts);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    onExported?.(format);
    onClose?.();
  };

  const [narrow, setNarrow] = useState(isNarrow);
  useEffect(() => {
    let mq;
    try {
      mq = window.matchMedia(NARROW);
    } catch {
      return undefined;
    }
    const on = () => setNarrow(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  useEffect(() => {
    if (!narrow) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [narrow, onClose]);

  const menu = (
    <div
      role="dialog"
      aria-label="Export configuration"
      className={className}
      style={{
        position: 'absolute',
        top: 'calc(100% + 8px)',
        right: 0,
        zIndex: 100,
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 10,
        background: 'var(--riscv-popover-bg)',
        border: '1px solid var(--riscv-popover-edge)',
        boxShadow: 'var(--riscv-popover-shadow), 0 0 0 1px var(--riscv-tint-2) inset',
        width: 320,
        maxWidth: 'calc(100vw - 32px)',
        overflow: 'hidden',
        ...style,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '10px 14px',
          borderBottom: '1px solid var(--riscv-tint-3)',
          background: 'var(--riscv-popover-head)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <Package size={13} style={{ color: 'var(--riscv-gold)' }} />
          <span style={{ fontSize: 12, color: 'var(--riscv-text)', fontWeight: 700 }}>
            Export Configuration YAML
          </span>
        </div>
        <button
          type="button"
          aria-label="Close the export menu"
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--riscv-text-3)',
            cursor: 'pointer',
            padding: 2,
            borderRadius: 4,
            lineHeight: 0,
          }}
        >
          <X size={13} />
        </button>
      </div>

      <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {EXPORT_FORMATS.map((f, i) => (
          <React.Fragment key={f.format}>
            <button
              type="button"
              onClick={() => download(f.format)}
              style={{
                width: '100%',
                padding: '9px 12px',
                borderRadius: 7,
                textAlign: 'left',
                cursor: 'pointer',
                background:
                  i === 0
                    ? 'linear-gradient(135deg, rgba(245,197,66,0.22) 0%, rgba(245,197,66,0.12) 100%)'
                    : 'var(--riscv-tint-2)',
                color: i === 0 ? 'var(--riscv-gold)' : 'var(--riscv-text)',
                border: `1px solid ${i === 0 ? 'rgba(245,197,66,0.4)' : 'var(--riscv-tint-3)'}`,
              }}
            >
              <span
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 12,
                  fontWeight: 700,
                }}
              >
                <Package size={13} />
                {f.label}
              </span>
              <span
                style={{
                  display: 'block',
                  marginTop: 3,
                  fontSize: 11,
                  fontWeight: 400,
                  lineHeight: 1.4,
                  color: 'var(--riscv-text-2)',
                }}
              >
                {f.detail}
              </span>
            </button>
            {f.format === 'landscape' && (
              // The catalogue goes only into the Standard file, so the switch
              // sits under it and says so.
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                  padding: '2px 4px 4px',
                  fontSize: 11.5,
                  color: 'var(--riscv-text-2)',
                  cursor: 'pointer',
                }}
              >
                <span>
                  Include the instruction catalogue in the Standard file
                  <span
                    style={{
                      display: 'block',
                      fontSize: 11,
                      color: totalInstructions > 100 ? 'var(--riscv-warn)' : 'var(--riscv-text-3)',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {totalInstructions.toLocaleString()} instructions
                    {totalInstructions > 100 ? ' · large export' : ''}
                  </span>
                </span>
                <input
                  type="checkbox"
                  checked={includeInstructions}
                  onChange={(e) => setIncludeInstructions(e.target.checked)}
                  style={{ accentColor: '#f5c542', width: 16, height: 16, flexShrink: 0 }}
                />
              </label>
            )}
          </React.Fragment>
        ))}
      </div>
    </div>
  );

  if (!narrow) return menu;
  return createPortal(
    <div
      // The owner closes its menu on a mousedown outside it, and the sheet is
      // outside it in the DOM: the event stops here.
      onMouseDown={(e) => e.nativeEvent.stopPropagation()}
    >
      <div
        aria-hidden="true"
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, zIndex: 999, background: 'rgba(0,0,0,0.4)' }}
      />
      {React.cloneElement(menu, {
        style: {
          ...menu.props.style,
          position: 'fixed',
          // At the top: the Ask AI chip owns the bottom-right corner.
          top: 16,
          left: 16,
          right: 16,
          bottom: 'auto',
          width: 'auto',
          maxWidth: 'none',
          maxHeight: 'calc(100vh - 32px)',
          overflowY: 'auto',
          zIndex: 1000,
        },
      })}
    </div>,
    document.body,
  );
}
