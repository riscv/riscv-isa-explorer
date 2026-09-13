/**
 * WorkspacePanel.jsx — ISA Configuration Builder
 *
 * Full-browser professional engineering studio for silicon architects and system
 * engineers to configure, analyze, and export RISC-V ISA configurations.
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  X,
  Copy,
  CheckCircle2,
  Search,
  Cpu,
  ArrowRight,
  ArrowLeft,
  ExternalLink,
  Trash2,
  Package,
  Download,
  Info,
  BookOpen,
  Terminal,
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
  Zap,
  Sliders,
  Layers,
  Plus,
  Binary,
  Shield,
  Lock,
  Unlock,
  AlertTriangle,
} from 'lucide-react';

import {
  parseMarchString,
  buildMarchString,
  buildCombinedCatalog,
  DATA_PROVENANCE,
} from './marchUtils.js';
import { buildIsaConfigYaml } from './exportUtils.js';
import { resolveParams, impliedVlen, vlenExtension } from './isaGraph.js';
import { describeParameter } from './isaParams.js';
import { PROFILES } from './profiles.js';
import EncodingDiagram from './EncodingDiagram.jsx';
import { focusableWithin, nextFocus } from './focusTrap.js';

/**
 * Sort direction indicator for the catalog table header.
 */
function SortIcon({ col, sort }) {
  if (sort.col !== col) return <ChevronsUpDown size={11} style={{ opacity: 0.35 }} />;
  return sort.dir === 1 ? (
    <ChevronUp size={11} style={{ color: 'var(--riscv-gold)' }} />
  ) : (
    <ChevronDown size={11} style={{ color: 'var(--riscv-gold)' }} />
  );
}

