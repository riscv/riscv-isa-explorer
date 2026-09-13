import React, { useState } from 'react';
import {
  Info,
  ScanSearch,
  X,
  ArrowRight,
  ArrowUpRight,
  Copy,
  Grid3x3,
  Link2,
  Search,
  Cpu,
  Shield,
  Zap,
  Lock,
  Database,
  Settings2,
  Layers,
  Braces,
  FlaskConical,
  PanelRightOpen,
  Bug,
  ExternalLink,
  Network,
  Activity,
  AreaChart,
  BookOpen,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Package,
  Binary,
  MemoryStick,
  CircuitBoard,
  Shuffle,
  Timer,
  Gauge,
  ServerCrash,
  KeyRound,
  Trash2,
  Download,
  Maximize2,
  Sun,
  Moon,
  GitCompare,
} from 'lucide-react';
import extensions from './riscv_extensions.json';
import ExtensionTile from './ExtensionTile.jsx';
import CompareView from './CompareView.jsx';
import EncodingDiagram from './EncodingDiagram.jsx';
import { focusableWithin, nextFocus } from './focusTrap.js';
import { computeLockedExtensions, missingMandatory } from './workspaceLock.js';
import CompareTray from './CompareTray.jsx';
import {
  COMPARE_MAX,
  COMPARE_PARAM,
  instructionKey,
  parseInstructionKey,
  buildExtensionComparison,
  buildInstructionComparison,
  buildProfileComparison,
  buildComparePermalink,
  parseComparePermalink,
} from './compareModel.js';
// INCOMPATIBLE_WITH is no longer imported here: conflicts now come back from
// resolveSelection(), which checks them over the resolved closure rather than
// only over what the user clicked.
import {
  BASE_ISA_IDS,
  SMART_DEPENDENCIES,
  buildMarchString,
  buildCombinedCatalog,
} from './marchUtils.js';
import { resolveSelection } from './isaGraph.js';
import RiscvLogo from './RiscvLogo.jsx';
import { PROFILES } from './profiles.js';
import PROFILE_OPTIONAL from './profile-optional.json';
import { buildIsaConfigYaml } from './exportUtils.js';
import AskAiLauncher from './AskAiLauncher.jsx';
import SandboxPanel from './SandboxPanel.jsx';
import {
  OPCODES,
  loadSandbox,
  deserializeSandbox,
  deserializeSandboxAsync,
} from './sandboxModel.js';
import {
  BIT_MASK_32,
  parseHexToBigInt,
  toHex32,
  normalizeEncodingString,
  encodingToMatchMask,
  matchMaskToEncoding,
  patternsOverlap,
  isSubsetPattern,
  overlapExampleWord,
} from './encodingUtils.js';

export const formatSandboxExtensionForCatalog = (ext) => {
  const instructionsObj = {};
  for (const instr of ext.instructions || []) {
    if (!instr.mnemonic) continue;
    instructionsObj[instr.mnemonic] = {
      encoding: instr.encoding,
      variable_fields: instr.variable_fields || [],
      match: instr.match,
      mask: instr.mask,
      extension: [`rv_${ext.id.toLowerCase()}`],
      notes: instr.notes,
    };
  }
  const customSlotName = OPCODES.find((o) => o.value === ext.opcode)?.name || 'custom';
  return {
    id: ext.id,
    name: ext.name || ext.id,
    desc: ext.desc || 'Custom user-defined extension (Sandbox)',
    use: `Custom ${customSlotName} opcode extension`,
    opcode: ext.opcode,
    isSandbox: true,
    url: '',
    instructions: instructionsObj,
  };
};

// Ids the catalog can actually render. The dependency graph carries a few nodes
// the catalog does not (UDB's S requires Sm, for which we have no entry), and
// adding one of those to the workspace would show a row with nothing behind it.
const CATALOG_IDS = new Set(
  Object.values(extensions)
    .flat()
    .filter(Boolean)
    .map((e) => e.id),
);

/* ─── Permalinks ────────────────────────────────────────────────────────────
 * A link to a specific extension, so the tool can be cited in a discussion or
 * a spec review rather than described. Originally proposed in #94 by
 * @Veekshitha11; that branch could not be rebased, so this reimplements it.
 *
 * A query parameter rather than a path, deliberately. The site is served as
 * static files from GitHub Pages with no router, so /extensions/Zba would 404
 * on a hard refresh unless the host were configured to fall back to
 * index.html. ?ext=Zba needs no server cooperation at all.
 */
const PERMALINK_PARAM = 'ext';
const BUILDER_STORAGE_KEY = 'riscv-landscape-builder-state';

/**
 * Restore the builder from localStorage, validating rather than trusting.
 *
 * Everything here has been out of our hands since it was written: the payload
 * may predate a catalogue sync that renamed an extension, predate a change to
 * a profile's mandatory set, or simply have been edited by hand. A shape check
 * alone let unknown ids and a non-object paramChoices flow into -march
 * assembly, so each field is checked against live data and dropped if it no
 * longer refers to anything.
 *
 * The reconciliation at the end matters most. `baselineLocked` was stored
 * independently of `workspaceIds`, so a payload could come back claiming the
 * profile floor was held while the selection had already lost a mandatory
 * extension — the false-compliance state #214 exists to prevent, reachable
 * through a reload rather than a click. When the two disagree we believe the
 * extension set and release the lock, which tells the truth and leaves the
 * user's configuration untouched; re-locking restores the floor as it always
 * has.
 */
