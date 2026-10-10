/**
 * ProfileDownloadMenu — the "Download" button shown beside the Highlight
 * Profile picker while a profile is highlighted, and its list of formats.
 *
 * It knows nothing about profiles or files: it reports which format was
 * chosen, and the caller builds the file (profileExport.js). Kept in its own
 * module so the main view's render body never declares a component.
 *
 * The menu is portalled to <body> at fixed coordinates under the button. The
 * toolbar's filter row scrolls (overflow: auto) so it can shrink on narrow
 * screens, and a menu rendered inside it was clipped, and focusing it scrolled
 * the whole row out of sight.
 */
import React from 'react';
import { createPortal } from 'react-dom';
import { Download } from 'lucide-react';
import { EXPORT_FORMATS } from './profileExport.js';

export default function ProfileDownloadMenu({ profile, onDownload }) {
  const [open, setOpen] = React.useState(false);
  const [position, setPosition] = React.useState(null);
  const buttonRef = React.useRef(null);
  const menuRef = React.useRef(null);
  const menuId = React.useId();

  const close = React.useCallback((restoreFocus) => {
    setOpen(false);
    if (restoreFocus) buttonRef.current?.focus();
  }, []);

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = buttonRef.current.getBoundingClientRect();
    setPosition({ top: rect.bottom + 4, left: rect.left });
    setOpen(true);
  };

  React.useEffect(() => {
    if (!open) return undefined;
    menuRef.current?.querySelector('[role="menuitem"]')?.focus({ preventScroll: true });
    const onPointer = (e) => {
      if (!menuRef.current?.contains(e.target) && !buttonRef.current?.contains(e.target)) {
        close(false);
      }
    };
    // Fixed coordinates go stale when anything moves, so close rather than drift.
    const onMove = (e) => {
      if (!menuRef.current?.contains(e.target)) close(false);
    };
    document.addEventListener('mousedown', onPointer);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open, close]);

  const onMenuKey = (e) => {
    const items = [...(menuRef.current?.querySelectorAll('[role="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      items[(at + step + items.length) % items.length]?.focus({ preventScroll: true });
    } else if (e.key === 'Tab') {
      // The menu lives at the end of <body>, so letting Tab continue from it
      // would leave the page; send focus back to the button instead.
      e.preventDefault();
      close(true);
    }
  };

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={toggle}
        title={`Download the ${profile} extension list`}
        className="riscv-pin-btn px-2 py-1 rounded-md border text-[11px] font-semibold inline-flex items-center gap-1 whitespace-nowrap"
      >
        <Download size={12} />
        <span>Download</span>
      </button>
      {open &&
        position &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label={`Download ${profile} extensions as`}
            onKeyDown={onMenuKey}
            className="fixed z-[60] min-w-[11rem] rounded-lg border p-1 shadow-xl"
            style={{
              top: position.top,
              left: position.left,
              background: 'var(--riscv-surface)',
              borderColor: 'var(--riscv-border-2)',
            }}
          >
            {EXPORT_FORMATS.map((format) => (
              <button
                key={format.key}
                type="button"
                role="menuitem"
                onClick={() => {
                  onDownload(format.key);
                  close(true);
                }}
                className="riscv-menu-item w-full text-left px-2.5 py-1.5 rounded-md text-[12px] flex items-center justify-between gap-3"
                style={{ color: 'var(--riscv-text)' }}
              >
                <span>{format.label}</span>
                <span className="font-mono text-[11px]" style={{ color: 'var(--riscv-text-3)' }}>
                  .{format.extension}
                </span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
