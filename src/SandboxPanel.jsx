/**
 * SandboxPanel.jsx — Custom Extension Sandbox
 *
 * An interactive design tool for custom RISC-V instructions. Users define
 * instructions in the custom opcode space (custom-0 through custom-3), and
 * the panel validates them in real-time against the full standard encoding
 * database using the same conflict-detection arithmetic as the Encoder Validator.
 *
 * The sandbox never modifies canonical data files. It operates as a runtime
 * overlay stored in localStorage, keeping the source-of-truth files untouched.
 */
import React from 'react';
import {
  X,
  Plus,
  Trash2,
  Copy,
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
  Info,
  Download,
  ChevronDown,
  Link,
  Activity,
  Undo2,
  Search,
  ArrowRight,
  BookOpen,
  Cpu,
  ShieldCheck,
} from 'lucide-react';

import {
  OPCODES,
  INSTRUCTION_FORMATS,
  MAX_EXTENSIONS,
  MAX_INSTRUCTIONS,
  createExtension,
  createInstruction,
  cloneFromCatalogInstruction,
  getExtensionMajorOpcodes,
  enforcePrefix,
  validateExtensionId,
  validateInstruction,
  toRiscvOpcodesJson,
  allInstructionEncodings,
  saveSandbox,
  loadSandbox,
  serializeSandboxAsync,
} from './sandboxModel.js';
import { DEPENDENCY_GRAPH } from './isaGraph.js';
import { encodingToMatchMask, toHex32 } from './encodingUtils.js';
import { focusableWithin, nextFocus } from './focusTrap.js';

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// Severity icon helper
// ---------------------------------------------------------------------------

function SeverityIcon({ severity }) {
  if (severity === 'error') {
    return <AlertCircle size={13} style={{ color: 'var(--riscv-red, #ef4444)' }} />;
  }
  if (severity === 'warning') {
    return <AlertTriangle size={13} style={{ color: 'var(--riscv-gold)' }} />;
  }
  return <Info size={13} style={{ color: 'var(--riscv-accent-4, #60a5fa)' }} />;
}

// ---------------------------------------------------------------------------
// Bit Cell — a single bit in the 32-bit editor
// ---------------------------------------------------------------------------