const loadSavedBuilderState = () => {
  if (typeof window === 'undefined') return null;
  let parsed = null;
  try {
    const raw = window.localStorage.getItem(BUILDER_STORAGE_KEY);
    if (!raw) return null;
    parsed = JSON.parse(raw);
  } catch {
    /* storage unavailable or corrupt — start clean */
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const knownProfile = (name) =>
    typeof name === 'string' && Object.hasOwn(PROFILES, name) ? name : null;

  const catalogIds = new Set(allExtensionsFlat.map((ext) => ext.id));
  const workspaceIds = Array.isArray(parsed.workspaceIds)
    ? parsed.workspaceIds.filter((id) => catalogIds.has(id))
    : [];

  const paramChoices =
    parsed.paramChoices &&
    typeof parsed.paramChoices === 'object' &&
    !Array.isArray(parsed.paramChoices)
      ? parsed.paramChoices
      : {};

  let seedProfile = knownProfile(parsed.seedProfile);
  let customFromProfile = knownProfile(parsed.customFromProfile);
  let baselineLocked = typeof parsed.baselineLocked === 'boolean' ? parsed.baselineLocked : true;

  if (seedProfile && baselineLocked) {
    const missing = missingMandatory({ workspaceIds, seedProfile, profiles: PROFILES });
    if (missing.length > 0) {
      customFromProfile = seedProfile;
      seedProfile = null;
      baselineLocked = false;
    }
  }

  return {
    workspaceIds,
    seedProfile,
    customFromProfile,
    paramChoices,
    baselineLocked,
    builderMode: typeof parsed.builderMode === 'boolean' ? parsed.builderMode : undefined,
  };
};

/*
 * Three panels are heavy and not needed for first paint: WorkspacePanel alone
 * is 104 KB of source. Loading them lazily keeps them out of the initial parse
 * and compile.
 *
 * The Suspense fallbacks are null rather than a loading shell. One reviewer
 * wanted a shell, since opening the Workspace also hides its own toolbar
 * button and a slow chunk could leave neither on screen; another judged null
 * safe, because focus stays on the trigger until the panel mounts. The chunks
 * are 7 to 46 KB from the same origin as the page that just loaded, so the gap
 * is short, and an idle prefetch was tried and reverted: dynamic import of JSX
 * cannot resolve in the test environment and it took the render-smoke suite
 * from seconds to two minutes.
 *
 * CompareView is deliberately NOT lazy. It is reachable by permalink, so a URL
 * that opens straight into a comparison would have to wait on a chunk before
 * showing anything. Four render-smoke tests cover exactly that path, and the
 * right response to them failing was to narrow the optimisation, not to weaken
 * the tests.
 *
 * Paired with useOnceMounted below, which is what makes this safe. These
 * components are rendered unconditionally today and hold state while closed
 * (WorkspacePanel has twenty state hooks and fifteen transitions), so gating
 * them on `open` would lose that state and break the close animation. Mounting
 * on first open and leaving them mounted defers the download without changing
 * when anything unmounts.
 */
const EncodingMap = React.lazy(() => import('./EncodingMap.jsx'));
const WorkspacePanel = React.lazy(() => import('./WorkspacePanel.jsx'));
const ExtensionEvolution = React.lazy(() => import('./ExtensionEvolution.jsx'));

/**
 * True once `open` has been true, and true forever after.
 *
 * Lets a lazy panel stay unmounted until it is first needed, then behave
 * exactly as it did before: still mounted while closed, still holding its own
 * state, still able to animate out.
 */
function useOnceMounted(open) {
  /*
   * A ref latch rather than state, because state costs a render before the
   * chunk fetch can even begin: the first render after `open` flips would still
   * return false, Suspense would render nothing, and only the following render
   * would mount the boundary and start the download. Latching during render
   * starts the fetch in the same pass.
   *
   * Safe to write during render because it is idempotent: it only ever moves
   * false to true, so a double invocation reaches the same value.
   */
  const mounted = React.useRef(open);
  if (open) mounted.current = true;
  return mounted.current;
}

const allExtensionsFlat = Object.values(extensions).flat().filter(Boolean);

// Shared so an empty query allocates nothing and searchMatchIds keeps a stable
// reference for anything that depends on it. Note this is NOT what protects the
// tile memo: tiles receive a boolean, so a fresh Set would compare the same.
const EMPTY_MATCH_SET = new Set();

const findExtensionById = (id, extraExtensions = []) => {
  const wanted = String(id ?? '')
    .trim()
    .toLowerCase();
  if (!wanted) return null;
  // Case-insensitive: people type ?ext=zba as readily as ?ext=Zba.
  const pool = extraExtensions.length
    ? [...allExtensionsFlat, ...extraExtensions]
    : allExtensionsFlat;
  return pool.find((ext) => ext.id.toLowerCase() === wanted) ?? null;
};

const extensionFromUrl = () => {
  if (typeof window === 'undefined') return null;
  try {
    const params = new URLSearchParams(window.location.search);
    const sandboxParam = params.get('sandbox');
    let sandboxExts = [];
    // c: prefixes need async decompression \u2014 can't resolve synchronously.
    // Fall back to localStorage so the ?ext= permalink still works on share links;
    // the async useEffect below will load and select the correct sandbox extension
    // once decompression finishes.
    if (sandboxParam && !sandboxParam.startsWith('c:')) {
      sandboxExts = deserializeSandbox(sandboxParam);
    } else {
      sandboxExts = loadSandbox();
    }
    return findExtensionById(
      params.get(PERMALINK_PARAM),
      sandboxExts.map(formatSandboxExtensionForCatalog),
    );
  } catch {
    return null;
  }
};

const permalinkFor = (extId) => {
  if (typeof window === 'undefined') return '';
  const url = new URL(window.location.href);
  url.searchParams.set(PERMALINK_PARAM, extId);
  url.hash = '';
  return url.toString();
};

const normalizeMnemonicKey = (value) =>
  String(value ?? '')
    .trim()
    .toUpperCase()
    .split(/\s+/)[0];

const COMPRESSED_INSTRUCTION_MAPPINGS = [
  {
    mnemonic: 'C.NOP',
    compressed: 'C.NOP',
    standard: 'addi x0, x0, 0',
    description: 'No Operation',
    notes: '',
  },
  {
    mnemonic: 'C.LI',
    compressed: 'C.LI rd, imm',
    standard: 'addi rd, x0, imm',
    description: 'Load Immediate',
    notes: 'Expands to addi with x0.',
  },
  {
    mnemonic: 'C.LUI',
    compressed: 'C.LUI rd, imm',
    standard: 'lui rd, imm',
    description: 'Load Upper Immediate',
    notes: '',
  },
  {
    mnemonic: 'C.ADDI',
    compressed: 'C.ADDI rd, imm',
    standard: 'addi rd, rd, imm',
    description: 'Add Immediate',
    notes: '',
  },
  {
    mnemonic: 'C.ADDIW',
    compressed: 'C.ADDIW rd, imm',
    standard: 'addiw rd, rd, imm',
    description: 'Add Word Immediate',
    notes: 'RV64/128 Only.',
  },
  {
    mnemonic: 'C.ADDI16SP',
    compressed: 'C.ADDI16SP imm',
    standard: 'addi sp, sp, imm',
    description: 'Adjust Stack Pointer',
    notes: 'Specific to sp (x2).',
  },
  {
    mnemonic: 'C.ADDI4SPN',
    compressed: "C.ADDI4SPN rd', imm",
    standard: "addi rd', sp, imm",
    description: 'Add Immediate, Scaled 4, SP rel',
    notes: "Used to generate pointers to stack variables. Destination rd' must be x8-x15.",
  },
  {
    mnemonic: 'C.SLLI',
    compressed: 'C.SLLI rd, imm',
    standard: 'slli rd, rd, imm',
    description: 'Shift Left Logical Imm',
    notes: '',
  },
  {
    mnemonic: 'C.SRLI',
    compressed: "C.SRLI rd', imm",
    standard: "srli rd', rd', imm",
    description: 'Shift Right Logical Imm',
    notes: "rd' restricted to x8-x15.",
  },
  {
    mnemonic: 'C.SRAI',
    compressed: "C.SRAI rd', imm",
    standard: "srai rd', rd', imm",
    description: 'Shift Right Arithmetic Imm',
    notes: "rd' restricted to x8-x15.",
  },
  {
    mnemonic: 'C.ANDI',
    compressed: "C.ANDI rd', imm",
    standard: "andi rd', rd', imm",
    description: 'AND Immediate',
    notes: "rd' restricted to x8-x15.",
  },
  {
    mnemonic: 'C.MV',
    compressed: 'C.MV rd, rs2',
    standard: 'add rd, x0, rs2',
    description: 'Move Register',
    notes: 'Copies rs2 to rd.',
  },
  {
    mnemonic: 'C.ADD',
    compressed: 'C.ADD rd, rs2',
    standard: 'add rd, rd, rs2',
    description: 'Add Register',
    notes: 'rd += rs2.',
  },
  {
    mnemonic: 'C.AND',
    compressed: "C.AND rd', rs2'",
    standard: "and rd', rd', rs2'",
    description: 'AND Register',
    notes: 'Operands restricted to x8-x15.',
  },
  {
    mnemonic: 'C.OR',
    compressed: "C.OR rd', rs2'",
    standard: "or rd', rd', rs2'",
    description: 'OR Register',
    notes: 'Operands restricted to x8-x15.',
  },
  {
    mnemonic: 'C.XOR',
    compressed: "C.XOR rd', rs2'",
    standard: "xor rd', rd', rs2'",
    description: 'XOR Register',
    notes: 'Operands restricted to x8-x15.',
  },
  {
    mnemonic: 'C.SUB',
    compressed: "C.SUB rd', rs2'",
    standard: "sub rd', rd', rs2'",
    description: 'Subtract Register',
    notes: 'Operands restricted to x8-x15.',
  },
  {
    mnemonic: 'C.SUBW',
    compressed: "C.SUBW rd', rs2'",
    standard: "subw rd', rd', rs2'",
    description: 'Subtract Word',
    notes: 'RV64/128 Only. Operands restricted to x8-x15.',
  },
  {
    mnemonic: 'C.ADDW',
    compressed: "C.ADDW rd', rs2'",
    standard: "addw rd', rd', rs2'",
    description: 'Add Word',
    notes: 'RV64/128 Only. Operands restricted to x8-x15.',
  },
  {
    mnemonic: 'C.LW',
    compressed: "C.LW rd', imm(rs1')",
    standard: "lw rd', offset(rs1')",
    description: 'Load Word',
    notes: "rd' and rs1' must be x8-x15.",
  },
  {
    mnemonic: 'C.SW',
    compressed: "C.SW rs2', imm(rs1')",
    standard: "sw rs2', offset(rs1')",
    description: 'Store Word',
    notes: "rs2' and rs1' must be x8-x15.",
  },
  {
    mnemonic: 'C.LD',
    compressed: "C.LD rd', imm(rs1')",
    standard: "ld rd', offset(rs1')",
    description: 'Load Doubleword',
    notes: 'RV64/128 Only.',
  },
  {
    mnemonic: 'C.SD',
    compressed: "C.SD rs2', imm(rs1')",
    standard: "sd rs2', offset(rs1')",
    description: 'Store Doubleword',
    notes: 'RV64/128 Only.',
  },
  {
    mnemonic: 'C.LWSP',
    compressed: 'C.LWSP rd, imm',
    standard: 'lw rd, offset(sp)',
    description: 'Load Word (SP-relative)',
    notes: 'Uses sp implicitly. rd cannot be x0.',
  },
  {
    mnemonic: 'C.SWSP',
    compressed: 'C.SWSP rs2, imm',
    standard: 'sw rs2, offset(sp)',
    description: 'Store Word (SP-relative)',
    notes: 'Uses sp implicitly.',
  },
  {
    mnemonic: 'C.LDSP',
    compressed: 'C.LDSP rd, imm',
    standard: 'ld rd, offset(sp)',
    description: 'Load Double (SP-relative)',
    notes: 'RV64/128 Only.',
  },
  {
    mnemonic: 'C.SDSP',
    compressed: 'C.SDSP rs2, imm',
    standard: 'sd rs2, offset(sp)',
    description: 'Store Double (SP-relative)',
    notes: 'RV64/128 Only.',
  },
  {
    mnemonic: 'C.J',
    compressed: 'C.J offset',
    standard: 'jal x0, offset',
    description: 'Jump (Unconditional)',
    notes: 'Essentially a goto.',
  },
  {
    mnemonic: 'C.JAL',
    compressed: 'C.JAL offset',
    standard: 'jal x1, offset',
    description: 'Jump and Link',
    notes: 'RV32 Only. Calls a function (saves return addr to ra).',
  },
  {
    mnemonic: 'C.JR',
    compressed: 'C.JR rs1',
    standard: 'jalr x0, 0(rs1)',
    description: 'Jump Register',
    notes: 'Returns from function (if rs1 is ra).',
  },
  {
    mnemonic: 'C.JALR',
    compressed: 'C.JALR rs1',
    standard: 'jalr x1, 0(rs1)',
    description: 'Jump and Link Register',
    notes: 'Calls function pointer; saves return addr to ra.',
  },
  {
    mnemonic: 'C.BEQZ',
    compressed: "C.BEQZ rs1', offset",
    standard: "beq rs1', x0, offset",
    description: 'Branch if Equal to Zero',
    notes: "rs1' restricted to x8-x15.",
  },
  {
    mnemonic: 'C.BNEZ',
    compressed: "C.BNEZ rs1', offset",
    standard: "bne rs1', x0, offset",
    description: 'Branch if Not Equal Zero',
    notes: "rs1' restricted to x8-x15.",
  },
  {
    mnemonic: 'C.EBREAK',
    compressed: 'C.EBREAK',
    standard: 'ebreak',
    description: 'Environment Break',
    notes: 'Used for debuggers.',
  },
];

const COMPRESSED_INSTRUCTION_LOOKUP = COMPRESSED_INSTRUCTION_MAPPINGS.reduce((acc, entry) => {
  acc[normalizeMnemonicKey(entry.mnemonic)] = entry;
  return acc;
}, {});

const COMPRESSED_BY_STANDARD = COMPRESSED_INSTRUCTION_MAPPINGS.reduce((acc, entry) => {
  const key = normalizeMnemonicKey(entry.standard);
  if (!key) return acc;
  if (!acc[key]) acc[key] = [];
  acc[key].push(entry);
  return acc;
}, {});

const STANDARD_EQUIVALENT_PRIORITY = ['RV32I', 'RV64I', 'RV128I', 'RV32E', 'RV64E'];

// Encoding utilities imported from ./encodingUtils.js (see top-of-file imports).
// The functions below were originally defined here; they now live in a shared
// module so both the Encoder Validator and the Custom Extension Sandbox can
// use the same validated arithmetic without duplication.

const extensionCsrLabels = {
  S: 'Supervisor CSRs',
  U: 'User CSRs',
};

const RISCVExplorer = () => {
  const [activeProfile, setActiveProfile] = useState(null);
  const [activeVolume, setActiveVolume] = useState(null);
  // Lazy initialiser, so ?ext=Zba is honoured on first paint rather than
  // selecting nothing and then correcting itself.
  const [selectedExt, setSelectedExt] = useState(extensionFromUrl);
  const [permalinkCopied, setPermalinkCopied] = useState(false);
  const [selectedInstruction, setSelectedInstruction] = useState(null);
  const [copyStatus, setCopyStatus] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');

  /*
   * Whether the current selection was made by the search effect rather than by
   * a click. Only the former is debounced when written to the URL.
   */
  const selectionCameFromSearchRef = React.useRef(false);

  const [searchMatches, setSearchMatches] = useState(null);
  const [encoderValidatorOpen, setEncoderValidatorOpen] = useState(false);

  // What the tool is, moved off the page into a dialog (#209 put it inline; it
  // cost three lines of vertical space above the fold to say something a
  // returning visitor already knows). The trigger keeps it one click away.
  const [aboutOpen, setAboutOpen] = useState(false);
  const [evolutionOpen, setEvolutionOpen] = useState(false);
  const evolutionTriggerRef = React.useRef(null);
  const aboutTriggerRef = React.useRef(null);
  const [encodingMapOpen, setEncodingMapOpen] = useState(false);
  const [sandboxOpen, setSandboxOpen] = useState(false);

  const [sandboxExtensions, setSandboxExtensions] = useState(() => {
    if (typeof window === 'undefined') return [];
    try {
      const param = new URLSearchParams(window.location.search).get('sandbox');
      if (param && !param.startsWith('c:')) {
        const fromUrl = deserializeSandbox(param);
        if (Array.isArray(fromUrl) && fromUrl.length > 0) return fromUrl;
      }
    } catch {
      /* ignore */
    }
    return loadSandbox();
  });

  React.useEffect(() => {
    try {
      if (typeof window === 'undefined') return;
      const params = new URLSearchParams(window.location.search);
      const param = params.get('sandbox');
      if (param && param.startsWith('c:')) {
        deserializeSandboxAsync(param).then((fromUrl) => {
          if (Array.isArray(fromUrl) && fromUrl.length > 0) {
            setSandboxExtensions(fromUrl);
            setSandboxOpen(true);
            // Resolve the ?ext= permalink against the newly-loaded sandbox extensions.
            // extensionFromUrl ran synchronously before decompression, so a share link
            // like ?ext=Xtest__sandbox&sandbox=c:... never selected the right extension.
            const extParam = params.get(PERMALINK_PARAM);
            if (extParam) {
              const formatted = fromUrl.map(formatSandboxExtensionForCatalog);
              const match = findExtensionById(extParam, formatted);
              if (match) setSelectedExt(match);
            }
          }
        });
      } else if (param) {
        setSandboxOpen(true);
      }
    } catch {
      // ignore
    }
  }, []);

  const formattedSandboxExts = React.useMemo(
    () => sandboxExtensions.map(formatSandboxExtensionForCatalog),
    [sandboxExtensions],
  );
  const [encoderValidatorInput, setEncoderValidatorInput] = useState({
    mnemonic: '',
    encoding: '',
    match: '',
    mask: '',
  });
  const [encoderValidatorResult, setEncoderValidatorResult] = useState(null);
  const [encoderValidatorCopyStatus, setEncoderValidatorCopyStatus] = useState(null);
  // ── Instruction Expand Modal ───────────────────────────────────────────────
  const [instructionExpandOpen, setInstructionExpandOpen] = useState(false);
  const expandedModalRef = React.useRef(null);
  const restoreModalFocusRef = React.useRef(null);
  const onCloseExpandedModalRef = React.useRef(() => setInstructionExpandOpen(false));
  onCloseExpandedModalRef.current = () => setInstructionExpandOpen(false);

  // About dialog: Escape closes, and focus goes back to the trigger. Lighter
  // than the encoder dialog's full trap because this one holds no fields, only
  // prose and a close button.
  React.useEffect(() => {
    if (!aboutOpen) return undefined;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setAboutOpen(false);
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      aboutTriggerRef.current?.focus();
    };
  }, [aboutOpen]);

  // Evolution panel: same shape as the About dialog above. It holds a slider
  // and 219 buttons, but they are all inside the dialog, so Escape plus
  // returning focus to the trigger is the whole contract.
  React.useEffect(() => {
    if (!evolutionOpen) return undefined;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setEvolutionOpen(false);
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      evolutionTriggerRef.current?.focus();
    };
  }, [evolutionOpen]);

  // Expanded instruction modal: focus trap and Escape, in one listener.
  //
  // Both live here rather than in separate effects — an earlier pass had a
  // second capture-phase listener closing on Escape as well, which was
  // harmless only because setState is idempotent. CompareView.jsx keeps the
  // same shape: one window listener owning both keys for the dialog.
  React.useEffect(() => {
    if (!instructionExpandOpen) return undefined;
    restoreModalFocusRef.current = document.activeElement;
    expandedModalRef.current?.focus();

    const onKey = (e) => {
      if (e.key === 'Escape') {
        onCloseExpandedModalRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const target = nextFocus(
        focusableWithin(expandedModalRef.current),
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
      const restore = restoreModalFocusRef.current;
      if (restore && typeof restore.focus === 'function') {
        restore.focus();
      }
    };
  }, [instructionExpandOpen]);
  const savedBuilderState = React.useMemo(() => loadSavedBuilderState(), []);

  // ── ISA Workspace state ────────────────────────────────────────────────────
  const [workspaceIds, setWorkspaceIds] = useState(() => {
    if (savedBuilderState?.workspaceIds && Array.isArray(savedBuilderState.workspaceIds)) {
      return new Set(savedBuilderState.workspaceIds);
    }
    return new Set();
  });
  const [workspaceNotice, setWorkspaceNotice] = useState(null);
  const toastTimerRef = React.useRef(null);
  const showToast = React.useCallback((msg) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setWorkspaceNotice(msg);
    toastTimerRef.current = setTimeout(() => setWorkspaceNotice(null), 3500);
  }, []);

  // Comparison. Two sets, because extensions and instructions are compared
  // separately and pinning one kind must not discard the other.
  const comparePermalinkSeed = React.useMemo(() => {
    if (typeof window === 'undefined')
      return { kind: null, resolved: [], dropped: [], overflow: [] };
    const value = new URL(window.location.href).searchParams.get(COMPARE_PARAM);
    return parseComparePermalink(value, allExtensionsFlat);
  }, []);

  const [compareExtIds, setCompareExtIds] = useState(
    () => new Set(comparePermalinkSeed.kind === 'ext' ? comparePermalinkSeed.resolved : []),
  );
  const [compareInstrKeys, setCompareInstrKeys] = useState(
    () => new Set(comparePermalinkSeed.kind === 'instr' ? comparePermalinkSeed.resolved : []),
  );
  const [compareKind, setCompareKind] = useState(comparePermalinkSeed.kind || 'ext');
  // Compare mode keeps the pin affordances out of the way until asked for.
  // A shared ?cmp= link switches it on at mount, so a comparison someone sent
  // still opens for a reader who has never turned the mode on themselves.
  const [compareMode, setCompareMode] = useState(comparePermalinkSeed.resolved.length > 0);
  const [compareProfileNames, setCompareProfileNames] = useState(
    () => new Set(comparePermalinkSeed.kind === 'profile' ? comparePermalinkSeed.resolved : []),
  );
  const [compareExpandDeps, setCompareExpandDeps] = useState(false);
  const [compareOpen, setCompareOpen] = useState(comparePermalinkSeed.resolved.length >= 2);

  // A shared comparison outlives the catalog it was made from. Unresolvable
  // ids and ids merely over the cap are different facts and must be reported
  // separately — conflating them tells the user a real extension "is not in
  // the catalog" when it was only bumped by COMPARE_MAX.
  React.useEffect(() => {
    const { dropped, overflow } = comparePermalinkSeed;
    if (dropped.length === 0 && overflow.length === 0) return;
    // showToast displays one message at a time, so when both facts are true
    // they are joined into a single toast rather than the second call
    // silently clobbering the first.
    const messages = [];
    if (dropped.length > 0) {
      messages.push(`Not in the catalog, left out of the comparison: ${dropped.join(', ')}`);
    }
    if (overflow.length > 0) {
      messages.push(`Comparison holds ${COMPARE_MAX} at most, left out: ${overflow.join(', ')}`);
    }
    showToast(messages.join(' '));
  }, [comparePermalinkSeed, showToast]);

  // Builder mode. The per-tile "+" affordances only exist while this is on.
  // Previously they were always rendered, in a low-contrast grey, with nothing
  // explaining what they did — a permanent control for a mode the user had not
  // asked to be in. Turning the builder on is now a deliberate act.
  // Theme. Defaults to whatever the OS asks for, then remembers the choice.
  // Applied to documentElement rather than a wrapper so the CSS variables
  // cascade to everything, including the fixed-position panel.
  const [theme, setTheme] = useState(() => {
    try {
      const saved = window.localStorage.getItem('riscv-landscape-theme');
      if (saved === 'light' || saved === 'dark') return saved;
    } catch {
      /* storage unavailable — fall through to the system preference */
    }
    return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  });

  React.useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      window.localStorage.setItem('riscv-landscape-theme', theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  const [builderMode, setBuilderMode] = useState(() => {
    if (typeof savedBuilderState?.builderMode === 'boolean') return savedBuilderState.builderMode;
    return Boolean(savedBuilderState?.workspaceIds?.length);
  });
  // Deliberately not restored: see the persistence effect. The studio is a
  // full-screen opaque overlay, so reopening it on load hid whatever the
  // visitor had actually navigated to.
  const [workspacePanelOpen, setWorkspacePanelOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const profileMenuRef = React.useRef(null);
  // Which profile seeded the workspace, so the panel can offer that profile's
  // optional extensions (#217). Set to null when the workspace is cleared OR
  // when the user removes a mandatory extension (diverging from the spec).
  // In that case customFromProfile holds the origin name for the 'Custom (from X)' badge.
  const [seedProfile, setSeedProfile] = useState(() => savedBuilderState?.seedProfile ?? null);
  // When a user releases the lock and removes mandatory extensions, seedProfile
  // becomes null (the config is no longer that profile), but we remember where
  // it came from so the header can show 'Custom (from RVA23)' and the profile
  // switcher can offer an easy way to restore.
  const [customFromProfile, setCustomFromProfile] = useState(
    () => savedBuilderState?.customFromProfile ?? null,
  );
  // Chosen values for oneOf parameters (#216). Only oneOf leaves a decision
  // open — equal and includes are pinned by whichever extension asks for them —
  // so this holds the handful of genuine choices, keyed by parameter name.
  const [paramChoices, setParamChoices] = useState(() => savedBuilderState?.paramChoices ?? {});
  // Whether the seeding profile's mandatory set is held in place (#214).
  // Certification work needs a floor that cannot be silently reverted — dropping
  // H from RVA23 leaves something that is no longer RVA23 — but exploring what a
  // profile would be without one of its extensions is also legitimate, so the
  // floor is releasable rather than absolute.
  const [baselineLocked, setBaselineLocked] = useState(
    () => savedBuilderState?.baselineLocked ?? true,
  );

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      // Nothing selected and the builder switched off means there is nothing
      // worth remembering. The old condition also required the panel to be
      // closed, but "Clear all" is only reachable from inside the open panel,
      // so the explicit clear removed the key and this effect wrote it straight
      // back on the same tick.
      if (workspaceIds.size === 0 && !builderMode) {
        window.localStorage.removeItem(BUILDER_STORAGE_KEY);
      } else {
        window.localStorage.setItem(
          BUILDER_STORAGE_KEY,
          JSON.stringify({
            workspaceIds: Array.from(workspaceIds),
            seedProfile,
            customFromProfile,
            paramChoices,
            baselineLocked,
            // The configuration is worth restoring; "a full-screen modal was
            // open" is not. Restoring that dropped returning visitors into an
            // opaque overlay, hiding any ?ext= extension they had followed a
            // link to. Note this is the real builderMode, not one widened by
            // the panel being open, which used to switch the builder back on
            // after the user had explicitly switched it off.
            builderMode,
          }),
        );
      }
    } catch {
      /* ignore */
    }
  }, [workspaceIds, seedProfile, customFromProfile, paramChoices, baselineLocked, builderMode]);

  const handleSetParam = React.useCallback((name, value) => {
    setParamChoices((prev) => {
      const next = { ...prev };
      if (value === null || value === undefined) delete next[name];
      else next[name] = value;
      return next;
    });
  }, []);

  // Keep the profile menu inside the viewport (#232).
  //
  // It is absolutely positioned against a trigger that moves as the toolbar
  // wraps, so no fixed anchor works: right-aligned it ran off the left edge at
  // 500px, left-aligned it ran off the right edge at 360px. position: fixed is
  // not available either — .builder-toolbar and .riscv-toolbar both set
  // backdrop-filter, which makes them the containing block for fixed
  // descendants, so the menu would clamp to the toolbar rather than the screen.
  // So measure once on open and shift it back into view.
  React.useLayoutEffect(() => {
    if (!profileMenuOpen) return undefined;
    const clamp = () => {
      const el = profileMenuRef.current;
      if (!el) return;
      el.style.transform = 'none';
      const rect = el.getBoundingClientRect();
      const margin = 8;
      let dx = 0;
      if (rect.right > window.innerWidth - margin) dx = window.innerWidth - margin - rect.right;
      if (rect.left + dx < margin) dx = margin - rect.left;
      el.style.transform = dx ? `translateX(${Math.round(dx)}px)` : 'none';
    };
    clamp();
    window.addEventListener('resize', clamp);
    return () => window.removeEventListener('resize', clamp);
  }, [profileMenuOpen]);
  const [quickExportOpen, setQuickExportOpen] = useState(false);

  /*
   * The question the Ask AI button opens with, derived from whatever the reader
   * currently has open.
   *
   * kapa's open() takes a `query` and pre-fills its box with it. That is a
   * documented, supported option — worth recording, because an earlier probe
   * concluded it was ignored. That probe ran while the widget was not yet
   * allowlisted for this origin, so it was mounting nothing at all and no
   * option could have had any effect. Re-tested once the widget worked: it
   * pre-fills.
   *
   * Deliberately no `submit`. The question is a starting point the reader can
   * edit, not one sent on their behalf.
   *
   * Ordered most specific first: an open instruction is narrower than the
   * extension behind it, which is narrower than the builder.
   */
  /*
   * What the Ask AI button opens with, derived from whatever the reader has on
   * screen. Returns the question and whether to send it, because those differ
   * per context.
   *
   * Two rules, both from putting the wording to independent review:
   *
   * 1. Only the extension id and instruction mnemonic go in. `short` is our own
   *    editorial label ("Address-Generation Bitmanip"), written for the tiles
   *    and absent from the specifications kapa retrieves over, so it dilutes
   *    the match against the one token that does appear verbatim: the id. It
   *    also produced nonsense on the 41 entries whose short contains
   *    parentheses, worst of all "the Shvstvala extension (Virtual Supervisor
   *    Trap Value (vstval) provides all needed values)".
   *
   * 2. Single intent. Asking two things at once pulls the query vector between
   *    them and retrieves a weaker match for both. The dependency and encoding
   *    detail arrives anyway, because it sits in the same spec passage.
   *
   * "RISC-V" is named explicitly. Ids like B, V and M are ambiguous, and the
   * model writing the answer has read every other architecture too.
   */
  const askAiContext = React.useMemo(() => {
    if (workspacePanelOpen) {
      /*
       * Checked first, not last. The builder panel covers the page, so while it
       * is open it is what the reader is looking at, whatever is still selected
       * behind it.
       *
       * Never auto-submitted, and never a list of ids.
       *
       * A full profile resolves to 78 extensions, and a wall of comma-separated
       * acronyms matches no passage in any specification: the retriever lands
       * on something generic like a title page. It is also a poor thing to send
       * on someone's behalf, because a reader looking at a configuration has a
       * specific worry in mind and it is rarely "summarise all of these".
       *
       * So this opens a sentence for them to finish rather than a question they
       * did not ask.
       */
      const from = seedProfile ? ` based on the ${seedProfile} profile` : '';
      return { query: `I am configuring a RISC-V core${from}. `, submit: false };
    }
    if (selectedExt?.id && selectedInstruction?.mnemonic) {
      // Both required: closing the panel clears selectedExt but leaves the
      // instruction set, and an instruction is only meaningful inside the
      // extension showing it.
      return {
        query: `How does the ${selectedInstruction.mnemonic} instruction work in the RISC-V ${selectedExt.id} extension?`,
        submit: true,
      };
    }
    if (selectedExt?.id) {
      return { query: `Explain the RISC-V ${selectedExt.id} extension.`, submit: true };
    }
    return null;
  }, [selectedInstruction, selectedExt, workspacePanelOpen, seedProfile]);

  const [quickExportIncludeInstr, setQuickExportIncludeInstr] = useState(true);

  // Smart lock: live reverse-lookup of dependencies, plus the seeding profile's
  // mandatory floor. Derived through the shared helper so this display copy and
  // the removal guard inside addWorkspaceIdsSmart cannot drift apart.
  const lockedExtensions = React.useMemo(
    () =>
      computeLockedExtensions({
        workspaceIds,
        seedProfile,
        baselineLocked,
        smartDependencies: SMART_DEPENDENCIES,
        profiles: PROFILES,
      }),
    [workspaceIds, seedProfile, baselineLocked],
  );

  // Smart dependency and mutually-exclusive handler
  const addWorkspaceIdsSmart = React.useCallback(
    (idsToAdd, isToggle = false) => {
      setWorkspaceIds((prev) => {
        const next = new Set(prev);
        const autoAdded = [];
        let baseChanged = false;

        // Recompute lock state against `prev` rather than reading the memo, so
        // batched updates check against what the set actually holds right now.
        // Same helper as the memo: the profile floor is part of the answer here
        // too, otherwise a tile could drop a mandatory extension while the
        // header still claimed the configuration matched the profile.
        const currentLocked = computeLockedExtensions({
          workspaceIds: prev,
          seedProfile,
          baselineLocked,
          smartDependencies: SMART_DEPENDENCIES,
          profiles: PROFILES,
        });

        const arrToAdd = Array.isArray(idsToAdd) ? idsToAdd : [idsToAdd];

        for (const id of arrToAdd) {
          if (!id || id.includes('__') || id.endsWith('__sandbox')) {
            continue;
          }

          if (isToggle && next.has(id)) {
            // If locked, we cannot toggle it off
            if (currentLocked.has(id)) {
              showToast(`Cannot remove ${id}: required by ${currentLocked.get(id).join(', ')}`);
              continue; // block removal
            }
            next.delete(id);
            continue;
          }

          // 1. Mutually Exclusive Base ISAs
          if (BASE_ISA_IDS.has(id)) {
            for (const baseId of BASE_ISA_IDS) {
              if (baseId !== id && next.has(baseId)) {
                // Note: Base ISAs aren't typically locked by other extensions in our SMART_DEPENDENCIES,
                // but if they were, we might need a lock check here too. Safe for now.
                next.delete(baseId);
                baseChanged = true;
              }
            }
          }

          next.add(id);
        }

        // 2. Dependencies, resolved transitively through the graph.
        //
        // This used to walk SMART_DEPENDENCIES one level deep, which is only
        // correct when a dependency has none of its own. It silently under-selected
        // everything deeper: picking H added S but not U (H -> S -> U), and picking
        // Zve64d added D and Zve64f but none of F, Zicsr, Zve32x, Zve64x or the
        // Zvl*b tokens. resolveSelection() walks the whole closure.
        const resolution = resolveSelection({
          selected: Array.from(next),
          base: Array.from(next).find((x) => BASE_ISA_IDS.has(x)) ?? null,
        });

        // 3. Incompatibility check, over the fully resolved set — so a conflict
        // reached only through a dependency is caught too. The path is what makes
        // the message useful: the offending extension is often one the user never
        // picked (Zve64d -> D -> F on an E-base).
        if (resolution.conflicts.length > 0) {
          const c = resolution.conflicts[0];
          const via = c.path.length > 1 ? ` (pulled in by ${c.path.join(' -> ')})` : '';
          showToast(`Architecturally Invalid: ${c.with} is incompatible with ${c.ext}${via}`);
          return prev; // revert the whole batch, as before
        }

        for (const dep of resolution.resolved) {
          // Skip graph-only nodes the catalog cannot show.
          if (!CATALOG_IDS.has(dep)) continue;
          if (next.has(dep)) continue;
          next.add(dep);
          autoAdded.push(dep);
        }

        if (autoAdded.length > 0) {
          showToast(`Auto-added: ${autoAdded.join(', ')} (Required dependency)`);
        } else if (baseChanged) {
          showToast('Base ISA is mutually exclusive. Previous base removed.');
        }

        return next;
      });
    },
    [showToast, seedProfile, baselineLocked],
  );

  // Flat list of all extensions including custom sandbox extensions — stable reference
  const allExtsList = React.useMemo(
    () => [...allExtensionsFlat, ...formattedSandboxExts],
    [formattedSandboxExts],
  );

  const workspaceTotalInstr = React.useMemo(() => {
    if (workspaceIds.size === 0) return 0;
    return buildCombinedCatalog(Array.from(workspaceIds), allExtsList).length;
  }, [workspaceIds, allExtsList]);

  React.useEffect(() => {
    setQuickExportIncludeInstr(workspaceTotalInstr <= 100);
  }, [workspaceTotalInstr]);
  // --------------------------------------------------------------------------
  const lastScrolledKeyRef = React.useRef(null);
  // Whether the open Selected Details panel was opened by the search rather than
  // by a click. Only a search-driven selection may be cleared when the query
  // stops matching; a deliberate click must survive.
  const searchDrivenSelectionRef = React.useRef(false);
  // Encoder Validator dialog: the panel itself, and the control that opened it,
  // so focus can be handed back on close.
  const encoderDialogRef = React.useRef(null);
  const encoderTriggerRef = React.useRef(null);

  // "Copied" badges reset themselves on a timer. Holding the handles lets a
  // second copy replace the first rather than race it, and lets unmount cancel
  // a pending reset instead of leaving it to fire into a dead component.
  const copyStatusTimerRef = React.useRef(null);
  const encoderCopyTimerRef = React.useRef(null);
  // Pending auto-scroll from the search effect, so a later keystroke can cancel
  // one that has not fired yet.
  const scrollTimerRef = React.useRef(null);
  const permalinkTimerRef = React.useRef(null);

  React.useEffect(
    () => () => {
      if (copyStatusTimerRef.current) window.clearTimeout(copyStatusTimerRef.current);
      if (encoderCopyTimerRef.current) window.clearTimeout(encoderCopyTimerRef.current);
      if (scrollTimerRef.current) window.clearTimeout(scrollTimerRef.current);
      if (permalinkTimerRef.current) window.clearTimeout(permalinkTimerRef.current);
    },
    [],
  );
  const searchInputRef = React.useRef(null);

  // Encoder Validator dialog keyboard behaviour.
  //
  // A dialog that can only be dismissed with the mouse is a trap for anyone
  // navigating by keyboard, and without a focus trap Tab walks out of the modal
  // and onto the 227 tiles behind it while the backdrop still blocks the mouse.
  React.useEffect(() => {
    if (!encoderValidatorOpen) return undefined;

    // Prefer the trigger element itself over document.activeElement: a mouse
    // click does not focus a button in every browser, so activeElement can be
    // <body> here and focus would be dropped on the floor when the dialog closes.
    const opener = document.activeElement;
    const fallbackOpener =
      opener instanceof HTMLElement && opener !== document.body ? opener : null;

    const FOCUSABLE =
      'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';
    const focusable = () => {
      const root = encoderDialogRef.current;
      if (!root) return [];
      return [...root.querySelectorAll(FOCUSABLE)].filter(
        (el) => el.offsetWidth > 0 || el.offsetHeight > 0,
      );
    };

    // Start inside the dialog, on the first field rather than the close button.
    const first = focusable();
    (first.find((el) => el.tagName === 'INPUT') ?? first[0])?.focus();

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setEncoderValidatorOpen(false);
        return;
      }
      if (e.key !== 'Tab') return;

      const items = focusable();
      if (!items.length) return;
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      const active = document.activeElement;

      // Wrap at both ends, and pull focus back in if it has escaped already.
      if (e.shiftKey && (active === firstEl || !encoderDialogRef.current?.contains(active))) {
        e.preventDefault();
        lastEl.focus();
      } else if (
        !e.shiftKey &&
        (active === lastEl || !encoderDialogRef.current?.contains(active))
      ) {
        e.preventDefault();
        firstEl.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      // Hand focus back to the trigger, so keyboard users resume where they left
      // off instead of at the top of the document.
      (encoderTriggerRef.current ?? fallbackOpener)?.focus?.();
    };
  }, [encoderValidatorOpen]);

  // Ctrl+K / Cmd+K → focus search
  React.useEffect(() => {
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        // The studio covers the page opaquely, so focusing the catalogue search
        // behind it moved the caret somewhere the user cannot see.
        if (workspacePanelOpen) return;
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [workspacePanelOpen]);

  // ---------------------------------------------------------------------------
  // Extension Catalog – loaded from `src/riscv_extensions.json`
  // ---------------------------------------------------------------------------

  // Profile definitions live in ./profiles.js so scripts and tests can reach
  // them; see that file for why.
  const profiles = PROFILES;

  // ---------------------------------------------------------------------------
  // Derived helpers
  // ---------------------------------------------------------------------------
  const volumeMembership = React.useMemo(() => {
    const allIds = new Set(
      Object.values(extensions)
        .flat()
        .filter(Boolean)
        .map((ext) => ext.id),
    );

    const vol2Ids = new Set();

    for (const ext of extensions.standard || []) {
      if (['S', 'U', 'H', 'N'].includes(ext.id)) vol2Ids.add(ext.id);
    }
    // Every privileged group is Volume II. Derived from the key prefix rather
    // than listed by name: enumerating them meant a new group could be added to
    // the catalogue, rendered in the grid, and still fall through to Volume I.
    // s_counters did exactly that when it was introduced (#251), so its four
    // counter extensions were dimmed under the Volume II filter and highlighted
    // under Volume I.
    for (const [group, members] of Object.entries(extensions)) {
      if (!group.startsWith('s_')) continue;
      for (const ext of members || []) vol2Ids.add(ext.id);
    }

    const vol1Ids = new Set(Array.from(allIds).filter((id) => !vol2Ids.has(id)));
    return {
      I: vol1Ids,
      II: vol2Ids,
    };
  }, []);

  const instructionMatchesQuery = (mnemonic, details, q) => {
    const needle = String(q || '')
      .trim()
      .toLowerCase();
    if (!needle) return false;

    if (mnemonic && String(mnemonic).toLowerCase().includes(needle)) return true;
    if (!details || typeof details !== 'object') return false;

    for (const field of [details.encoding, details.match, details.mask]) {
      if (field && String(field).toLowerCase().includes(needle)) return true;
    }
    for (const list of [details.variable_fields, details.extension]) {
      if (Array.isArray(list) && list.join(' ').toLowerCase().includes(needle)) return true;
    }

    return false;
  };

  const selectInstructionByMnemonic = React.useCallback((ext, mnemonic) => {
    const details = ext?.instructions?.[mnemonic];
    setSelectedInstruction(details ? { mnemonic, ...details } : null);
  }, []);

  const instructionIndex = React.useMemo(() => {
    const index = new Map();
    const allExts = Object.values(extensions).flat().filter(Boolean);

    for (const ext of allExts) {
      const instructions = ext?.instructions;
      if (!instructions || typeof instructions !== 'object') continue;

      for (const [mnemonic, details] of Object.entries(instructions)) {
        const key = normalizeMnemonicKey(mnemonic);
        if (!key) continue;
        if (!index.has(key)) index.set(key, []);
        index.get(key).push({ ext, mnemonic, details });
      }
    }

    return index;
  }, []);

  const selectInstructionByMnemonicKey = React.useCallback(
    (mnemonicKey, preferredExtIds = []) => {
      const key = normalizeMnemonicKey(mnemonicKey);
      if (!key) return false;
      const candidates = instructionIndex.get(key);
      if (!candidates || !candidates.length) return false;

      let chosen = null;
      for (const extId of preferredExtIds) {
        chosen = candidates.find((entry) => entry.ext.id === extId);
        if (chosen) break;
      }
      if (!chosen && selectedExt) {
        chosen = candidates.find((entry) => entry.ext.id === selectedExt.id);
      }
      if (!chosen) [chosen] = candidates;

      if (!chosen) return false;
      setSelectedExt(chosen.ext);
      setSelectedInstruction({ mnemonic: chosen.mnemonic, ...chosen.details });
      setSearchMatches(null);
      return true;
    },
    [instructionIndex, selectedExt],
  );

  const selectStandardEquivalent = React.useCallback(
    (mnemonic) => selectInstructionByMnemonicKey(mnemonic, STANDARD_EQUIVALENT_PRIORITY),
    [selectInstructionByMnemonicKey],
  );

  const selectCompressedEquivalent = React.useCallback(
    (mnemonic) => selectInstructionByMnemonicKey(mnemonic, ['C']),
    [selectInstructionByMnemonicKey],
  );

  const compressedMapping = selectedInstruction
    ? COMPRESSED_INSTRUCTION_LOOKUP[normalizeMnemonicKey(selectedInstruction.mnemonic)]
    : null;
  const standardEquivalentMnemonic = compressedMapping
    ? normalizeMnemonicKey(compressedMapping.standard)
    : '';
  const hasStandardEquivalent =
    Boolean(standardEquivalentMnemonic) && instructionIndex.get(standardEquivalentMnemonic)?.length;
  const compressedEquivalents = selectedInstruction
    ? (COMPRESSED_BY_STANDARD[normalizeMnemonicKey(selectedInstruction.mnemonic)] || []).filter(
        (entry) => instructionIndex.has(normalizeMnemonicKey(entry.mnemonic)),
      )
    : [];

  const formatInstructionForClipboard = React.useCallback((ext, instr) => {
    if (!ext || !instr) return '';
    const lines = [
      `RISC-V Extension: ${ext.name} (${ext.id})`,
      ext.desc ? `Description: ${ext.desc}` : null,
      ext.use ? `Use: ${ext.use}` : null,
      `Reference: ${ext.url || 'https://github.com/riscv/riscv-isa-manual'}`,
      '',
      `Instruction: ${instr.mnemonic}`,
      instr.encoding ? `Encoding: ${instr.encoding}` : null,
      Array.isArray(instr.variable_fields) && instr.variable_fields.length
        ? `Variable fields: ${instr.variable_fields.join(', ')}`
        : null,
      instr.match ? `Match: ${instr.match}` : null,
      instr.mask ? `Mask: ${instr.mask}` : null,
      Array.isArray(instr.extension) && instr.extension.length
        ? `Extension tags: ${instr.extension.join(', ')}`
        : null,
    ].filter(Boolean);
    return `${lines.join('\n')}\n`;
  }, []);

  const copyTextToClipboard = React.useCallback(async (text) => {
    if (!text) return false;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // fall through
    }

    try {
      const el = document.createElement('textarea');
      el.value = text;
      el.setAttribute('readonly', 'true');
      el.style.position = 'fixed';
      el.style.top = '0';
      el.style.left = '0';
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.focus();
      el.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(el);
      return ok;
    } catch {
      return false;
    }
  }, []);

  const allInstructionPatterns = React.useMemo(() => {
    const patterns = [];
    const allExts = Object.values(extensions).flat().filter(Boolean);

    for (const ext of allExts) {
      const instructions = ext?.instructions;
      if (!instructions || typeof instructions !== 'object') continue;

      for (const [mnemonic, details] of Object.entries(instructions)) {
        const encoding = normalizeEncodingString(details?.encoding);
        const matchParsed = parseHexToBigInt(details?.match);
        const maskParsed = parseHexToBigInt(details?.mask);

        let match = matchParsed;
        let mask = maskParsed;

        if ((match == null || mask == null) && encoding) {
          const derived = encodingToMatchMask(encoding);
          match = derived.match;
          mask = derived.mask;
        }

        if (match == null || mask == null) continue;

        patterns.push({
          extId: ext.id,
          extName: ext.name,
          mnemonic,
          encoding: encoding || matchMaskToEncoding(match, mask),
          match: match & BIT_MASK_32,
          mask: mask & BIT_MASK_32,
          url: ext.url || 'https://github.com/riscv/riscv-isa-manual',
        });
      }
    }

    return patterns;
  }, []);

  const formatEncoderValidatorReport = React.useCallback((proposed, result) => {
    const lines = [];
    const now = new Date();
    lines.push(`RISC-V Encoder Validation Report`);
    lines.push(`Generated: ${now.toISOString()}`);
    lines.push('');
    if (proposed.mnemonic) lines.push(`Proposed mnemonic: ${proposed.mnemonic}`);
    if (proposed.encoding) lines.push(`Proposed encoding: ${proposed.encoding}`);
    if (proposed.match) lines.push(`Proposed match: ${proposed.match}`);
    if (proposed.mask) lines.push(`Proposed mask: ${proposed.mask}`);
    lines.push('');

    if (result.errors.length) {
      lines.push(`Errors (${result.errors.length}):`);
      for (const err of result.errors) lines.push(`- ${err}`);
      lines.push('');
    }

    lines.push(`Conflicts (${result.conflicts.length}):`);
    if (!result.conflicts.length) {
      lines.push(`- None found within the current instruction set database.`);
      return `${lines.join('\n')}\n`;
    }

    for (const conflict of result.conflicts) {
      lines.push(`- ${conflict.other.extId}:${conflict.other.mnemonic} (${conflict.type})`);
      lines.push(`  Why: ${conflict.why}`);
      if (conflict.commonMask) lines.push(`  Common mask: ${conflict.commonMask}`);
      if (conflict.exampleWord) lines.push(`  Example word: ${conflict.exampleWord}`);
    }
    return `${lines.join('\n')}\n`;
  }, []);

  const runEncoderValidation = React.useCallback(() => {
    const input = encoderValidatorInput;
    const errors = [];

    const proposedMnemonic = String(input.mnemonic || '').trim();
    const proposedEncoding = normalizeEncodingString(input.encoding);
    const proposedMatchInput = String(input.match || '').trim();
    const proposedMaskInput = String(input.mask || '').trim();

    let proposedMatch = null;
    let proposedMask = null;
    let normalizedEncoding = '';

    const hasEncoding = Boolean(proposedEncoding);
    const hasMatchMask = Boolean(proposedMatchInput || proposedMaskInput);

    if (!hasEncoding && !hasMatchMask) {
      errors.push('Provide either Encoding, or both Match and Mask.');
    }

    if (hasEncoding) {
      const derived = encodingToMatchMask(proposedEncoding);
      if (derived.error) errors.push(derived.error);
      proposedMatch = derived.match;
      proposedMask = derived.mask;
      normalizedEncoding = proposedEncoding;
    }

    if (hasMatchMask) {
      const matchParsed = parseHexToBigInt(proposedMatchInput);
      const maskParsed = parseHexToBigInt(proposedMaskInput);
      if (matchParsed == null) errors.push('Match must be a hex value like 0x1234.');
      if (maskParsed == null) errors.push('Mask must be a hex value like 0x707f.');

      // Reject oversized input before anything truncates it. Everything below
      // masks with BIT_MASK_32, so 0x11800202f silently became 0x1800202f and
      // reported a conflict against SC.W that the user never typed. The check
      // lives here rather than in parseHexToBigInt because that helper also
      // parses catalogue match/mask values, which are trusted and already 32-bit.
      if (matchParsed != null && matchParsed > BIT_MASK_32) {
        errors.push('Match exceeds 32 bits.');
      }
      if (maskParsed != null && maskParsed > BIT_MASK_32) {
        errors.push('Mask exceeds 32 bits.');
      }

      if (
        matchParsed != null &&
        maskParsed != null &&
        matchParsed <= BIT_MASK_32 &&
        maskParsed <= BIT_MASK_32
      ) {
        const matchNorm = matchParsed & BIT_MASK_32;
        const maskNorm = maskParsed & BIT_MASK_32;
        if ((matchNorm & ~maskNorm) !== 0n) {
          errors.push('Match contains bits outside Mask (match & ~mask must be 0).');
        }

        if (!hasEncoding) {
          proposedMatch = matchNorm;
          proposedMask = maskNorm;
          normalizedEncoding = matchMaskToEncoding(matchNorm, maskNorm);
        } else if (proposedMatch != null && proposedMask != null) {
          const derivedMatchNorm = proposedMatch & BIT_MASK_32;
          const derivedMaskNorm = proposedMask & BIT_MASK_32;
          if (derivedMatchNorm !== matchNorm || derivedMaskNorm !== maskNorm) {
            errors.push('Encoding does not match the provided Match/Mask.');
          }
        }
      }
    }

    if (proposedMatch == null || proposedMask == null) {
      setEncoderValidatorResult({ errors, proposed: null, conflicts: [] });
      return;
    }

    const matchNorm = (proposedMatch ?? 0n) & BIT_MASK_32;
    const maskNorm = (proposedMask ?? 0n) & BIT_MASK_32;

    const proposed = {
      mnemonic: proposedMnemonic,
      encoding:
        normalizeEncodingString(normalizedEncoding) || matchMaskToEncoding(matchNorm, maskNorm),
      match: toHex32(matchNorm),
      mask: toHex32(maskNorm),
      matchValue: matchNorm,
      maskValue: maskNorm,
    };

    const conflicts = [];
    for (const other of allInstructionPatterns) {
      const overlaps = patternsOverlap(matchNorm, maskNorm, other.match, other.mask);
      if (!overlaps) continue;

      const commonMask = maskNorm & other.mask & BIT_MASK_32;
      const type =
        matchNorm === other.match && maskNorm === other.mask
          ? 'identical'
          : isSubsetPattern(matchNorm, maskNorm, other.match, other.mask)
            ? 'proposed_subset_of_existing'
            : isSubsetPattern(other.match, other.mask, matchNorm, maskNorm)
              ? 'existing_subset_of_proposed'
              : 'partial_overlap';

      let why =
        'Overlapping decode space (there exist instruction words that satisfy both patterns).';
      if (type === 'identical') {
        why = 'Exact same match/mask pattern.';
      } else if (type === 'proposed_subset_of_existing') {
        why =
          'Your proposed pattern is more specific, but every word it matches also matches the existing instruction.';
      } else if (type === 'existing_subset_of_proposed') {
        why =
          'Your proposed pattern is more general, and it would also match words intended for the existing instruction.';
      }

      const exampleWord = overlapExampleWord(matchNorm, maskNorm, other.match, other.mask);
      conflicts.push({
        other,
        type,
        why,
        commonMask: toHex32(commonMask),
        exampleWord: toHex32(exampleWord),
      });
    }

    conflicts.sort((a, b) => {
      const order = {
        identical: 0,
        proposed_subset_of_existing: 1,
        existing_subset_of_proposed: 2,
        partial_overlap: 3,
      };
      return (order[a.type] ?? 99) - (order[b.type] ?? 99);
    });

    setEncoderValidatorResult({ errors, proposed, conflicts });
  }, [allInstructionPatterns, encoderValidatorInput]);

  const isHighlightedByProfile = React.useCallback(
    (id) => {
      if (!activeProfile) return false;
      return profiles[activeProfile].includes(id);
    },
    [activeProfile],
  );

  const isHighlightedByVolume = React.useCallback(
    (id) => {
      if (!activeVolume) return false;
      return volumeMembership[activeVolume]?.has(id) ?? false;
    },
    [activeVolume, volumeMembership],
  );

  const extensionSearchIndexById = React.useMemo(() => {
    const index = new Map();
    const allExts = allExtsList;

    for (const ext of allExts) {
      const parts = [];

      for (const field of [ext.id, ext.name, ext.short, ext.desc, ext.use]) {
        if (field) parts.push(String(field));
      }

      const mnemonicList = Object.keys(ext.instructions || {});
      if (mnemonicList.length) {
        parts.push(mnemonicList.join(' '));
      }
      // CSRs now come from the catalogue entry, populated from
      // riscv-unified-db, rather than a hand-written table covering S and U.
      // Names and descriptions are both indexed, so 'mstatus' and 'machine
      // status' both find their extension.
      if (ext.csrs && typeof ext.csrs === 'object') {
        const names = Object.keys(ext.csrs);
        if (names.length) {
          parts.push(names.join(' '));
          parts.push(
            names
              .map((n) => ext.csrs[n]?.desc)
              .filter(Boolean)
              .join(' '),
          );
        }
      }

      const instructions = ext.instructions;
      if (instructions && typeof instructions === 'object') {
        for (const [mnemonic, details] of Object.entries(instructions)) {
          parts.push(mnemonic);

          if (!details || typeof details !== 'object') {
            if (details != null) parts.push(String(details));
            continue;
          }

          if (details.encoding) parts.push(String(details.encoding));
          if (details.match) parts.push(String(details.match));
          if (details.mask) parts.push(String(details.mask));

          if (Array.isArray(details.variable_fields)) {
            parts.push(details.variable_fields.join(' '));
          }
          if (Array.isArray(details.extension)) {
            parts.push(details.extension.join(' '));
          }
        }
      }

      index.set(ext.id, parts.join(' ').toLowerCase());
    }

    return index;
  }, [allExtsList]);

  // Stable identities on purpose: these ride in tileProps, and a fresh function
  // each render would make every tile re-render even when nothing it shows moved.
  const isHighlighted = React.useCallback(
    (id) => isHighlightedByProfile(id) || isHighlightedByVolume(id),
    [isHighlightedByProfile, isHighlightedByVolume],
  );

  // Dim whatever the active filter excludes. The two filters are mutually
  // exclusive (selecting one clears the other), so at most one branch applies.
  // This used to return false as soon as a volume was set, which meant picking
  // a volume while a profile was active un-dimmed the entire grid while both
  // filters still highlighted, and nothing showed which one was responsible.
  const isDimmed = React.useCallback(
    (id) => {
      if (activeVolume) return !(volumeMembership[activeVolume]?.has(id) ?? false);
      if (activeProfile) return !profiles[activeProfile].includes(id);
      return false;
    },
    [activeVolume, activeProfile, volumeMembership],
  );

  // The tile lives in ./ExtensionTile.jsx. It used to be defined here, inside
  // the render body, which meant a new component type on every render and a
  // full unmount/remount of all 227 tiles for every click and keystroke.
  //
  // These props are memoised so the tile's comparator can do its job: stable
  // identities for everything shared, and the tile itself asks only whether ITS
  // own id changed membership.
  // Keep the address bar in step with the selection, so copying the URL from
  // the browser works without touching the Share button, and a reload or a
  // bookmark returns to the same extension.
  //
  // replaceState rather than pushState on purpose: clicking through twenty
  // tiles should not bury the previous page under twenty history entries that
  // Back has to walk through one at a time.
  /*
   * Debounced ONLY for selections search made on the reader's behalf.
   *
   * Search selects as you type, so an exact id match writes history on the
   * keystroke that produces it: typing "amo" wrote three times, once for the
   * "a" that matches extension A. Delaying that is right.
   *
   * Delaying a deliberate click is not. Someone who clicks a tile and reaches
   * straight for the address bar would copy the previous URL, and the write
   * would be cancelled outright if they closed the tab inside the window. A
   * click is an explicit act and the URL has to be true immediately.
   */
  React.useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const write = () => {
      const url = new URL(window.location.href);
      const current = url.searchParams.get(PERMALINK_PARAM);
      const next = selectedExt?.id ?? null;
      if (current === next) return;
      if (next) url.searchParams.set(PERMALINK_PARAM, next);
      else url.searchParams.delete(PERMALINK_PARAM);
      window.history.replaceState(null, '', url.toString());
    };

    if (!selectionCameFromSearchRef.current) {
      write();
      return undefined;
    }
    const id = setTimeout(write, 250);
    return () => clearTimeout(id);
  }, [selectedExt]);

  // A fresh selection invalidates the "Copied" confirmation.
  React.useEffect(() => {
    setPermalinkCopied(false);
  }, [selectedExt]);

  const copyPermalink = React.useCallback(async () => {
    if (!selectedExt) return;
    const ok = await copyTextToClipboard(permalinkFor(selectedExt.id));
    setPermalinkCopied(ok);
    if (ok) showToast(`Link to ${selectedExt.id} copied`);
    if (permalinkTimerRef.current) window.clearTimeout(permalinkTimerRef.current);
    permalinkTimerRef.current = window.setTimeout(() => {
      permalinkTimerRef.current = null;
      setPermalinkCopied(false);
    }, 1500);
  }, [selectedExt, copyTextToClipboard, showToast]);

  const handleSelectExt = React.useCallback((data) => {
    selectionCameFromSearchRef.current = false;
    // A deliberate click owns the panel from here on, so a later non-matching
    // query must not clear it out from under the user.
    searchDrivenSelectionRef.current = false;
    setSelectedExt((current) => {
      const next = current?.id === data.id ? null : data;
      setSelectedInstruction(null);
      setSearchMatches(null);
      return next;
    });
  }, []);

  const handleToggleWorkspace = React.useCallback(
    (id) => {
      addWorkspaceIdsSmart(id, true);
    },
    [addWorkspaceIdsSmart],
  );

  // Setting a VLEN floor is not the same as adding an extension. The Zvl*b
  // chain is nested — Zvl1024b already implies Zvl128b — so clicking a lower
  // value while a higher one is selected has to REMOVE the higher ones, or
  // nothing visible happens. That was the original bug: the button only added,
  // so lowering VLEN silently did nothing.
  //
  // Passing null clears the floor entirely.
  //
  // The result is re-resolved afterwards, so anything genuinely required puts
  // itself back: asking for 32 while Zve64x is selected leaves you at 64,
  // because Zve64x requires Zvl64b. The panel then shows the real floor rather
  // than the one that was asked for.
  const handleSetVlen = React.useCallback((bits) => {
    const WIDTHS = [32, 64, 128, 256, 512, 1024];
    setWorkspaceIds((prev) => {
      const desired = new Set(prev);
      for (const w of WIDTHS) {
        if (bits === null || w > bits) desired.delete(`Zvl${w}b`);
      }
      if (bits !== null) desired.add(`Zvl${bits}b`);

      const base = [...desired].find((x) => BASE_ISA_IDS.has(x)) ?? null;
      const { resolved } = resolveSelection({ selected: [...desired], base });
      return new Set(resolved.filter((id) => CATALOG_IDS.has(id)));
    });
  }, []);

  const toggleCompareExt = React.useCallback(
    (id) => {
      setCompareExtIds((current) => {
        const next = new Set(current);
        if (next.has(id)) {
          next.delete(id);
          return next;
        }
        if (next.size >= COMPARE_MAX) {
          showToast(`Comparison holds ${COMPARE_MAX} extensions at most`);
          return current;
        }
        next.add(id);
        return next;
      });
      setCompareKind('ext');
    },
    [showToast],
  );

  const toggleCompareInstruction = React.useCallback(
    (extId, mnemonic) => {
      const key = instructionKey(extId, mnemonic);
      setCompareInstrKeys((current) => {
        const next = new Set(current);
        if (next.has(key)) {
          next.delete(key);
          return next;
        }
        if (next.size >= COMPARE_MAX) {
          showToast(`Comparison holds ${COMPARE_MAX} instructions at most`);
          return current;
        }
        next.add(key);
        return next;
      });
      setCompareKind('instr');
    },
    [showToast],
  );

  const toggleCompareProfile = React.useCallback(
    (name) => {
      setCompareProfileNames((current) => {
        const next = new Set(current);
        if (next.has(name)) {
          next.delete(name);
          return next;
        }
        if (next.size >= COMPARE_MAX) {
          showToast(`Comparison holds ${COMPARE_MAX} profiles at most`);
          return current;
        }
        next.add(name);
        return next;
      });
      setCompareKind('profile');
    },
    [showToast],
  );

  const removeCompareItem = React.useCallback((kind, key) => {
    // Chosen inline rather than from a lookup object: a lookup declared in the
    // render body would be a fresh object each render, captured stale by this
    // empty-dependency callback.
    const setter =
      kind === 'instr'
        ? setCompareInstrKeys
        : kind === 'profile'
          ? setCompareProfileNames
          : setCompareExtIds;
    setter((current) => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }, []);

  const clearCompare = React.useCallback((kind) => {
    if (kind === 'instr') setCompareInstrKeys(new Set());
    else if (kind === 'profile') setCompareProfileNames(new Set());
    else setCompareExtIds(new Set());
  }, []);

  // Stable identities for CompareTray/CompareView, rather than inline arrows
  // at the JSX call site. CompareView's focus effect depends on `onClose`;
  // an inline arrow is a new function every render, so any re-render while
  // the dialog is open (e.g. the toast auto-clearing) would re-run that
  // effect and steal focus back to the dialog container. CompareView also
  // holds onClose in a ref for the same reason, so it stays correct even if
  // a future caller passes an inline handler again.
  const openCompareView = React.useCallback(() => setCompareOpen(true), []);
  const closeCompareView = React.useCallback(() => setCompareOpen(false), []);

  /*
   * One pass per query instead of one per tile per keystroke. The tiles are
   * handed the answer, so React can skip every tile whose match state did not
   * change; previously the raw query was a prop and all 219 re-rendered on
   * every character.
   */
  // Each panel mounts on its first open and stays mounted thereafter.
  const encodingMapMounted = useOnceMounted(encodingMapOpen);
  const workspacePanelMounted = useOnceMounted(workspacePanelOpen);

  const searchMatchIds = React.useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return EMPTY_MATCH_SET;
    const hits = new Set();
    for (const [id, index] of extensionSearchIndexById) {
      if ((index || '').includes(q)) hits.add(id);
    }
    return hits;
  }, [searchQuery, extensionSearchIndexById]);

  const tileProps = React.useMemo(
    () => ({
      selectedExtId: selectedExt?.id ?? null,
      workspaceIds,
      lockedExtensions,
      compareIds: compareExtIds,
      compareMode,
      builderMode,
      isHighlighted,
      isDimmed,
      onSelect: handleSelectExt,
      onToggleWorkspace: handleToggleWorkspace,
      onToggleCompare: toggleCompareExt,
    }),
    [
      // searchQuery is deliberately absent: it is no longer a tile prop, so
      // rebuilding this object on every keystroke would re-render all 219 tiles
      // for nothing, which is the exact cost this change removes.
      selectedExt,
      workspaceIds,
      lockedExtensions,
      compareExtIds,
      compareMode,
      builderMode,
      isHighlighted,
      isDimmed,
      handleSelectExt,
      handleToggleWorkspace,
      toggleCompareExt,
    ],
  );

  const comparePinnedTotal = compareExtIds.size + compareInstrKeys.size + compareProfileNames.size;

  const compareKeys = React.useMemo(() => {
    if (compareKind === 'instr') return [...compareInstrKeys];
    if (compareKind === 'profile') return [...compareProfileNames];
    return [...compareExtIds];
  }, [compareKind, compareInstrKeys, compareProfileNames, compareExtIds]);

  const compareModel = React.useMemo(() => {
    if (compareKeys.length === 0) return null;
    if (compareKind === 'profile') {
      return buildProfileComparison(compareKeys, { expandDependencies: compareExpandDeps });
    }
    if (compareKind === 'ext') {
      return buildExtensionComparison(
        compareKeys.map((id) => findExtensionById(id, formattedSandboxExts)).filter(Boolean),
      );
    }
    return buildInstructionComparison(
      compareKeys
        .map((key) => {
          const parsed = parseInstructionKey(key);
          const ext = parsed && findExtensionById(parsed.extId, formattedSandboxExts);
          const instr = ext && ext.instructions?.[parsed.mnemonic];
          return instr ? { extId: ext.id, mnemonic: parsed.mnemonic, instr } : null;
        })
        .filter(Boolean),
    );
  }, [compareKind, compareKeys, compareExpandDeps, formattedSandboxExts]);

  // Mirrors the existing `ext` permalink effect: replaceState, never push, so
  // pinning does not fill the back button with intermediate states.
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    const current = url.searchParams.get(COMPARE_PARAM);
    const next = buildComparePermalink(compareKind, compareKeys);
    if ((current || '') === next) return;
    if (next) url.searchParams.set(COMPARE_PARAM, next);
    else url.searchParams.delete(COMPARE_PARAM);
    window.history.replaceState(null, '', url.toString());
  }, [compareKind, compareKeys]);

  const copyCompareMarkdown = React.useCallback(
    async (markdown) => {
      const ok = await copyTextToClipboard(markdown);
      showToast(ok ? 'Comparison copied as Markdown' : 'Could not copy to the clipboard');
    },
    [copyTextToClipboard, showToast],
  );

  const copyCompareLink = React.useCallback(async () => {
    const url = new URL(window.location.href);
    url.searchParams.set(COMPARE_PARAM, buildComparePermalink(compareKind, compareKeys));
    const ok = await copyTextToClipboard(url.toString());
    showToast(ok ? 'Comparison link copied' : 'Could not copy to the clipboard');
  }, [compareKind, compareKeys, copyTextToClipboard, showToast]);

  // Unpinning down to one item leaves nothing to compare. Closing beats showing
  // a single column and calling it a comparison.
  React.useEffect(() => {
    if (compareOpen && compareKeys.length < 2) setCompareOpen(false);
  }, [compareOpen, compareKeys]);

  // Calculate if search has any matching extensions
  const hasSearchMatches = React.useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return true;
    return allExtsList.some((ext) => {
      const indexStr = extensionSearchIndexById.get(ext.id) || '';
      return indexStr.includes(q);
    });
  }, [searchQuery, allExtsList, extensionSearchIndexById]);

  // Scroll to extension tile when search matches an extension ID or instruction mnemonic,
  // and automatically open the Selected Details panel. Use a ref to avoid re-scrolling
  // on every render while the query stays the same.
  React.useEffect(() => {
    const q = searchQuery.trim().toLowerCase();

    if (!q) {
      // Reset tracking when query is cleared
      lastScrolledKeyRef.current = null;
      setSearchMatches(null);
      return;
    }

    const allExts = Object.values(extensions).flat();
    let matchedMnemonic = null;
    let matchedDetails = null;

    // Anything selected from here on is search acting on the reader's behalf,
    // not a deliberate click, so its URL write is the one that gets debounced.
    selectionCameFromSearchRef.current = true;

    // First, try an exact extension ID match
    let targetExt = allExts.find((ext) => ext.id.toLowerCase() === q);

    // If no exact extension ID match, try to match an instruction mnemonic
    if (!targetExt) {
      for (const ext of allExts) {
        const mnemonics = Object.keys(ext.instructions || {});
        const found = mnemonics.find((m) => m.toLowerCase() === q);
        if (found) {
          targetExt = ext;
          matchedMnemonic = found;
          matchedDetails = ext.instructions[found] || null;
          break;
        }
      }
    }

    // If still no match, try a deep search against indexed extension+instruction details
    if (!targetExt) {
      targetExt =
        allExts.find((ext) => (extensionSearchIndexById.get(ext.id) || '').includes(q)) || null;
    }

    if (targetExt) {
      const hits = [];
      if (targetExt.instructions && typeof targetExt.instructions === 'object') {
        for (const [mnemonic, details] of Object.entries(targetExt.instructions)) {
          if (instructionMatchesQuery(mnemonic, details, q)) {
            hits.push(mnemonic);
          }
        }
      }

      if (matchedMnemonic && !hits.includes(matchedMnemonic)) hits.unshift(matchedMnemonic);
      if (!matchedMnemonic && hits.length) matchedMnemonic = hits[0];
      matchedDetails = matchedMnemonic ? targetExt?.instructions?.[matchedMnemonic] : null;

      // Always open/update the Selected Details panel for the matched extension
      searchDrivenSelectionRef.current = true;
      setSelectedExt(targetExt);
      setSearchMatches(
        hits.length ? { extId: targetExt.id, query: q, mnemonics: hits, index: 0 } : null,
      );
      setSelectedInstruction(
        matchedMnemonic && matchedDetails ? { mnemonic: matchedMnemonic, ...matchedDetails } : null,
      );

      const key = targetExt.id;

      // Auto-scroll is deferred; matching, highlighting and the details panel
      // are not. Otherwise typing fires one smooth scroll per keystroke and
      // each new one interrupts the last: "zicboz" chased B, C, Ziccrse,
      // Zicbom and Zicboz in turn, and "addi" scrolled four times for only two
      // distinct targets. Debouncing the whole search instead, as the issue
      // originally proposed, would have delayed the highlight as well, trading
      // visible jank for visible lag. This settles on the final target once
      // typing pauses and leaves every other response immediate.
      //
      // The key is the extension id alone. It used to include the query, so a
      // target that had not actually moved was scrolled to again on every
      // keystroke.
      if (lastScrolledKeyRef.current !== key) {
        if (scrollTimerRef.current) window.clearTimeout(scrollTimerRef.current);
        scrollTimerRef.current = window.setTimeout(() => {
          scrollTimerRef.current = null;
          document
            .getElementById(`ext-${targetExt.id}`)
            ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          lastScrolledKeyRef.current = key;
        }, 180);
      }
    } else if (searchDrivenSelectionRef.current) {
      // The query is non-empty and matched nothing. Without this branch the
      // panel kept showing whatever the previous query opened, which read as
      // though the new query had matched it. Only clear what the search itself
      // opened; a clicked selection is left alone.
      searchDrivenSelectionRef.current = false;
      lastScrolledKeyRef.current = null;
      setSelectedExt(null);
      setSelectedInstruction(null);
      setSearchMatches(null);
    }
  }, [searchQuery, extensionSearchIndexById]);

  // Compute stat bar numbers from loaded JSON
  const totalExtensions = React.useMemo(
    () => Object.values(extensions).flat().filter(Boolean).length,
    [],
  );
  const totalInstructions = React.useMemo(() => {
    let c = 0;
    for (const ext of Object.values(extensions).flat().filter(Boolean)) {
      c += Object.keys(ext.instructions || {}).length;
    }
    return c;
  }, []);

  return (
    <div
      className="min-h-screen relative overflow-x-clip"
      style={{ background: 'var(--riscv-bg)', color: 'var(--riscv-text)' }}
    >
      {/* Skip link. First thing in the tab order, visible only once focused.
          Without it a keyboard user pays for the whole header — filters, four
          action controls, the search field — on every page load before reaching
          the 227 tiles they came for. */}
      <a href="#extension-grid" className="riscv-skip-link">
        Skip to the extension grid
      </a>

      {/* Gradient top border */}
      <div className="riscv-top-border" />
      <div className="px-3 md:px-6 py-4 md:py-6 max-w-[1700px] mx-auto">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* ─── Header ───────────────────────────────────────────────────── */}
          <div
            className="lg:col-span-12 pb-5 mb-2"
            style={{ borderBottom: '1px solid var(--riscv-border)' }}
          >
            {/* Title row */}
            <div className="flex flex-col gap-4">
              {/* Identity row. Title left, counts right, one line. The tagline
                  that used to sit under the title said what the title says, and
                  the counts are orientation rather than a dashboard — neither
                  earned a line of its own above the grid. */}
              <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1">
                <div className="flex items-center gap-3">
                  {/* The wordmark stands in for the words "RISC-V", so the
                      heading reads "RISC-V ISA Explorer" with the mark doing
                      the first half. Sized in em so it tracks the h1 across
                      the md breakpoint instead of needing its own step. */}
                  <RiscvLogo height="1.15em" className="text-2xl md:text-3xl" />
                  <h1
                    className="text-2xl md:text-3xl font-black tracking-tight whitespace-nowrap"
                    style={{ color: 'var(--riscv-title)' }}
                  >
                    ISA Explorer
                    {/* Rides the title like an exponent. Inside the h1 on
                        purpose, so it tracks the title's last letter at any
                        size instead of being positioned against a width that
                        changes with the viewport. The class keeps its own
                        -webkit-text-fill-color: harmless now the title is a
                        flat colour, and it is what kept this readable back
                        when the h1 painted itself with a clipped gradient. */}
                    <sup
                      className="riscv-preview-sup"
                      title="This site is a technical preview — verify anything load-bearing against the ratified specification."
                    >
                      Tech Preview
                    </sup>
                  </h1>
                </div>
                {/* Counts. Wrappable on purpose: this sits inside an
                    overflow-x-clip root that clips rather than scrolls, so on
                    a narrow screen they drop below the title instead of off the
                    edge. */}
                <div className="flex flex-wrap items-center gap-x-2 text-[11px]">
                  {[
                    { label: 'Extensions', value: totalExtensions },
                    { label: 'Profiles', value: Object.keys(profiles).length },
                    { label: 'Instructions', value: `${(totalInstructions / 1000).toFixed(1)}k+` },
                    { label: 'Volumes', value: 2 },
                  ].map(({ label, value }) => (
                    <span
                      key={label}
                      className="whitespace-nowrap"
                      style={{ color: 'var(--riscv-text-3)' }}
                    >
                      <span style={{ color: 'var(--riscv-text-2)', fontWeight: 600 }}>{value}</span>{' '}
                      {label}
                      {label !== 'Volumes' && <span className="mx-1 opacity-50">&middot;</span>}
                    </span>
                  ))}

                  {/* Before About, because it answers the same question one
                      step earlier: not "what is this tool" but "what is the
                      thing it catalogues, and how did it get here". */}
                  <button
                    type="button"
                    ref={evolutionTriggerRef}
                    onClick={() => setEvolutionOpen(true)}
                    className="riscv-btn tooltip-wide tooltip-bottom-right ml-3 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold whitespace-nowrap"
                    aria-haspopup="dialog"
                    data-tooltip={`Watch the ISA grow: a cumulative timeline of all ${allExtensionsFlat.length} catalogued extensions, banded by family. Click any dot to open that extension.`}
                  >
                    {/* An axis under a filled, rising mass -- which is what the
                        panel actually draws. It was lucide's Activity, a
                        heart-rate trace, which said nothing about growth and was
                        already in use elsewhere in this file. */}
                    <AreaChart size={12} />
                    Evolution
                  </button>

                  {/* Sits between the counts and Report an issue: the three
                      things a first-time visitor wants from the header row are
                      what this is, how big it is, and where to complain. */}
                  <button
                    type="button"
                    ref={aboutTriggerRef}
                    onClick={() => setAboutOpen(true)}
                    className="riscv-btn tooltip-wide tooltip-bottom-right ml-3 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold whitespace-nowrap"
                    aria-haspopup="dialog"
                    data-tooltip="Browse every ratified RISC-V extension, its instructions and their encodings. Select a tile for details, filter by profile or manual volume, and turn on ISA Builder to assemble a configuration and get a validated -march string. Compare puts extensions, instructions or profiles side by side."
                  >
                    <Info size={12} />
                    About
                  </button>

                  {/* A preview needs somewhere for the findings to go, and it
                      should be reachable from the caveat rather than buried in
                      a footer nobody scrolls to. */}
                  <a
                    href="https://github.com/riscv/riscv-isa-explorer/issues"
                    target="_blank"
                    rel="noreferrer noopener"
                    className="riscv-report-btn ml-3 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold whitespace-nowrap"
                    title="Report an issue on GitHub"
                  >
                    <Bug size={12} />
                    Report an issue
                    <ExternalLink size={10} className="opacity-70" />
                  </a>
                </div>
              </div>

              {/* Controls Area.
                  items-end right-aligns children, so a child wider than this
                  column is pushed off the LEFT edge rather than overflowing the
                  right. At 390px that put the controls at left:-179 inside an
                  overflow-x-clip root, which clips rather than scrolls, so the
                  profile buttons and the builder toggle could not be reached at
                  all. Stretch until there is room to right-align.
                  min-w-0 because a flex item defaults to min-width:auto and
                  refuses to shrink below its content. */}
              <div className="riscv-toolbar flex flex-wrap items-center justify-between gap-2 w-full pb-1">
                {/* Filters — what you are looking at. */}
                <div className="flex items-center gap-x-1 flex-1 pr-1 shrink-0">
                  {/* Grouped Filters Container. */}
                  <div
                    className="flex items-center gap-x-1"
                    style={{
                      background: 'var(--riscv-plate)',
                      borderColor: 'rgba(255,255,255,0.08)',
                    }}
                  >
                    {/* Profiles. Wraps at 320px, where the label plus four buttons
                      measured 338px and ran past the edge — so the label stays one
                      short word rather than spelling the action out.
                      "Highlight", not "Profile": these chips are a lens over the
                      catalogue and write nothing, while the builder's "Start from
                      profile" replaces the workspace. Both said "profile" and looked
                      alike, so the pair read as duplication (#212). */}
                    {/* Profiles Segmented Control */}
                    <div className="flex items-center gap-1 bg-slate-500/10 p-1 rounded-xl border border-slate-500/20">
                      {Object.keys(profiles).map((profile) => (
                        <span key={profile} className="inline-flex items-center">
                          <button
                            onClick={() =>
                              setActiveProfile((current) => {
                                // Profile and volume are mutually exclusive. With
                                // both live, highlight matched either one while
                                // dimming followed only the volume, so the grid
                                // gave no clue which filter was acting.
                                setActiveVolume(null);
                                setSelectedInstruction(null);
                                setSearchMatches(null);
                                return current === profile ? null : profile;
                              })
                            }
                            aria-pressed={activeProfile === profile}
                            title={
                              activeProfile === profile
                                ? `Stop highlighting ${profile}`
                                : `Highlight the extensions in ${profile} — does not change your ISA configuration`
                            }
                            className={[
                              'px-3 py-1.5 text-[12px] rounded-lg transition-all duration-200 font-medium whitespace-nowrap shrink-0',
                              activeProfile === profile
                                ? 'bg-slate-700/80 text-white shadow-inner border border-slate-500/50'
                                : 'text-slate-300 hover:text-white hover:bg-slate-700/40 border border-transparent hover:border-slate-600/30',
                            ].join(' ')}
                          >
                            {profile}
                          </button>
                          {/* Sibling, not nested: a button inside a button is
                              invalid HTML and React warns about it. */}
                          {compareMode && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleCompareProfile(profile);
                              }}
                              aria-pressed={compareProfileNames.has(profile)}
                              className="riscv-pin-btn px-1 py-0.5 rounded border text-[11px] inline-flex items-center justify-center transition-all"
                              title={
                                compareProfileNames.has(profile)
                                  ? `Remove ${profile} from comparison`
                                  : `Pin ${profile} to comparison`
                              }
                            >
                              <GitCompare
                                size={9}
                                strokeWidth={compareProfileNames.has(profile) ? 2.5 : 2}
                              />
                            </button>
                          )}
                        </span>
                      ))}
                    </div>

                    {/* Vertical Divider */}
                    <div className="h-5 w-px bg-slate-700/60 mx-2" />

                    {/* Volumes */}
                    <div className="flex gap-1 bg-slate-500/10 p-1 rounded-xl border border-slate-500/20">
                      {['I', 'II'].map((vol) => (
                        <button
                          key={vol}
                          onClick={() =>
                            setActiveVolume((current) => {
                              setActiveProfile(null);
                              setSelectedInstruction(null);
                              setSearchMatches(null);
                              return current === vol ? null : vol;
                            })
                          }
                          aria-pressed={activeVolume === vol}
                          className={[
                            'px-3 py-1.5 text-[12px] rounded-lg transition-all duration-200 font-medium whitespace-nowrap shrink-0',
                            activeVolume === vol
                              ? 'bg-slate-700/80 text-white shadow-inner border border-slate-500/50'
                              : 'text-slate-300 hover:text-white hover:bg-slate-700/40 border border-transparent hover:border-slate-600/30',
                          ].join(' ')}
                        >
                          Vol {vol}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Actions — what you can do. Tools open a dialog and return
                    you to where you were; modes latch and change how the whole
                    page behaves. They are deliberately not styled alike: a tool
                    stays neutral at all times, a mode takes its accent only
                    while it is ON, so the loudest control in the toolbar is
                    always a mode that is actually running. */}
                <div className="flex items-center gap-1 shrink-0">
                  {/* Encoder Validator - Sleek Outline Button */}
                  <button
                    type="button"
                    onClick={() => {
                      setEncoderValidatorOpen(true);
                      setEncoderValidatorResult(null);
                      setEncoderValidatorCopyStatus(null);
                    }}
                    ref={encoderTriggerRef}
                    aria-haspopup="dialog"
                    aria-expanded={encoderValidatorOpen}
                    className="riscv-tool-btn group inline-flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-semibold transition-all duration-300 whitespace-nowrap border"
                    data-tooltip="Validate a proposed instruction encoding against the existing instruction set"
                  >
                    <ScanSearch size={14} className="opacity-80" />
                    <span className="whitespace-nowrap">Encoder Validator</span>
                  </button>

                  {/* Beside the validator because they answer neighbouring
                      questions: one checks a proposed encoding, the other
                      shows where the space it would occupy already is. */}
                  <button
                    type="button"
                    onClick={() => setEncodingMapOpen(true)}
                    aria-haspopup="dialog"
                    aria-expanded={encodingMapOpen}
                    className="riscv-tool-btn group inline-flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-semibold transition-all duration-300 whitespace-nowrap border"
                    // Colour, border and hover all come from .riscv-tool-btn.
                    // Deliberately no inline style: an inline `color` outranks
                    // the class's :hover rule, so the button would never light
                    // up under the cursor. The class uses tokens rather than
                    // Tailwind amber, which has no light-theme remapping and
                    // measured 1.33:1 on the pastel ground.
                    data-tooltip="See how the 32-bit opcode space is allocated"
                  >
                    <Grid3x3 size={14} className="opacity-80" />
                    <span className="whitespace-nowrap">Encoding Map</span>
                  </button>

                  {/* Custom Extension Sandbox — interactive design in custom-0..3 space */}
                  <button
                    type="button"
                    onClick={() => setSandboxOpen(true)}
                    aria-haspopup="dialog"
                    aria-expanded={sandboxOpen}
                    className="group inline-flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-semibold transition-all duration-300 whitespace-nowrap border text-blue-500 bg-blue-500/10 border-blue-500/30 hover:bg-blue-500/20 hover:border-blue-500/50 shadow-sm"
                    data-tooltip="A safe sandbox to design, test, and validate your own custom RISC-V extensions and instructions"
                  >
                    <FlaskConical size={14} className="opacity-80" />
                    <span className="whitespace-nowrap">Extension Sandbox</span>
                  </button>

                  {/* Theme toggle relocated to header */}

                  {/* Tools end, modes begin. */}
                  <div className="h-6 w-px" style={{ background: 'var(--riscv-border-2)' }} />

                  {/* Compare mode. Deliberately a mode rather than always-on
                    affordances: a pin on every one of 227 tiles, every
                    instruction chip and every profile button is a lot of
                    permanent furniture for an occasional task. Turning it off
                    hides the affordances and the tray but keeps the pinned set
                    and the ?cmp= URL, so it never destroys a comparison. */}
                  <button
                    type="button"
                    aria-pressed={compareMode}
                    onClick={() => setCompareMode((v) => !v)}
                    className="compare-mode-toggle relative inline-flex items-center gap-2 px-3 py-2 text-xs font-bold rounded-xl transition-all duration-200 whitespace-nowrap cursor-pointer"
                    style={
                      compareMode
                        ? {
                            background: 'var(--riscv-violet)',
                            color: '#ffffff',
                            boxShadow: '0 4px 18px rgba(139,124,248,0.35)',
                            border: '1px solid var(--riscv-violet)',
                          }
                        : {
                            background: 'var(--riscv-surface)',
                            color: 'var(--riscv-violet)',
                            border: '1px solid rgba(139,124,248,0.35)',
                          }
                    }
                    data-tooltip={
                      compareMode
                        ? 'Compare mode is ON — click to turn off (pinned items are preserved)'
                        : 'Turn on Compare mode to pin extensions, instructions, or profiles'
                    }
                  >
                    <GitCompare size={14} className="flex-shrink-0" />
                    <span className="whitespace-nowrap hidden sm:inline">Compare</span>
                    <span
                      className="inline-flex items-center justify-center px-1.5 h-[16px] rounded-full text-[10px] font-black tracking-wide"
                      style={
                        compareMode
                          ? {
                              background: 'rgba(0,0,0,0.25)',
                              color: '#ffffff',
                            }
                          : comparePinnedTotal > 0
                            ? {
                                background: 'var(--riscv-violet-dim)',
                                color: 'var(--riscv-violet)',
                                border: '1px solid rgba(139,124,248,0.3)',
                              }
                            : {
                                background: 'var(--riscv-tint-3)',
                                color: 'var(--riscv-text-3)',
                              }
                      }
                    >
                      {comparePinnedTotal > 0 ? comparePinnedTotal : compareMode ? 'ON' : 'OFF'}
                    </span>
                  </button>

                  {/* ISA Configuration Builder — fused action group */}
                  <div className="relative inline-flex items-stretch rounded-xl">
                    {/* Active glow ring */}
                    {builderMode && (
                      <span className="absolute -inset-px rounded-xl animate-pulse bg-amber-400/20 pointer-events-none z-0" />
                    )}

                    {/* Main body — switches builder mode on and off.
                      It deliberately does NOT open the panel: the panel is a
                      full-screen overlay, so opening it on activation would
                      immediately cover the tiles the user is meant to click. */}
                    <div className="relative flex flex-col">
                      <button
                        type="button"
                        aria-pressed={builderMode}
                        onClick={() => setBuilderMode((v) => !v)}
                        className={[
                          'relative z-10 inline-flex items-center gap-2 px-3 py-2 text-xs font-bold transition-all duration-300 whitespace-nowrap',
                          builderMode
                            ? 'bg-gradient-to-b from-amber-400 to-amber-500 text-slate-900 hover:from-amber-300 hover:to-amber-400 rounded-xl'
                            : 'builder-btn-off bg-slate-800/80 text-amber-300/90 border border-amber-400/30 hover:bg-slate-700/80 hover:text-amber-200 rounded-xl',
                        ].join(' ')}
                        style={{
                          boxShadow: builderMode
                            ? '0 4px 18px rgba(251,191,36,0.4)'
                            : '0 2px 10px rgba(0,0,0,0.2)',
                        }}
                        data-tooltip={
                          builderMode
                            ? 'ISA Configuration Builder is ON — click any extension’s + to add it. Click here to turn off.'
                            : 'Turn on the ISA Configuration Builder to start picking extensions'
                        }
                      >
                        <Cpu size={14} className="opacity-80 flex-shrink-0" />
                        <span className="whitespace-nowrap hidden sm:inline">
                          ISA Configuration Builder
                        </span>
                        <span className="whitespace-nowrap sm:hidden">ISA Builder</span>
                        <span
                          className={[
                            'inline-flex items-center justify-center px-1.5 h-[16px] rounded-full text-[10px] font-black tracking-wide',
                            builderMode
                              ? 'builder-badge-on bg-slate-900/75 text-amber-400'
                              : 'builder-badge-off bg-slate-900/60 text-slate-400',
                          ].join(' ')}
                        >
                          {builderMode ? 'ON' : 'OFF'}
                        </span>
                        {workspaceIds.size > 0 && (
                          <span className="builder-badge-on inline-flex items-center justify-center min-w-[18px] px-1 h-[18px] rounded-full text-[10px] font-black bg-slate-900/75 text-amber-400">
                            {workspaceIds.size}
                          </span>
                        )}
                      </button>

                      {/* Builder Contextual Actions Toolbar.
                        Hidden while the full panel is open: this toolbar belongs to the
                        header. It used to float on top of the panel modal, which
                        was the original reason to unmount it; since .riscv-toolbar
                        took z-index 30 — to stop its backdrop-filter trapping the
                        profile menu — everything in this toolbar now paints below
                        the panel's z-40 instead. The guard stays because the
                        actions are redundant while the panel is open, one of them
                        being "open the panel". */}
                      {builderMode && !workspacePanelOpen && (
                        <div className="builder-toolbar absolute top-[calc(100%+6px)] left-0 right-0 flex items-center justify-between p-1 bg-slate-800/90 border border-amber-500/40 rounded-xl shadow-[0_8px_32px_rgba(0,0,0,0.4)] backdrop-blur-xl z-50 animate-fade-in-up gap-1">
                          {/* Open the full panel */}
                          <button
                            type="button"
                            data-tooltip="Open the builder panel (-march string, export, conflicts)"
                            aria-label="Open the builder panel"
                            onClick={() => setWorkspacePanelOpen(true)}
                            className={`builder-action-amber ${workspaceIds.size === 0 ? 'flex-none px-4' : 'flex-1'} flex items-center justify-center py-1.5 text-amber-300 hover:bg-amber-500/30 hover:text-amber-100 transition-all duration-300 rounded-lg hover:shadow-[0_0_12px_rgba(251,191,36,0.3)]`}
                          >
                            {/* PanelRightOpen, not Maximize2. The diagonal
                                arrows are the universal "go fullscreen" gesture,
                                but this opens a drawer that slides in from the
                                right — the icon was describing the wrong motion.
                                The label carries the rest: three unlabelled icons
                                in a row make the reader guess, and this is the
                                primary action of the three. */}
                            <PanelRightOpen size={14} className="flex-shrink-0" />
                            {workspaceIds.size > 0 && (
                              <span className="ml-1.5 text-[11px] font-bold whitespace-nowrap hidden sm:inline">
                                Open panel
                              </span>
                            )}
                          </button>

                          {/* Profile Menu */}
                          <div className="relative flex-1 flex">
                            <button
                              type="button"
                              onClick={() => setProfileMenuOpen((v) => !v)}
                              data-tooltip="Start the configuration from a ratified profile"
                              className={`builder-action-indigo w-full flex items-center justify-center gap-1.5 py-1.5 text-[11px] font-semibold transition-all duration-300 rounded-lg ${
                                profileMenuOpen
                                  ? 'bg-indigo-500 text-white shadow-inner'
                                  : 'text-indigo-300 hover:bg-indigo-500/30 hover:text-indigo-100 hover:shadow-[0_0_12px_rgba(99,102,241,0.3)]'
                              }`}
                            >
                              <Layers size={14} className="transition-transform hover:scale-110" />
                              {workspaceIds.size === 0 && (
                                <span className="whitespace-nowrap">Start from profile</span>
                              )}
                            </button>

                            {profileMenuOpen && (
                              <div
                                ref={profileMenuRef}
                                className="builder-menu"
                                style={{
                                  position: 'absolute',
                                  top: 'calc(100% + 8px)',
                                  right: 0,
                                  zIndex: 50,
                                  display: 'flex',
                                  flexDirection: 'column',
                                  borderRadius: 10,
                                  minWidth: 'min(300px, calc(100vw - 24px))',
                                  maxWidth: 'calc(100vw - 24px)',
                                  overflow: 'hidden',
                                }}
                              >
                                <div
                                  style={{
                                    padding: '10px 14px',
                                    borderBottom: '1px solid var(--riscv-tint-3)',
                                    background: 'rgba(245,197,66,0.04)',
                                    fontSize: 12,
                                    color: 'var(--riscv-text)',
                                    fontWeight: 700,
                                  }}
                                >
                                  Start from a ratified profile
                                </div>

                                {Object.entries(profiles).map(([name, list]) => (
                                  <button
                                    key={name}
                                    type="button"
                                    onClick={() => {
                                      // Replace rather than merge: "start from" means
                                      // this profile is the starting point, and mixing
                                      // it into an existing pick would silently produce
                                      // a configuration matching neither.
                                      setWorkspaceIds(new Set());
                                      addWorkspaceIdsSmart(list);
                                      setSeedProfile(name);
                                      // A fresh profile load is a new origin.
                                      setCustomFromProfile(null);
                                      setBaselineLocked(true);
                                      setProfileMenuOpen(false);
                                    }}
                                    style={{
                                      display: 'flex',
                                      alignItems: 'center',
                                      justifyContent: 'space-between',
                                      gap: 12,
                                      padding: '10px 14px',
                                      textAlign: 'left',
                                      borderBottom: '1px solid var(--riscv-tint-2)',
                                      background: 'transparent',
                                      cursor: 'pointer',
                                    }}
                                    className="hover:bg-amber-400/10 transition-colors"
                                  >
                                    <span
                                      style={{
                                        fontSize: 13,
                                        fontWeight: 700,
                                        color: 'var(--riscv-gold)',
                                      }}
                                    >
                                      {name}
                                    </span>
                                    <span style={{ fontSize: 11, color: 'var(--riscv-text-2)' }}>
                                      {list.length} extensions
                                    </span>
                                  </button>
                                ))}

                                <div
                                  style={{
                                    padding: '8px 14px',
                                    fontSize: 11,
                                    color: 'var(--riscv-text-3)',
                                    lineHeight: 1.5,
                                  }}
                                >
                                  Replaces the current selection. Dependencies are resolved
                                  automatically, so the result may include more than the profile
                                  lists.
                                </div>
                              </div>
                            )}
                          </div>

                          {workspaceIds.size > 0 && (
                            <>
                              <button
                                type="button"
                                data-tooltip="Clear all extensions"
                                aria-label="Clear all extensions"
                                onClick={() => {
                                  setWorkspaceIds(new Set());
                                  setSeedProfile(null);
                                  // Origin tracking has to go too. Leaving it
                                  // set made a fresh selection claim it was
                                  // 'Custom (from RVA23)' — and that badge is
                                  // persisted, so the lie survived a reload.
                                  setCustomFromProfile(null);
                                  setParamChoices({});
                                  setBaselineLocked(true);
                                }}
                                className="builder-action-rose flex-1 flex items-center justify-center py-1.5 text-rose-300 hover:bg-rose-500/30 hover:text-rose-100 hover:shadow-[0_0_12px_rgba(244,63,94,0.3)] transition-all duration-300 rounded-lg"
                              >
                                <Trash2
                                  size={14}
                                  className="transition-transform hover:scale-110"
                                />
                              </button>

                              <div className="relative flex-1 flex">
                                <button
                                  type="button"
                                  data-tooltip="Export configuration YAML"
                                  aria-label="Export configuration YAML"
                                  onClick={() => setQuickExportOpen((v) => !v)}
                                  className={`builder-action-emerald w-full flex items-center justify-center py-1.5 transition-all duration-300 rounded-lg ${
                                    quickExportOpen
                                      ? 'bg-emerald-500 text-white shadow-inner'
                                      : 'text-emerald-300 hover:bg-emerald-500/30 hover:text-emerald-100 hover:shadow-[0_0_12px_rgba(16,185,129,0.3)]'
                                  }`}
                                >
                                  <Download
                                    size={14}
                                    className="transition-transform hover:scale-110"
                                  />
                                </button>

                                {quickExportOpen && (
                                  <div
                                    className="builder-menu"
                                    style={{
                                      position: 'absolute',
                                      top: 'calc(100% + 8px)',
                                      right: 0,
                                      zIndex: 50,
                                      display: 'flex',
                                      flexDirection: 'column',
                                      gap: 0,
                                      borderRadius: 10,
                                      minWidth: 280,
                                      overflow: 'hidden',
                                    }}
                                  >
                                    {/* Header strip */}
                                    <div
                                      style={{
                                        display: 'flex',
                                        justifyContent: 'space-between',
                                        alignItems: 'center',
                                        padding: '10px 14px',
                                        borderBottom: '1px solid var(--riscv-tint-3)',
                                        background: 'rgba(245,197,66,0.04)',
                                      }}
                                    >
                                      <div
                                        style={{ display: 'flex', alignItems: 'center', gap: 7 }}
                                      >
                                        <Package
                                          size={12}
                                          style={{ color: 'var(--riscv-gold)', opacity: 0.85 }}
                                        />
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
                                        onClick={() => setQuickExportOpen(false)}
                                        style={{
                                          background: 'none',
                                          border: 'none',
                                          color: '#6f7f95',
                                          cursor: 'pointer',
                                          padding: 2,
                                          lineHeight: 0,
                                          borderRadius: 4,
                                        }}
                                        onMouseEnter={(e) =>
                                          (e.currentTarget.style.color = '#94a3b8')
                                        }
                                        onMouseLeave={(e) =>
                                          (e.currentTarget.style.color = '#6f7f95')
                                        }
                                      >
                                        <X size={13} />
                                      </button>
                                    </div>

                                    {/* Toggle card */}
                                    <div style={{ padding: '12px 14px' }}>
                                      <div
                                        onClick={() => setQuickExportIncludeInstr((v) => !v)}
                                        style={{
                                          display: 'flex',
                                          alignItems: 'center',
                                          justifyContent: 'space-between',
                                          gap: 12,
                                          padding: '10px 12px',
                                          borderRadius: 8,
                                          cursor: 'pointer',
                                          background: quickExportIncludeInstr
                                            ? 'rgba(245,197,66,0.07)'
                                            : 'var(--riscv-tint-2)',
                                          border: `1px solid ${quickExportIncludeInstr ? 'rgba(245,197,66,0.2)' : 'var(--riscv-tint-3)'}`,
                                          transition: 'all 0.2s',
                                          userSelect: 'none',
                                        }}
                                      >
                                        <div style={{ flex: 1 }}>
                                          <span
                                            style={{
                                              fontSize: 12.5,
                                              fontWeight: 600,
                                              color: quickExportIncludeInstr
                                                ? 'var(--riscv-text)'
                                                : '#94a3b8',
                                              display: 'block',
                                              lineHeight: 1.35,
                                              transition: 'color 0.2s',
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
                                                workspaceTotalInstr > 100 ? '#f59e0b' : '#64748b',
                                              fontVariantNumeric: 'tabular-nums',
                                            }}
                                          >
                                            {workspaceTotalInstr.toLocaleString()} instructions
                                            {workspaceTotalInstr > 100 ? ' · large export' : ''}
                                          </span>
                                        </div>

                                        {/* Premium toggle track */}
                                        <div
                                          style={{
                                            width: 38,
                                            height: 21,
                                            borderRadius: 11,
                                            flexShrink: 0,
                                            background: quickExportIncludeInstr
                                              ? 'linear-gradient(135deg, #f5c542 0%, #fde68a 100%)'
                                              : 'rgba(255,255,255,0.08)',
                                            boxShadow: quickExportIncludeInstr
                                              ? '0 0 8px rgba(245,197,66,0.4)'
                                              : 'none',
                                            position: 'relative',
                                            transition: 'all 0.25s',
                                            border: `1px solid ${quickExportIncludeInstr ? 'rgba(245,197,66,0.7)' : 'var(--riscv-tint-4)'}`,
                                          }}
                                        >
                                          <div
                                            style={{
                                              width: 15,
                                              height: 15,
                                              borderRadius: '50%',
                                              background: quickExportIncludeInstr
                                                ? '#1a1206'
                                                : '#6f7f95',
                                              position: 'absolute',
                                              top: 2,
                                              left: quickExportIncludeInstr ? 19 : 2,
                                              transition: 'all 0.25s',
                                              boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
                                            }}
                                          />
                                        </div>
                                      </div>
                                    </div>

                                    {/* Download button */}
                                    <div style={{ padding: '0 14px 13px' }}>
                                      <button
                                        onClick={() => {
                                          const { yaml } = buildIsaConfigYaml(
                                            Array.from(workspaceIds),
                                            allExtsList,
                                            quickExportIncludeInstr,
                                          );
                                          const blob = new Blob([yaml], { type: 'text/yaml' });
                                          const url = URL.createObjectURL(blob);
                                          const a = document.createElement('a');
                                          a.href = url;
                                          const marchRes = buildMarchString(
                                            Array.from(workspaceIds),
                                            allExtsList,
                                          );
                                          const base = marchRes.march
                                            ? marchRes.march.split('_')[0]
                                            : 'core';
                                          a.download = `riscv_${base}_config.yaml`;
                                          document.body.appendChild(a);
                                          a.click();
                                          document.body.removeChild(a);
                                          setTimeout(() => URL.revokeObjectURL(url), 1000);
                                          setQuickExportOpen(false);
                                          showToast('Exported YAML configuration!');
                                        }}
                                        style={{
                                          width: '100%',
                                          padding: '9px 14px',
                                          borderRadius: 7,
                                          background:
                                            'linear-gradient(135deg, rgba(245,197,66,0.22) 0%, rgba(245,197,66,0.12) 100%)',
                                          color: 'var(--riscv-gold)',
                                          border: '1px solid rgba(245,197,66,0.4)',
                                          fontSize: 12.5,
                                          fontWeight: 700,
                                          cursor: 'pointer',
                                          transition: 'all 0.18s',
                                          letterSpacing: '0.02em',
                                          display: 'flex',
                                          alignItems: 'center',
                                          justifyContent: 'center',
                                          gap: 6,
                                        }}
                                        onMouseEnter={(e) => {
                                          e.currentTarget.style.background =
                                            'linear-gradient(135deg, rgba(245,197,66,0.35) 0%, rgba(245,197,66,0.22) 100%)';
                                          e.currentTarget.style.boxShadow =
                                            '0 0 12px rgba(245,197,66,0.2)';
                                        }}
                                        onMouseLeave={(e) => {
                                          e.currentTarget.style.background =
                                            'linear-gradient(135deg, rgba(245,197,66,0.22) 0%, rgba(245,197,66,0.12) 100%)';
                                          e.currentTarget.style.boxShadow = 'none';
                                        }}
                                      >
                                        <Package size={11} />
                                        Download .yaml
                                      </button>
                                    </div>
                                  </div>
                                )}
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          {/* ─── Main Grid ───────────────────────────────────────────────── */}
          <div
            id="extension-grid"
            tabIndex={-1}
            role="region"
            aria-label="Extension catalogue"
            className={`${
              selectedExt ? 'lg:col-span-8' : 'lg:col-span-12'
            } grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6 auto-rows-min`}
          >
            {/* Search Bar */}
            <div className="col-span-full mb-2 flex items-center gap-3">
              <div className="relative flex-1">
                <Search
                  size={15}
                  className="absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
                  style={{ color: 'var(--riscv-text-3)' }}
                />
                <input
                  ref={searchInputRef}
                  type="search"
                  aria-label="Search extensions, instructions and encodings"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search extensions, instructions, encodings…"
                  className="riscv-input w-full pl-10 pr-24 py-2.5 text-sm"
                />
                <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-2">
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={() => setSearchQuery('')}
                      className="p-0.5 rounded hover:opacity-80"
                      style={{ color: 'var(--riscv-text-3)' }}
                      data-tooltip="Clear search"
                      aria-label="Clear search"
                    >
                      <X size={13} />
                    </button>
                  )}
                  <kbd
                    className="hidden sm:inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium"
                    style={{
                      background: 'var(--riscv-surface)',
                      color: 'var(--riscv-text-3)',
                      border: '1px solid var(--riscv-border-2)',
                    }}
                  >
                    <span className="text-[10px]">⌘</span> K
                  </kbd>
                </div>
              </div>

              {/* Theme Toggle - Perfectly positioned next to Search for max visibility */}
              <button
                type="button"
                onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
                data-tooltip={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
                aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
                className="group flex items-center justify-center rounded-xl transition-all duration-300 shadow-sm hover:shadow-md hover:-translate-y-0.5 border flex-shrink-0"
                style={{
                  width: 42,
                  height: 42,
                  background: 'var(--riscv-plate)',
                  borderColor: 'rgba(128,128,128,0.2)',
                  color: 'var(--riscv-text-2)',
                }}
              >
                {theme === 'dark' ? (
                  <Sun size={18} className="group-hover:text-amber-400 transition-colors" />
                ) : (
                  <Moon size={18} className="group-hover:text-indigo-500 transition-colors" />
                )}
              </button>
            </div>

            {hasSearchMatches ? (
              <>
                {/* 1. Base ISA */}
                <div className="space-y-2.5 col-span-full">
                  <div className="flex items-center gap-2">
                    <CircuitBoard size={13} style={{ color: '#60a5fa' }} />
                    <h3
                      className="text-[12px] font-semibold uppercase tracking-widest"
                      style={{ color: '#60a5fa' }}
                    >
                      Base ISA
                    </h3>
                    <span className="text-[11px]" style={{ color: 'var(--riscv-text-3)' }}>
                      {extensions.base.length} isa
                    </span>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                    {extensions.base.map((item) => (
                      <ExtensionTile
                        key={item.id}
                        data={item}
                        matchesSearch={searchMatchIds.has(item.id)}
                        {...tileProps}
                        colorClass="border-blue-900/60 bg-blue-950/40 text-blue-100"
                      />
                    ))}
                  </div>
                </div>

                {/* 2. Single-Letter Extensions */}
                <div className="space-y-2.5 col-span-full">
                  <div className="flex items-center gap-2">
                    <Braces size={13} style={{ color: '#34d399' }} />
                    <h3
                      className="text-[12px] font-semibold uppercase tracking-widest"
                      style={{ color: '#34d399' }}
                    >
                      Single-Letter Extensions
                    </h3>
                    <span className="text-[11px]" style={{ color: 'var(--riscv-text-3)' }}>
                      {extensions.standard.length} ext
                    </span>
                  </div>
                  <div className="grid grid-cols-4 md:grid-cols-8 gap-2">
                    {extensions.standard.map((item) => (
                      <ExtensionTile
                        key={item.id}
                        data={item}
                        matchesSearch={searchMatchIds.has(item.id)}
                        {...tileProps}
                        colorClass="border-emerald-900/60 bg-emerald-950/40 text-emerald-100"
                      />
                    ))}
                  </div>
                </div>

                {/* 3. Z-Extensions */}
                <div
                  className="col-span-full columns-1 md:columns-2 xl:columns-3 gap-4 pt-5"
                  style={{ borderTop: '1px solid var(--riscv-border)' }}
                >
                  <div className="space-y-2.5 break-inside-avoid mb-4">
                    <div className="flex items-center gap-2">
                      <Binary size={12} style={{ color: '#a78bfa' }} />
                      <h3
                        className="text-[12px] font-semibold uppercase tracking-widest"
                        style={{ color: '#a78bfa' }}
                      >
                        Bit Manipulation (Zb*)
                      </h3>
                      <span className="text-[11px]" style={{ color: 'var(--riscv-text-3)' }}>
                        {extensions.z_bit.length}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {extensions.z_bit.map((item) => (
                        <ExtensionTile
                          key={item.id}
                          data={item}
                          matchesSearch={searchMatchIds.has(item.id)}
                          {...tileProps}
                          colorClass="border-purple-900/60 bg-purple-950/30 text-purple-100"
                        />
                      ))}
                    </div>
                  </div>

                  <div className="space-y-2.5 break-inside-avoid mb-4">
                    <div className="flex items-center gap-2">
                      <Shuffle size={12} style={{ color: '#fbbf24' }} />
                      <h3
                        className="text-[12px] font-semibold uppercase tracking-widest"
                        style={{ color: '#fbbf24' }}
                      >
                        Atomics (Za/Zic*)
                      </h3>
                      <span className="text-[11px]" style={{ color: 'var(--riscv-text-3)' }}>
                        {extensions.z_atomics.length}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {extensions.z_atomics.map((item) => (
                        <ExtensionTile
                          key={item.id}
                          data={item}
                          matchesSearch={searchMatchIds.has(item.id)}
                          {...tileProps}
                          colorClass="border-amber-900/60 bg-amber-950/30 text-amber-100"
                        />
                      ))}
                    </div>
                  </div>

                  <div className="space-y-2.5 break-inside-avoid mb-4">
                    <div className="flex items-center gap-2">
                      <Layers size={12} style={{ color: '#818cf8' }} />
                      <h3
                        className="text-[12px] font-semibold uppercase tracking-widest"
                        style={{ color: '#818cf8' }}
                      >
                        Compressed (Zc*)
                      </h3>
                      <span className="text-[11px]" style={{ color: 'var(--riscv-text-3)' }}>
                        {extensions.z_compress.length}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {extensions.z_compress.map((item) => (
                        <ExtensionTile
                          key={item.id}
                          data={item}
                          matchesSearch={searchMatchIds.has(item.id)}
                          {...tileProps}
                          colorClass="border-indigo-900/60 bg-indigo-950/30 text-indigo-100"
                        />
                      ))}
                    </div>
                  </div>

                  <div className="space-y-2.5 break-inside-avoid mb-4">
                    <div className="flex items-center gap-2">
                      <FlaskConical size={12} style={{ color: '#f472b6' }} />
                      <h3
                        className="text-[12px] font-semibold uppercase tracking-widest"
                        style={{ color: '#f472b6' }}
                      >
                        Float & Numerics (Zf*)
                      </h3>
                      <span className="text-[11px]" style={{ color: 'var(--riscv-text-3)' }}>
                        {extensions.z_float.length}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {extensions.z_float.map((item) => (
                        <ExtensionTile
                          key={item.id}
                          data={item}
                          matchesSearch={searchMatchIds.has(item.id)}
                          {...tileProps}
                          colorClass="border-pink-900/60 bg-pink-950/30 text-pink-100"
                        />
                      ))}
                    </div>
                  </div>

                  <div className="space-y-2.5 break-inside-avoid mb-4">
                    <div className="flex items-center gap-2">
                      <Database size={12} style={{ color: '#38bdf8' }} />
                      <h3
                        className="text-[12px] font-semibold uppercase tracking-widest"
                        style={{ color: '#38bdf8' }}
                      >
                        Load / Store
                      </h3>
                      <span className="text-[11px]" style={{ color: 'var(--riscv-text-3)' }}>
                        {extensions.z_load_store.length}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {extensions.z_load_store.map((item) => (
                        <ExtensionTile
                          key={item.id}
                          data={item}
                          matchesSearch={searchMatchIds.has(item.id)}
                          {...tileProps}
                          colorClass="border-sky-900/60 bg-sky-950/30 text-sky-100"
                        />
                      ))}
                    </div>
                  </div>

                  <div className="space-y-2.5 break-inside-avoid mb-4">
                    <div className="flex items-center gap-2">
                      <Activity size={12} style={{ color: '#e879f9' }} />
                      <h3
                        className="text-[12px] font-semibold uppercase tracking-widest"
                        style={{ color: '#e879f9' }}
                      >
                        Integer
                      </h3>
                      <span className="text-[11px]" style={{ color: 'var(--riscv-text-3)' }}>
                        {extensions.z_integer.length}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {extensions.z_integer.map((item) => (
                        <ExtensionTile
                          key={item.id}
                          data={item}
                          matchesSearch={searchMatchIds.has(item.id)}
                          {...tileProps}
                          colorClass="border-fuchsia-900/60 bg-fuchsia-950/30 text-fuchsia-100"
                        />
                      ))}
                    </div>
                  </div>

                  <div className="space-y-2.5 break-inside-avoid mb-4">
                    <div className="flex items-center gap-2">
                      <Zap size={12} style={{ color: '#2dd4bf' }} />
                      <h3
                        className="text-[12px] font-semibold uppercase tracking-widest"
                        style={{ color: '#2dd4bf' }}
                      >
                        Vector Subsets (Zv/Zve)
                      </h3>
                      <span className="text-[11px]" style={{ color: 'var(--riscv-text-3)' }}>
                        {extensions.z_vector.length}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {extensions.z_vector.map((item) => (
                        <ExtensionTile
                          key={item.id}
                          data={item}
                          matchesSearch={searchMatchIds.has(item.id)}
                          {...tileProps}
                          colorClass="border-teal-900/60 bg-teal-950/30 text-teal-100"
                        />
                      ))}
                    </div>
                  </div>

                  <div className="space-y-2.5 break-inside-avoid mb-4">
                    <div className="flex items-center gap-2">
                      <Shield size={12} style={{ color: '#f87171' }} />
                      <h3
                        className="text-[12px] font-semibold uppercase tracking-widest"
                        style={{ color: '#f87171' }}
                      >
                        Security & CFI
                      </h3>
                      <span className="text-[11px]" style={{ color: 'var(--riscv-text-3)' }}>
                        {extensions.z_security.length}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {extensions.z_security.map((item) => (
                        <ExtensionTile
                          key={item.id}
                          data={item}
                          matchesSearch={searchMatchIds.has(item.id)}
                          {...tileProps}
                          colorClass="border-red-900/60 bg-red-950/30 text-red-100"
                        />
                      ))}
                    </div>
                  </div>

                  <div className="space-y-2.5 break-inside-avoid mb-4">
                    <div className="flex items-center gap-2">
                      <KeyRound size={12} style={{ color: '#94a3b8' }} />
                      <h3
                        className="text-[12px] font-semibold uppercase tracking-widest"
                        style={{ color: '#94a3b8' }}
                      >
                        Cryptography (Zk*)
                      </h3>
                      <span className="text-[11px]" style={{ color: 'var(--riscv-text-3)' }}>
                        {extensions.z_crypto.length}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {extensions.z_crypto.map((item) => (
                        <ExtensionTile
                          key={item.id}
                          data={item}
                          matchesSearch={searchMatchIds.has(item.id)}
                          {...tileProps}
                          colorClass="border-[var(--riscv-border-2)] bg-[var(--riscv-surface-2)] text-slate-300"
                        />
                      ))}
                    </div>
                  </div>

                  <div className="space-y-2.5 break-inside-avoid mb-4">
                    <div className="flex items-center gap-2">
                      <Lock size={12} style={{ color: '#c4b5fd' }} />
                      <h3
                        className="text-[12px] font-semibold uppercase tracking-widest"
                        style={{ color: '#c4b5fd' }}
                      >
                        Vector Cryptography (Zvk*)
                      </h3>
                      <span className="text-[11px]" style={{ color: 'var(--riscv-text-3)' }}>
                        {extensions.z_vector_crypto.length}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {extensions.z_vector_crypto.map((item) => (
                        <ExtensionTile
                          key={item.id}
                          data={item}
                          matchesSearch={searchMatchIds.has(item.id)}
                          {...tileProps}
                          colorClass="border-violet-900/60 bg-violet-950/30 text-violet-100"
                        />
                      ))}
                    </div>
                  </div>

                  <div className="space-y-2.5 break-inside-avoid mb-4">
                    <div className="flex items-center gap-2">
                      <Settings2 size={12} style={{ color: '#fb923c' }} />
                      <h3
                        className="text-[12px] font-semibold uppercase tracking-widest"
                        style={{ color: '#fb923c' }}
                      >
                        System
                      </h3>
                      <span className="text-[11px]" style={{ color: 'var(--riscv-text-3)' }}>
                        {extensions.z_system.length}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {extensions.z_system.map((item) => (
                        <ExtensionTile
                          key={item.id}
                          data={item}
                          matchesSearch={searchMatchIds.has(item.id)}
                          {...tileProps}
                          colorClass="border-orange-900/60 bg-orange-950/30 text-orange-100"
                        />
                      ))}
                    </div>
                  </div>

                  <div className="space-y-2.5 break-inside-avoid mb-4">
                    <div className="flex items-center gap-2">
                      <MemoryStick size={12} style={{ color: '#fdba74' }} />
                      <h3
                        className="text-[12px] font-semibold uppercase tracking-widest"
                        style={{ color: '#fdba74' }}
                      >
                        Caches
                      </h3>
                      <span className="text-[11px]" style={{ color: 'var(--riscv-text-3)' }}>
                        {extensions.z_caches.length}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {extensions.z_caches.map((item) => (
                        <ExtensionTile
                          key={item.id}
                          data={item}
                          matchesSearch={searchMatchIds.has(item.id)}
                          {...tileProps}
                          colorClass="border-orange-900/40 bg-orange-950/20 text-orange-100"
                        />
                      ))}
                    </div>
                  </div>
                </div>

                {/* 4. S-Extensions (Privileged) */}
                <div
                  className="col-span-full pt-5"
                  style={{ borderTop: '1px solid var(--riscv-border)' }}
                >
                  <div className="flex items-center gap-2 mb-4">
                    <Network size={13} style={{ color: '#22d3ee' }} />
                    <h3
                      className="text-[12px] font-semibold uppercase tracking-widest"
                      style={{ color: '#22d3ee' }}
                    >
                      S &amp; Sv Extensions — Privileged ISA
                    </h3>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                    <div className="space-y-2.5">
                      <div className="flex items-center gap-1.5">
                        <Layers size={11} style={{ color: 'var(--riscv-text-3)' }} />
                        <h4
                          className="text-[11px] uppercase tracking-widest font-semibold"
                          style={{ color: 'var(--riscv-text-3)' }}
                        >
                          Memory & Addressing
                        </h4>
                        <span className="text-[11px]" style={{ color: 'var(--riscv-text-3)' }}>
                          {extensions.s_mem.length}
                        </span>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        {extensions.s_mem.map((item) => (
                          <ExtensionTile
                            key={item.id}
                            data={item}
                            matchesSearch={searchMatchIds.has(item.id)}
                            {...tileProps}
                            colorClass="border-cyan-900/50 bg-cyan-950/20 text-cyan-100"
                          />
                        ))}
                      </div>
                    </div>
                    <div className="space-y-2.5">
                      <div className="flex items-center gap-1.5">
                        <Timer size={11} style={{ color: 'var(--riscv-text-3)' }} />
                        <h4
                          className="text-[11px] uppercase tracking-widest font-semibold"
                          style={{ color: 'var(--riscv-text-3)' }}
                        >
                          Interrupts (Sm/Ss)
                        </h4>
                        <span className="text-[11px]" style={{ color: 'var(--riscv-text-3)' }}>
                          {extensions.s_interrupt.length}
                        </span>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        {extensions.s_interrupt.map((item) => (
                          <ExtensionTile
                            key={item.id}
                            data={item}
                            matchesSearch={searchMatchIds.has(item.id)}
                            {...tileProps}
                            colorClass="border-cyan-900/50 bg-cyan-950/20 text-cyan-100"
                          />
                        ))}
                      </div>
                    </div>
                    <div className="space-y-2.5">
                      <div className="flex items-center gap-1.5">
                        <Gauge size={11} style={{ color: 'var(--riscv-text-3)' }} />
                        <h4
                          className="text-[11px] uppercase tracking-widest font-semibold"
                          style={{ color: 'var(--riscv-text-3)' }}
                        >
                          Counters & Profiling
                        </h4>
                        <span className="text-[11px]" style={{ color: 'var(--riscv-text-3)' }}>
                          {extensions.s_counters.length}
                        </span>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        {extensions.s_counters.map((item) => (
                          <ExtensionTile
                            key={item.id}
                            data={item}
                            matchesSearch={searchMatchIds.has(item.id)}
                            {...tileProps}
                            colorClass="border-cyan-900/50 bg-cyan-950/20 text-cyan-100"
                          />
                        ))}
                      </div>
                    </div>
                    <div className="space-y-2.5">
                      <div className="flex items-center gap-1.5">
                        <ServerCrash size={11} style={{ color: 'var(--riscv-text-3)' }} />
                        <h4
                          className="text-[11px] uppercase tracking-widest font-semibold"
                          style={{ color: 'var(--riscv-text-3)' }}
                        >
                          Trap, Debug &amp; Hypervisor
                        </h4>
                        <span className="text-[11px]" style={{ color: 'var(--riscv-text-3)' }}>
                          {extensions.s_trap.length}
                        </span>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        {extensions.s_trap.map((item) => (
                          <ExtensionTile
                            key={item.id}
                            data={item}
                            matchesSearch={searchMatchIds.has(item.id)}
                            {...tileProps}
                            colorClass="border-cyan-900/50 bg-cyan-950/20 text-cyan-100"
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                {/* 5. Custom / Sandbox Extensions */}
                {formattedSandboxExts.length > 0 && (
                  <div
                    className="col-span-full pt-5"
                    style={{ borderTop: '1px solid var(--riscv-border)' }}
                  >
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-2">
                        <FlaskConical
                          size={13}
                          style={{ color: 'var(--riscv-accent-4, #60a5fa)' }}
                        />
                        <h3
                          className="text-[12px] font-semibold uppercase tracking-widest"
                          style={{ color: 'var(--riscv-accent-4, #60a5fa)' }}
                        >
                          Custom / Sandbox Extensions
                        </h3>
                        <span className="text-[11px]" style={{ color: 'var(--riscv-text-3)' }}>
                          {formattedSandboxExts.length} custom
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setSandboxOpen(true)}
                        className="text-[11px] font-semibold flex items-center gap-1 hover:underline"
                        style={{ color: 'var(--riscv-accent-4, #60a5fa)' }}
                      >
                        <span>Manage in Sandbox</span>
                        <ArrowUpRight size={11} />
                      </button>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                      {formattedSandboxExts.map((item) => (
                        <ExtensionTile
                          key={item.id}
                          data={item}
                          searchIndex={extensionSearchIndexById.get(item.id)}
                          {...tileProps}
                          onToggleWorkspace={undefined}
                          colorClass="border-blue-500/40 bg-blue-950/30 text-blue-100"
                        />
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div
                className="col-span-full flex flex-col items-center justify-center py-20 text-center animate-fade-in-up"
                style={{ minHeight: '50vh' }}
              >
                <div
                  style={{
                    padding: '20px',
                    background: 'var(--riscv-surface-2)',
                    borderRadius: '50%',
                    marginBottom: '24px',
                  }}
                >
                  <Search size={40} strokeWidth={1.5} style={{ color: 'var(--riscv-text-3)' }} />
                </div>
                <h3
                  className="text-[16px] font-semibold mb-2"
                  style={{ color: 'var(--riscv-text)' }}
                >
                  No results found
                </h3>
                <p
                  className="text-[13px] max-w-sm"
                  style={{ color: 'var(--riscv-text-2)', lineHeight: 1.5 }}
                >
                  We couldn't find any extensions, instructions, or encodings matching{' '}
                  <strong style={{ color: 'var(--riscv-text)' }}>"{searchQuery}"</strong>.
                </p>
                <button onClick={() => setSearchQuery('')} className="mt-6 riscv-btn px-4 py-2">
                  Clear Search
                </button>
              </div>
            )}
          </div>

          {/*
            The announcement lives out here, not on the panel.

            The panel is display:none until something is selected, and a node
            that is display:none is not in the accessibility tree, so an
            aria-live region on it would be created and populated in the same
            render. Screen readers only announce changes to live regions that
            already existed, so that combination announces nothing. This node
            is always mounted and only its text changes.
          */}
          <div className="sr-only" role="status" aria-live="polite">
            {selectedExt ? `${selectedExt.id} details opened` : ''}
          </div>

          {/* ─── Sidebar ─────────────────────────────────────────────────── */}
          <div
            id="detail-panel"
            role="region"
            aria-label="Selected extension details"
            className={`lg:col-span-4 mt-6 lg:mt-0 ${selectedExt ? 'panel-open' : 'hidden'}`}
          >
            <div
              className="sticky top-6 riscv-card backdrop-blur-sm min-h-[400px] max-h-[calc(100vh-3rem)] flex flex-col overflow-hidden"
              style={{ boxShadow: '0 20px 60px rgba(0,0,0,0.6)' }}
            >
              <div
                className="p-4 pb-3 flex items-center justify-between"
                style={{ borderBottom: '1px solid var(--riscv-border)' }}
              >
                <div className="flex items-center gap-2">
                  <Info size={14} style={{ color: 'var(--riscv-text-3)' }} />
                  <h2
                    className="text-[12px] font-semibold uppercase tracking-widest"
                    style={{ color: 'var(--riscv-text-3)' }}
                  >
                    Selected Details
                  </h2>
                </div>
                {/*
                  Dismiss. Was lg:hidden, from when the panel was permanently
                  open on desktop and there was nothing to dismiss it to. Now
                  that it collapses and the catalogue reclaims the width, a
                  desktop reader needs the same way out as a mobile one.

                  Themed rather than slate-*: those literals only ever resolved
                  correctly against the dark surface it used to sit on.
                */}
                <button
                  type="button"
                  onClick={() => {
                    setSelectedExt(null);
                    setSelectedInstruction(null);
                  }}
                  aria-label="Close details panel"
                  title="Close (Esc)"
                  className="p-1 rounded-md transition-colors riscv-panel-dismiss"
                >
                  <X size={16} />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto overscroll-contain p-4 pt-3">
                {selectedExt ? (
                  <div className="animate-in fade-in slide-in-from-right-4 duration-300">
                    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <a
                          href={selectedExt.url || 'https://github.com/riscv/riscv-isa-manual'}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-start gap-1 font-black tracking-tight break-words hover:opacity-80"
                          style={{
                            fontSize: '1.5rem',
                            lineHeight: 1.2,
                            color: 'var(--riscv-gold)',
                          }}
                          data-tooltip="Open reference link"
                        >
                          <span>{selectedExt.name}</span>
                          <ArrowUpRight size={15} className="mt-1 shrink-0 opacity-70" />
                        </a>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        {/* Ratification status. Without this, a proposal such as
                            Zvabd reads exactly as settled as Zbb, which is the
                            same hazard as publishing a withdrawn encoding: the
                            reader cannot tell what is real.

                            "Unconfirmed" rather than "unratified" is deliberate.
                            It means our sources are silent, not that we know the
                            extension was rejected. Zvabd, Zibi and Zvfofp8min are
                            absent from both riscv-unified-db and riscv-opcodes;
                            RV32E and RV64E are simply not modelled in UDB. Those
                            are different situations and neither warrants a claim
                            we cannot source. */}
                        {(() => {
                          const state = selectedExt.state;
                          const hasInstructions =
                            Object.keys(selectedExt.instructions || {}).length > 0;
                          if (!state && !hasInstructions) return null;

                          const ratified = state === 'ratified';
                          const label = ratified
                            ? `Ratified${selectedExt.ratification_date ? ` ${selectedExt.ratification_date}` : ''}`
                            : state
                              ? state.charAt(0).toUpperCase() + state.slice(1)
                              : 'Status unconfirmed';
                          const tip = ratified
                            ? // Deliberately does not name a source. Most states
                              // are synced from riscv-unified-db, but not all:
                              // UDB has no E extension and no RV128, so RV32E,
                              // RV64E and RV128I carry states set here against
                              // the specification itself. Crediting UDB for
                              // those would be a false claim about provenance —
                              // the same mistake as RV128I inheriting I's
                              // ratification. The linked chapter is the source
                              // a reader can actually check.
                              'Ratified — see the linked specification chapter'
                            : state
                              ? `Reported as ${state}; see the linked specification chapter`
                              : 'Neither riscv-unified-db nor riscv-opcodes describes this extension, so its status could not be confirmed';
                          return (
                            <span
                              title={tip}
                              className="px-2 py-1 rounded-md text-[11px] font-mono uppercase tracking-wide border whitespace-nowrap"
                              style={
                                ratified
                                  ? {
                                      background: 'var(--riscv-check-fill)',
                                      color: 'var(--riscv-check)',
                                      borderColor: 'var(--riscv-check-edge)',
                                    }
                                  : {
                                      background: 'var(--riscv-gold-dim)',
                                      color: 'var(--riscv-gold)',
                                      borderColor: 'rgba(245,197,66,0.35)',
                                    }
                              }
                            >
                              {label}
                            </span>
                          );
                        })()}
                        {selectedExt.discontinued === 1 && (
                          <span
                            className="px-2 py-1 rounded-md text-[11px] font-mono uppercase tracking-wide border"
                            style={{
                              background: 'var(--riscv-report-tint)',
                              color: 'var(--riscv-danger)',
                              borderColor: 'var(--riscv-report-edge)',
                            }}
                          >
                            Discontinued
                          </span>
                        )}
                        {selectedExt.isSandbox && (
                          <span
                            className="px-2 py-1 rounded-md text-[11px] font-mono uppercase tracking-wide border whitespace-nowrap"
                            style={{
                              background: 'rgba(59,130,246,0.15)',
                              color: 'var(--riscv-accent-4, #60a5fa)',
                              borderColor: 'rgba(59,130,246,0.4)',
                            }}
                          >
                            Custom (Sandbox)
                          </span>
                        )}
                        {/* The address bar already carries ?ext=<id>, but a
                            button is the discoverable route and works on mobile,
                            where copying the URL is fiddly. */}
                        <button
                          type="button"
                          onClick={copyPermalink}
                          aria-label={`Copy a link to ${selectedExt.id}`}
                          title={`Copy a link to ${selectedExt.id}`}
                          className="riscv-btn inline-flex items-center gap-1 px-2 py-1 text-[11px]"
                        >
                          <Link2 size={12} />
                          {permalinkCopied ? 'Copied' : 'Link'}
                        </button>
                        {selectedExt.isSandbox && (
                          <button
                            type="button"
                            onClick={() => setSandboxOpen(true)}
                            aria-label="Edit this extension in the sandbox"
                            title="Edit this extension in the sandbox"
                            className="riscv-btn inline-flex items-center gap-1 px-2 py-1 text-[11px]"
                            style={{
                              borderColor: 'rgba(59,130,246,0.4)',
                              color: 'var(--riscv-accent-4, #60a5fa)',
                            }}
                          >
                            <FlaskConical size={12} />
                            <span>Edit in Sandbox</span>
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="space-y-6">
                      <div>
                        <h4
                          className="text-[11px] uppercase tracking-widest font-semibold mb-1.5"
                          style={{ color: 'var(--riscv-text-3)' }}
                        >
                          Description
                        </h4>
                        <p
                          className="text-sm leading-relaxed"
                          style={{ color: 'var(--riscv-text)' }}
                        >
                          {selectedExt.desc}
                        </p>
                      </div>

                      <div className="riscv-card-2 p-3 rounded-lg">
                        <h4
                          className="text-[11px] uppercase tracking-widest font-semibold mb-2 flex items-center gap-1"
                          style={{ color: 'var(--riscv-violet)' }}
                        >
                          <ArrowRight size={10} /> Use Case
                        </h4>
                        <p className="text-sm italic" style={{ color: 'var(--riscv-text-2)' }}>
                          {selectedExt.use}
                        </p>
                      </div>

                      {/* Instruction list, when available */}
                      {searchMatches &&
                        searchMatches.extId === selectedExt.id &&
                        searchMatches.query === searchQuery.trim().toLowerCase() &&
                        searchMatches.mnemonics.length > 0 && (
                          <div className="bg-slate-900 p-3 rounded border border-slate-700">
                            <div className="flex items-center justify-between gap-3">
                              <div className="min-w-0">
                                <div className="text-[11px] uppercase tracking-wider text-yellow-300 font-bold mb-0.5">
                                  Search Hits ({searchMatches.mnemonics.length})
                                </div>
                                <div className="text-[12px] font-mono text-slate-200 truncate">
                                  {searchMatches.mnemonics[searchMatches.index] || ''}
                                  <span className="ml-2 text-slate-500">
                                    ({searchMatches.index + 1}/{searchMatches.mnemonics.length})
                                  </span>
                                </div>
                              </div>

                              <div className="flex items-center gap-2 shrink-0">
                                <button
                                  type="button"
                                  className="px-2 py-1 rounded border border-slate-600 bg-slate-800 text-[11px] font-mono text-slate-100 disabled:opacity-40"
                                  onClick={() => {
                                    setSearchMatches((current) => {
                                      if (!current || current.extId !== selectedExt.id)
                                        return current;
                                      const nextIndex =
                                        (current.index - 1 + current.mnemonics.length) %
                                        current.mnemonics.length;
                                      const mnemonic = current.mnemonics[nextIndex];
                                      selectInstructionByMnemonic(selectedExt, mnemonic);
                                      return { ...current, index: nextIndex };
                                    });
                                  }}
                                  disabled={searchMatches.mnemonics.length < 2}
                                >
                                  Prev
                                </button>
                                <button
                                  type="button"
                                  className="px-2 py-1 rounded border border-slate-600 bg-slate-800 text-[11px] font-mono text-slate-100 disabled:opacity-40"
                                  onClick={() => {
                                    setSearchMatches((current) => {
                                      if (!current || current.extId !== selectedExt.id)
                                        return current;
                                      const nextIndex =
                                        (current.index + 1) % current.mnemonics.length;
                                      const mnemonic = current.mnemonics[nextIndex];
                                      selectInstructionByMnemonic(selectedExt, mnemonic);
                                      return { ...current, index: nextIndex };
                                    });
                                  }}
                                  disabled={searchMatches.mnemonics.length < 2}
                                >
                                  Next
                                </button>
                              </div>
                            </div>
                          </div>
                        )}

                      {Object.keys(selectedExt.instructions || {}).length > 0 && (
                        <div className="bg-slate-900 p-3 rounded border border-slate-700">
                          <h4 className="text-[11px] uppercase tracking-wider text-emerald-400 font-bold mb-2">
                            Instruction Set Snapshot (
                            {Object.keys(selectedExt.instructions || {}).length})
                          </h4>
                          <div className="flex flex-wrap gap-1">
                            {Object.keys(selectedExt.instructions || {}).map((mnemonic) => {
                              const q = searchQuery.trim().toLowerCase();
                              const instructionDetails = selectedExt.instructions?.[mnemonic];
                              const isHit =
                                q.length &&
                                (mnemonic.toLowerCase().includes(q) ||
                                  instructionMatchesQuery(mnemonic, instructionDetails, q));
                              const isActive = selectedInstruction?.mnemonic === mnemonic;
                              const isClickable = Boolean(instructionDetails);
                              const isDeprecated = Boolean(instructionDetails?.deprecated);
                              return (
                                <span key={mnemonic} className="inline-flex items-center">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      if (!isClickable) return;
                                      setSelectedInstruction(
                                        isActive ? null : { mnemonic, ...instructionDetails },
                                      );
                                      setSearchMatches((current) => {
                                        if (
                                          !current ||
                                          current.extId !== selectedExt.id ||
                                          current.query !== searchQuery.trim().toLowerCase()
                                        ) {
                                          return current;
                                        }
                                        const idx = current.mnemonics.indexOf(mnemonic);
                                        if (idx === -1) return current;
                                        return { ...current, index: idx };
                                      });
                                    }}
                                    className={`px-1.5 py-0.5 rounded-l border text-[11px] font-mono tracking-tight ${
                                      isActive
                                        ? isDeprecated
                                          ? 'border-red-400 bg-red-500/10 text-red-200'
                                          : 'border-emerald-400 bg-emerald-500/10 text-emerald-200'
                                        : isHit
                                          ? 'border-yellow-400 bg-yellow-500/10 text-yellow-200'
                                          : isDeprecated
                                            ? 'border-red-500/60 bg-red-500/5 text-red-200'
                                            : 'border-slate-700 bg-slate-800/70'
                                    }`}
                                    title={
                                      isClickable
                                        ? `View details for ${mnemonic}`
                                        : `${mnemonic} (no details yet)`
                                    }
                                    disabled={!isClickable}
                                  >
                                    {mnemonic}
                                  </button>
                                  {/* Gated on compareMode like the tile pin, the
                                      profile pin and the tray. Without it a
                                      reader with Compare OFF could pin an
                                      instruction — the chip lit up and the URL
                                      gained ?cmp=i:… — while the tray stayed
                                      hidden, so nothing could open the
                                      comparison they had just built. */}
                                  {compareMode &&
                                    isClickable &&
                                    (() => {
                                      const pinned = compareInstrKeys.has(
                                        instructionKey(selectedExt.id, mnemonic),
                                      );
                                      return (
                                        <button
                                          type="button"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            toggleCompareInstruction(selectedExt.id, mnemonic);
                                          }}
                                          aria-pressed={pinned}
                                          className="riscv-pin-btn px-1 py-0.5 rounded-r border-l-0 text-[11px] inline-flex items-center justify-center transition-all"
                                          title={
                                            pinned
                                              ? `Remove ${mnemonic} from comparison`
                                              : `Compare ${mnemonic}`
                                          }
                                        >
                                          <GitCompare size={9} strokeWidth={pinned ? 2.5 : 2} />
                                        </button>
                                      );
                                    })()}
                                </span>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {selectedExt.csrs && Object.keys(selectedExt.csrs).length > 0 && (
                        <div className="bg-slate-900 p-3 rounded border border-slate-700">
                          <h4 className="text-[11px] uppercase tracking-wider text-sky-300 font-bold mb-2">
                            {extensionCsrLabels[selectedExt.id] || 'CSRs'} (
                            {Object.keys(selectedExt.csrs).length})
                          </h4>
                          <div className="flex flex-wrap gap-1">
                            {Object.keys(selectedExt.csrs)
                              .sort()
                              .map((name) => {
                                const csr = selectedExt.csrs[name] || {};
                                // Address and description are what identify a CSR;
                                // both ride along in the catalogue entry.
                                const tip = [
                                  csr.desc,
                                  csr.address,
                                  csr.priv_mode && `${csr.priv_mode}-mode`,
                                ]
                                  .filter(Boolean)
                                  .join(' · ');
                                return (
                                  <span
                                    key={name}
                                    title={tip || undefined}
                                    className="px-1.5 py-0.5 rounded border border-slate-700 bg-slate-800/70 text-[11px] font-mono text-slate-200"
                                  >
                                    {name.toUpperCase()}
                                  </span>
                                );
                              })}
                          </div>
                        </div>
                      )}

                      {selectedInstruction && (
                        <div className="bg-slate-900 p-3 rounded border border-slate-700">
                          <div className="flex items-start justify-between gap-3 mb-2">
                            <h4 className="text-[11px] uppercase tracking-wider text-purple-300 font-bold flex items-center gap-1">
                              <ArrowRight size={10} /> Instruction Details
                              {/* Some extensions define no new opcode: they name a
                                  specific encoding of an existing instruction. PAUSE is
                                  a FENCE, NTL.* are ADDs, RDCYCLE is a CSRRS. Saying so
                                  explains why the encoding below looks like something
                                  else, and why the validator reports an overlap. */}
                              {selectedInstruction.alias_of && (
                                <span
                                  className="ml-1 px-1.5 py-0.5 rounded font-mono normal-case tracking-normal text-[10px]"
                                  style={{
                                    background: 'var(--riscv-tint-3)',
                                    color: 'var(--riscv-text-2)',
                                    border: '1px solid var(--riscv-tint-4)',
                                  }}
                                  title={`Defines no new opcode: this is a specific encoding of ${selectedInstruction.alias_of}`}
                                >
                                  alias of {selectedInstruction.alias_of}
                                </span>
                              )}
                            </h4>
                            <div className="flex items-center gap-2">
                              {(() => {
                                const isPinned = compareInstrKeys.has(
                                  instructionKey(selectedExt.id, selectedInstruction.mnemonic),
                                );
                                return (
                                  <button
                                    type="button"
                                    aria-pressed={isPinned}
                                    className="inline-flex items-center gap-1 px-2 py-1 riscv-btn tooltip-align-right"
                                    style={
                                      isPinned
                                        ? {
                                            background: 'var(--riscv-violet-dim)',
                                            color: 'var(--riscv-violet)',
                                            borderColor: 'rgba(139, 124, 248, 0.4)',
                                          }
                                        : undefined
                                    }
                                    onClick={() => {
                                      toggleCompareInstruction(
                                        selectedExt.id,
                                        selectedInstruction.mnemonic,
                                      );
                                      if (!compareMode) setCompareMode(true);
                                    }}
                                    data-tooltip={
                                      isPinned ? 'Remove from comparison' : 'Pin to comparison'
                                    }
                                  >
                                    <GitCompare
                                      size={12}
                                      style={{
                                        color: isPinned ? 'var(--riscv-violet)' : 'inherit',
                                        opacity: isPinned ? 1 : 0.7,
                                      }}
                                    />
                                    {isPinned ? 'Pinned' : 'Compare'}
                                  </button>
                                );
                              })()}
                              <button
                                type="button"
                                className="inline-flex items-center gap-1 px-2 py-1 riscv-btn tooltip-align-right"
                                onClick={async () => {
                                  const text = formatInstructionForClipboard(
                                    selectedExt,
                                    selectedInstruction,
                                  );
                                  const ok = await copyTextToClipboard(text);
                                  setCopyStatus(ok ? 'copied' : 'failed');
                                  if (ok) showToast('Copied instruction details!');
                                  if (copyStatusTimerRef.current)
                                    window.clearTimeout(copyStatusTimerRef.current);
                                  copyStatusTimerRef.current = window.setTimeout(() => {
                                    copyStatusTimerRef.current = null;
                                    setCopyStatus(null);
                                  }, 1500);
                                }}
                                data-tooltip="Copy extension + instruction details"
                              >
                                <Copy size={12} />
                                {copyStatus === 'copied'
                                  ? 'Copied'
                                  : copyStatus === 'failed'
                                    ? 'Copy failed'
                                    : 'Copy'}
                              </button>
                              {/* Expand to full-screen detail view */}
                              <button
                                type="button"
                                className="inline-flex items-center gap-1 px-2 py-1 riscv-btn riscv-btn-violet tooltip-align-right"
                                onClick={() => setInstructionExpandOpen(true)}
                                data-tooltip="Expand instruction details to full view"
                                aria-label="Expand instruction details to full view"
                              >
                                <Maximize2 size={12} />
                                Expand
                              </button>
                              <button
                                type="button"
                                className="text-[11px] font-mono text-slate-500 hover:text-slate-300"
                                onClick={() => setSelectedInstruction(null)}
                              >
                                Close
                              </button>
                            </div>
                          </div>

                          <div className="mb-3 flex items-start justify-between gap-2">
                            <div className="text-white font-black tracking-tight text-xl">
                              {selectedInstruction.mnemonic}
                            </div>
                            {selectedInstruction.deprecated && (
                              <span className="shrink-0 px-2 py-1 rounded-md text-[11px] font-mono uppercase tracking-wide border bg-red-950/40 text-red-200 border-red-600/60">
                                Discontinued
                              </span>
                            )}
                          </div>

                          <div className="space-y-3">
                            <div>
                              <div className="text-[11px] uppercase tracking-wider text-slate-500 font-bold mb-1">
                                Encoding
                              </div>
                              <EncodingDiagram encoding={selectedInstruction.encoding} />
                              <div className="mt-1 text-[11px] text-slate-500">
                                Fixed bits are <span className="font-mono">0/1</span>, variable bits
                                are <span className="font-mono">x</span>.
                              </div>
                            </div>

                            <div>
                              <div className="text-[11px] uppercase tracking-wider text-slate-500 font-bold mb-1">
                                Variable Fields
                              </div>
                              <div className="flex flex-wrap gap-1">
                                {(selectedInstruction.variable_fields || []).map((field) => (
                                  <span
                                    key={field}
                                    className="px-1.5 py-0.5 rounded border border-slate-700 bg-slate-800/70 text-[11px] font-mono text-slate-200"
                                  >
                                    {field}
                                  </span>
                                ))}
                              </div>
                            </div>

                            <div className="grid grid-cols-2 gap-2">
                              <div>
                                <div className="text-[11px] uppercase tracking-wider text-slate-500 font-bold mb-1">
                                  Match
                                </div>
                                <div
                                  className={`font-mono text-[12px] text-slate-100 bg-slate-800/70 border rounded px-2 py-1 ${
                                    searchQuery.trim().length &&
                                    String(selectedInstruction.match || '')
                                      .toLowerCase()
                                      .includes(searchQuery.trim().toLowerCase())
                                      ? 'border-yellow-400 bg-yellow-500/10'
                                      : 'border-slate-700'
                                  }`}
                                >
                                  {selectedInstruction.match}
                                </div>
                              </div>
                              <div>
                                <div className="text-[11px] uppercase tracking-wider text-slate-500 font-bold mb-1">
                                  Mask
                                </div>
                                <div
                                  className={`font-mono text-[12px] text-slate-100 bg-slate-800/70 border rounded px-2 py-1 ${
                                    searchQuery.trim().length &&
                                    String(selectedInstruction.mask || '')
                                      .toLowerCase()
                                      .includes(searchQuery.trim().toLowerCase())
                                      ? 'border-yellow-400 bg-yellow-500/10'
                                      : 'border-slate-700'
                                  }`}
                                >
                                  {selectedInstruction.mask}
                                </div>
                              </div>
                            </div>

                            {compressedMapping && (
                              <div className="rounded border border-slate-700 bg-slate-950/50 p-3">
                                <div className="text-[11px] uppercase tracking-wider text-cyan-300 font-bold mb-2">
                                  Compressed Mapping
                                </div>
                                <div className="space-y-2">
                                  <div>
                                    <div className="text-[11px] uppercase tracking-wider text-slate-500 font-bold mb-1">
                                      Compressed
                                    </div>
                                    <div className="font-mono text-[12px] text-slate-100 bg-slate-800/70 border border-slate-700 rounded px-2 py-1">
                                      {compressedMapping.compressed}
                                    </div>
                                  </div>
                                  <div>
                                    <div className="text-[11px] uppercase tracking-wider text-slate-500 font-bold mb-1">
                                      Standard Equivalent
                                    </div>
                                    {hasStandardEquivalent ? (
                                      <button
                                        type="button"
                                        className="w-full text-left font-mono text-[12px] text-slate-100 bg-slate-800/70 border border-slate-700 rounded px-2 py-1 hover:border-cyan-400/60"
                                        onClick={() =>
                                          selectStandardEquivalent(standardEquivalentMnemonic)
                                        }
                                        data-tooltip="Open standard instruction details"
                                      >
                                        <span className="inline-flex items-center gap-1">
                                          {compressedMapping.standard}
                                          <ArrowUpRight size={12} className="opacity-70" />
                                        </span>
                                      </button>
                                    ) : (
                                      <div className="font-mono text-[12px] text-slate-100 bg-slate-800/70 border border-slate-700 rounded px-2 py-1">
                                        {compressedMapping.standard}
                                      </div>
                                    )}
                                  </div>
                                  <div>
                                    <div className="text-[11px] uppercase tracking-wider text-slate-500 font-bold mb-1">
                                      Equivalent Instruction
                                    </div>
                                    {standardEquivalentMnemonic ? (
                                      hasStandardEquivalent ? (
                                        <button
                                          type="button"
                                          className="inline-flex items-center gap-1 text-[12px] font-mono text-cyan-200 hover:text-cyan-100 underline"
                                          onClick={() =>
                                            selectStandardEquivalent(standardEquivalentMnemonic)
                                          }
                                          data-tooltip="Open standard instruction details"
                                        >
                                          {standardEquivalentMnemonic}
                                          <ArrowUpRight size={12} className="opacity-70" />
                                        </button>
                                      ) : (
                                        <div className="text-[12px] text-slate-500 font-mono">
                                          {standardEquivalentMnemonic}
                                        </div>
                                      )
                                    ) : (
                                      <div className="text-[12px] text-slate-500">Unavailable</div>
                                    )}
                                  </div>
                                  <div>
                                    <div className="text-[11px] uppercase tracking-wider text-slate-500 font-bold mb-1">
                                      Description
                                    </div>
                                    <div className="text-[12px] text-slate-200">
                                      {compressedMapping.description}
                                    </div>
                                  </div>
                                </div>
                              </div>
                            )}

                            {compressedEquivalents.length > 0 && (
                              <div className="rounded border border-slate-700 bg-slate-950/40 p-3">
                                <div className="text-[11px] uppercase tracking-wider text-emerald-300 font-bold mb-2">
                                  Compressed Equivalents
                                </div>
                                <div className="space-y-2">
                                  {compressedEquivalents.map((entry) => (
                                    <button
                                      key={entry.mnemonic}
                                      type="button"
                                      className="w-full text-left rounded border border-slate-700 bg-slate-900/60 px-2 py-1.5 hover:border-emerald-400/60"
                                      onClick={() => selectCompressedEquivalent(entry.mnemonic)}
                                      data-tooltip={`Open ${entry.mnemonic} details`}
                                    >
                                      <div className="flex items-center gap-1 text-[12px] font-mono text-emerald-200">
                                        {normalizeMnemonicKey(entry.mnemonic)}
                                        <ArrowUpRight size={12} className="opacity-70" />
                                      </div>
                                      <div className="text-[11px] font-mono text-slate-400">
                                        {entry.compressed}
                                      </div>
                                    </button>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      )}

                      {activeProfile && (
                        <div
                          className={`
                      mt-4 p-3 rounded text-xs flex items-center gap-2 border
                      ${
                        isHighlighted(selectedExt.id)
                          ? 'bg-yellow-900/20 border-yellow-700/30 text-yellow-200'
                          : 'bg-slate-800 border-slate-700 text-slate-500'
                      }
                    `}
                        >
                          {isHighlighted(selectedExt.id) ? (
                            <>
                              <div className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
                              Required in <strong>{activeProfile}</strong>
                            </>
                          ) : (
                            <>
                              <div className="w-1.5 h-1.5 rounded-full bg-slate-600" />
                              Not required in {activeProfile}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div
                    className="h-[300px] flex flex-col items-center justify-center text-center space-y-3"
                    style={{ color: 'var(--riscv-text-3)' }}
                  >
                    <div
                      className="p-4 rounded-full"
                      style={{
                        background: 'var(--riscv-surface-2)',
                        border: '1px solid var(--riscv-border-2)',
                      }}
                    >
                      <CircuitBoard size={28} style={{ color: 'var(--riscv-muted)' }} />
                    </div>
                    <div>
                      <p
                        className="text-xs font-medium mb-1"
                        style={{ color: 'var(--riscv-text-2)' }}
                      >
                        No Extension Selected
                      </p>
                      <p
                        className="text-[12px] max-w-[160px] mx-auto"
                        style={{ color: 'var(--riscv-text-3)' }}
                      >
                        Click any tile to explore specifications, encodings &amp; profiles.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ─── Footer ─────────────────────────────────────────────────── */}
        <footer
          className="mt-10 pb-8 flex flex-col sm:flex-row items-center justify-center gap-x-3 gap-y-2 text-[12px]"
          style={{
            borderTop: '1px solid var(--riscv-border)',
            paddingTop: '1.5rem',
            color: 'var(--riscv-text-3)',
          }}
        >
          <div className="flex items-center gap-2">
            <RiscvLogo height="14px" />
            <span className="font-semibold" style={{ color: 'var(--riscv-text-2)' }}>
              ISA Explorer
            </span>
            <span style={{ color: 'var(--riscv-border-2)' }}>·</span>
            <span>
              Data sourced from{' '}
              <a
                href="https://github.com/riscv/riscv-unified-db"
                target="_blank"
                rel="noreferrer noopener"
                className="hover:underline"
                style={{ color: 'var(--riscv-violet)' }}
              >
                riscv/riscv-unified-db
              </a>
            </span>
          </div>
          <div className="flex items-center gap-3">
            <a
              href="https://github.com/riscv/riscv-unified-db"
              target="_blank"
              rel="noreferrer noopener"
              className="hover:opacity-80 tooltip-align-right"
              style={{ color: 'var(--riscv-text-2)' }}
              data-tooltip="View riscv-unified-db on GitHub"
              aria-label="View riscv-unified-db on GitHub"
            >
              <BookOpen size={14} />
            </a>
          </div>
        </footer>
      </div>

      {encodingMapMounted && (
        <React.Suspense fallback={null}>
          <EncodingMap
            open={encodingMapOpen}
            onClose={() => setEncodingMapOpen(false)}
            catalog={allExtensionsFlat}
            sandboxExtensions={sandboxExtensions}
            onSelectExtension={(id) => {
              const target = allExtsList.find((e) => e && e.id === id);
              if (target) handleSelectExt(target);
            }}
            onOpenSandbox={() => {
              setEncodingMapOpen(false);
              setSandboxOpen(true);
            }}
          />
        </React.Suspense>
      )}

      <CompareTray
        extIds={compareExtIds}
        instrKeys={compareInstrKeys}
        profileNames={compareProfileNames}
        visible={compareMode}
        kind={compareKind}
        onKindChange={setCompareKind}
        onRemove={removeCompareItem}
        onClear={clearCompare}
        onOpen={openCompareView}
      />

      <CompareView
        open={compareOpen}
        model={compareModel}
        onClose={closeCompareView}
        onRemoveItem={removeCompareItem}
        onCopyMarkdown={copyCompareMarkdown}
        onCopyLink={copyCompareLink}
        expandDeps={compareExpandDeps}
        onToggleExpandDeps={setCompareExpandDeps}
      />

      {evolutionOpen && (
        <div className="fixed inset-0 z-50">
          <div
            className="absolute inset-0"
            style={{ background: 'rgba(7,7,14,0.85)', backdropFilter: 'blur(4px)' }}
            onClick={() => setEvolutionOpen(false)}
            role="presentation"
          />

          <div className="absolute inset-0 p-3 md:p-6 flex items-start justify-center overflow-y-auto">
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="evolution-title"
              className="animate-scale-in w-full max-w-6xl riscv-card overflow-hidden"
              style={{ boxShadow: '0 0 60px rgba(0,0,0,0.8), 0 0 0 1px rgba(139,124,248,0.15)' }}
            >
              <div
                className="p-4 flex items-start justify-between gap-3"
                style={{ borderBottom: '1px solid var(--riscv-border)' }}
              >
                <div>
                  <h3
                    id="evolution-title"
                    className="text-[13px] font-semibold uppercase tracking-widest"
                    style={{ color: 'var(--riscv-text-2)' }}
                  >
                    How the ISA was built
                  </h3>
                  <p className="text-[12px] mt-1" style={{ color: 'var(--riscv-text-3)' }}>
                    {`How fast the ISA grew, and when each of the ${allExtensionsFlat.length} catalogued extensions arrived.`}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setEvolutionOpen(false)}
                  aria-label="Close the evolution panel"
                  title="Close (Esc)"
                  className="p-1 rounded-md transition-colors riscv-panel-dismiss"
                >
                  <X size={16} />
                </button>
              </div>

              <div className="p-4">
                <React.Suspense fallback={null}>
                  <ExtensionEvolution
                    catalog={extensions}
                    onSelect={(id) => {
                      const found = Object.values(extensions)
                        .flat()
                        .find((e) => e && e.id === id);
                      if (found) {
                        handleSelectExt(found);
                        // Close on pick: the reader asked for that extension, and
                        // the details panel is behind this dialog.
                        setEvolutionOpen(false);
                      }
                    }}
                  />
                </React.Suspense>
              </div>
            </div>
          </div>
        </div>
      )}

      {aboutOpen && (
        <div className="fixed inset-0 z-50">
          <div
            className="absolute inset-0"
            style={{ background: 'rgba(7,7,14,0.85)', backdropFilter: 'blur(4px)' }}
            onClick={() => setAboutOpen(false)}
            role="presentation"
          />

          <div className="absolute inset-0 p-3 md:p-8 flex items-start justify-center overflow-y-auto">
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="about-title"
              className="animate-scale-in w-full max-w-xl riscv-card overflow-hidden"
              style={{ boxShadow: '0 0 60px rgba(0,0,0,0.8), 0 0 0 1px rgba(139,124,248,0.15)' }}
            >
              <div
                className="p-4 flex items-start justify-between gap-3"
                style={{ borderBottom: '1px solid var(--riscv-border)' }}
              >
                <h3
                  id="about-title"
                  className="font-bold flex items-center gap-2"
                  style={{ color: 'var(--riscv-text)', fontSize: '14px' }}
                >
                  <Info size={15} style={{ color: 'var(--riscv-violet)' }} />
                  <span>About RISC-V ISA Explorer</span>
                </h3>
                <button
                  type="button"
                  className="riscv-btn p-1.5"
                  onClick={() => setAboutOpen(false)}
                  aria-label="Close"
                  autoFocus
                >
                  <X size={14} />
                </button>
              </div>

              <div
                className="p-4 text-[13px] leading-relaxed"
                style={{ color: 'var(--riscv-text-2)' }}
              >
                <p>
                  Browse every ratified RISC-V extension, its instructions and their encodings.{' '}
                  <span style={{ color: 'var(--riscv-text-3)' }}>
                    Select a tile for details, filter by profile or manual volume, and turn on{' '}
                    <strong style={{ color: 'var(--riscv-text-2)', fontWeight: 600 }}>
                      ISA Builder
                    </strong>{' '}
                    to assemble a configuration and get a validated{' '}
                    <code style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.95em' }}>
                      -march
                    </code>{' '}
                    string.{' '}
                    <strong style={{ color: 'var(--riscv-text-2)', fontWeight: 600 }}>
                      Compare
                    </strong>{' '}
                    puts extensions, instructions or profiles side by side.
                  </span>
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {encoderValidatorOpen && (
        <div className="fixed inset-0 z-50">
          <div
            className="absolute inset-0"
            style={{ background: 'rgba(7,7,14,0.85)', backdropFilter: 'blur(4px)' }}
            onClick={() => setEncoderValidatorOpen(false)}
            role="presentation"
          />

          <div className="absolute inset-0 p-3 md:p-8 flex items-start justify-center overflow-y-auto">
            <div
              ref={encoderDialogRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="encoder-validator-title"
              aria-describedby="encoder-validator-desc"
              className="animate-scale-in w-full max-w-3xl riscv-card overflow-hidden"
              style={{ boxShadow: '0 0 60px rgba(0,0,0,0.8), 0 0 0 1px rgba(139,124,248,0.15)' }}
            >
              <div
                className="p-4 flex items-start justify-between gap-3"
                style={{ borderBottom: '1px solid var(--riscv-border)' }}
              >
                <div className="min-w-0">
                  <h3
                    id="encoder-validator-title"
                    className="font-bold flex items-center gap-2"
                    style={{ color: 'var(--riscv-text)', fontSize: '14px' }}
                  >
                    <ScanSearch size={15} style={{ color: 'var(--riscv-violet)' }} />
                    <span>Encoder Validator</span>
                  </h3>
                  <p
                    id="encoder-validator-desc"
                    className="text-[12px] mt-1"
                    style={{ color: 'var(--riscv-text-3)' }}
                  >
                    Enter a 32-bit encoding (0/1/-) or Match+Mask (hex). Detects overlaps against
                    the full ISA database.
                  </p>
                </div>

                <button
                  type="button"
                  className="riscv-btn p-1.5"
                  onClick={() => setEncoderValidatorOpen(false)}
                  data-tooltip="Close"
                  aria-label="Close encoder validator"
                >
                  <X size={15} />
                </button>
              </div>

              <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-3">
                  <div>
                    <div
                      className="text-[11px] uppercase tracking-widest font-semibold mb-1.5"
                      style={{ color: 'var(--riscv-text-3)' }}
                    >
                      Proposed Mnemonic <span style={{ fontWeight: 400 }}>(optional)</span>
                    </div>
                    <input
                      type="text"
                      value={encoderValidatorInput.mnemonic}
                      onChange={(e) =>
                        setEncoderValidatorInput((prev) => ({ ...prev, mnemonic: e.target.value }))
                      }
                      placeholder="e.g. MYOP"
                      className="riscv-input w-full px-3 py-2 text-sm font-mono"
                    />
                  </div>

                  <div>
                    <div
                      className="text-[11px] uppercase tracking-widest font-semibold mb-1.5"
                      style={{ color: 'var(--riscv-text-3)' }}
                    >
                      Encoding <span style={{ fontWeight: 400 }}>(required if no match/mask)</span>
                    </div>
                    <input
                      type="text"
                      value={encoderValidatorInput.encoding}
                      onChange={(e) =>
                        setEncoderValidatorInput((prev) => ({ ...prev, encoding: e.target.value }))
                      }
                      placeholder="-----------------000-----1100111"
                      className="riscv-input w-full px-3 py-2 text-sm font-mono"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <div
                        className="text-[11px] uppercase tracking-widest font-semibold mb-1.5"
                        style={{ color: 'var(--riscv-text-3)' }}
                      >
                        Match (hex)
                      </div>
                      <input
                        type="text"
                        value={encoderValidatorInput.match}
                        onChange={(e) =>
                          setEncoderValidatorInput((prev) => ({ ...prev, match: e.target.value }))
                        }
                        placeholder="0x67"
                        className="riscv-input w-full px-3 py-2 text-sm font-mono"
                      />
                    </div>
                    <div>
                      <div
                        className="text-[11px] uppercase tracking-widest font-semibold mb-1.5"
                        style={{ color: 'var(--riscv-text-3)' }}
                      >
                        Mask (hex)
                      </div>
                      <input
                        type="text"
                        value={encoderValidatorInput.mask}
                        onChange={(e) =>
                          setEncoderValidatorInput((prev) => ({ ...prev, mask: e.target.value }))
                        }
                        placeholder="0x707f"
                        className="riscv-input w-full px-3 py-2 text-sm font-mono"
                      />
                    </div>
                  </div>

                  <div className="flex items-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={runEncoderValidation}
                      className="riscv-btn riscv-btn-violet inline-flex items-center gap-2 px-4 py-2 text-[12px]"
                    >
                      <ScanSearch size={14} />
                      Validate
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setEncoderValidatorInput({
                          mnemonic: '',
                          encoding: '',
                          match: '',
                          mask: '',
                        });
                        setEncoderValidatorResult(null);
                        setEncoderValidatorCopyStatus(null);
                      }}
                      className="riscv-btn px-3 py-2 text-[12px]"
                    >
                      Reset
                    </button>
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div
                      className="text-[11px] uppercase tracking-widest font-semibold"
                      style={{ color: 'var(--riscv-text-3)' }}
                    >
                      Results
                    </div>
                    <button
                      type="button"
                      disabled={!encoderValidatorResult?.proposed}
                      onClick={async () => {
                        if (!encoderValidatorResult?.proposed) return;
                        setEncoderValidatorCopyStatus(null);
                        const report = formatEncoderValidatorReport(
                          encoderValidatorResult.proposed,
                          encoderValidatorResult,
                        );
                        const ok = await copyTextToClipboard(report);
                        setEncoderValidatorCopyStatus(ok ? 'copied' : 'failed');
                        if (ok) showToast('Copied validation report!');
                        if (encoderCopyTimerRef.current)
                          window.clearTimeout(encoderCopyTimerRef.current);
                        encoderCopyTimerRef.current = window.setTimeout(() => {
                          encoderCopyTimerRef.current = null;
                          setEncoderValidatorCopyStatus(null);
                        }, 1500);
                      }}
                      className="riscv-btn inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] disabled:opacity-30"
                      data-tooltip="Copy validation report"
                    >
                      <Copy size={12} />
                      {encoderValidatorCopyStatus === 'copied'
                        ? 'Copied!'
                        : encoderValidatorCopyStatus === 'failed'
                          ? 'Failed'
                          : 'Copy report'}
                    </button>
                  </div>

                  {!encoderValidatorResult ? (
                    <div
                      className="text-[12px] rounded-lg p-3"
                      style={{
                        background: 'var(--riscv-surface-2)',
                        border: '1px solid var(--riscv-border-2)',
                        color: 'var(--riscv-text-3)',
                      }}
                    >
                      Enter a proposed encoding and click Validate.
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {encoderValidatorResult.errors.length > 0 && (
                        <div className="border border-red-800/40 bg-red-950/30 rounded p-3">
                          <div className="text-[11px] uppercase tracking-wider text-red-200 font-bold mb-2">
                            Errors
                          </div>
                          <ul className="text-xs text-red-100 space-y-1 list-disc pl-4">
                            {encoderValidatorResult.errors.map((err) => (
                              <li key={err}>{err}</li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {encoderValidatorResult.proposed && (
                        <div className="border border-slate-700 rounded p-3 bg-slate-800/50">
                          <div className="text-[11px] uppercase tracking-wider text-slate-400 font-bold mb-2">
                            Normalized Proposal
                          </div>
                          <div className="space-y-2">
                            <div className="font-mono text-[12px] text-slate-200 break-all">
                              Encoding: {encoderValidatorResult.proposed.encoding}
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                              <div className="font-mono text-[12px] text-slate-200">
                                Match: {encoderValidatorResult.proposed.match}
                              </div>
                              <div className="font-mono text-[12px] text-slate-200">
                                Mask: {encoderValidatorResult.proposed.mask}
                              </div>
                            </div>
                          </div>
                        </div>
                      )}

                      {encoderValidatorResult.proposed && (
                        <div
                          className="rounded-lg p-3"
                          style={{
                            border: '1px solid var(--riscv-border-2)',
                            background: 'var(--riscv-surface-2)',
                          }}
                        >
                          <div
                            className="text-[11px] uppercase tracking-widest font-semibold mb-2"
                            style={{ color: 'var(--riscv-text-3)' }}
                          >
                            Conflicts ({encoderValidatorResult.conflicts.length})
                          </div>
                          {encoderValidatorResult.conflicts.length === 0 ? (
                            <div className="conflict-none rounded-lg p-3 flex items-center gap-2 border">
                              <CheckCircle2
                                size={15}
                                style={{ color: 'var(--riscv-success)', flexShrink: 0 }}
                              />
                              <span
                                className="text-[13px] font-medium"
                                style={{ color: 'var(--riscv-success)' }}
                              >
                                No overlaps found in ISA database — safe to use.
                              </span>
                            </div>
                          ) : (
                            <div className="space-y-2 max-h-[340px] overflow-y-auto overscroll-contain pr-1">
                              {encoderValidatorResult.conflicts.map((conflict) => {
                                const severityCls =
                                  conflict.type === 'identical'
                                    ? 'conflict-identical'
                                    : conflict.type === 'proposed_subset_of_existing'
                                      ? 'conflict-subset-in'
                                      : conflict.type === 'existing_subset_of_proposed'
                                        ? 'conflict-subset-out'
                                        : 'conflict-partial';
                                const SeverityIcon =
                                  conflict.type === 'identical'
                                    ? XCircle
                                    : conflict.type === 'partial_overlap'
                                      ? AlertCircle
                                      : AlertTriangle;
                                return (
                                  <div
                                    key={`${conflict.other.extId}:${conflict.other.mnemonic}:${conflict.type}`}
                                    className={`rounded-lg p-2.5 border ${severityCls}`}
                                  >
                                    <div className="flex items-start justify-between gap-2">
                                      <div className="min-w-0 flex items-start gap-1.5">
                                        <SeverityIcon
                                          size={13}
                                          className="mt-0.5 shrink-0 opacity-80"
                                        />
                                        <div>
                                          <div
                                            className="font-mono text-[12px] font-medium break-words"
                                            style={{ color: 'var(--riscv-text)' }}
                                          >
                                            {conflict.other.mnemonic}{' '}
                                            <span style={{ color: 'var(--riscv-text-3)' }}>
                                              ({conflict.other.extId})
                                            </span>
                                          </div>
                                          <div
                                            className="text-[11px] mt-0.5"
                                            style={{ color: 'var(--riscv-text-3)' }}
                                          >
                                            {conflict.other.extName}
                                          </div>
                                        </div>
                                      </div>
                                      <span
                                        className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider border"
                                        style={{ background: 'rgba(0,0,0,0.2)', color: 'inherit' }}
                                      >
                                        {conflict.type.replace(/_/g, ' ')}
                                      </span>
                                    </div>

                                    <div
                                      className="mt-1.5 text-[12px]"
                                      style={{ color: 'var(--riscv-text-2)' }}
                                    >
                                      {conflict.why}
                                    </div>
                                    <div className="mt-1.5 grid grid-cols-2 gap-2">
                                      <div
                                        className="font-mono text-[11px]"
                                        style={{ color: 'var(--riscv-text-3)' }}
                                      >
                                        mask: {conflict.commonMask}
                                      </div>
                                      <div
                                        className="font-mono text-[11px]"
                                        style={{ color: 'var(--riscv-text-3)' }}
                                      >
                                        example: {conflict.exampleWord}
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Instruction Details Expand Modal ────────────────────────────── */}
      {instructionExpandOpen && selectedInstruction && selectedExt && (
        <div className="fixed inset-0 z-50" role="presentation">
          {/* Backdrop */}
          <div
            className="absolute inset-0"
            style={{ background: 'rgba(7,7,14,0.92)', backdropFilter: 'blur(6px)' }}
            onClick={() => setInstructionExpandOpen(false)}
            role="presentation"
          />

          <div className="absolute inset-0 p-3 md:p-8 flex items-start justify-center overflow-y-auto">
            <div
              ref={expandedModalRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="instr-expand-title"
              tabIndex={-1}
              className="animate-scale-in w-full max-w-5xl riscv-card overflow-hidden mb-8 outline-none"
              style={{ boxShadow: '0 0 80px rgba(0,0,0,0.9), 0 0 0 1px rgba(245,197,66,0.12)' }}
              onClick={(e) => e.stopPropagation()}
            >
              {/* ── Modal Header ── */}
              <div
                className="p-5 flex items-start justify-between gap-4"
                style={{ borderBottom: '1px solid var(--riscv-border)' }}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-3 flex-wrap mb-1.5">
                    <Binary size={18} style={{ color: 'var(--riscv-gold)', flexShrink: 0 }} />
                    <h2
                      id="instr-expand-title"
                      className="font-black tracking-tight font-mono"
                      style={{ fontSize: '1.75rem', lineHeight: 1.1, color: 'var(--riscv-gold)' }}
                    >
                      {selectedInstruction.mnemonic}
                    </h2>
                    {selectedInstruction.alias_of && (
                      <span
                        className="px-2 py-0.5 rounded font-mono text-[11px]"
                        style={{
                          background: 'var(--riscv-tint-3)',
                          color: 'var(--riscv-text-2)',
                          border: '1px solid var(--riscv-tint-4)',
                        }}
                        title={`Defines no new opcode: this is a specific encoding of ${selectedInstruction.alias_of}`}
                      >
                        alias of {selectedInstruction.alias_of}
                      </span>
                    )}
                    {selectedInstruction.deprecated && (
                      <span
                        className="px-2 py-1 rounded-md text-[11px] font-mono uppercase tracking-wide border"
                        style={{
                          background: 'var(--riscv-report-tint)',
                          color: 'var(--riscv-danger)',
                          borderColor: 'var(--riscv-report-edge)',
                        }}
                      >
                        Discontinued
                      </span>
                    )}
                  </div>
                  <div
                    className="flex items-center gap-2 flex-wrap"
                    style={{ marginLeft: '2.1rem' }}
                  >
                    <a
                      href={selectedExt.url || 'https://github.com/riscv/riscv-isa-manual'}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-[13px] hover:opacity-80 transition-opacity font-semibold"
                      style={{ color: 'var(--riscv-violet)' }}
                    >
                      {selectedExt.name}
                      <ArrowUpRight size={13} className="opacity-70" />
                    </a>
                    {selectedExt.desc && (
                      <span
                        className="text-[12px] hidden sm:inline"
                        style={{ color: 'var(--riscv-text-3)' }}
                      >
                        — {selectedExt.desc}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {(() => {
                    const isPinned = compareInstrKeys.has(
                      instructionKey(selectedExt.id, selectedInstruction.mnemonic),
                    );
                    return (
                      <button
                        type="button"
                        aria-pressed={isPinned}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 riscv-btn tooltip-bottom-right"
                        style={
                          isPinned
                            ? {
                                background: 'var(--riscv-violet-dim)',
                                color: 'var(--riscv-violet)',
                                borderColor: 'rgba(139, 124, 248, 0.4)',
                              }
                            : undefined
                        }
                        onClick={() => {
                          toggleCompareInstruction(selectedExt.id, selectedInstruction.mnemonic);
                          if (!compareMode) setCompareMode(true);
                        }}
                        data-tooltip={isPinned ? 'Remove from comparison' : 'Pin to comparison'}
                      >
                        <GitCompare
                          size={13}
                          style={{
                            color: isPinned ? 'var(--riscv-violet)' : 'inherit',
                            opacity: isPinned ? 1 : 0.7,
                          }}
                        />
                        <span>{isPinned ? 'Pinned' : 'Compare'}</span>
                      </button>
                    );
                  })()}
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 riscv-btn tooltip-bottom-right"
                    onClick={async () => {
                      const text = formatInstructionForClipboard(selectedExt, selectedInstruction);
                      const ok = await copyTextToClipboard(text);
                      setCopyStatus(ok ? 'copied' : 'failed');
                      if (ok) showToast('Copied instruction details!');
                      if (copyStatusTimerRef.current)
                        window.clearTimeout(copyStatusTimerRef.current);
                      copyStatusTimerRef.current = window.setTimeout(() => {
                        copyStatusTimerRef.current = null;
                        setCopyStatus(null);
                      }, 1500);
                    }}
                    data-tooltip="Copy extension + instruction details"
                  >
                    <Copy size={13} />
                    {copyStatus === 'copied'
                      ? 'Copied!'
                      : copyStatus === 'failed'
                        ? 'Failed'
                        : 'Copy'}
                  </button>
                  <button
                    type="button"
                    className="riscv-btn p-1.5 tooltip-bottom-right"
                    onClick={() => setInstructionExpandOpen(false)}
                    data-tooltip="Close expanded view (Esc)"
                    aria-label="Close expanded instruction view"
                  >
                    <X size={15} />
                  </button>
                </div>
              </div>

              {/* ── Modal Body ── */}
              <div
                className="p-5 space-y-6 overflow-y-auto"
                style={{ maxHeight: 'calc(90vh - 100px)' }}
              >
                {/* ── Encoding Diagram — full width, no scroll on wide screens ── */}
                <div>
                  <div
                    className="flex items-center gap-2 text-[11px] uppercase tracking-widest font-semibold mb-3"
                    style={{ color: 'var(--riscv-text-3)' }}
                  >
                    <Binary size={12} />
                    <span>32-bit Instruction Encoding</span>
                  </div>
                  <div
                    className="rounded-xl p-4"
                    style={{
                      background: 'var(--riscv-surface-2)',
                      border: '1px solid var(--riscv-border-2)',
                    }}
                  >
                    <EncodingDiagram encoding={selectedInstruction.encoding} />
                    <div className="mt-2 text-[11px]" style={{ color: 'var(--riscv-text-3)' }}>
                      Fixed bits are <span className="font-mono">0/1</span>, variable bits are{' '}
                      <span className="font-mono">x</span>.
                    </div>
                  </div>
                </div>

                {/* ── Match / Mask / Variable Fields / Extension Tags ── */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                  <div className="space-y-4">
                    <div>
                      <div
                        className="text-[11px] uppercase tracking-widest font-semibold mb-2"
                        style={{ color: 'var(--riscv-text-3)' }}
                      >
                        Match
                      </div>
                      <div
                        className={`font-mono text-[14px] px-4 py-3 rounded-lg border flex items-center justify-between group ${
                          searchQuery.trim().length &&
                          String(selectedInstruction.match || '')
                            .toLowerCase()
                            .includes(searchQuery.trim().toLowerCase())
                            ? 'border-yellow-400 bg-yellow-500/10 text-yellow-200'
                            : 'border-slate-700 bg-slate-800/70 text-slate-100'
                        }`}
                      >
                        <span>{selectedInstruction.match || '—'}</span>
                        {selectedInstruction.match && (
                          <button
                            type="button"
                            className="riscv-btn p-1.5 tooltip-align-right"
                            onClick={async () => {
                              const ok = await copyTextToClipboard(selectedInstruction.match);
                              if (ok) showToast('Copied Match value!');
                            }}
                            data-tooltip="Copy Match"
                          >
                            <Copy size={14} />
                          </button>
                        )}
                      </div>
                    </div>
                    <div>
                      <div
                        className="text-[11px] uppercase tracking-widest font-semibold mb-2"
                        style={{ color: 'var(--riscv-text-3)' }}
                      >
                        Mask
                      </div>
                      <div
                        className={`font-mono text-[14px] px-4 py-3 rounded-lg border flex items-center justify-between group ${
                          searchQuery.trim().length &&
                          String(selectedInstruction.mask || '')
                            .toLowerCase()
                            .includes(searchQuery.trim().toLowerCase())
                            ? 'border-yellow-400 bg-yellow-500/10 text-yellow-200'
                            : 'border-slate-700 bg-slate-800/70 text-slate-100'
                        }`}
                      >
                        <span>{selectedInstruction.mask || '—'}</span>
                        {selectedInstruction.mask && (
                          <button
                            type="button"
                            className="riscv-btn p-1.5 tooltip-align-right"
                            onClick={async () => {
                              const ok = await copyTextToClipboard(selectedInstruction.mask);
                              if (ok) showToast('Copied Mask value!');
                            }}
                            data-tooltip="Copy Mask"
                          >
                            <Copy size={14} />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="space-y-4">
                    <div>
                      <div
                        className="text-[11px] uppercase tracking-widest font-semibold mb-2"
                        style={{ color: 'var(--riscv-text-3)' }}
                      >
                        Variable Fields
                      </div>
                      <div className="flex flex-wrap gap-1.5 min-h-[36px] items-start content-start">
                        {(selectedInstruction.variable_fields || []).length > 0 ? (
                          (selectedInstruction.variable_fields || []).map((field) => (
                            <span
                              key={field}
                              className="px-2.5 py-1 rounded-md border border-slate-700 bg-slate-800/70 text-[12px] font-mono text-slate-200"
                            >
                              {field}
                            </span>
                          ))
                        ) : (
                          <span className="text-[13px]" style={{ color: 'var(--riscv-text-3)' }}>
                            None
                          </span>
                        )}
                      </div>
                    </div>

                    {Array.isArray(selectedInstruction.extension) &&
                      selectedInstruction.extension.length > 0 && (
                        <div>
                          <div
                            className="text-[11px] uppercase tracking-widest font-semibold mb-2"
                            style={{ color: 'var(--riscv-text-3)' }}
                          >
                            Extension Tags
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {selectedInstruction.extension.map((tag) => (
                              <span
                                key={tag}
                                className="px-2.5 py-1 rounded-md text-[12px] font-mono"
                                style={{
                                  background: 'var(--riscv-violet-dim)',
                                  color: 'var(--riscv-violet)',
                                  border: '1px solid rgba(139,124,248,0.25)',
                                }}
                              >
                                {tag}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                  </div>
                </div>

                {/* ── Compressed Mapping ── */}
                {compressedMapping && (
                  <div
                    className="rounded-xl p-4"
                    style={{
                      border: '1px solid rgba(34,211,238,0.2)',
                      background: 'rgba(34,211,238,0.04)',
                    }}
                  >
                    <div className="text-[11px] uppercase tracking-widest font-semibold mb-4 text-cyan-400">
                      Compressed Mapping
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <div
                          className="text-[11px] uppercase tracking-wider font-semibold mb-1.5"
                          style={{ color: 'var(--riscv-text-3)' }}
                        >
                          Compressed Form
                        </div>
                        <div className="font-mono text-[13px] text-slate-100 bg-slate-800/70 border border-slate-700 rounded-lg px-3 py-2">
                          {compressedMapping.compressed}
                        </div>
                      </div>
                      <div>
                        <div
                          className="text-[11px] uppercase tracking-wider font-semibold mb-1.5"
                          style={{ color: 'var(--riscv-text-3)' }}
                        >
                          Standard Equivalent
                        </div>
                        {hasStandardEquivalent ? (
                          <button
                            type="button"
                            className="w-full text-left font-mono text-[13px] text-slate-100 bg-slate-800/70 border border-slate-700 rounded-lg px-3 py-2 hover:border-cyan-400/60 transition-colors inline-flex items-center justify-between group"
                            onClick={() => {
                              selectStandardEquivalent(standardEquivalentMnemonic);
                            }}
                            data-tooltip="Open standard instruction details"
                          >
                            <span>{compressedMapping.standard}</span>
                            <ArrowUpRight
                              size={14}
                              className="opacity-0 group-hover:opacity-70 shrink-0 transition-opacity"
                            />
                          </button>
                        ) : (
                          <div className="font-mono text-[13px] text-slate-100 bg-slate-800/70 border border-slate-700 rounded-lg px-3 py-2">
                            {compressedMapping.standard}
                          </div>
                        )}
                      </div>
                      <div>
                        <div
                          className="text-[11px] uppercase tracking-wider font-semibold mb-1.5"
                          style={{ color: 'var(--riscv-text-3)' }}
                        >
                          Equivalent Instruction
                        </div>
                        {standardEquivalentMnemonic ? (
                          hasStandardEquivalent ? (
                            <button
                              type="button"
                              className="inline-flex items-center gap-1 text-[13px] font-mono text-cyan-400 hover:text-cyan-300 underline decoration-cyan-400/30 underline-offset-4 hover:decoration-cyan-300 transition-colors tooltip-align-left"
                              onClick={() => {
                                selectStandardEquivalent(standardEquivalentMnemonic);
                              }}
                              data-tooltip="Open standard instruction details"
                            >
                              {standardEquivalentMnemonic}
                              <ArrowUpRight size={13} className="opacity-70 shrink-0" />
                            </button>
                          ) : (
                            <div className="font-mono text-[13px] text-slate-400">
                              {standardEquivalentMnemonic}
                            </div>
                          )
                        ) : (
                          <div className="text-[13px] text-slate-500">Unavailable</div>
                        )}
                      </div>
                      <div>
                        <div
                          className="text-[11px] uppercase tracking-wider font-semibold mb-1.5"
                          style={{ color: 'var(--riscv-text-3)' }}
                        >
                          Description
                        </div>
                        <div className="text-[13px]" style={{ color: 'var(--riscv-text-2)' }}>
                          {compressedMapping.description}
                        </div>
                      </div>
                      {compressedMapping.notes && (
                        <div>
                          <div
                            className="text-[11px] uppercase tracking-wider font-semibold mb-1.5"
                            style={{ color: 'var(--riscv-text-3)' }}
                          >
                            Notes
                          </div>
                          <div className="text-[13px]" style={{ color: 'var(--riscv-text-2)' }}>
                            {compressedMapping.notes}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* ── Compressed Equivalents ── */}
                {compressedEquivalents.length > 0 && (
                  <div
                    className="rounded-xl p-4"
                    style={{
                      border: '1px solid rgba(52,211,153,0.2)',
                      background: 'rgba(52,211,153,0.04)',
                    }}
                  >
                    <div
                      className="text-[11px] uppercase tracking-widest font-semibold mb-4"
                      style={{ color: '#34d399' }}
                    >
                      Compressed Equivalents ({compressedEquivalents.length})
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
                      {compressedEquivalents.map((entry) => (
                        <button
                          key={entry.mnemonic}
                          type="button"
                          className="text-left rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 hover:border-emerald-400/60 transition-colors"
                          onClick={() => {
                            selectCompressedEquivalent(entry.mnemonic);
                          }}
                          data-tooltip={`Open ${entry.mnemonic} details`}
                        >
                          <div className="flex items-center gap-1 text-[13px] font-mono text-emerald-200">
                            {normalizeMnemonicKey(entry.mnemonic)}
                            <ArrowUpRight size={12} className="opacity-70" />
                          </div>
                          <div className="text-[11px] font-mono text-slate-400 mt-0.5">
                            {entry.compressed}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* ── Profile Status ── */}
                {activeProfile && (
                  <div
                    className={`
                      mt-2 p-4 rounded-xl flex items-center gap-3 border text-[13px]
                      ${
                        isHighlighted(selectedExt.id)
                          ? 'bg-yellow-900/20 border-yellow-700/30 text-yellow-200'
                          : 'bg-slate-800/50 border-slate-700/50 text-slate-400'
                      }
                    `}
                  >
                    {isHighlighted(selectedExt.id) ? (
                      <>
                        <div className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse" />
                        <div>
                          Required in <strong>{activeProfile}</strong>
                        </div>
                      </>
                    ) : (
                      <>
                        <div
                          className="w-2 h-2 rounded-full"
                          style={{ background: 'var(--riscv-muted)' }}
                        />
                        <div>
                          Not required in <strong>{activeProfile}</strong>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── ISA Workspace Panel ────────────────────────────────────────── */}
      {workspacePanelMounted && (
        <React.Suspense fallback={null}>
          <WorkspacePanel
            open={workspacePanelOpen}
            onClose={() => setWorkspacePanelOpen(false)}
            workspaceIds={workspaceIds}
            lockedExtensions={lockedExtensions}
            allExts={allExtsList}
            onSetVlen={handleSetVlen}
            seedProfile={seedProfile}
            profileOptional={PROFILE_OPTIONAL}
            paramChoices={paramChoices}
            onSetParam={handleSetParam}
            baselineLocked={baselineLocked}
            customFromProfile={customFromProfile}
            onToggleBaseline={() => {
              if (baselineLocked) {
                // Releasing the lock: just release it
                setBaselineLocked(false);
              } else {
                // Re-locking: restore any missing mandatory extensions first,
                // so the locked state is always a genuinely compliant configuration.
                if (seedProfile) {
                  const mandatory = PROFILES[seedProfile] || [];
                  const missing = mandatory.filter((id) => !workspaceIds.has(id));
                  if (missing.length > 0) {
                    addWorkspaceIdsSmart(missing);
                    showToast(
                      `Re-locked ${seedProfile}: restored ${missing.join(', ')} to the mandatory set.`,
                    );
                  }
                }
                setBaselineLocked(true);
              }
            }}
            onAddId={(id) => addWorkspaceIdsSmart(id, true)}
            onRemoveId={(id) => {
              // Decide before mutating anything. The previous order downgraded the
              // profile first and only then discovered the removal was refused,
              // which left the configuration permanently 'Custom' and the lock
              // forced open while nothing had actually been removed.
              if (lockedExtensions.has(id)) {
                showToast(
                  `Cannot remove ${id}: required by ${lockedExtensions.get(id).join(', ')}`,
                );
                return;
              }
              if (!workspaceIds.has(id)) return;

              // Reaching here means the removal will happen. A mandatory extension
              // can only be unlocked, so this is the deliberate divergence path.
              const divergesFromProfile = Boolean(
                seedProfile && (PROFILES[seedProfile] || []).includes(id),
              );

              setWorkspaceIds((prev) => {
                const next = new Set(prev);
                next.delete(id);
                return next;
              });

              if (divergesFromProfile) {
                setSeedProfile(null);
                setCustomFromProfile(seedProfile);
                showToast(
                  `${id} removed — configuration is now Custom (from ${seedProfile}). Re-select the profile from the switcher to restore full compliance.`,
                );
              }
            }}
            onClear={() => {
              setWorkspaceIds(new Set());
              setSeedProfile(null);
              setCustomFromProfile(null);
              setParamChoices({});
              setBaselineLocked(true);
              try {
                window.localStorage.removeItem(BUILDER_STORAGE_KEY);
              } catch {
                /* ignore */
              }
            }}
            onLoadIds={(ids, profileName) => {
              setWorkspaceIds(new Set()); // clear
              addWorkspaceIdsSmart(ids); // smartly add all
              setSeedProfile(profileName || null);
              setCustomFromProfile(null); // fresh load resets origin tracking
              setBaselineLocked(true);
            }}
            onSelectInstruction={({ extId, mnemonic, encoding, variable_fields, match, mask }) => {
              // Navigate the main view to the specified extension + instruction
              const targetExt = allExtsList.find((e) => e.id === extId);
              if (targetExt) {
                setSelectedExt(targetExt);
                setSelectedInstruction({ mnemonic, encoding, variable_fields, match, mask });
                setWorkspacePanelOpen(false); // close panel to reveal main view
                // Scroll tile into view
                requestAnimationFrame(() => {
                  const el = document.getElementById(`ext-${extId}`);
                  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                });
              }
            }}
          />
        </React.Suspense>
      )}

      {/* ── Custom Extension Sandbox ───────────────────────────────────── */}
      <SandboxPanel
        open={sandboxOpen}
        onClose={() => setSandboxOpen(false)}
        catalog={allExtsList}
        extensions={sandboxExtensions}
        onUpdateExtensions={setSandboxExtensions}
      />

      {/* ── Ask AI Launcher ── */}
      <AskAiLauncher context={askAiContext} />

      {/* ── Workspace Notices Toast ── */}
      <div
        style={{
          position: 'fixed',
          bottom: workspaceNotice ? '32px' : '-100px',
          left: '50%',
          transform: 'translateX(-50%)',
          background: 'var(--riscv-surface-2)',
          border: '1px solid var(--riscv-border-2)',
          color: 'var(--riscv-text)',
          padding: '10px 16px',
          borderRadius: '8px',
          boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
          transition: 'all 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
          zIndex: 9999,
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          opacity: workspaceNotice ? 1 : 0,
          pointerEvents: workspaceNotice ? 'auto' : 'none',
          backdropFilter: 'blur(8px)',
        }}
      >
        <Info size={16} style={{ color: '#6366f1' }} />
        <span style={{ fontSize: '13px', fontWeight: 500 }}>{workspaceNotice}</span>
      </div>
    </div>
  );
};

export default RISCVExplorer;