export default function WorkspacePanel({
  open,
  onClose,
  workspaceIds,
  lockedExtensions,
  allExts,
  onSetVlen,
  onRemoveId,
  onAddId,
  onClear,
  onLoadIds,
  seedProfile,
  profileOptional,
  customFromProfile,
  paramChoices,
  onSetParam,
  baselineLocked,
  onToggleBaseline,
}) {
  const [marchTab, setMarchTab] = useState('encode');
  const [marchInput, setMarchInput] = useState('');
  const [parseResult, setParseResult] = useState(null);
  const [encodeResult, setEncodeResult] = useState(null);
  const [copiedMarch, setCopiedMarch] = useState(false);
  const [catalogQuery, setCatalogQuery] = useState('');
  const [catalogSort, setCatalogSort] = useState({ col: 'mnemonic', dir: 1 });
  const [hoveredRow, setHoveredRow] = useState(null);
  const [selectedRowInstruction, setSelectedRowInstruction] = useState(null);
  const [showExportOptions, setShowExportOptions] = useState(false);
  const [includeInstructions, setIncludeInstructions] = useState(true);
  const [extSearchQuery, setExtSearchQuery] = useState('');
  const [profileDropdownOpen, setProfileDropdownOpen] = useState(false);

  const marchInputRef = useRef(null);

  // Close on Escape, innermost layer first. Every open popover has to be
  // unwound before Escape reaches the studio itself — otherwise dismissing a
  // dropdown tore down the whole builder along with it.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e) => {
      if (e.key !== 'Escape') return;
      if (showExportOptions) {
        setShowExportOptions(false);
      } else if (profileDropdownOpen) {
        setProfileDropdownOpen(false);
      } else {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose, showExportOptions, profileDropdownOpen]);

  // The studio declares role="dialog" aria-modal="true" over an opaque
  // full-screen backdrop, so it has to hold focus as well as take it —
  // otherwise Tab walks into the page underneath, which is still focusable and
  // now invisible. Same helpers the encoder dialog uses.
  const dialogRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const opener = typeof document !== 'undefined' ? document.activeElement : null;

    const onKeyDown = (e) => {
      if (e.key !== 'Tab' || !dialogRef.current) return;
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

    document.addEventListener('keydown', onKeyDown, true);
    // Seed focus inside the dialog so the first Tab starts from within it.
    focusableWithin(dialogRef.current)[0]?.focus();

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      // Hand focus back to whatever opened the studio, so keyboard users
      // resume where they left off rather than at the top of the document.
      opener?.focus?.();
    };
  }, [open]);

  // Dismiss the popovers on an outside click, the way the main view's own
  // profile menu already does. Without this, Escape was the only way to close
  // them — and Escape used to close the entire studio.
  const profileDropdownRef = useRef(null);
  const exportOptionsRef = useRef(null);
  useEffect(() => {
    if (!open || (!profileDropdownOpen && !showExportOptions)) return;
    const onPointerDown = (e) => {
      if (profileDropdownOpen && !profileDropdownRef.current?.contains(e.target)) {
        setProfileDropdownOpen(false);
      }
      if (showExportOptions && !exportOptionsRef.current?.contains(e.target)) {
        setShowExportOptions(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open, profileDropdownOpen, showExportOptions]);

  // Extensions the seeding profile lists as optional and that are not already in workspace
  const optionalToAdd = useMemo(() => {
    if (!seedProfile || !profileOptional) return [];
    const ids = new Set(profileOptional[seedProfile] || []);
    if (ids.size === 0) return [];
    return allExts
      .filter((e) => ids.has(e.id) && !workspaceIds.has(e.id))
      .sort((a, b) => a.id.localeCompare(b.id));
  }, [seedProfile, profileOptional, allExts, workspaceIds]);

  // Derived extensions in workspace
  const workspaceExts = useMemo(() => {
    const lookup = new Map(allExts.map((e) => [e.id, e]));
    return Array.from(workspaceIds)
      .map((id) => lookup.get(id))
      .filter(Boolean);
  }, [workspaceIds, allExts]);

  // Available extensions not yet selected (for quick-add search)
  const availableToAdd = useMemo(() => {
    const q = extSearchQuery.trim().toLowerCase();
    if (!q) return [];
    return allExts
      .filter(
        (e) =>
          !workspaceIds.has(e.id) &&
          (e.id.toLowerCase().includes(q) || (e.name && e.name.toLowerCase().includes(q))),
      )
      .slice(0, 10);
  }, [allExts, workspaceIds, extSearchQuery]);

  const combinedCatalog = useMemo(
    () => buildCombinedCatalog(Array.from(workspaceIds), allExts),
    [workspaceIds, allExts],
  );

  const totalInstructions = combinedCatalog.length;

  const filteredCatalog = useMemo(() => {
    const q = catalogQuery.trim().toLowerCase();
    let rows = q
      ? combinedCatalog.filter(
          (row) =>
            row.mnemonic.toLowerCase().includes(q) ||
            (row.match && row.match.toLowerCase().includes(q)) ||
            row.sources.some((s) => s.extId.toLowerCase().includes(q)),
        )
      : combinedCatalog;

    const { col, dir } = catalogSort;
    return [...rows].sort((a, b) => {
      if (col === 'mnemonic') return dir * a.mnemonic.localeCompare(b.mnemonic);
      if (col === 'source') return dir * a.sources[0].extId.localeCompare(b.sources[0].extId);
      if (col === 'match') return dir * String(a.match || '').localeCompare(String(b.match || ''));
      return 0;
    });
  }, [combinedCatalog, catalogQuery, catalogSort]);

  useEffect(() => {
    if (marchTab !== 'encode') return;
    setEncodeResult(buildMarchString(Array.from(workspaceIds), allExts));
  }, [workspaceIds, allExts, marchTab]);

  // Auto-disable instruction catalog export for very large selections
  useEffect(() => {
    setIncludeInstructions(totalInstructions <= 100);
  }, [totalInstructions]);

  useEffect(() => {
    if (open && marchTab === 'decode') setTimeout(() => marchInputRef.current?.focus(), 80);
  }, [open, marchTab]);

  function handleParse() {
    const result = parseMarchString(marchInput, allExts);
    setParseResult(result);
    if (result.resolvedIds.length > 0) onLoadIds(result.resolvedIds);
  }

  function handleCopyMarch() {
    const march = encodeResult?.march;
    if (!march) return;
    navigator.clipboard?.writeText(march).catch(() => {
      const el = document.createElement('textarea');
      el.value = march;
      el.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    });
    setCopiedMarch(true);
    setTimeout(() => setCopiedMarch(false), 1500);
  }

  function handleExportYaml(format = 'landscape') {
    const { yaml } = buildIsaConfigYaml(
      Array.from(workspaceIds),
      allExts,
      format === 'landscape' ? { includeInstructions, paramChoices } : { format, paramChoices },
    );
    const blob = new Blob([yaml], { type: 'text/yaml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const baseProfile = encodeResult?.march ? encodeResult.march.split('_')[0] : 'core';
    a.download =
      format === 'udb'
        ? `riscv_${baseProfile}_udb_config.yaml`
        : `riscv_${baseProfile}_config.yaml`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setShowExportOptions(false);
  }

  function toggleSort(col) {
    setCatalogSort((prev) => (prev.col === col ? { col, dir: -prev.dir } : { col, dir: 1 }));
  }

  if (!open) return null;

  const isEmpty = workspaceIds.size === 0;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="ISA Configuration Builder Studio"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--riscv-bg)',
        color: 'var(--riscv-text)',
        fontFamily: "'Inter', sans-serif",
        overflow: 'hidden',
        animation: 'wsStudioFadeIn 0.15s ease-out',
      }}
    >
      {/* =========================================================================
          TOP STUDIO NAVIGATION BAR
          ========================================================================= */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          padding: '12px 24px',
          borderBottom: '1px solid var(--riscv-tint-3)',
          background: 'var(--riscv-surface)',
          flexShrink: 0,
          boxShadow: '0 2px 12px rgba(0,0,0,0.3)',
          zIndex: 60,
        }}
      >
        {/* Left: Back button + Title + Stats */}
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0, flexWrap: 'wrap' }}
        >
          <button
            type="button"
            onClick={onClose}
            aria-label="Return to Landscape Explorer"
            title="Return to Landscape Explorer (Esc)"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '7px 12px',
              borderRadius: 8,
              background: 'var(--riscv-surface-2)',
              border: '1px solid var(--riscv-border-2)',
              color: 'var(--riscv-text)',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              transition: 'all 0.15s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = 'var(--riscv-gold)';
              e.currentTarget.style.color = 'var(--riscv-gold)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = 'var(--riscv-border-2)';
              e.currentTarget.style.color = 'var(--riscv-text)';
            }}
          >
            <ArrowLeft size={14} />
            <span>Landscape Explorer</span>
            <kbd
              style={{
                fontSize: 10,
                padding: '1px 5px',
                borderRadius: 4,
                background: 'var(--riscv-tint-3)',
                color: 'var(--riscv-text-3)',
              }}
            >
              Esc
            </kbd>
          </button>

          <div style={{ width: 1, height: 20, background: 'var(--riscv-border)' }} />

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div
              style={{
                width: 30,
                height: 30,
                borderRadius: 8,
                background: 'rgba(245,197,66,0.12)',
                border: '1px solid rgba(245,197,66,0.3)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Cpu size={15} style={{ color: 'var(--riscv-gold)' }} />
            </div>
            <div>
              <span
                style={{
                  fontWeight: 800,
                  fontSize: 15,
                  letterSpacing: '-0.01em',
                  color: 'var(--riscv-text)',
                  display: 'block',
                }}
              >
                ISA Configuration Builder
              </span>
            </div>
          </div>

          {/* Stats Badges */}
          {!isEmpty && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 6 }}>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  padding: '3px 9px',
                  borderRadius: 6,
                  background: 'rgba(245,197,66,0.1)',
                  border: '1px solid rgba(245,197,66,0.25)',
                  fontSize: 11,
                  fontWeight: 700,
                  color: 'var(--riscv-gold)',
                  letterSpacing: '0.02em',
                }}
              >
                <span style={{ color: 'var(--riscv-text)', fontVariantNumeric: 'tabular-nums' }}>
                  {workspaceIds.size}
                </span>
                <span style={{ opacity: 0.7, fontWeight: 500 }}>extensions</span>
              </span>

              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  padding: '3px 9px',
                  borderRadius: 6,
                  background: 'rgba(99,179,237,0.08)',
                  border: '1px solid rgba(99,179,237,0.2)',
                  fontSize: 11,
                  fontWeight: 700,
                  color: 'var(--riscv-info)',
                  letterSpacing: '0.02em',
                }}
              >
                <span style={{ color: 'var(--riscv-text)', fontVariantNumeric: 'tabular-nums' }}>
                  {totalInstructions.toLocaleString()}
                </span>
                <span style={{ opacity: 0.7, fontWeight: 500 }}>instructions</span>
              </span>

              {/* Profile Badge / Switcher */}
              <div ref={profileDropdownRef} style={{ position: 'relative' }}>
                <button
                  type="button"
                  onClick={() => setProfileDropdownOpen((v) => !v)}
                  title="Switch or start from a certified profile"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '3px 10px',
                    borderRadius: 6,
                    background: seedProfile
                      ? 'rgba(139,124,248,0.14)'
                      : customFromProfile
                        ? 'rgba(245,158,11,0.10)'
                        : 'var(--riscv-surface-2)',
                    border: `1px solid ${
                      seedProfile
                        ? 'rgba(139,124,248,0.35)'
                        : customFromProfile
                          ? 'rgba(245,158,11,0.35)'
                          : 'var(--riscv-border-2)'
                    }`,
                    fontSize: 11,
                    fontWeight: 700,
                    color: seedProfile
                      ? 'var(--riscv-violet)'
                      : customFromProfile
                        ? '#f59e0b'
                        : 'var(--riscv-text-2)',
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                  }}
                >
                  <span>
                    {seedProfile
                      ? `Profile: ${seedProfile}`
                      : customFromProfile
                        ? `Custom (from ${customFromProfile})`
                        : 'Profile: Custom Base'}
                  </span>
                  <ChevronDown size={11} />
                </button>

                {profileDropdownOpen && (
                  <div
                    style={{
                      position: 'absolute',
                      top: 'calc(100% + 6px)',
                      left: 0,
                      zIndex: 100,
                      minWidth: 240,
                      background: 'var(--riscv-popover-bg)',
                      border: '1px solid var(--riscv-popover-edge)',
                      borderRadius: 10,
                      boxShadow: '0 12px 36px rgba(0,0,0,0.6), 0 0 0 1px var(--riscv-tint-2) inset',
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        padding: '8px 12px',
                        fontSize: 10.5,
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        letterSpacing: '0.06em',
                        color: 'var(--riscv-text-3)',
                        borderBottom: '1px solid var(--riscv-tint-3)',
                        background: 'var(--riscv-popover-head)',
                      }}
                    >
                      Start from Certified Profile
                    </div>
                    {Object.entries(PROFILES).map(([pName, pList]) => (
                      <button
                        key={pName}
                        type="button"
                        onClick={() => {
                          onLoadIds(pList, pName);
                          setProfileDropdownOpen(false);
                        }}
                        style={{
                          width: '100%',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '9px 12px',
                          background:
                            seedProfile === pName ? 'rgba(139,124,248,0.15)' : 'transparent',
                          border: 'none',
                          borderBottom: '1px solid var(--riscv-tint-2)',
                          color: 'var(--riscv-text)',
                          cursor: 'pointer',
                          textAlign: 'left',
                        }}
                        onMouseEnter={(e) => {
                          if (seedProfile !== pName)
                            e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
                        }}
                        onMouseLeave={(e) => {
                          if (seedProfile !== pName)
                            e.currentTarget.style.background = 'transparent';
                        }}
                      >
                        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--riscv-gold)' }}>
                          {pName}
                        </span>
                        <span style={{ fontSize: 11, color: 'var(--riscv-text-3)' }}>
                          {pList.length} extensions
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Right Actions: Export YAML, Clear all, Close */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          {!isEmpty && (
            <div ref={exportOptionsRef} style={{ position: 'relative' }}>
              <button
                type="button"
                onClick={() => setShowExportOptions(!showExportOptions)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 7,
                  padding: '7px 14px',
                  borderRadius: 8,
                  background: showExportOptions
                    ? 'rgba(16, 185, 129, 0.2)'
                    : 'rgba(16, 185, 129, 0.1)',
                  border: '1px solid rgba(16, 185, 129, 0.35)',
                  color: '#34d399',
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(16, 185, 129, 0.25)';
                }}
                onMouseLeave={(e) => {
                  if (!showExportOptions) {
                    e.currentTarget.style.background = 'rgba(16, 185, 129, 0.1)';
                  }
                }}
              >
                <Download size={14} />
                <span>Export YAML</span>
                <ChevronDown size={12} />
              </button>

              {/* Export Popover */}
              {showExportOptions && (
                <div
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
                    minWidth: 300,
                    overflow: 'hidden',
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
                      <span
                        style={{
                          fontSize: 12,
                          color: 'var(--riscv-text)',
                          fontWeight: 700,
                          letterSpacing: '0.01em',
                        }}
                      >
                        Export Configuration YAML
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowExportOptions(false)}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--riscv-text-3)',
                        cursor: 'pointer',
                        padding: 2,
                        borderRadius: 4,
                      }}
                    >
                      <X size={13} />
                    </button>
                  </div>

                  <div style={{ padding: '12px 14px' }}>
                    <div
                      onClick={() => setIncludeInstructions((v) => !v)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 12,
                        padding: '10px 12px',
                        borderRadius: 8,
                        cursor: 'pointer',
                        background: includeInstructions
                          ? 'rgba(245,197,66,0.07)'
                          : 'var(--riscv-tint-2)',
                        border: `1px solid ${includeInstructions ? 'rgba(245,197,66,0.2)' : 'var(--riscv-tint-3)'}`,
                        transition: 'all 0.2s',
                        userSelect: 'none',
                      }}
                    >
                      <div style={{ flex: 1 }}>
                        <span
                          style={{
                            fontSize: 12,
                            fontWeight: 600,
                            color: includeInstructions
                              ? 'var(--riscv-text)'
                              : 'var(--riscv-text-2)',
                            display: 'block',
                            lineHeight: 1.35,
                          }}
                        >
                          Include instruction catalog
                        </span>
                        <span
                          style={{
                            fontSize: 11,
                            marginTop: 2,
                            display: 'block',
                            color:
                              totalInstructions > 100 ? 'var(--riscv-warn)' : 'var(--riscv-text-3)',
                            fontVariantNumeric: 'tabular-nums',
                          }}
                        >
                          {totalInstructions.toLocaleString()} instructions
                          {totalInstructions > 100 ? ' · large export' : ''}
                        </span>
                      </div>

                      <div
                        style={{
                          width: 38,
                          height: 21,
                          borderRadius: 11,
                          flexShrink: 0,
                          background: includeInstructions
                            ? 'linear-gradient(135deg, #f5c542 0%, #fde68a 100%)'
                            : 'var(--riscv-tint-4)',
                          position: 'relative',
                          transition: 'all 0.25s',
                          border: `1px solid ${includeInstructions ? 'rgba(245,197,66,0.7)' : 'var(--riscv-tint-4)'}`,
                        }}
                      >
                        <div
                          style={{
                            width: 15,
                            height: 15,
                            borderRadius: '50%',
                            background: includeInstructions ? '#1a1206' : 'var(--riscv-text-3)',
                            position: 'absolute',
                            top: 2,
                            left: includeInstructions ? 19 : 2,
                            transition: 'all 0.25s',
                          }}
                        />
                      </div>
                    </div>
                  </div>

                  <div
                    style={{
                      padding: '0 14px 13px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 7,
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => handleExportYaml('landscape')}
                      style={{
                        width: '100%',
                        padding: '9px 14px',
                        borderRadius: 7,
                        background:
                          'linear-gradient(135deg, rgba(245,197,66,0.22) 0%, rgba(245,197,66,0.12) 100%)',
                        color: 'var(--riscv-gold)',
                        border: '1px solid rgba(245,197,66,0.4)',
                        fontSize: 12,
                        fontWeight: 700,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 6,
                      }}
                    >
                      <Package size={13} />
                      Download .yaml (Standard)
                    </button>

                    <button
                      type="button"
                      onClick={() => handleExportYaml('udb')}
                      title="UDB architecture configuration for riscv-arch-test."
                      style={{
                        width: '100%',
                        padding: '8px 14px',
                        borderRadius: 7,
                        background: 'var(--riscv-tint-2)',
                        color: 'var(--riscv-text)',
                        border: '1px solid var(--riscv-tint-3)',
                        fontSize: 11.5,
                        fontWeight: 600,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 6,
                      }}
                    >
                      <Package size={13} />
                      Download UDB config (arch-test)
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {!isEmpty && (
            <button
              type="button"
              onClick={onClear}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '7px 12px',
                borderRadius: 8,
                background: 'rgba(239, 68, 68, 0.08)',
                border: '1px solid rgba(239, 68, 68, 0.25)',
                color: '#f87171',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'all 0.15s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(239, 68, 68, 0.16)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'rgba(239, 68, 68, 0.08)';
              }}
            >
              <Trash2 size={13} />
              <span>Clear all</span>
            </button>
          )}

          <button
            type="button"
            onClick={onClose}
            aria-label="Close ISA Configuration Builder"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 32,
              height: 32,
              borderRadius: 8,
              background: 'var(--riscv-surface-2)',
              border: '1px solid var(--riscv-border-2)',
              color: 'var(--riscv-text-3)',
              cursor: 'pointer',
              transition: 'all 0.15s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = 'var(--riscv-text)';
              e.currentTarget.style.borderColor = 'var(--riscv-border)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = 'var(--riscv-text-3)';
              e.currentTarget.style.borderColor = 'var(--riscv-border-2)';
            }}
          >
            <X size={16} />
          </button>
        </div>
      </header>

      {/* =========================================================================
          STUDIO MAIN BODY
          ========================================================================= */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          overscrollBehavior: 'contain',
          padding: '20px 24px 40px',
        }}
      >
        {/* --- EMPTY STATE WORKBENCH --- */}
        {isEmpty ? (
          <div
            style={{
              maxWidth: 960,
              margin: '30px auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 24,
            }}
          >
            <div
              style={{
                textAlign: 'center',
                padding: '40px 24px',
                borderRadius: 16,
                background: 'var(--riscv-surface)',
                border: '1px solid var(--riscv-border)',
                boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
              }}
            >
              <div
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: 14,
                  background: 'rgba(245,197,66,0.1)',
                  border: '1px solid rgba(245,197,66,0.25)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  margin: '0 auto 16px',
                }}
              >
                <Cpu size={28} style={{ color: 'var(--riscv-gold)' }} />
              </div>
              <h2
                style={{
                  fontSize: 20,
                  fontWeight: 700,
                  color: 'var(--riscv-text)',
                  marginBottom: 8,
                }}
              >
                Configure a Custom RISC-V Processor ISA
              </h2>
              <p
                style={{
                  fontSize: 14,
                  color: 'var(--riscv-text-2)',
                  maxWidth: 620,
                  margin: '0 auto 24px',
                  lineHeight: 1.6,
                }}
              >
                Start from a certified ratified profile, pick a base integer ISA, or paste an
                existing{' '}
                <code
                  style={{ color: 'var(--riscv-gold)', fontFamily: 'JetBrains Mono, monospace' }}
                >
                  -march
                </code>{' '}
                string to resolve all dependencies, encodings, and parameters.
              </p>

              {/* Profile Quick-Starts */}
              <div style={{ marginBottom: 28 }}>
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                    color: 'var(--riscv-text-3)',
                    marginBottom: 12,
                  }}
                >
                  Start from a Ratified Profile
                </div>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                    gap: 12,
                    maxWidth: 820,
                    margin: '0 auto',
                  }}
                >
                  {Object.entries(PROFILES).map(([name, list]) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => {
                        onLoadIds(list, name);
                      }}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'flex-start',
                        padding: '14px 16px',
                        borderRadius: 10,
                        background: 'var(--riscv-surface-2)',
                        border: '1px solid var(--riscv-border-2)',
                        cursor: 'pointer',
                        textAlign: 'left',
                        transition: 'all 0.15s ease',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.borderColor = 'rgba(245,197,66,0.5)';
                        e.currentTarget.style.transform = 'translateY(-2px)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.borderColor = 'var(--riscv-border-2)';
                        e.currentTarget.style.transform = 'none';
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          width: '100%',
                          marginBottom: 4,
                        }}
                      >
                        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--riscv-gold)' }}>
                          {name}
                        </span>
                        <span
                          style={{
                            fontSize: 11,
                            color: 'var(--riscv-text-3)',
                            fontFamily: 'JetBrains Mono, monospace',
                          }}
                        >
                          {list.length} ext
                        </span>
                      </div>
                      <span
                        style={{ fontSize: 11.5, color: 'var(--riscv-text-2)', lineHeight: 1.4 }}
                      >
                        {name === 'RVA23'
                          ? 'Latest 64-bit application profile (Linux/Android)'
                          : name === 'RVA22'
                            ? '64-bit application profile baseline'
                            : name === 'RVA20'
                              ? 'RV64GC-compatible standard profile'
                              : '64-bit bare-metal / RTOS microcontroller profile'}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Paste -march Decode */}
              <div
                style={{
                  maxWidth: 620,
                  margin: '0 auto',
                  padding: '16px 20px',
                  borderRadius: 12,
                  background: 'var(--riscv-surface-2)',
                  border: '1px solid var(--riscv-border-2)',
                  textAlign: 'left',
                }}
              >
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                    color: 'var(--riscv-text-3)',
                    marginBottom: 8,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <Terminal size={12} /> Or Paste an Existing -march String
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="text"
                    value={marchInput}
                    onChange={(e) => setMarchInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleParse()}
                    placeholder="e.g. rv64gc_zba_zbb_zicsr_zifencei"
                    style={{
                      flex: 1,
                      padding: '10px 14px',
                      background: 'var(--riscv-bg)',
                      border: '1px solid var(--riscv-border)',
                      borderRadius: 8,
                      outline: 'none',
                      fontFamily: 'JetBrains Mono, monospace',
                      fontSize: 13,
                      color: 'var(--riscv-text)',
                    }}
                  />
                  <button
                    type="button"
                    onClick={handleParse}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '10px 18px',
                      borderRadius: 8,
                      background: 'rgba(245,197,66,0.15)',
                      border: '1px solid rgba(245,197,66,0.35)',
                      color: 'var(--riscv-gold)',
                      fontSize: 13,
                      fontWeight: 700,
                      cursor: 'pointer',
                    }}
                  >
                    Parse <ArrowRight size={13} />
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : (
          /* --- POPULATED 3-COLUMN MULTI-PANE WORKBENCH --- */
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))',
              gap: 20,
              alignItems: 'start',
            }}
          >
            {/* =========================================================================
                COLUMN 1: SELECTED EXTENSIONS & OPTIONAL EXTENSIONS & QUICK ADD
                ========================================================================= */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              {/* Card 1.1: Selected Extensions (Roster on Top) */}
              <StudioCard
                title="Selected Extensions"
                count={`${workspaceIds.size} active`}
                icon={<Cpu size={14} style={{ color: 'var(--riscv-gold)' }} />}
              >
                {/* Profile Baseline Conformance Note + Lock / Release Toggle */}
                {seedProfile && (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 10,
                      marginBottom: 12,
                      padding: '8px 12px',
                      borderRadius: 8,
                      background: baselineLocked ? 'rgba(245,197,66,0.06)' : 'var(--riscv-tint-1)',
                      border: `1px solid ${
                        baselineLocked ? 'rgba(245,197,66,0.2)' : 'var(--riscv-tint-3)'
                      }`,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flex: 1 }}>
                      <Shield
                        size={14}
                        style={{ color: 'var(--riscv-gold)', flexShrink: 0, marginTop: 2 }}
                      />
                      <span
                        style={{ fontSize: 11, color: 'var(--riscv-text-2)', lineHeight: 1.45 }}
                      >
                        {baselineLocked
                          ? `The ${seedProfile} mandatory set is held in place — removing one would leave a configuration that is no longer ${seedProfile}.`
                          : `The ${seedProfile} baseline is released. Removing a mandatory extension will leave a configuration that no longer satisfies ${seedProfile}.`}
                      </span>
                    </div>
                    {onToggleBaseline && (
                      <button
                        type="button"
                        onClick={onToggleBaseline}
                        aria-pressed={baselineLocked}
                        title={
                          baselineLocked
                            ? `Allow removing extensions ${seedProfile} mandates`
                            : `Hold the ${seedProfile} mandatory set in place again`
                        }
                        style={{
                          flexShrink: 0,
                          fontSize: 10,
                          fontWeight: 700,
                          letterSpacing: '0.04em',
                          textTransform: 'uppercase',
                          padding: '4px 9px',
                          borderRadius: 6,
                          cursor: 'pointer',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4,
                          border: `1px solid ${baselineLocked ? 'rgba(245,197,66,0.5)' : 'var(--riscv-tint-4)'}`,
                          background: baselineLocked
                            ? 'rgba(245,197,66,0.15)'
                            : 'var(--riscv-tint-2)',
                          color: baselineLocked ? 'var(--riscv-gold)' : 'var(--riscv-text-2)',
                        }}
                      >
                        {baselineLocked ? <Lock size={10} /> : <Unlock size={10} />}
                        {baselineLocked ? 'Locked' : 'Released'}
                      </button>
                    )}
                  </div>
                )}

                {/* Diverged config notice: shown when user removed mandatory extensions */}
                {!seedProfile && customFromProfile && (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      marginBottom: 12,
                      padding: '8px 12px',
                      borderRadius: 8,
                      background: 'rgba(245,158,11,0.07)',
                      border: '1px solid rgba(245,158,11,0.25)',
                    }}
                  >
                    <AlertTriangle
                      size={14}
                      style={{ color: '#f59e0b', flexShrink: 0, marginTop: 1 }}
                    />
                    <span style={{ fontSize: 11, color: 'var(--riscv-text-2)', lineHeight: 1.45 }}>
                      This configuration has diverged from{' '}
                      <strong style={{ color: '#f59e0b' }}>{customFromProfile}</strong> — one or
                      more mandatory extensions were removed. To restore full {customFromProfile}{' '}
                      compliance, use the <strong>Profile switcher</strong> above to reload it.
                    </span>
                  </div>
                )}

                {/* Active extension chips */}
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 6,
                    maxHeight: 280,
                    overflowY: 'auto',
                    padding: '2px',
                  }}
                >
                  {workspaceExts.map((ext) => (
                    <ExtChip
                      key={ext.id}
                      ext={ext}
                      lockedBy={lockedExtensions?.get(ext.id)}
                      onRemove={() => onRemoveId(ext.id)}
                    />
                  ))}
                </div>

                <div
                  style={{
                    fontSize: 10.5,
                    color: 'var(--riscv-text-3)',
                    marginTop: 10,
                    lineHeight: 1.4,
                  }}
                >
                  Click ✕ to remove non-mandatory extensions. Locked (🔒) extensions are required by
                  active dependents.
                </div>
              </StudioCard>

              {/* Card 1.2: Profile Optional Extensions (Original section preserved) */}
              {optionalToAdd.length > 0 && (
                <StudioCard
                  title={`Optional in ${seedProfile}`}
                  count={optionalToAdd.length}
                  icon={<Sliders size={14} style={{ color: 'var(--riscv-violet)' }} />}
                >
                  <div style={{ fontSize: 11, color: 'var(--riscv-text-3)', marginBottom: 10 }}>
                    Extensions optional under <strong>{seedProfile}</strong>. Click + on any chip to
                    include it in your configuration.
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {optionalToAdd.map((ext) => (
                      <OptionalChip key={ext.id} ext={ext} onAdd={() => onAddId(ext.id)} />
                    ))}
                  </div>
                </StudioCard>
              )}

              {/* Card 1.3: Add Extension to Core (Search & Add from full 227+ catalog) */}
              <StudioCard
                title="Add Extension to Core"
                badge="Catalog Search"
                icon={<Layers size={14} style={{ color: 'var(--riscv-gold)' }} />}
              >
                <div style={{ position: 'relative' }}>
                  <div style={{ fontSize: 11, color: 'var(--riscv-text-3)', marginBottom: 8 }}>
                    Search and add any standard RISC-V extension (e.g. Zicond, Zabha, Zvbb, Zfa).
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '7px 10px',
                      borderRadius: 8,
                      background: 'var(--riscv-surface-2)',
                      border: '1px solid var(--riscv-border-2)',
                    }}
                  >
                    <Search size={13} style={{ color: 'var(--riscv-text-3)' }} />
                    <input
                      type="text"
                      value={extSearchQuery}
                      onChange={(e) => setExtSearchQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && availableToAdd.length > 0) {
                          e.preventDefault();
                          onAddId(availableToAdd[0].id);
                          setExtSearchQuery('');
                        }
                      }}
                      placeholder="Search 220+ extensions..."
                      style={{
                        flex: 1,
                        background: 'transparent',
                        border: 'none',
                        outline: 'none',
                        fontSize: 12,
                        color: 'var(--riscv-text)',
                      }}
                    />
                    {extSearchQuery && (
                      <button
                        type="button"
                        onClick={() => setExtSearchQuery('')}
                        style={{
                          background: 'none',
                          border: 'none',
                          color: 'var(--riscv-text-3)',
                          cursor: 'pointer',
                          padding: 0,
                        }}
                      >
                        <X size={12} />
                      </button>
                    )}
                  </div>

                  {/* Autocomplete Dropdown (unconstrained overflow) */}
                  {extSearchQuery.trim() && (
                    <div
                      style={{
                        position: 'absolute',
                        top: 'calc(100% + 6px)',
                        left: 0,
                        right: 0,
                        zIndex: 100,
                        background: 'var(--riscv-popover-bg)',
                        border: '1px solid var(--riscv-popover-edge)',
                        borderRadius: 10,
                        boxShadow:
                          '0 12px 36px rgba(0,0,0,0.6), 0 0 0 1px var(--riscv-tint-2) inset',
                        maxHeight: 280,
                        overflowY: 'auto',
                      }}
                    >
                      {availableToAdd.length > 0 ? (
                        availableToAdd.map((ext) => (
                          <button
                            key={ext.id}
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => {
                              onAddId(ext.id);
                              setExtSearchQuery('');
                            }}
                            style={{
                              width: '100%',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              gap: 10,
                              padding: '9px 12px',
                              background: 'transparent',
                              border: 'none',
                              borderBottom: '1px solid var(--riscv-tint-2)',
                              color: 'var(--riscv-text)',
                              cursor: 'pointer',
                              textAlign: 'left',
                              transition: 'background 0.12s',
                            }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.background = 'rgba(245,197,66,0.12)';
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.background = 'transparent';
                            }}
                          >
                            <div
                              style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}
                            >
                              <span
                                style={{
                                  fontFamily: 'JetBrains Mono, monospace',
                                  fontSize: 12,
                                  fontWeight: 700,
                                  color: 'var(--riscv-gold)',
                                  flexShrink: 0,
                                }}
                              >
                                {ext.id}
                              </span>
                              <span
                                style={{
                                  fontSize: 11.5,
                                  color: 'var(--riscv-text-2)',
                                  whiteSpace: 'nowrap',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                }}
                              >
                                {ext.name || ext.desc}
                              </span>
                            </div>
                            <span
                              style={{
                                fontSize: 11,
                                fontWeight: 700,
                                color: 'var(--riscv-gold)',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 3,
                                flexShrink: 0,
                                padding: '2px 7px',
                                borderRadius: 5,
                                background: 'rgba(245,197,66,0.15)',
                                border: '1px solid rgba(245,197,66,0.3)',
                              }}
                            >
                              <Plus size={11} /> Add
                            </span>
                          </button>
                        ))
                      ) : (
                        <div
                          style={{
                            padding: '12px 14px',
                            fontSize: 11.5,
                            color: 'var(--riscv-text-3)',
                            textAlign: 'center',
                          }}
                        >
                          No matching unselected extensions found.
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </StudioCard>
            </div>

            {/* =========================================================================
                COLUMN 2: COMPILER -MARCH TOOL & HARDWARE PARAMETERS
                ========================================================================= */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              {/* Card 2.1: -march Tool */}
              <StudioCard
                title="-march Architecture Tool"
                icon={<Terminal size={14} style={{ color: 'var(--riscv-gold)' }} />}
              >
                {/* Tabs */}
                <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
                  {['encode', 'decode'].map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      onClick={() => {
                        setMarchTab(tab);
                        setParseResult(null);
                      }}
                      style={{
                        padding: '6px 14px',
                        borderRadius: 7,
                        fontSize: 12,
                        fontWeight: 700,
                        fontFamily: 'JetBrains Mono, monospace',
                        cursor: 'pointer',
                        letterSpacing: '0.04em',
                        textTransform: 'uppercase',
                        transition: 'all 0.15s',
                        ...(marchTab === tab
                          ? {
                              background: 'rgba(245,197,66,0.15)',
                              border: '1px solid rgba(245,197,66,0.35)',
                              color: 'var(--riscv-gold)',
                            }
                          : {
                              background: 'var(--riscv-surface-2)',
                              border: '1px solid var(--riscv-border-2)',
                              color: 'var(--riscv-text-3)',
                            }),
                      }}
                    >
                      {tab === 'encode' ? 'Canonical -march' : 'Decode / Import'}
                    </button>
                  ))}
                </div>

                {/* Encode View */}
                {marchTab === 'encode' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {encodeResult?.march ? (
                      <>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            borderRadius: 9,
                            overflow: 'hidden',
                            border: '1px solid rgba(245,197,66,0.25)',
                            background: 'rgba(245,197,66,0.05)',
                          }}
                        >
                          <code
                            style={{
                              flex: 1,
                              padding: '12px 14px',
                              fontFamily: 'JetBrains Mono, monospace',
                              fontSize: 13,
                              color: 'var(--riscv-gold)',
                              wordBreak: 'break-all',
                              letterSpacing: '0.01em',
                              lineHeight: 1.5,
                            }}
                          >
                            {encodeResult.march}
                          </code>
                          <button
                            type="button"
                            onClick={handleCopyMarch}
                            style={{
                              flexShrink: 0,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              width: 44,
                              alignSelf: 'stretch',
                              borderLeft: '1px solid rgba(245,197,66,0.2)',
                              background: copiedMarch ? 'rgba(32,217,160,0.15)' : 'transparent',
                              color: copiedMarch ? '#20d9a0' : 'var(--riscv-text-3)',
                              cursor: 'pointer',
                              transition: 'all 0.15s',
                            }}
                            title="Copy -march string"
                          >
                            {copiedMarch ? <CheckCircle2 size={16} /> : <Copy size={16} />}
                          </button>
                        </div>

                        {/* Excluded extensions note */}
                        {encodeResult.excluded.length > 0 && (
                          <div
                            style={{
                              borderRadius: 8,
                              padding: '12px 14px',
                              background: 'rgba(255,160,122,0.06)',
                              border: '1px solid rgba(255,160,122,0.18)',
                            }}
                          >
                            <p
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 6,
                                fontSize: 11,
                                fontWeight: 700,
                                textTransform: 'uppercase',
                                letterSpacing: '0.06em',
                                color: '#ffa07a',
                                marginBottom: 8,
                                marginTop: 0,
                              }}
                            >
                              <Info size={13} /> Excluded from -march
                            </p>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                              {encodeResult.excluded.map((ex) => (
                                <div
                                  key={ex.id}
                                  style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}
                                >
                                  <span
                                    style={{
                                      padding: '2px 6px',
                                      borderRadius: 4,
                                      background: 'rgba(255,255,255,0.08)',
                                      fontFamily: 'JetBrains Mono, monospace',
                                      fontSize: 11,
                                      fontWeight: 700,
                                      color: 'var(--riscv-text)',
                                      flexShrink: 0,
                                    }}
                                  >
                                    {ex.id}
                                  </span>
                                  <span
                                    style={{
                                      fontSize: 11.5,
                                      color: 'var(--riscv-text-2)',
                                      lineHeight: 1.4,
                                    }}
                                  >
                                    {ex.reason}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </>
                    ) : (
                      <div
                        style={{
                          borderRadius: 8,
                          padding: '14px',
                          background: 'var(--riscv-surface-2)',
                          border: '1px solid var(--riscv-border-2)',
                          textAlign: 'center',
                          fontSize: 13,
                          color: 'var(--riscv-text-3)',
                        }}
                      >
                        Add a base ISA (RV32I, RV64I, …) to generate a valid -march string.
                      </div>
                    )}
                  </div>
                )}

                {/* Decode View */}
                {marchTab === 'decode' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input
                        ref={marchInputRef}
                        type="text"
                        value={marchInput}
                        onChange={(e) => {
                          setMarchInput(e.target.value);
                          setParseResult(null);
                        }}
                        onKeyDown={(e) => e.key === 'Enter' && handleParse()}
                        placeholder="e.g. rv64gc_zba_zbb_zicsr"
                        style={{
                          flex: 1,
                          padding: '9px 12px',
                          background: 'var(--riscv-surface-2)',
                          border: '1px solid var(--riscv-border-2)',
                          borderRadius: 8,
                          outline: 'none',
                          fontFamily: 'JetBrains Mono, monospace',
                          fontSize: 13,
                          color: 'var(--riscv-text)',
                        }}
                      />
                      <button
                        type="button"
                        onClick={handleParse}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '9px 14px',
                          borderRadius: 8,
                          background: 'rgba(245,197,66,0.14)',
                          border: '1px solid rgba(245,197,66,0.3)',
                          color: 'var(--riscv-gold)',
                          fontSize: 12,
                          fontWeight: 700,
                          cursor: 'pointer',
                        }}
                      >
                        Parse <ArrowRight size={12} />
                      </button>
                    </div>

                    {parseResult && (
                      <div
                        style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}
                      >
                        {parseResult.resolvedIds.length > 0 && (
                          <div
                            style={{
                              borderRadius: 8,
                              padding: '10px 12px',
                              background: 'rgba(32,217,160,0.06)',
                              border: '1px solid rgba(32,217,160,0.2)',
                            }}
                          >
                            <p
                              style={{
                                fontSize: 11,
                                fontWeight: 700,
                                textTransform: 'uppercase',
                                letterSpacing: '0.06em',
                                color: '#20d9a0',
                                marginBottom: 7,
                              }}
                            >
                              ✓ Resolved {parseResult.resolvedIds.length} extensions — loaded to
                              builder
                            </p>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                              {parseResult.resolvedIds.map((id) => (
                                <span
                                  key={id}
                                  style={{
                                    padding: '2px 7px',
                                    borderRadius: 4,
                                    fontFamily: 'JetBrains Mono, monospace',
                                    fontSize: 11,
                                    background: 'rgba(32,217,160,0.1)',
                                    border: '1px solid rgba(32,217,160,0.25)',
                                    color: '#a7f3d0',
                                  }}
                                >
                                  {id}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}

                        {parseResult.gExpanded && (
                          <InfoPill icon={<Zap size={12} />}>
                            "g" expanded →{' '}
                            {['I', 'M', 'A', 'F', 'D', 'Zicsr', 'Zifencei'].join(' · ')}
                          </InfoPill>
                        )}

                        {parseResult.unknownTokens && parseResult.unknownTokens.length > 0 && (
                          <div
                            style={{
                              borderRadius: 8,
                              padding: '10px 12px',
                              background: 'rgba(245,197,66,0.05)',
                              border: '1px solid rgba(245,197,66,0.15)',
                            }}
                          >
                            <p
                              style={{
                                fontSize: 11,
                                fontWeight: 700,
                                textTransform: 'uppercase',
                                letterSpacing: '0.06em',
                                color: '#f59e0b',
                                marginBottom: 6,
                              }}
                            >
                              Not in catalog ({parseResult.unknownTokens.length})
                            </p>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                              {parseResult.unknownTokens.map((t) => (
                                <span
                                  key={t}
                                  style={{
                                    padding: '2px 6px',
                                    borderRadius: 4,
                                    fontFamily: 'monospace',
                                    fontSize: 11,
                                    background: 'rgba(245,197,66,0.08)',
                                    border: '1px solid rgba(245,197,66,0.2)',
                                    color: '#fde68a',
                                  }}
                                >
                                  {t}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}

                        {parseResult.warnings && parseResult.warnings.length > 0 && (
                          <div
                            style={{
                              borderRadius: 8,
                              padding: '10px 12px',
                              background: 'rgba(255,160,122,0.06)',
                              border: '1px solid rgba(255,160,122,0.15)',
                            }}
                          >
                            <p
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 6,
                                fontSize: 11,
                                fontWeight: 700,
                                textTransform: 'uppercase',
                                letterSpacing: '0.06em',
                                color: '#ffa07a',
                                marginBottom: 8,
                                marginTop: 0,
                              }}
                            >
                              <Info size={13} /> Decoder Notes
                            </p>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                              {parseResult.warnings.map((warn, i) => (
                                <div
                                  key={i}
                                  style={{ fontSize: 11.5, color: 'var(--riscv-text-2)' }}
                                >
                                  • {warn}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </StudioCard>

              {/* Card 2.2: Hardware & Implementation Parameters */}
              {(() => {
                const ids = Array.from(workspaceIds);
                const params = resolveParams(ids);
                const vlen = impliedVlen(ids);
                const VLEN_CHOICES = [32, 64, 128, 256, 512, 1024];
                return (
                  <StudioCard
                    title="Implementation Parameters"
                    badge={params.length ? `${params.length} constraints` : undefined}
                    icon={<Sliders size={14} style={{ color: 'var(--riscv-gold)' }} />}
                  >
                    {/* Vector length picker */}
                    <div style={{ marginBottom: params.length ? 14 : 0 }}>
                      <div
                        style={{ fontSize: 11.5, color: 'var(--riscv-text-2)', marginBottom: 7 }}
                      >
                        Vector length (VLEN):{' '}
                        {vlen ? (
                          <span style={{ color: 'var(--riscv-gold)', fontWeight: 700 }}>
                            ≥ {vlen} bits
                          </span>
                        ) : (
                          <span style={{ color: 'var(--riscv-text-3)' }}>
                            not constrained — no vector extension selected
                          </span>
                        )}
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {VLEN_CHOICES.map((bits) => {
                          const ext = vlenExtension(bits);
                          const active = vlen === bits;
                          return (
                            <button
                              key={bits}
                              type="button"
                              onClick={() => onSetVlen(active ? null : bits)}
                              title={
                                active
                                  ? `VLEN is ≥ ${bits}. Click to clear it (removes ${ext}).`
                                  : `Set VLEN ≥ ${bits}${vlen && bits < vlen ? ` — lowers it from ${vlen}` : ''}`
                              }
                              style={{
                                fontSize: 11,
                                fontFamily: 'JetBrains Mono, monospace',
                                fontWeight: 600,
                                padding: '4px 10px',
                                borderRadius: 6,
                                cursor: 'pointer',
                                border: `1px solid ${active ? 'rgba(245,197,66,0.6)' : 'var(--riscv-border-2)'}`,
                                background: active
                                  ? 'rgba(245,197,66,0.18)'
                                  : 'var(--riscv-surface-2)',
                                color: active ? 'var(--riscv-gold)' : 'var(--riscv-text-2)',
                              }}
                            >
                              {bits}
                            </button>
                          );
                        })}
                      </div>
                      <div
                        style={{
                          fontSize: 10.5,
                          color: 'var(--riscv-text-3)',
                          marginTop: 6,
                          lineHeight: 1.45,
                        }}
                      >
                        There is no VLEN flag: vector length is expressed by the Zvl*b extensions.
                        Click a value to set the floor, or click the selected one to clear it. A
                        vector extension may hold the floor above your choice — Zve64x requires
                        Zvl64b — in which case the higher value stands.
                      </div>
                    </div>

                    {/* Derived Parameters */}
                    {params.length > 0 && (
                      <div
                        style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}
                      >
                        {params.map((prm) => (
                          <div
                            key={prm.name}
                            style={{
                              borderRadius: 7,
                              padding: '8px 10px',
                              background: prm.conflict
                                ? 'rgba(255,77,107,0.08)'
                                : 'var(--riscv-surface-2)',
                              border: `1px solid ${prm.conflict ? 'rgba(255,77,107,0.3)' : 'var(--riscv-border-2)'}`,
                            }}
                          >
                            <div
                              style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}
                            >
                              <span
                                style={{
                                  fontFamily: 'JetBrains Mono, monospace',
                                  fontSize: 11,
                                  color: 'var(--riscv-text)',
                                  fontWeight: 600,
                                }}
                              >
                                {prm.name}
                              </span>
                              <span
                                style={{
                                  fontFamily: 'JetBrains Mono, monospace',
                                  fontSize: 11,
                                  color: 'var(--riscv-gold)',
                                  fontWeight: 700,
                                }}
                              >
                                {prm.kind === 'greaterThanOrEqual'
                                  ? `≥ ${prm.value}`
                                  : prm.kind === 'oneOf' && Array.isArray(prm.value)
                                    ? (paramChoices?.[prm.name] ??
                                      `choose one of ${prm.value.length}`)
                                    : Array.isArray(prm.value)
                                      ? prm.value.join(', ')
                                      : String(prm.value)}
                              </span>
                            </div>

                            {(() => {
                              // What the parameter IS, from unified-db, under what this
                              // selection makes it. The row above shows a name and a value;
                              // on its own that does not say whether the value is a count, a
                              // mode, or a list, which is what a reader needs before deciding
                              // whether it looks right.
                              const def = describeParameter(prm.name);
                              if (!def) return null;
                              return (
                                <div
                                  title={def.description ?? undefined}
                                  style={{
                                    fontSize: 10,
                                    color: 'var(--riscv-text-3)',
                                    marginTop: 3,
                                  }}
                                >
                                  {def.longName ? `${def.longName} · ` : ''}
                                  {def.summary}
                                </div>
                              );
                            })()}
                            {prm.kind === 'oneOf' &&
                              Array.isArray(prm.value) &&
                              prm.value.length > 1 && (
                                <div
                                  style={{
                                    display: 'flex',
                                    gap: 5,
                                    flexWrap: 'wrap',
                                    marginTop: 6,
                                  }}
                                >
                                  {prm.value.map((option) => {
                                    const active = paramChoices?.[prm.name] === option;
                                    return (
                                      <button
                                        key={String(option)}
                                        type="button"
                                        onClick={() => onSetParam(prm.name, active ? null : option)}
                                        aria-pressed={active}
                                        title={
                                          active
                                            ? 'Clear this choice'
                                            : `Set ${prm.name} to ${option}`
                                        }
                                        style={{
                                          fontSize: 10,
                                          fontFamily: 'JetBrains Mono, monospace',
                                          padding: '3px 8px',
                                          borderRadius: 6,
                                          cursor: 'pointer',
                                          border: `1px solid ${active ? 'rgba(245,197,66,0.6)' : 'var(--riscv-border-2)'}`,
                                          background: active
                                            ? 'rgba(245,197,66,0.18)'
                                            : 'var(--riscv-bg)',
                                          color: active
                                            ? 'var(--riscv-gold)'
                                            : 'var(--riscv-text-2)',
                                        }}
                                      >
                                        {String(option)}
                                      </button>
                                    );
                                  })}
                                </div>
                              )}

                            <div
                              style={{ fontSize: 10, color: 'var(--riscv-text-3)', marginTop: 4 }}
                            >
                              {prm.kind === 'oneOf'
                                ? `narrowed to these by ${prm.from.join(', ')}`
                                : prm.kind === 'greaterThanOrEqual'
                                  ? `floor set by ${prm.from.join(', ')} — raise it with the buttons above`
                                  : `fixed by ${prm.from.join(', ')} — not separately settable`}
                            </div>
                            {prm.conflict && (
                              <div style={{ fontSize: 10, color: '#ff7a8a', marginTop: 4 }}>
                                {prm.conflict}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </StudioCard>
                );
              })()}
            </div>

            {/* =========================================================================
                COLUMN 3: COMBINED INSTRUCTION CATALOG & BITFIELD INSPECTOR
                ========================================================================= */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              {/* Card 3.1: Instruction Catalog */}
              <StudioCard
                title="Combined Instruction Catalog"
                badge={`${filteredCatalog.length.toLocaleString()} / ${totalInstructions.toLocaleString()}`}
                icon={<BookOpen size={14} style={{ color: 'var(--riscv-gold)' }} />}
              >
                {/* Search box */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '7px 10px',
                    borderRadius: 8,
                    border: '1px solid var(--riscv-border-2)',
                    background: 'var(--riscv-surface-2)',
                    marginBottom: 10,
                  }}
                >
                  <Search size={13} style={{ color: 'var(--riscv-text-3)', flexShrink: 0 }} />
                  <input
                    type="text"
                    value={catalogQuery}
                    onChange={(e) => setCatalogQuery(e.target.value)}
                    placeholder="Filter mnemonic, extension, match..."
                    style={{
                      flex: 1,
                      background: 'transparent',
                      border: 'none',
                      outline: 'none',
                      fontSize: 12,
                      color: 'var(--riscv-text)',
                    }}
                  />
                  {catalogQuery && (
                    <button
                      type="button"
                      onClick={() => setCatalogQuery('')}
                      style={{
                        color: 'var(--riscv-text-3)',
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        padding: 0,
                      }}
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>

                {/* Table */}
                <div
                  style={{
                    borderRadius: 8,
                    border: '1px solid var(--riscv-border-2)',
                    overflow: 'hidden',
                    background: 'var(--riscv-surface)',
                  }}
                >
                  {/* Table Header */}
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '2fr 1.5fr 1.5fr',
                      padding: '8px 12px',
                      background: 'var(--riscv-surface-2)',
                      borderBottom: '1px solid var(--riscv-border-2)',
                    }}
                  >
                    {[
                      { col: 'mnemonic', label: 'Mnemonic' },
                      { col: 'source', label: 'Source(s)' },
                      { col: 'match', label: 'Match' },
                    ].map(({ col, label }) => (
                      <button
                        key={col}
                        type="button"
                        onClick={() => toggleSort(col)}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4,
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          padding: 0,
                          fontSize: 10.5,
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          letterSpacing: '0.06em',
                          color:
                            catalogSort.col === col ? 'var(--riscv-gold)' : 'var(--riscv-text-3)',
                        }}
                      >
                        {label} <SortIcon sort={catalogSort} col={col} />
                      </button>
                    ))}
                  </div>

                  {/* Rows */}
                  <div style={{ maxHeight: 320, overflowY: 'auto', overscrollBehavior: 'contain' }}>
                    {filteredCatalog.length === 0 ? (
                      <div
                        style={{
                          padding: '20px',
                          textAlign: 'center',
                          fontSize: 12,
                          color: 'var(--riscv-text-3)',
                        }}
                      >
                        {catalogQuery
                          ? 'No instructions match filter.'
                          : 'No instructions in selected extensions.'}
                      </div>
                    ) : (
                      filteredCatalog.slice(0, 200).map((row, i) => (
                        <CatalogRow
                          key={row.key}
                          row={row}
                          isEven={i % 2 === 0}
                          isHovered={hoveredRow === row.key}
                          isSelected={selectedRowInstruction?.key === row.key}
                          onHover={setHoveredRow}
                          onSelect={(instr) => {
                            setSelectedRowInstruction(instr);
                          }}
                        />
                      ))
                    )}
                    {filteredCatalog.length > 200 && (
                      <div
                        style={{
                          padding: '8px 12px',
                          background: 'var(--riscv-surface-2)',
                          borderTop: '1px solid var(--riscv-border-2)',
                          fontSize: 11,
                          color: 'var(--riscv-text-3)',
                          textAlign: 'center',
                        }}
                      >
                        Showing first 200 of {filteredCatalog.length.toLocaleString()} instructions.
                      </div>
                    )}
                  </div>
                </div>

                <div
                  style={{
                    fontSize: 10.5,
                    color: 'var(--riscv-text-3)',
                    marginTop: 7,
                    lineHeight: 1.4,
                  }}
                >
                  Deduplicated by mnemonic + encoding across all active extensions.
                </div>
              </StudioCard>

              {/* Card 3.2: Selected Instruction Bitfield Inspector */}
              {selectedRowInstruction && (
                <StudioCard
                  title={`Instruction: ${selectedRowInstruction.mnemonic}`}
                  badge={selectedRowInstruction.extId}
                  icon={<Binary size={14} style={{ color: 'var(--riscv-gold)' }} />}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {selectedRowInstruction.encoding && (
                      <div>
                        <div
                          style={{
                            fontSize: 10.5,
                            fontWeight: 700,
                            textTransform: 'uppercase',
                            letterSpacing: '0.06em',
                            color: 'var(--riscv-text-3)',
                            marginBottom: 6,
                          }}
                        >
                          32-Bit Encoding Breakdown
                        </div>
                        <EncodingDiagram encoding={selectedRowInstruction.encoding} />
                      </div>
                    )}

                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '1fr 1fr',
                        gap: 8,
                        marginTop: 4,
                      }}
                    >
                      <div
                        style={{
                          padding: '6px 10px',
                          borderRadius: 6,
                          background: 'var(--riscv-surface-2)',
                          border: '1px solid var(--riscv-border-2)',
                        }}
                      >
                        <span
                          style={{ fontSize: 10, color: 'var(--riscv-text-3)', display: 'block' }}
                        >
                          Match
                        </span>
                        <code style={{ fontSize: 11.5, color: 'var(--riscv-gold)' }}>
                          {selectedRowInstruction.match || '—'}
                        </code>
                      </div>
                      <div
                        style={{
                          padding: '6px 10px',
                          borderRadius: 6,
                          background: 'var(--riscv-surface-2)',
                          border: '1px solid var(--riscv-border-2)',
                        }}
                      >
                        <span
                          style={{ fontSize: 10, color: 'var(--riscv-text-3)', display: 'block' }}
                        >
                          Mask
                        </span>
                        <code style={{ fontSize: 11.5, color: 'var(--riscv-text-2)' }}>
                          {selectedRowInstruction.mask || '—'}
                        </code>
                      </div>
                    </div>
                  </div>
                </StudioCard>
              )}

              {/* Card 3.3: Data Sources & Provenance */}
              <div
                style={{
                  borderRadius: 12,
                  background: 'var(--riscv-surface)',
                  border: '1px solid var(--riscv-border)',
                  padding: '14px 16px',
                }}
              >
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                    color: 'var(--riscv-text-3)',
                    marginBottom: 10,
                  }}
                >
                  Specification Data Sources
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {DATA_PROVENANCE.map((p) => (
                    <div key={p.label} style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                      <span style={{ fontSize: 11, color: 'var(--riscv-text-3)', flexShrink: 0 }}>
                        {p.label}
                      </span>
                      <span
                        style={{
                          height: 1,
                          flex: 1,
                          background: 'var(--riscv-border-2)',
                          alignSelf: 'center',
                        }}
                      />
                      <a
                        href={p.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4,
                          fontSize: 11,
                          color: 'var(--riscv-violet)',
                          textDecoration: 'none',
                          flexShrink: 0,
                        }}
                      >
                        {p.source} <ExternalLink size={10} />
                      </a>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      <style>{`
        @keyframes wsStudioFadeIn {
          from { opacity: 0; transform: scale(0.995); }
          to   { opacity: 1; transform: scale(1); }
        }
      `}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Studio Card Component (visible overflow so search dropdowns/popovers stay fully visible)
// ---------------------------------------------------------------------------
function StudioCard({ title, badge, count, icon, children }) {
  return (
    <div
      style={{
        borderRadius: 12,
        background: 'var(--riscv-surface)',
        border: '1px solid var(--riscv-border)',
        boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
        position: 'relative',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 16px',
          borderBottom: '1px solid var(--riscv-border-2)',
          background: 'var(--riscv-tint-1)',
          borderTopLeftRadius: 11,
          borderTopRightRadius: 11,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {icon}
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--riscv-text)' }}>{title}</span>
        </div>
        {badge ? (
          <span
            style={{
              fontSize: 10.5,
              fontWeight: 700,
              padding: '2px 7px',
              borderRadius: 5,
              background: 'var(--riscv-surface-2)',
              border: '1px solid var(--riscv-border-2)',
              color: 'var(--riscv-text-2)',
            }}
          >
            {badge}
          </span>
        ) : count !== undefined ? (
          <span
            style={{
              fontSize: 11,
              fontFamily: 'JetBrains Mono, monospace',
              color: 'var(--riscv-text-3)',
            }}
          >
            {count}
          </span>
        ) : null}
      </div>
      <div style={{ padding: '14px 16px' }}>{children}</div>
    </div>
  );
}

function InfoPill({ icon, children }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 7,
        padding: '8px 11px',
        borderRadius: 7,
        background: 'var(--riscv-surface-2)',
        border: '1px solid var(--riscv-border-2)',
        fontSize: 11.5,
        color: 'var(--riscv-text-2)',
      }}
    >
      <span style={{ flexShrink: 0, marginTop: 1, color: 'var(--riscv-gold)' }}>{icon}</span>
      <div>{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chips
// ---------------------------------------------------------------------------
function OptionalChip({ ext, onAdd }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      onClick={onAdd}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={`${ext.desc || ext.name || ext.id} — optional in this profile, click to add`}
      aria-label={`Add ${ext.id}, optional in this profile`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        paddingLeft: 8,
        paddingRight: 8,
        paddingTop: 4,
        paddingBottom: 4,
        borderRadius: 6,
        background: hovered ? 'rgba(139,124,248,0.15)' : 'transparent',
        border: `1px dashed ${hovered ? 'var(--riscv-violet)' : 'rgba(139,124,248,0.4)'}`,
        cursor: 'pointer',
        transition: 'all 0.12s',
      }}
    >
      <span
        style={{
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 11.5,
          fontWeight: 700,
          color: hovered ? 'var(--riscv-violet)' : 'var(--riscv-text-2)',
        }}
      >
        {ext.id}
      </span>
      <span style={{ fontSize: 12, lineHeight: 1, color: 'var(--riscv-violet)' }}>+</span>
    </button>
  );
}

function ExtChip({ ext, lockedBy, onRemove }) {
  const [hovered, setHovered] = useState(false);
  const isLocked = lockedBy && lockedBy.length > 0;

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        paddingLeft: 8,
        paddingRight: isLocked ? 8 : 4,
        paddingTop: 4,
        paddingBottom: 4,
        borderRadius: 6,
        background:
          hovered && !isLocked
            ? 'rgba(245,197,66,0.14)'
            : isLocked
              ? 'rgba(245,197,66,0.04)'
              : 'rgba(245,197,66,0.08)',
        border: `1px solid ${
          hovered && !isLocked
            ? 'rgba(245,197,66,0.4)'
            : isLocked
              ? 'rgba(245,197,66,0.15)'
              : 'rgba(245,197,66,0.25)'
        }`,
        transition: 'all 0.12s',
        opacity: isLocked ? 0.8 : 1,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={isLocked ? `Required by ${lockedBy.join(', ')} — remove dependent first` : undefined}
    >
      <span
        style={{
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 11.5,
          fontWeight: 700,
          color: isLocked ? 'var(--riscv-gold-locked)' : 'var(--riscv-gold)',
        }}
      >
        {ext.id}
      </span>

      {!isLocked ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${ext.id}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 16,
            height: 16,
            borderRadius: 4,
            background: hovered ? 'rgba(255,255,255,0.1)' : 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: hovered ? '#f87171' : 'var(--riscv-text-3)',
            transition: 'all 0.12s',
            padding: 0,
          }}
        >
          <X size={10} />
        </button>
      ) : (
        <span
          title={`Required by ${lockedBy.join(', ')}`}
          style={{ fontSize: 9, opacity: 0.6, color: 'var(--riscv-gold)' }}
        >
          🔒
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Catalog table row
// ---------------------------------------------------------------------------
function CatalogRowInner({ row, isEven, isHovered, isSelected, onHover, onSelect }) {
  function srcColor(extId) {
    const palette = [
      'var(--riscv-accent-1)',
      'var(--riscv-accent-2)',
      'var(--riscv-accent-3)',
      'var(--riscv-accent-4)',
      'var(--riscv-accent-5)',
      'var(--riscv-accent-6)',
      'var(--riscv-accent-7)',
      'var(--riscv-accent-8)',
      'var(--riscv-accent-9)',
    ];
    let h = 0;
    for (const c of extId) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
    return palette[h % palette.length];
  }

  return (
    <button
      type="button"
      onMouseEnter={() => onHover(row.key)}
      onMouseLeave={() => onHover(null)}
      onClick={() =>
        onSelect({
          // Carries the row's unique key so selection can identify this exact
          // row. The catalog deduplicates by mnemonic AND encoding, so the
          // mnemonic alone does not identify a row.
          key: row.key,
          extId: row.sources[0].extId,
          mnemonic: row.mnemonic,
          encoding: row.encoding,
          variable_fields: row.variable_fields,
          match: row.match,
          mask: row.mask,
        })
      }
      style={{
        display: 'grid',
        gridTemplateColumns: '2fr 1.5fr 1.5fr',
        width: '100%',
        padding: '8px 12px',
        background: isSelected
          ? 'rgba(245,197,66,0.12)'
          : isHovered
            ? 'rgba(139,124,248,0.08)'
            : isEven
              ? 'transparent'
              : 'rgba(255,255,255,0.015)',
        borderBottom: '1px solid var(--riscv-border-2)',
        cursor: 'pointer',
        textAlign: 'left',
        border: 'none',
        outline: isSelected
          ? '1px solid var(--riscv-gold)'
          : isHovered
            ? '1px solid rgba(139,124,248,0.25)'
            : 'none',
        outlineOffset: -1,
      }}
    >
      <span
        style={{
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 12.5,
          fontWeight: 700,
          color: isSelected ? 'var(--riscv-gold)' : isHovered ? '#c4b5fd' : 'var(--riscv-text)',
          paddingRight: 8,
        }}
      >
        {row.mnemonic}
      </span>

      <span
        style={{ display: 'flex', flexWrap: 'wrap', gap: 3, paddingRight: 8, alignItems: 'center' }}
      >
        {row.sources.map((s) => (
          <span
            key={s.extId}
            style={{
              padding: '1px 5px',
              borderRadius: 4,
              fontSize: 10.5,
              fontFamily: 'JetBrains Mono, monospace',
              fontWeight: 600,
              background: `${srcColor(s.extId)}18`,
              border: `1px solid ${srcColor(s.extId)}38`,
              color: srcColor(s.extId),
            }}
          >
            {s.extId}
          </span>
        ))}
      </span>

      <span
        style={{
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 11.5,
          color: 'var(--riscv-text-3)',
        }}
      >
        {row.match || '—'}
      </span>
    </button>
  );
}

const CatalogRow = React.memo(CatalogRowInner);