function BitCell({ index, value, fieldName, onClick }) {
  const isFixed = value === '0' || value === '1';
  const isOpcode = index >= 25; // bits [6:0] → indices 25..31

  return (
    <button
      type="button"
      onClick={() => onClick(index)}
      title={`bit[${31 - index}] — ${fieldName}${isOpcode ? ' (opcode — click to cycle)' : ' — click to cycle: 0 → 1 → variable → 0'}`}
      className="sandbox-bit-cell"
      style={{
        background: isFixed
          ? isOpcode
            ? 'var(--riscv-tint-gold, rgba(245,197,66,0.1))'
            : 'var(--riscv-surface-2)'
          : 'transparent',
        color: isFixed ? 'var(--riscv-text)' : 'var(--riscv-text-3)',
        fontWeight: isFixed ? 600 : 400,
        borderRight:
          (index + 1) % 4 === 0 && index !== 31
            ? '2px solid var(--riscv-border-2)'
            : '1px solid var(--riscv-border)',
      }}
    >
      {value === '-' ? 'x' : value}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Field mapping for the 32-bit editor legend
// ---------------------------------------------------------------------------

function getFieldForBit(index, format) {
  const bitPos = 31 - index;
  if (bitPos <= 6) return 'opcode';
  const fmt = INSTRUCTION_FORMATS[format];
  if (!fmt) return 'unknown';
  for (const field of fmt.fields) {
    if (bitPos >= field.bits[1] && bitPos <= field.bits[0]) return field.name;
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// SandboxPanel
// ---------------------------------------------------------------------------

export default function SandboxPanel({
  open,
  onClose,
  catalog,
  extensions: externalExtensions,
  onUpdateExtensions,
}) {
  const [extensions, setExtensionsState] = React.useState(
    () => externalExtensions || loadSandbox(),
  );

  React.useEffect(() => {
    if (externalExtensions) setExtensionsState(externalExtensions);
  }, [externalExtensions]);

  const setExtensions = React.useCallback(
    (updater) => {
      const next = typeof updater === 'function' ? updater(extensions) : updater;
      setExtensionsState(next);
      saveSandbox(next);
      onUpdateExtensions?.(next);
    },
    [extensions, onUpdateExtensions],
  );

  const [selectedExtIdx, setSelectedExtIdx] = React.useState(0);
  const [selectedInstrIdx, setSelectedInstrIdx] = React.useState(-1);
  const [copiedState, setCopiedState] = React.useState(null);
  const [formatDropdown, setFormatDropdown] = React.useState(false);
  const [history, setHistory] = React.useState([]);

  // Mode B Intent Modal & Picker state
  const [intentModalOpen, setIntentModalOpen] = React.useState(false);
  const [intentModalStep, setIntentModalStep] = React.useState('intent'); // 'intent' | 'picker'
  const [intentModalNotice, setIntentModalNotice] = React.useState(null);
  const [catalogSearchQuery, setCatalogSearchQuery] = React.useState('');

  // Sibling Instruction Clone Popover state
  const [clonePopoverOpen, setClonePopoverOpen] = React.useState(false);
  const [cloneSearchQuery, setCloneSearchQuery] = React.useState('');

  const commitHistory = React.useCallback(
    (label) => {
      setHistory((prev) => [...prev, { state: JSON.parse(JSON.stringify(extensions)), label }]);
    },
    [extensions],
  );

  const handleUndo = React.useCallback(() => {
    if (history.length === 0) return;
    const last = history[history.length - 1];
    setHistory((prev) => prev.slice(0, -1));
    setExtensions(last.state);
  }, [history, setExtensions]);

  const dialogRef = React.useRef(null);

  // Focus trap and Escape
  const onCloseRef = React.useRef(onClose);
  React.useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Initial focus and return focus on close
  React.useEffect(() => {
    if (!open) return undefined;
    const opener = document.activeElement;

    // Only set initial focus if we aren't already focused inside
    if (dialogRef.current && !dialogRef.current.contains(document.activeElement)) {
      focusableWithin(dialogRef.current)[0]?.focus();
    }

    return () => {
      opener?.focus?.();
    };
  }, [open]);

  // Keyboard trap
  React.useEffect(() => {
    if (!open) return undefined;

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        if (clonePopoverOpen) {
          setClonePopoverOpen(false);
        } else if (formatDropdown) {
          setFormatDropdown(false);
        } else if (intentModalOpen) {
          setIntentModalOpen(false);
        } else {
          onCloseRef.current();
        }
        return;
      }
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
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, formatDropdown, intentModalOpen, clonePopoverOpen]);

  const catalogInstructions = React.useMemo(() => {
    if (!open || !catalog) return [];
    // Do not check against other sandbox instructions globally here,
    // otherwise the instruction conflicts with itself.
    const standardCatalog = catalog.filter((ext) => !ext.isSandbox);
    return allInstructionEncodings(standardCatalog);
  }, [open, catalog]);

  // Current extension and instruction
  const ext = extensions[selectedExtIdx] || null;
  const instr = ext && selectedInstrIdx >= 0 ? ext.instructions[selectedInstrIdx] : null;

  // Catalog contextual metadata for the current extension
  const currentCatalogExt = React.useMemo(() => {
    if (!ext || !catalog) return null;
    const targetId = ext.baseExtensionId || ext.id;
    return catalog.find((c) => c && c.id === targetId && !c.isSandbox) || null;
  }, [ext, catalog]);

  const activeOpcodes = React.useMemo(() => {
    if (!currentCatalogExt) return [];
    return getExtensionMajorOpcodes(currentCatalogExt);
  }, [currentCatalogExt]);

  const currentDependencies = React.useMemo(() => {
    if (!ext) return [];
    const targetId = ext.baseExtensionId || ext.id;
    const node = DEPENDENCY_GRAPH?.nodes?.[targetId];
    return (node?.requires || []).map((r) => r.ext).filter(Boolean);
  }, [ext]);

  const extContext = React.useMemo(() => {
    if (!ext) return null;
    return {
      mode: ext.mode || 'custom',
      baseExtensionId: ext.baseExtensionId || ext.id,
      allowedOpcodes: activeOpcodes,
    };
  }, [ext, activeOpcodes]);

  // Live validation for all instructions in the current extension
  const allDiagnostics = React.useMemo(() => {
    if (!ext) return [];
    const results = [];
    for (let i = 0; i < ext.instructions.length; i++) {
      const currentInst = ext.instructions[i];
      const others = [];
      for (const e of extensions) {
        for (const oi of e.instructions) {
          if (oi !== currentInst) others.push(oi);
        }
      }
      const d = validateInstruction(currentInst, catalogInstructions, others, extContext);
      if (d.length > 0) {
        results.push({ idx: i, instr: currentInst, diagnostics: d });
      }
    }
    return results;
  }, [ext, catalogInstructions, extensions, extContext]);

  // ------- Mutation helpers -------

  const createVendorExtension = () => {
    if (extensions.length >= MAX_EXTENSIONS) return;
    commitHistory('Add Vendor Extension');
    // Find the first unused sequential ID to avoid reuse after deletes.
    // createExtension(`Xext${extensions.length + 1}`) re-creates Xext2 if
    // you have [Xext1, Xext2], delete Xext1, then add again.
    const existingIds = new Set(extensions.map((e) => e.id));
    let n = 1;
    while (existingIds.has(`Xext${n}`)) n++;
    const newExt = createExtension(`Xext${n}`, false, 'custom');
    setExtensions((prev) => [...prev, newExt]);
    setSelectedExtIdx(extensions.length);
    setSelectedInstrIdx(-1);
    setIntentModalOpen(false);
  };

  const createStandardAddition = (targetCatalogExt) => {
    if (!targetCatalogExt || extensions.length >= MAX_EXTENSIONS) return;
    setIntentModalNotice(null);

    // Guard against picking the same base extension twice
    const existingIdx = extensions.findIndex(
      (e) =>
        e.mode === 'addition' &&
        (e.baseExtensionId === targetCatalogExt.id || e.id === `${targetCatalogExt.id}__sandbox`),
    );
    if (existingIdx !== -1) {
      setSelectedExtIdx(existingIdx);
      setSelectedInstrIdx(-1);
      setIntentModalOpen(false);
      return;
    }

    // Refuse and surface if extension has no 32-bit major opcodes allocated (e.g. compressed-only Zcb/Zca)
    const opcodes = getExtensionMajorOpcodes(targetCatalogExt);
    if (opcodes.length === 0) {
      setIntentModalNotice(
        `Cannot create 32-bit addition for "${targetCatalogExt.id}": this extension operates entirely in 16-bit compressed space (inst[1:0] \u2260 11) or has no 32-bit major opcodes allocated. The sandbox models 32-bit base instructions.`,
      );
      return;
    }

    commitHistory(`Add Standard Addition to ${targetCatalogExt.id}`);
    const primaryOpcode = opcodes[0];
    const newExt = createExtension('', true, 'addition', {
      id: targetCatalogExt.id,
      name: targetCatalogExt.name,
      desc: targetCatalogExt.desc,
      primaryOpcode,
      tags: targetCatalogExt.tags,
    });
    if (!newExt) return;
    setExtensions((prev) => [...prev, newExt]);
    setSelectedExtIdx(extensions.length);
    setSelectedInstrIdx(-1);
    setIntentModalOpen(false);
  };

  const removeExtension = (idx) => {
    commitHistory('Remove Extension');
    setExtensions((prev) => prev.filter((_, i) => i !== idx));
    setSelectedExtIdx((cur) => {
      // If deleting the selected extension, clamp to the new last index.
      if (cur === idx) return Math.max(0, Math.min(cur, extensions.length - 2));
      // If deleting before the selection, shift down to follow it.
      if (cur > idx) return cur - 1;
      // Deleting after the selection: no change.
      return cur;
    });
    setSelectedInstrIdx(-1);
  };

  const updateExtField = (field, value) => {
    setExtensions((prev) =>
      prev.map((e, i) => {
        if (i !== selectedExtIdx) return e;
        const nextExt = { ...e, [field]: value };
        if (field === 'isOfficial') {
          nextExt.id = enforcePrefix(nextExt.id, value, e.mode === 'addition');
        } else if (field === 'id') {
          nextExt.id = enforcePrefix(value, nextExt.isOfficial, e.mode === 'addition');
        }
        if (field === 'id' || field === 'isOfficial') {
          if (e.mode !== 'addition') {
            nextExt.tags = [`rv_${nextExt.id.toLowerCase()}`];
          }
        }
        return nextExt;
      }),
    );
  };

  const cloneSiblingInstruction = (catalogInstr) => {
    if (!ext || ext.instructions.length >= MAX_INSTRUCTIONS) return;
    commitHistory(`Clone ${catalogInstr.mnemonic}`);
    const newInstr = cloneFromCatalogInstruction(catalogInstr, ext.opcode);
    if (!newInstr) return;
    setExtensions((prev) =>
      prev.map((e, i) => {
        if (i !== selectedExtIdx) return e;
        return { ...e, instructions: [...e.instructions, newInstr] };
      }),
    );
    setSelectedInstrIdx(ext.instructions.length);
    setClonePopoverOpen(false);
  };

  const addInstruction = (formatKey = 'R') => {
    if (!ext || ext.instructions.length >= MAX_INSTRUCTIONS) return;
    commitHistory('Add Instruction');
    const newInstr = createInstruction(formatKey, ext.opcode);
    if (!newInstr) return;
    setExtensions((prev) =>
      prev.map((e, i) => {
        if (i !== selectedExtIdx) return e;
        return { ...e, instructions: [...e.instructions, newInstr] };
      }),
    );
    setSelectedInstrIdx(ext.instructions.length);
    setFormatDropdown(false);
  };

  const removeInstruction = (instrIdx) => {
    commitHistory('Remove Instruction');
    setExtensions((prev) =>
      prev.map((e, i) => {
        if (i !== selectedExtIdx) return e;
        return { ...e, instructions: e.instructions.filter((_, j) => j !== instrIdx) };
      }),
    );
    setSelectedInstrIdx((cur) => {
      const len = ext?.instructions.length || 0;
      if (cur === instrIdx) return Math.max(-1, Math.min(cur, len - 2));
      if (cur > instrIdx) return cur - 1;
      return cur;
    });
  };

  const updateInstrField = (field, value) => {
    setExtensions((prev) =>
      prev.map((e, i) => {
        if (i !== selectedExtIdx) return e;
        return {
          ...e,
          instructions: e.instructions.map((instr2, j) => {
            if (j !== selectedInstrIdx) return instr2;
            const updated = { ...instr2, [field]: value };
            // If encoding changed, recompute match/mask
            if (field === 'encoding') {
              const parsed = encodingToMatchMask(value);
              if (parsed.match !== null && parsed.mask !== null) {
                updated.match = toHex32(parsed.match);
                updated.mask = toHex32(parsed.mask);
              }
              // Recompute variable fields from encoding
              const enc = (value || '').replace(/\s+/g, '');
              if (enc.length === 32) {
                const fmt = INSTRUCTION_FORMATS[updated.format];
                if (fmt) {
                  const formatFieldNames = new Set(fmt.fields.map((f) => f.name));
                  const knownVariable = fmt.fields
                    .filter((f) => {
                      // A field is variable if ANY of its bits are '-'
                      for (let b = f.bits[0]; b >= f.bits[1]; b--) {
                        const idx = 31 - b;
                        if (enc[idx] === '-') return true;
                      }
                      return false;
                    })
                    .map((f) => f.name);
                  // Preserve fields that were on the instruction but aren't in the format def (e.g. bimm12hi/lo)
                  const preserved = (updated.variable_fields || []).filter(
                    (name) => !formatFieldNames.has(name),
                  );
                  updated.variable_fields = [...knownVariable, ...preserved];
                }
              }
            }
            return updated;
          }),
        };
      }),
    );
  };

  const handleBitClick = (bitIndex) => {
    if (!instr) return;
    const enc = instr.encoding.split('');
    const current = enc[bitIndex];
    // Cycle: 0 → 1 → - → 0
    if (current === '0') enc[bitIndex] = '1';
    else if (current === '1') enc[bitIndex] = '-';
    else enc[bitIndex] = '0';
    updateInstrField('encoding', enc.join(''));
  };

  const handleExportJson = () => {
    if (!ext) return;
    const json = toRiscvOpcodesJson(ext);
    const text = JSON.stringify(json, null, 2);
    navigator.clipboard?.writeText(text).then(() => {
      setCopiedState('json');
      setTimeout(() => setCopiedState(null), 2000);
    });
  };

  const handleShareLink = async () => {
    try {
      const param = await serializeSandboxAsync(extensions);
      const url = new URL(window.location.href);
      url.searchParams.set('sandbox', param);
      await navigator.clipboard.writeText(url.toString());
      setCopiedState('share');
      setTimeout(() => setCopiedState(null), 2000);
    } catch {
      // ignore
    }
  };

  if (!open) return null;

  const extIdError = ext
    ? validateExtensionId(ext.id, ext.isOfficial, ext.mode === 'addition')
    : null;

  return (
    <div className="fixed inset-0 z-50">
      <div
        className="absolute inset-0"
        style={{ background: 'rgba(7,7,14,0.88)', backdropFilter: 'blur(4px)' }}
        onClick={onClose}
        role="presentation"
      />
      <div
        className="absolute inset-0 p-3 md:p-6 flex items-start justify-center overflow-y-auto scrollbar-stable"
        style={{ scrollbarGutter: 'stable' }}
      >
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="sandbox-title"
          className="animate-scale-in w-[95vw] max-w-[1300px] riscv-card overflow-hidden sandbox-panel"
          style={{
            boxShadow: '0 0 60px rgba(0,0,0,0.8), 0 0 0 1px rgba(59,130,246,0.2)',
          }}
        >
          {/* ── Header ── */}
          <div
            className="p-4 flex items-start justify-between gap-3"
            style={{ borderBottom: '1px solid var(--riscv-border)' }}
          >
            <div className="min-w-0">
              <h3
                id="sandbox-title"
                className="font-bold flex items-center gap-2"
                style={{ color: 'var(--riscv-text)', fontSize: 15 }}
              >
                <Cpu size={16} style={{ color: 'var(--riscv-gold)' }} />
                <span>Custom Extension Sandbox</span>
              </h3>
              <p className="text-[12px] mt-1" style={{ color: 'var(--riscv-text-3)' }}>
                Design custom instructions in the reserved opcode space. Encodings are validated in
                real-time against every instruction in the catalog ({catalogInstructions.length}{' '}
                definitions from{' '}
                <a
                  href="https://github.com/riscv/riscv-opcodes"
                  target="_blank"
                  rel="noreferrer noopener"
                  style={{ color: 'var(--riscv-gold)' }}
                >
                  riscv-opcodes
                </a>
                ).
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                className="riscv-btn p-1.5 px-2.5 rounded flex items-center gap-1.5 text-[12px] font-semibold transition-all"
                onClick={handleUndo}
                disabled={history.length === 0}
                title={
                  history.length > 0
                    ? `Undo ${history[history.length - 1].label}`
                    : 'Nothing to undo'
                }
                style={{
                  background: 'var(--riscv-surface-2)',
                  borderColor: 'var(--riscv-border)',
                  color: history.length > 0 ? 'var(--riscv-text-2)' : 'var(--riscv-text-3)',
                  opacity: history.length > 0 ? 1 : 0.5,
                  cursor: history.length > 0 ? 'pointer' : 'not-allowed',
                }}
              >
                <Undo2 size={14} />
              </button>
              <button
                type="button"
                className="riscv-btn p-1.5 px-2.5 rounded flex items-center gap-1.5 text-[12px] font-semibold transition-all"
                onClick={handleShareLink}
                style={{
                  background: 'var(--riscv-surface-2)',
                  borderColor:
                    copiedState === 'share' ? 'var(--riscv-green)' : 'var(--riscv-border)',
                  color: copiedState === 'share' ? 'var(--riscv-green)' : 'var(--riscv-text-2)',
                }}
              >
                {copiedState === 'share' ? <CheckCircle2 size={14} /> : <Link size={14} />}
                {copiedState === 'share' ? 'Copied URL!' : 'Share'}
              </button>
              <button
                type="button"
                className="riscv-btn p-1.5 shrink-0"
                onClick={onClose}
                aria-label="Close the sandbox"
              >
                <X size={15} />
              </button>
            </div>
          </div>

          {/* ── Body ── */}
          <div className="flex" style={{ minHeight: 420 }}>
            {/* ── Left sidebar: extension list ── */}
            <div
              className="w-52 shrink-0 border-r p-3 flex flex-col gap-2"
              style={{ borderColor: 'var(--riscv-border)', background: 'var(--riscv-surface)' }}
            >
              <div
                className="text-[11px] uppercase tracking-wider font-semibold mb-1"
                style={{ color: 'var(--riscv-text-3)' }}
              >
                Extensions ({extensions.length}/{MAX_EXTENSIONS})
              </div>

              {extensions.map((e, idx) => (
                <div key={idx} className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedExtIdx(idx);
                      setSelectedInstrIdx(-1);
                    }}
                    className="flex-1 flex items-center justify-between px-2 py-1.5 rounded text-[12px] font-mono transition-all overflow-hidden"
                    style={{
                      background: idx === selectedExtIdx ? 'var(--riscv-surface-2)' : 'transparent',
                      color: idx === selectedExtIdx ? 'var(--riscv-text)' : 'var(--riscv-text-2)',
                      fontWeight: idx === selectedExtIdx ? 600 : 400,
                      border:
                        idx === selectedExtIdx
                          ? '1px solid var(--riscv-border-2)'
                          : '1px solid transparent',
                    }}
                  >
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span
                        className="px-1.5 py-0.5 rounded text-[8px] font-mono font-bold uppercase tracking-wider shrink-0"
                        style={{
                          background: 'var(--riscv-surface)',
                          color:
                            e.mode === 'addition' ? 'var(--riscv-accent-4)' : 'var(--riscv-gold)',
                          border: `1px solid ${
                            e.mode === 'addition' ? 'var(--riscv-accent-4)' : 'var(--riscv-gold)'
                          }`,
                        }}
                      >
                        {e.mode === 'addition' ? 'STD' : 'X'}
                      </span>
                      <span className="truncate">{e.id || '(unnamed)'}</span>
                    </div>
                    <span
                      className="ml-2 shrink-0 px-1.5 py-0.2 rounded font-mono text-[9px]"
                      style={{
                        background: 'var(--riscv-surface)',
                        color: 'var(--riscv-text-3)',
                        border: '1px solid var(--riscv-border)',
                      }}
                    >
                      {e.instructions.length}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => removeExtension(idx)}
                    className="p-1 rounded hover:bg-red-500/20 transition-colors"
                    style={{ color: 'var(--riscv-text-3)' }}
                    aria-label={`Remove ${e.id}`}
                    title={`Remove ${e.id}`}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}

              <button
                type="button"
                onClick={() => {
                  setIntentModalNotice(null);
                  setIntentModalStep('intent');
                  setCatalogSearchQuery('');
                  setIntentModalOpen(true);
                }}
                disabled={extensions.length >= MAX_EXTENSIONS}
                className="mt-2 flex items-center gap-2.5 px-3 py-2 rounded border transition-all disabled:opacity-40 text-left"
                style={{
                  background: 'var(--riscv-surface-2)',
                  borderColor: 'var(--riscv-border-2)',
                  color: 'var(--riscv-text)',
                }}
                title="Create a custom extension or extend an official standard extension"
              >
                <Plus size={14} style={{ color: 'var(--riscv-gold)' }} className="shrink-0" />
                <div className="flex flex-col leading-tight min-w-0">
                  <span
                    className="text-[11px] font-semibold tracking-tight"
                    style={{ color: 'var(--riscv-text)' }}
                  >
                    + Custom Extension
                  </span>
                  <span className="text-[9.5px]" style={{ color: 'var(--riscv-text-3)' }}>
                    or Extend Standard
                  </span>
                </div>
              </button>

              <div
                className="mt-auto pt-3 border-t text-[10px]"
                style={{ borderColor: 'var(--riscv-border)', color: 'var(--riscv-text-3)' }}
              >
                Data validated against the same catalog used by the Encoder Validator and Encoding
                Map.
              </div>
            </div>

            {/* ── Main area ── */}
            <div
              className="flex-1 p-4 overflow-y-auto scrollbar-stable"
              style={{ maxHeight: 'calc(100vh - 200px)', scrollbarGutter: 'stable' }}
            >
              {!ext ? (
                <div
                  className="flex flex-col items-center justify-center h-full gap-3 py-16"
                  style={{ color: 'var(--riscv-text-3)' }}
                >
                  <Cpu size={36} style={{ opacity: 0.35, color: 'var(--riscv-text-3)' }} />
                  <div className="text-center max-w-sm">
                    <h4
                      className="text-[13px] font-semibold"
                      style={{ color: 'var(--riscv-text)' }}
                    >
                      No Active Extension Workspace
                    </h4>
                    <p className="text-[12px] mt-1" style={{ color: 'var(--riscv-text-3)' }}>
                      Design custom instructions for your core or extend an official standard
                      extension.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setIntentModalNotice(null);
                      setIntentModalStep('intent');
                      setCatalogSearchQuery('');
                      setIntentModalOpen(true);
                    }}
                    className="mt-2 flex items-center gap-2 px-3.5 py-1.5 rounded text-[11.5px] font-semibold border transition-all"
                    style={{
                      background: 'var(--riscv-surface-2)',
                      borderColor: 'var(--riscv-border-2)',
                      color: 'var(--riscv-text)',
                    }}
                  >
                    <Plus size={13} style={{ color: 'var(--riscv-gold)' }} />
                    <span>Configure Extension Track</span>
                  </button>
                </div>
              ) : (
                <>
                  {/* ── Extension Intelligence Dossier for Standard Additions ── */}
                  {ext.mode === 'addition' && (
                    <div
                      className="rounded border p-3.5 mb-4"
                      style={{
                        background: 'var(--riscv-surface-2)',
                        borderColor: 'var(--riscv-border-2)',
                      }}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                        <div className="flex items-center gap-2">
                          <span
                            className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold uppercase tracking-wider"
                            style={{
                              background: 'var(--riscv-surface)',
                              color: 'var(--riscv-accent-4)',
                              border: '1px solid var(--riscv-border-2)',
                            }}
                          >
                            STANDARD TRACK
                          </span>
                          <h3
                            className="font-bold text-[13px] font-mono"
                            style={{ color: 'var(--riscv-text)' }}
                          >
                            {ext.id}
                            {currentCatalogExt?.name ? ` — ${currentCatalogExt.name}` : ''}
                          </h3>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setIntentModalNotice(null);
                            setIntentModalStep('picker');
                            setCatalogSearchQuery('');
                            setIntentModalOpen(true);
                          }}
                          className="text-[11px] font-medium px-2.5 py-1 rounded border transition-colors flex items-center gap-1.5"
                          style={{
                            background: 'var(--riscv-surface)',
                            borderColor: 'var(--riscv-border)',
                            color: 'var(--riscv-text-2)',
                          }}
                        >
                          <Search size={11} />
                          <span>Switch Target Extension</span>
                        </button>
                      </div>

                      <div
                        className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-2 pt-2 border-t text-[11px]"
                        style={{ borderColor: 'var(--riscv-border)' }}
                      >
                        <div
                          className="p-2 rounded"
                          style={{
                            background: 'var(--riscv-surface)',
                            border: '1px solid var(--riscv-border)',
                          }}
                        >
                          <span
                            className="text-[9px] uppercase font-mono font-semibold block"
                            style={{ color: 'var(--riscv-text-3)' }}
                          >
                            CATALOG INVENTORY
                          </span>
                          <span
                            className="font-mono font-semibold text-[12px]"
                            style={{ color: 'var(--riscv-text)' }}
                          >
                            {Object.keys(currentCatalogExt?.instructions || {}).length} instructions
                          </span>
                        </div>
                        <div
                          className="p-2 rounded"
                          style={{
                            background: 'var(--riscv-surface)',
                            border: '1px solid var(--riscv-border)',
                          }}
                        >
                          <span
                            className="text-[9px] uppercase font-mono font-semibold block"
                            style={{ color: 'var(--riscv-text-3)' }}
                          >
                            DESIGNATED OPCODES
                          </span>
                          <span
                            className="font-mono font-semibold text-[12px]"
                            style={{ color: 'var(--riscv-text)' }}
                          >
                            {activeOpcodes.length > 0
                              ? activeOpcodes
                                  .map(
                                    (op) => `0x${op.toString(16).padStart(2, '0').toUpperCase()}`,
                                  )
                                  .join(', ')
                              : 'None standard'}
                          </span>
                        </div>
                        <div
                          className="p-2 rounded"
                          style={{
                            background: 'var(--riscv-surface)',
                            border: '1px solid var(--riscv-border)',
                          }}
                        >
                          <span
                            className="text-[9px] uppercase font-mono font-semibold block"
                            style={{ color: 'var(--riscv-text-3)' }}
                          >
                            GRAPH DEPENDENCIES
                          </span>
                          <span
                            className="font-mono font-semibold text-[12px]"
                            style={{ color: 'var(--riscv-text)' }}
                          >
                            {currentDependencies.length > 0
                              ? currentDependencies.join(', ')
                              : 'None (Base ISA)'}
                          </span>
                        </div>
                      </div>

                      <div
                        className="mt-2.5 flex items-center gap-1.5 text-[11px]"
                        style={{ color: 'var(--riscv-text-2)' }}
                      >
                        <ShieldCheck
                          size={13}
                          className="shrink-0"
                          style={{ color: 'var(--riscv-success)' }}
                        />
                        <span>
                          <strong>RISC-V ISA §27:</strong> Candidate instructions allocate into
                          designated opcode space or reserved standard expansion slots (0x6B, 0x77).
                          Custom spaces are prohibited for standard extensions.
                        </span>
                      </div>
                    </div>
                  )}

                  {/* ── Extension metadata ── */}
                  <div className="mb-4">
                    <div className="flex flex-wrap gap-3 mb-3">
                      <div className="flex-1 min-w-[140px]">
                        <label
                          className="block text-[10px] uppercase tracking-wider font-semibold mb-1"
                          style={{ color: 'var(--riscv-text-3)' }}
                        >
                          Extension ID
                        </label>
                        {ext.mode === 'addition' ? (
                          <div
                            className="w-full h-[34px] px-2 rounded text-[12px] font-mono border flex items-center justify-between"
                            style={{
                              background: 'var(--riscv-surface-2)',
                              borderColor: 'var(--riscv-border)',
                              color: 'var(--riscv-text)',
                            }}
                          >
                            <span className="font-bold">{ext.id}</span>
                            <span className="text-[9px] uppercase font-bold text-blue-400 bg-blue-500/10 px-1.5 py-0.5 rounded border border-blue-500/20">
                              Standard
                            </span>
                          </div>
                        ) : (
                          <input
                            type="text"
                            value={ext.id}
                            onChange={(e) => updateExtField('id', e.target.value)}
                            placeholder="Xmyext"
                            className="w-full h-[34px] px-2 rounded text-[12px] font-mono border"
                            style={{
                              background: 'var(--riscv-surface-2)',
                              borderColor: extIdError
                                ? 'var(--riscv-red, #ef4444)'
                                : 'var(--riscv-border)',
                              color: 'var(--riscv-text)',
                            }}
                          />
                        )}
                        {extIdError && (
                          <p
                            className="text-[10px] mt-0.5"
                            style={{ color: 'var(--riscv-red, #ef4444)' }}
                          >
                            {extIdError}
                          </p>
                        )}
                      </div>
                      <div className="flex-1 min-w-[170px]">
                        <label
                          className="block text-[10px] uppercase tracking-wider font-semibold mb-1"
                          style={{ color: 'var(--riscv-text-3)' }}
                        >
                          Extension Track
                        </label>
                        <div
                          className="w-full h-[34px] px-2.5 rounded text-[12px] border font-medium flex items-center"
                          style={{
                            background: 'var(--riscv-surface-2)',
                            borderColor: 'var(--riscv-border)',
                            color: 'var(--riscv-text)',
                          }}
                        >
                          <span className="font-semibold truncate">
                            {ext.mode === 'addition' ? 'Official Standard' : 'Custom Extension'}
                          </span>
                        </div>
                      </div>
                      <div className="flex-1 min-w-[140px]">
                        <label
                          className="block text-[10px] uppercase tracking-wider font-semibold mb-1"
                          style={{ color: 'var(--riscv-text-3)' }}
                        >
                          Description
                        </label>
                        <input
                          type="text"
                          value={ext.desc}
                          onChange={(e) => updateExtField('desc', e.target.value)}
                          placeholder="Short description"
                          className="w-full h-[34px] px-2 rounded text-[12px] border"
                          style={{
                            background: 'var(--riscv-surface-2)',
                            borderColor: 'var(--riscv-border)',
                            color: 'var(--riscv-text)',
                          }}
                        />
                      </div>
                      <div className="w-48">
                        <label
                          className="block text-[10px] uppercase tracking-wider font-semibold mb-1"
                          style={{ color: 'var(--riscv-text-3)' }}
                        >
                          Opcode Space
                        </label>
                        <select
                          value={ext.opcode}
                          onChange={(e) => updateExtField('opcode', parseInt(e.target.value, 10))}
                          className="w-full h-[34px] px-2 rounded text-[12px] font-mono border"
                          style={{
                            background: 'var(--riscv-surface-2)',
                            borderColor: 'var(--riscv-border)',
                            color: 'var(--riscv-text)',
                          }}
                        >
                          {ext.mode === 'addition' ? (
                            <>
                              {activeOpcodes.length > 0 && (
                                <optgroup label={`${ext.id} Designated Opcodes (Standard)`}>
                                  {OPCODES.filter((op) => activeOpcodes.includes(op.value)).map(
                                    (op) => (
                                      <option key={op.value} value={op.value}>
                                        {op.name} (0x{op.value.toString(16).padStart(2, '0')})
                                      </option>
                                    ),
                                  )}
                                </optgroup>
                              )}
                              <optgroup label="Reserved for Future Standard (Safe)">
                                {OPCODES.filter(
                                  (op) =>
                                    op.type === 'reserved' && !activeOpcodes.includes(op.value),
                                ).map((op) => (
                                  <option key={op.value} value={op.value}>
                                    {op.name} (0x{op.value.toString(16).padStart(2, '0')})
                                  </option>
                                ))}
                              </optgroup>
                              <optgroup label="Other Standard Spaces (Collision Risk)">
                                {OPCODES.filter(
                                  (op) =>
                                    op.type === 'standard' && !activeOpcodes.includes(op.value),
                                ).map((op) => (
                                  <option key={op.value} value={op.value}>
                                    {op.name} (0x{op.value.toString(16).padStart(2, '0')})
                                  </option>
                                ))}
                              </optgroup>
                              <optgroup label="Custom (Forbidden by RISC-V §27)">
                                {OPCODES.filter((op) => op.type === 'custom').map((op) => (
                                  <option key={op.value} value={op.value}>
                                    {op.name} (0x{op.value.toString(16).padStart(2, '0')}) [INVALID]
                                  </option>
                                ))}
                              </optgroup>
                            </>
                          ) : (
                            <>
                              <optgroup label="Custom (Safe)">
                                {OPCODES.filter((op) => op.type === 'custom').map((op) => (
                                  <option key={op.value} value={op.value}>
                                    {op.name} (0x{op.value.toString(16).padStart(2, '0')})
                                  </option>
                                ))}
                              </optgroup>
                              <optgroup label="Reserved (Unsafe)">
                                {OPCODES.filter((op) => op.type === 'reserved').map((op) => (
                                  <option key={op.value} value={op.value}>
                                    {op.name} (0x{op.value.toString(16).padStart(2, '0')})
                                  </option>
                                ))}
                              </optgroup>
                              <optgroup label="Standard (Collisions Likely)">
                                {OPCODES.filter((op) => op.type === 'standard').map((op) => (
                                  <option key={op.value} value={op.value}>
                                    {op.name} (0x{op.value.toString(16).padStart(2, '0')})
                                  </option>
                                ))}
                              </optgroup>
                            </>
                          )}
                        </select>
                      </div>
                    </div>
                  </div>

                  {/* ── Instructions section ── */}
                  <div
                    className="rounded border p-3 mb-4"
                    style={{
                      background: 'var(--riscv-surface)',
                      borderColor: 'var(--riscv-border)',
                    }}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <h4
                        className="text-[12px] uppercase tracking-wider font-semibold"
                        style={{ color: 'var(--riscv-text-3)' }}
                      >
                        Instructions ({ext.instructions.length}/{MAX_INSTRUCTIONS})
                      </h4>
                      <div className="flex items-center gap-2">
                        {/* Clone Sibling Instruction Button (Mode B) */}
                        {ext.mode === 'addition' &&
                          currentCatalogExt?.instructions &&
                          Object.keys(currentCatalogExt.instructions).length > 0 && (
                            <div className="relative">
                              <button
                                type="button"
                                onClick={() => setClonePopoverOpen((v) => !v)}
                                disabled={ext.instructions.length >= MAX_INSTRUCTIONS}
                                className="flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-semibold border disabled:opacity-40 transition-colors"
                                style={{
                                  background: 'var(--riscv-surface)',
                                  borderColor: 'var(--riscv-border-2)',
                                  color: 'var(--riscv-text)',
                                }}
                                title="Clone an existing sibling instruction from this extension"
                              >
                                <Copy size={11} style={{ color: 'var(--riscv-accent-4)' }} />
                                <span>Clone Sibling Template</span>
                                <ChevronDown size={11} />
                              </button>
                              {clonePopoverOpen && (
                                <div
                                  className="absolute right-0 top-full mt-1 rounded-md border shadow-xl z-30 w-72 p-2 flex flex-col gap-1.5"
                                  style={{
                                    background: 'var(--riscv-surface)',
                                    borderColor: 'var(--riscv-border-2)',
                                  }}
                                >
                                  <div
                                    className="text-[10px] uppercase font-mono font-semibold tracking-wider px-1"
                                    style={{ color: 'var(--riscv-text-3)' }}
                                  >
                                    Select Base Sibling from {ext.id}
                                  </div>
                                  <input
                                    type="text"
                                    value={cloneSearchQuery}
                                    onChange={(e) => setCloneSearchQuery(e.target.value)}
                                    placeholder="Filter by mnemonic (e.g. vadd)..."
                                    className="w-full px-2 py-1 rounded text-[11px] font-mono border"
                                    style={{
                                      background: 'var(--riscv-surface-2)',
                                      borderColor: 'var(--riscv-border)',
                                      color: 'var(--riscv-text)',
                                    }}
                                    autoFocus
                                  />
                                  <div className="max-h-48 overflow-y-auto flex flex-col gap-0.5 pr-1">
                                    {Object.entries(currentCatalogExt.instructions)
                                      .filter(([mnemonic, details]) => {
                                        // 32-bit filter: skip 16-bit compressed instructions (inst[1:0] != 11)
                                        if (details.match != null) {
                                          try {
                                            const matchVal =
                                              typeof details.match === 'bigint'
                                                ? details.match
                                                : BigInt(details.match);
                                            if (Number(matchVal & 0x3n) !== 3) return false;
                                          } catch {
                                            return false;
                                          }
                                        } else if (
                                          details.encoding &&
                                          details.encoding.length !== 32
                                        ) {
                                          return false;
                                        }
                                        if (!cloneSearchQuery.trim()) return true;
                                        return mnemonic
                                          .toLowerCase()
                                          .includes(cloneSearchQuery.toLowerCase().trim());
                                      })
                                      .slice(0, 30)
                                      .map(([mnemonic, details]) => (
                                        <button
                                          key={mnemonic}
                                          type="button"
                                          onClick={() =>
                                            cloneSiblingInstruction({ mnemonic, ...details })
                                          }
                                          className="text-left px-2 py-1 rounded text-[11px] font-mono transition-colors flex items-center justify-between"
                                          style={{ color: 'var(--riscv-text)' }}
                                          onMouseEnter={(e) => {
                                            e.currentTarget.style.background =
                                              'var(--riscv-surface-2)';
                                          }}
                                          onMouseLeave={(e) => {
                                            e.currentTarget.style.background = 'transparent';
                                          }}
                                        >
                                          <span className="font-bold">{mnemonic}</span>
                                          <span
                                            className="text-[9px]"
                                            style={{ color: 'var(--riscv-text-3)' }}
                                          >
                                            {details.encoding ? details.encoding.slice(25) : '—'}
                                          </span>
                                        </button>
                                      ))}
                                  </div>
                                </div>
                              )}
                            </div>
                          )}

                        {/* Add Template Dropdown */}
                        <div className="relative">
                          <button
                            type="button"
                            onClick={() => setFormatDropdown((v) => !v)}
                            disabled={ext.instructions.length >= MAX_INSTRUCTIONS}
                            className="flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-semibold border disabled:opacity-40 transition-colors"
                            style={{
                              background: 'var(--riscv-surface)',
                              borderColor: 'var(--riscv-border-2)',
                              color: 'var(--riscv-text)',
                            }}
                          >
                            <Plus size={11} style={{ color: 'var(--riscv-gold)' }} />
                            <span>Add Format</span>
                            <ChevronDown size={11} />
                          </button>
                          {formatDropdown && (
                            <div
                              className="absolute right-0 top-full mt-1 rounded border shadow-xl z-20 min-w-[200px] p-1"
                              style={{
                                background: 'var(--riscv-surface)',
                                borderColor: 'var(--riscv-border-2)',
                              }}
                            >
                              {Object.entries(INSTRUCTION_FORMATS).map(([key, fmt]) => (
                                <button
                                  key={key}
                                  type="button"
                                  onClick={() => addInstruction(key)}
                                  className="w-full text-left px-3 py-2 text-[12px] hover:bg-white/5 transition-colors"
                                  style={{ color: 'var(--riscv-text)' }}
                                >
                                  <span className="font-mono font-semibold">{key}</span>
                                  <span className="ml-2" style={{ color: 'var(--riscv-text-3)' }}>
                                    {fmt.label}
                                  </span>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Instruction list */}
                    {ext.instructions.length === 0 ? (
                      <p
                        className="text-[12px] py-3 text-center"
                        style={{ color: 'var(--riscv-text-3)' }}
                      >
                        No instructions yet. Click &ldquo;Add&rdquo; to create one from a format
                        template.
                      </p>
                    ) : (
                      <div className="flex flex-wrap gap-1.5 mb-3">
                        {ext.instructions.map((inst, idx) => {
                          const isSelected = idx === selectedInstrIdx;
                          return (
                            <button
                              key={idx}
                              type="button"
                              onClick={() => setSelectedInstrIdx(idx)}
                              className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-mono transition-all border"
                              style={{
                                background: isSelected
                                  ? 'rgba(59,130,246,0.15)'
                                  : 'var(--riscv-surface-2)',
                                borderColor: isSelected
                                  ? 'rgba(59,130,246,0.4)'
                                  : 'var(--riscv-border)',
                                color: isSelected ? 'var(--riscv-text)' : 'var(--riscv-text-2)',
                                fontWeight: isSelected ? 600 : 400,
                              }}
                            >
                              <span className="font-semibold">
                                {inst.mnemonic || `(instr ${idx + 1})`}
                              </span>
                              <span className="text-[9px]" style={{ color: 'var(--riscv-text-3)' }}>
                                {inst.format}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}

                    {/* ── Selected instruction editor ── */}
                    {instr && (
                      <div
                        className="rounded border p-3"
                        style={{
                          background: 'var(--riscv-surface-2)',
                          borderColor: 'var(--riscv-border)',
                        }}
                      >
                        <div className="flex items-center justify-between mb-3">
                          <div className="flex gap-3 flex-1">
                            <div className="flex-1 max-w-[200px]">
                              <label
                                className="block text-[10px] uppercase tracking-wider font-semibold mb-1"
                                style={{ color: 'var(--riscv-text-3)' }}
                              >
                                Mnemonic
                              </label>
                              <input
                                type="text"
                                value={instr.mnemonic}
                                onChange={(e) =>
                                  updateInstrField('mnemonic', e.target.value.toUpperCase())
                                }
                                placeholder="XMYOP"
                                className="w-full px-2 py-1 rounded text-[12px] font-mono font-semibold border"
                                style={{
                                  background: 'var(--riscv-surface)',
                                  borderColor: 'var(--riscv-border)',
                                  color: 'var(--riscv-text)',
                                }}
                              />
                            </div>
                            <div className="flex-1 max-w-[250px]">
                              <label
                                className="block text-[10px] uppercase tracking-wider font-semibold mb-1"
                                style={{ color: 'var(--riscv-text-3)' }}
                              >
                                Notes
                              </label>
                              <input
                                type="text"
                                value={instr.notes}
                                onChange={(e) => updateInstrField('notes', e.target.value)}
                                placeholder="What this instruction does"
                                className="w-full px-2 py-1 rounded text-[12px] border"
                                style={{
                                  background: 'var(--riscv-surface)',
                                  borderColor: 'var(--riscv-border)',
                                  color: 'var(--riscv-text)',
                                }}
                              />
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => removeInstruction(selectedInstrIdx)}
                            className="p-1.5 rounded hover:bg-red-500/20 transition-colors ml-2"
                            style={{ color: 'var(--riscv-text-3)' }}
                            aria-label="Remove this instruction"
                            title="Remove this instruction"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>

                        {/* ── 32-bit editor ── */}
                        <div className="mb-3">
                          <div
                            className="text-[10px] uppercase tracking-wider font-semibold mb-1.5 flex items-center gap-2"
                            style={{ color: 'var(--riscv-text-3)' }}
                          >
                            <span>Encoding (click bits to toggle 0 / 1 / variable)</span>
                            <span
                              className="font-mono normal-case"
                              style={{ color: 'var(--riscv-accent-4, #60a5fa)' }}
                            >
                              {instr.format}-type
                            </span>
                          </div>
                          <div
                            className="grid w-full rounded-md border overflow-hidden"
                            style={{
                              gridTemplateColumns: 'repeat(32, minmax(0, 1fr))',
                              borderColor: 'var(--riscv-border-2)',
                            }}
                          >
                            {instr.encoding.split('').map((bit, i) => (
                              <BitCell
                                key={i}
                                index={i}
                                value={bit}
                                fieldName={getFieldForBit(i, instr.format)}
                                onClick={handleBitClick}
                              />
                            ))}
                          </div>
                          <div
                            className="mt-1 flex justify-between text-[10px] font-mono px-0.5"
                            style={{ color: 'var(--riscv-text-3)' }}
                          >
                            <span>31</span>
                            <span>0</span>
                          </div>

                          {/* Field legend */}
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {(INSTRUCTION_FORMATS[instr.format]?.fields || []).map((f) => {
                              const isVar = instr.variable_fields.includes(f.name);
                              return (
                                <span
                                  key={f.name}
                                  className="px-1.5 py-0.5 rounded text-[10px] font-mono border"
                                  style={{
                                    background: isVar
                                      ? 'transparent'
                                      : 'var(--riscv-tint-gold, rgba(245,197,66,0.08))',
                                    borderColor: isVar
                                      ? 'var(--riscv-border)'
                                      : 'var(--riscv-gold-glow, rgba(245,197,66,0.2))',
                                    color: isVar ? 'var(--riscv-text-3)' : 'var(--riscv-gold)',
                                  }}
                                >
                                  {f.name} [{f.bits[0]}:{f.bits[1]}]{isVar ? ' (var)' : ' (fixed)'}
                                </span>
                              );
                            })}
                            <span
                              className="px-1.5 py-0.5 rounded text-[10px] font-mono border"
                              style={{
                                background: 'var(--riscv-tint-gold, rgba(245,197,66,0.08))',
                                borderColor: 'var(--riscv-gold-glow, rgba(245,197,66,0.2))',
                                color: 'var(--riscv-gold)',
                              }}
                            >
                              opcode [6:0] (fixed)
                            </span>
                          </div>
                        </div>

                        {/* ── Match/Mask readout ── */}
                        <div
                          className="flex flex-wrap gap-3 mb-3 text-[11px] font-mono"
                          style={{ color: 'var(--riscv-text-2)' }}
                        >
                          <span>
                            match:{' '}
                            <strong style={{ color: 'var(--riscv-text)' }}>
                              {instr.match || '—'}
                            </strong>
                          </span>
                          <span>
                            mask:{' '}
                            <strong style={{ color: 'var(--riscv-text)' }}>
                              {instr.mask || '—'}
                            </strong>
                          </span>
                          <span>
                            variable fields:{' '}
                            <strong style={{ color: 'var(--riscv-text)' }}>
                              {instr.variable_fields.length > 0
                                ? instr.variable_fields.join(', ')
                                : 'none'}
                            </strong>
                          </span>
                        </div>

                        {/* Validation moved to the right sidebar */}
                      </div>
                    )}
                  </div>

                  {/* ── Export controls ── */}
                  <div
                    className="rounded border p-3"
                    style={{
                      background: 'var(--riscv-surface)',
                      borderColor: 'var(--riscv-border)',
                    }}
                  >
                    <h4
                      className="text-[11px] uppercase tracking-wider font-semibold mb-2"
                      style={{ color: 'var(--riscv-text-3)' }}
                    >
                      Export
                    </h4>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={handleExportJson}
                        disabled={ext.instructions.length === 0}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-semibold border transition-all disabled:opacity-40"
                        style={{
                          borderColor: 'var(--riscv-border-2)',
                          color: 'var(--riscv-text)',
                        }}
                      >
                        {copiedState === 'json' ? (
                          <>
                            <CheckCircle2 size={12} style={{ color: '#22c55e' }} /> Copied!
                          </>
                        ) : (
                          <>
                            <Copy size={12} /> Copy as riscv-opcodes JSON
                          </>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (!ext) return;
                          const json = toRiscvOpcodesJson(ext);
                          const blob = new Blob([JSON.stringify(json, null, 2)], {
                            type: 'application/json',
                          });
                          downloadBlob(blob, `${ext.id.toLowerCase()}_opcodes.json`);
                        }}
                        disabled={ext.instructions.length === 0}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-semibold border transition-all disabled:opacity-40"
                        style={{
                          borderColor: 'var(--riscv-border-2)',
                          color: 'var(--riscv-text)',
                        }}
                      >
                        <Download size={12} />
                        <span>Download JSON</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (!ext) return;
                          const json = toRiscvOpcodesJson(ext);
                          const jsonString = JSON.stringify(json, null, 2);

                          const dateStr = new Date().toISOString().split('T')[0];
                          const isAddition = ext.mode === 'addition';

                          let md = isAddition
                            ? `# RISC-V Standard Extension Addition Proposal: Candidate Instructions for ${ext.id}\n\n`
                            : `# RISC-V Custom Extension Proposal: ${ext.id}\n\n`;

                          md += `**Target Extension / ID:** ${ext.id}${currentCatalogExt?.name ? ` (${currentCatalogExt.name})` : ''}\n`;
                          md += `**Proposal Track:** ${isAddition ? 'Official Standard-Track (RFC / Upstream)' : 'Proprietary Vendor Extension (Non-Standard)'}\n`;
                          if (isAddition) {
                            md += `**Base Extension Instruction Inventory:** ${Object.keys(currentCatalogExt?.instructions || {}).length} standard instructions\n`;
                            md += `**Active Opcodes:** ${activeOpcodes.map((op) => `0x${op.toString(16).padStart(2, '0')}`).join(', ') || 'Standard'}\n`;
                            md += `**Architectural Dependencies:** ${currentDependencies.length > 0 ? currentDependencies.join(', ') : 'None (Base)'}\n`;
                          } else {
                            md += `**Description:** ${ext.desc || 'N/A'}\n`;
                          }
                          md += `**Date:** ${dateStr}\n\n`;

                          if (isAddition) {
                            md += `## Standard Track Compliance (RISC-V ISA §27)\n`;
                            md += `This proposal contributes candidate instructions directly to standard extension \`${ext.id}\`. In strict accordance with RISC-V ISA §27, proprietary custom slots (custom-0..custom-3) are not utilized; candidate instructions are allocated within the extension's designated standard opcode space or reserved standard expansion slots.\n\n`;
                          } else {
                            md += `## Custom Opcode Space Guarantee (RISC-V ISA §27)\n`;
                            md += `In accordance with RISC-V ISA Manual §27, this extension is allocated within reserved custom opcode space (0x0B..0x7B). This guarantees non-interference and collision freedom against all current and future standard ratified RISC-V extensions.\n\n`;
                          }

                          md += `## Live Collision & Validation Report\n\n`;
                          if (allDiagnostics.length === 0) {
                            md += `**Validation Status: PASS** — No encoding conflicts detected against the standard RISC-V catalog (1,220+ instructions).\n\n`;
                          } else {
                            md += `**Validation Status: DIAGNOSTICS DETECTED**:\n\n`;
                            allDiagnostics.forEach((d) => {
                              md += `### \`${d.instr.mnemonic}\`\n`;
                              if (d.instr.clonedFrom) {
                                md += `*Derived from base sibling instruction:* \`${d.instr.clonedFrom}\`\n\n`;
                              }
                              d.diagnostics.forEach((diag) => {
                                md += `- **[${diag.severity.toUpperCase()}]** ${diag.message}\n`;
                                if (diag.example)
                                  md += `  - Example colliding word: \`${diag.example}\`\n`;
                              });
                              md += '\n';
                            });
                          }

                          md += `## Candidate Encodings (riscv-opcodes format)\n\n`;
                          md += '```json\n' + jsonString + '\n```\n';

                          const blob = new Blob([md], { type: 'text/markdown' });
                          downloadBlob(
                            blob,
                            isAddition
                              ? `${ext.id.toLowerCase()}_addition_proposal.md`
                              : `${ext.id.toLowerCase()}_proposal.md`,
                          );
                        }}
                        disabled={ext.instructions.length === 0}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-semibold border transition-all disabled:opacity-40"
                        style={{
                          borderColor: 'var(--riscv-border-2)',
                          color: 'var(--riscv-text)',
                        }}
                      >
                        <Download size={12} />
                        <span>Download Specification Package (.md)</span>
                      </button>
                    </div>
                    <p className="text-[10.5px] mt-2" style={{ color: 'var(--riscv-text-3)' }}>
                      Exports match/mask bitfields in canonical riscv-opcodes format — paste
                      directly into a toolchain fork.
                    </p>
                  </div>
                </>
              )}
            </div>

            {/* ── Right sidebar: Conflict Report ── */}
            {ext && (
              <div
                className="w-80 shrink-0 border-l p-4 flex flex-col overflow-y-auto scrollbar-stable"
                style={{
                  borderColor: 'var(--riscv-border)',
                  background: 'var(--riscv-surface)',
                  scrollbarGutter: 'stable',
                }}
              >
                <div className="flex items-center gap-2 mb-2 shrink-0">
                  <Activity size={16} style={{ color: 'var(--riscv-gold)' }} />
                  <h4
                    className="font-bold text-[12px] uppercase tracking-wider"
                    style={{ color: 'var(--riscv-text)' }}
                  >
                    Live Conflict Report
                  </h4>
                </div>
                <div
                  className="text-[10px] font-mono mb-3 px-2 py-1 rounded border leading-tight"
                  style={{
                    background: 'var(--riscv-surface-2)',
                    borderColor: 'var(--riscv-border-2)',
                    color: 'var(--riscv-text-3)',
                  }}
                >
                  Scope: Comprehensive catalog validation (RV32, RV64, RV128)
                </div>

                {ext.instructions.length === 0 ? (
                  <div
                    className="text-[12px] text-center mt-10"
                    style={{ color: 'var(--riscv-text-3)' }}
                  >
                    Add an instruction to see live encoding validation.
                  </div>
                ) : allDiagnostics.length === 0 ? (
                  <div
                    className="rounded border p-3.5 flex flex-col items-center gap-2 text-center"
                    style={{
                      background: 'var(--riscv-surface-2)',
                      borderColor: 'var(--riscv-border-2)',
                    }}
                  >
                    <CheckCircle2 size={24} style={{ color: 'var(--riscv-success)' }} />
                    <div>
                      <div
                        className="font-semibold text-[12px]"
                        style={{ color: 'var(--riscv-text)' }}
                      >
                        Encoding Validation Clean
                      </div>
                      <p
                        className="text-[11px] mt-1 leading-relaxed"
                        style={{ color: 'var(--riscv-text-3)' }}
                      >
                        Zero bit collisions detected across all ratified instruction variants in the
                        catalog.
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col gap-3 pb-8">
                    {allDiagnostics.map(({ idx, instr: dInst, diagnostics: dList }) => {
                      const hasErr = dList.some((d) => d.severity === 'error');
                      const borderLeftColor = hasErr
                        ? 'var(--riscv-danger, #ef4444)'
                        : 'var(--riscv-warn, #f59e0b)';

                      return (
                        <div
                          key={idx}
                          className="rounded border-y border-r border-l-4 p-3"
                          style={{
                            borderLeftColor,
                            borderTopColor: 'var(--riscv-border)',
                            borderRightColor: 'var(--riscv-border)',
                            borderBottomColor: 'var(--riscv-border)',
                            background: 'var(--riscv-surface-2)',
                          }}
                        >
                          <div
                            className="flex items-center justify-between mb-2 pb-2 border-b"
                            style={{ borderColor: 'var(--riscv-border)' }}
                          >
                            <span
                              className="font-mono text-[12px] font-bold"
                              style={{ color: 'var(--riscv-text)' }}
                            >
                              {dInst.mnemonic || `(instr ${idx + 1})`}
                            </span>
                            <span
                              className="text-[9px] uppercase font-bold"
                              style={{ color: borderLeftColor }}
                            >
                              {hasErr ? 'Conflict' : 'Warning'}
                            </span>
                          </div>

                          <div className="flex flex-col gap-2.5">
                            {dList.map((d, i) => (
                              <div
                                key={i}
                                className="flex items-start gap-2 text-[11px] leading-relaxed"
                              >
                                <div className="mt-0.5">
                                  <SeverityIcon severity={d.severity} />
                                </div>
                                <div style={{ color: 'var(--riscv-text-2)' }}>
                                  <strong
                                    className="block font-medium"
                                    style={{ color: 'var(--riscv-text)' }}
                                  >
                                    {d.message}
                                  </strong>
                                  {d.example && (
                                    <div
                                      className="font-mono text-[10px] mt-1.5 p-1.5 rounded border"
                                      style={{
                                        color: 'var(--riscv-text-3)',
                                        background: 'var(--riscv-surface)',
                                        borderColor: 'var(--riscv-border)',
                                      }}
                                    >
                                      Overlap word: {d.example}
                                    </div>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ── Intent Modal (Mode A vs Mode B Picker + Catalog Autocomplete) ── */}
        {intentModalOpen && (
          <div
            className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="intent-modal-title"
          >
            <div
              className="w-full max-w-xl rounded-xl border p-6 shadow-2xl relative"
              style={{
                background: 'var(--riscv-surface)',
                borderColor: 'var(--riscv-border-2)',
                color: 'var(--riscv-text)',
              }}
            >
              <button
                type="button"
                onClick={() => setIntentModalOpen(false)}
                className="absolute top-4 right-4 p-1.5 rounded-lg hover:bg-white/10 transition-colors"
                style={{ color: 'var(--riscv-text-3)' }}
                aria-label="Close modal"
              >
                <X size={16} />
              </button>

              {intentModalStep === 'intent' ? (
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <Cpu size={18} style={{ color: 'var(--riscv-gold)' }} />
                    <h3
                      id="intent-modal-title"
                      className="font-bold text-[15px]"
                      style={{ color: 'var(--riscv-text)' }}
                    >
                      Add Extension Workspace
                    </h3>
                  </div>
                  <p
                    className="text-[12px] mb-5 leading-relaxed"
                    style={{ color: 'var(--riscv-text-3)' }}
                  >
                    Configure architecture scope: define proprietary custom instructions for your
                    core, or propose candidate instructions for an official standard extension.
                  </p>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {/* Card 1: Extend Official Standard Extension */}
                    <div
                      className="rounded border p-4 flex flex-col justify-between transition-colors"
                      style={{
                        background: 'var(--riscv-surface-2)',
                        borderColor: 'var(--riscv-border-2)',
                      }}
                    >
                      <div>
                        <div className="flex items-center justify-between mb-2.5">
                          <span
                            className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold uppercase tracking-wider"
                            style={{
                              background: 'var(--riscv-surface)',
                              color: 'var(--riscv-accent-4)',
                              border: '1px solid var(--riscv-border-2)',
                            }}
                          >
                            STANDARD TRACK
                          </span>
                          <BookOpen size={15} style={{ color: 'var(--riscv-accent-4)' }} />
                        </div>
                        <h4
                          className="font-bold text-[13px] mb-1"
                          style={{ color: 'var(--riscv-text)' }}
                        >
                          Extend an Official Extension
                        </h4>
                        <p
                          className="text-[11.5px] leading-relaxed mb-3"
                          style={{ color: 'var(--riscv-text-2)' }}
                        >
                          Draft candidate instructions for a ratified standard (e.g.{' '}
                          <strong>V</strong> (Vector), <strong>Zvbb</strong> (Crypto),{' '}
                          <strong>Zba</strong> (Bitmanip)).
                        </p>
                        <ul
                          className="text-[10.5px] space-y-2 mb-4"
                          style={{ color: 'var(--riscv-text-3)' }}
                        >
                          <li className="flex items-start gap-1.5">
                            <CheckCircle2
                              size={12}
                              className="shrink-0 mt-0.5"
                              style={{ color: 'var(--riscv-success)' }}
                            />
                            <span>Auto-ingests official catalog context &amp; opcodes</span>
                          </li>
                          <li className="flex items-start gap-1.5">
                            <CheckCircle2
                              size={12}
                              className="shrink-0 mt-0.5"
                              style={{ color: 'var(--riscv-success)' }}
                            />
                            <span>1-click clone from existing sibling instructions</span>
                          </li>
                          <li className="flex items-start gap-1.5">
                            <CheckCircle2
                              size={12}
                              className="shrink-0 mt-0.5"
                              style={{ color: 'var(--riscv-success)' }}
                            />
                            <span>Strict RISC-V ISA §27 standard safe-zone enforcement</span>
                          </li>
                        </ul>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setCatalogSearchQuery('');
                          setIntentModalStep('picker');
                        }}
                        className="w-full py-2 px-3 rounded text-[11px] font-semibold uppercase tracking-wider flex items-center justify-center gap-1.5 transition-colors border"
                        style={{
                          background: 'var(--riscv-surface)',
                          borderColor: 'var(--riscv-border-2)',
                          color: 'var(--riscv-text)',
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.borderColor = 'var(--riscv-accent-4)';
                          e.currentTarget.style.color = 'var(--riscv-accent-4)';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.borderColor = 'var(--riscv-border-2)';
                          e.currentTarget.style.color = 'var(--riscv-text)';
                        }}
                      >
                        <span>Select Official Extension</span>
                        <ArrowRight size={12} />
                      </button>
                    </div>

                    {/* Card 2: Proprietary / Custom Extension */}
                    <div
                      className="rounded border p-4 flex flex-col justify-between transition-colors"
                      style={{
                        background: 'var(--riscv-surface-2)',
                        borderColor: 'var(--riscv-border-2)',
                      }}
                    >
                      <div>
                        <div className="flex items-center justify-between mb-2.5">
                          <span
                            className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold uppercase tracking-wider"
                            style={{
                              background: 'var(--riscv-surface)',
                              color: 'var(--riscv-gold)',
                              border: '1px solid var(--riscv-border-2)',
                            }}
                          >
                            VENDOR / CUSTOM TRACK
                          </span>
                          <Cpu size={15} style={{ color: 'var(--riscv-gold)' }} />
                        </div>
                        <h4
                          className="font-bold text-[13px] mb-1"
                          style={{ color: 'var(--riscv-text)' }}
                        >
                          Create a Custom Extension
                        </h4>
                        <p
                          className="text-[11.5px] leading-relaxed mb-3"
                          style={{ color: 'var(--riscv-text-2)' }}
                        >
                          Design proprietary instructions specifically for your CPU core or
                          accelerator (using reserved vendor opcode space).
                        </p>
                        <ul
                          className="text-[10.5px] space-y-2 mb-4"
                          style={{ color: 'var(--riscv-text-3)' }}
                        >
                          <li className="flex items-start gap-1.5">
                            <CheckCircle2
                              size={12}
                              className="shrink-0 mt-0.5"
                              style={{ color: 'var(--riscv-gold)' }}
                            />
                            <span>Allocated in custom-0 through custom-3 (0x0B..0x7B)</span>
                          </li>
                          <li className="flex items-start gap-1.5">
                            <CheckCircle2
                              size={12}
                              className="shrink-0 mt-0.5"
                              style={{ color: 'var(--riscv-gold)' }}
                            />
                            <span>Guaranteed safe from future standard RISC-V collisions</span>
                          </li>
                          <li className="flex items-start gap-1.5">
                            <CheckCircle2
                              size={12}
                              className="shrink-0 mt-0.5"
                              style={{ color: 'var(--riscv-gold)' }}
                            />
                            <span>Full custom format freedom (R, I, S, U, R4)</span>
                          </li>
                        </ul>
                      </div>
                      <button
                        type="button"
                        onClick={createVendorExtension}
                        className="w-full py-2 px-3 rounded text-[11px] font-semibold uppercase tracking-wider flex items-center justify-center gap-1.5 transition-colors border"
                        style={{
                          background: 'var(--riscv-surface)',
                          borderColor: 'var(--riscv-border-2)',
                          color: 'var(--riscv-text)',
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
                        <span>Create Custom Extension</span>
                        <ArrowRight size={12} />
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                /* Step 2: Catalog Autocomplete & Quick Selection */
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setIntentModalStep('intent')}
                        className="p-1 rounded hover:bg-white/10 text-[11px] flex items-center gap-1"
                        style={{ color: 'var(--riscv-text-3)' }}
                      >
                        <Undo2 size={13} />
                        <span>Back</span>
                      </button>
                      <h3 id="intent-modal-title" className="font-bold text-[15px]">
                        Select Official Extension to Extend
                      </h3>
                    </div>
                  </div>

                  {intentModalNotice && (
                    <div
                      className="mb-3 p-2.5 rounded-lg text-[11.5px] border flex items-start gap-2"
                      style={{
                        background: 'rgba(239, 68, 68, 0.1)',
                        borderColor: 'var(--riscv-red, #ef4444)',
                        color: 'var(--riscv-text)',
                      }}
                    >
                      <AlertCircle
                        size={14}
                        className="shrink-0 mt-0.5"
                        style={{ color: 'var(--riscv-red, #ef4444)' }}
                      />
                      <div className="flex-1 leading-snug">{intentModalNotice}</div>
                      <button
                        type="button"
                        onClick={() => setIntentModalNotice(null)}
                        className="p-0.5 rounded hover:bg-white/10"
                        title="Dismiss"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  )}

                  <div className="relative mb-3">
                    <Search
                      size={14}
                      className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                    />
                    <input
                      type="text"
                      value={catalogSearchQuery}
                      onChange={(e) => setCatalogSearchQuery(e.target.value)}
                      placeholder="Search 228+ official extensions (e.g. V, Zvbb, Zba, Zicsr, vector, crypto)..."
                      className="w-full pl-9 pr-3 py-2 rounded-lg text-[12px] border font-mono"
                      style={{
                        background: 'var(--riscv-surface-2)',
                        borderColor: 'var(--riscv-border-2)',
                        color: 'var(--riscv-text)',
                      }}
                      autoFocus
                    />
                  </div>

                  {/* Quick chips */}
                  <div className="flex flex-wrap items-center gap-1.5 mb-3">
                    <span
                      className="text-[10px] uppercase font-bold tracking-wider"
                      style={{ color: 'var(--riscv-text-3)' }}
                    >
                      Popular:
                    </span>
                    {['V', 'Zvbb', 'Zba', 'Zbb', 'Zicsr', 'RV64I'].map((qid) => {
                      const target = (catalog || []).find((c) => c && c.id === qid && !c.isSandbox);
                      if (!target) return null;
                      return (
                        <button
                          key={qid}
                          type="button"
                          onClick={() => createStandardAddition(target)}
                          className="px-2 py-0.5 rounded text-[11px] font-mono font-semibold border transition-colors"
                          style={{
                            background: 'var(--riscv-surface)',
                            borderColor: 'var(--riscv-border-2)',
                            color: 'var(--riscv-text-2)',
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.borderColor = 'var(--riscv-accent-4)';
                            e.currentTarget.style.color = 'var(--riscv-text)';
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.borderColor = 'var(--riscv-border-2)';
                            e.currentTarget.style.color = 'var(--riscv-text-2)';
                          }}
                        >
                          {qid}
                        </button>
                      );
                    })}
                  </div>

                  {/* Results list */}
                  <div
                    className="max-h-64 overflow-y-auto flex flex-col gap-1 pr-1 border rounded-lg p-1.5"
                    style={{
                      borderColor: 'var(--riscv-border)',
                      background: 'var(--riscv-surface-2)',
                    }}
                  >
                    {(catalog || [])
                      .filter((c) => {
                        if (!c || c.isSandbox) return false;
                        if (!catalogSearchQuery.trim()) return true;
                        const q = catalogSearchQuery.toLowerCase().trim();
                        return (
                          c.id.toLowerCase().includes(q) ||
                          (c.name && c.name.toLowerCase().includes(q)) ||
                          (c.desc && c.desc.toLowerCase().includes(q))
                        );
                      })
                      .slice(0, 40)
                      .map((c) => {
                        const instrCount = Object.keys(c.instructions || {}).length;
                        const alreadyAdded = extensions.some(
                          (e) =>
                            e.mode === 'addition' &&
                            (e.baseExtensionId === c.id || e.id === `${c.id}__sandbox`),
                        );
                        const extOpcodes = getExtensionMajorOpcodes(c);
                        const isCompressedOnly = extOpcodes.length === 0;

                        return (
                          <button
                            key={c.id}
                            type="button"
                            onClick={() => createStandardAddition(c)}
                            className="text-left p-2 rounded transition-colors flex items-center justify-between border"
                            style={{
                              borderColor: alreadyAdded ? 'rgba(59,130,246,0.3)' : 'transparent',
                              background: alreadyAdded ? 'rgba(59,130,246,0.06)' : 'transparent',
                            }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.background = alreadyAdded
                                ? 'rgba(59,130,246,0.12)'
                                : 'var(--riscv-surface)';
                              e.currentTarget.style.borderColor = alreadyAdded
                                ? 'rgba(59,130,246,0.5)'
                                : 'var(--riscv-border)';
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.background = alreadyAdded
                                ? 'rgba(59,130,246,0.06)'
                                : 'transparent';
                              e.currentTarget.style.borderColor = alreadyAdded
                                ? 'rgba(59,130,246,0.3)'
                                : 'transparent';
                            }}
                          >
                            <div className="min-w-0 flex-1 pr-2">
                              <div className="flex items-center gap-2">
                                <span
                                  className="font-mono font-bold text-[12px] transition-colors"
                                  style={{ color: 'var(--riscv-text)' }}
                                >
                                  {c.id}
                                </span>
                                {c.name && c.name !== c.id && (
                                  <span
                                    className="text-[11px] truncate"
                                    style={{ color: 'var(--riscv-text-3)' }}
                                  >
                                    {c.name}
                                  </span>
                                )}
                              </div>
                              {c.desc && (
                                <p
                                  className="text-[10px] truncate mt-0.5"
                                  style={{ color: 'var(--riscv-text-3)' }}
                                >
                                  {c.desc}
                                </p>
                              )}
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0">
                              {alreadyAdded ? (
                                <span
                                  className="px-2 py-0.5 rounded text-[10px] font-mono font-semibold"
                                  style={{
                                    background: 'rgba(59,130,246,0.15)',
                                    color: 'var(--riscv-accent-4)',
                                    border: '1px solid rgba(59,130,246,0.3)',
                                  }}
                                >
                                  Proposal Open
                                </span>
                              ) : isCompressedOnly ? (
                                <span
                                  className="px-2 py-0.5 rounded text-[10px] font-mono"
                                  style={{
                                    background: 'rgba(239,68,68,0.1)',
                                    color: 'var(--riscv-red, #ef4444)',
                                    border: '1px solid rgba(239,68,68,0.25)',
                                  }}
                                  title="No 32-bit major opcodes allocated"
                                >
                                  16-bit only
                                </span>
                              ) : null}
                              <span
                                className="px-2 py-0.5 rounded text-[10px] font-mono"
                                style={{
                                  background: 'var(--riscv-surface)',
                                  color: 'var(--riscv-text-2)',
                                }}
                              >
                                {instrCount} ops
                              </span>
                            </div>
                          </button>
                        );
                      })}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
