import React from 'react';
import toolchainData from './toolchain-support.json';
import { BUILD_TOOLS, RUN_TOOLS, extensionSupport, marchRequirements } from './toolchainSupport.js';

/*
 * What "knows an extension" means for each tool, for the tooltips. Clang and
 * QEMU also have an experimental tier, each switched on its own way: `now`
 * says how to use it today, `then` how it was used before it was supported.
 */
const LLVM_FLAG =
  '-menable-experimental-extensions and the extension version spelled out in -march';
const spell = (options) =>
  options.map(({ option, from }, i) => (i ? `${option} from ${from}` : option)).join(', then ');

const WORDS = {
  llvm: {
    verb: 'accepted in -march by',
    now: () => `needs ${LLVM_FLAG}`,
    then: () => `which needed ${LLVM_FLAG}`,
  },
  gcc: { verb: 'accepted in -march by' },
  binutils: { verb: 'assembled by' },
  qemu: {
    verb: 'emulated by',
    now: (s) => (s.options.length ? `enable it with ${s.options.at(-1).option}` : ''),
    then: (s) => (s.options.length ? `as ${spell(s.options)}` : ''),
  },
  linux: {
    verb: 'detected by',
    note: '. The kernel reads it from the device tree or ACPI ISA string and lists it in /proc/cpuinfo',
  },
};

const capitalise = (text) => text.charAt(0).toUpperCase() + text.slice(1);

const CHIP = 'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-mono border';

const STYLES = {
  supported: {
    background: 'var(--riscv-check-fill)',
    color: 'var(--riscv-check)',
    borderColor: 'var(--riscv-check-edge)',
  },
  experimental: {
    background: 'var(--riscv-gold-dim)',
    color: 'var(--riscv-gold)',
    borderColor: 'color-mix(in srgb, var(--riscv-gold) 35%, transparent)',
  },
  none: {
    color: 'var(--riscv-text-3)',
    borderColor: 'var(--riscv-border-2)',
    borderStyle: 'dashed',
  },
};

function Chip({ state, title, children }) {
  return (
    <span className={CHIP} style={STYLES[state]} title={title}>
      {children}
    </span>
  );
}

// LLVM's own word for it, in llvm/docs/RISCVUsage.rst.
const ASSEMBLY_ONLY =
  '. LLVM lists it as Assembly Support: Clang accepts it and assembles it, but generates no code for it';

const list = (items) =>
  items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0];
// For releases that took a bundle's parts but not its name. Named, not
// spelled as -march: single letters such as Sha's H go in the letter run.
const spellParts = (s) => (s.parts ? `${list(s.parts.via)} (${s.name} ${s.parts.since}+)` : '');

function standingTitle(s) {
  const { verb, now, then, note: toolNote = '' } = WORDS[s.key] ?? { verb: 'supported by' };
  // For a bundle Linux knows only through its parts, cpuinfo shows the parts.
  const kernel =
    s.through && s.key === 'linux'
      ? '. It has no entry for the bundle itself, and /proc/cpuinfo lists the parts'
      : toolNote;
  const note = `${s.assemblyOnly ? ASSEMBLY_ONLY : ''}${kernel}`;
  // QEMU has no switch for these; it provides them with another extension.
  const part = s.impliedBy
    ? `, as part of ${s.impliedBy}`
    : s.through
      ? `, through ${list(s.through)}`
      : '';
  const before = s.parts ? `; before that, write its parts instead: ${spellParts(s)}` : '';
  if (s.state === 'supported') {
    const floor = s.earliest ? ` (the scan starts at ${s.since}, so it may be older)` : '';
    const since = `${capitalise(verb)} ${s.name} ${s.since} and later${floor}${part}`;
    const from = `${s.experimentalSince}${s.experimentalEarliest ? ' or earlier' : ''}`;
    const earlier = s.experimentalSince && then ? `; experimental from ${from}, ${then(s)}` : '';
    return `${since}${earlier}${before}${note}`;
  }
  if (s.state === 'experimental') {
    const how = now ? now(s) : '';
    const since = s.earliest ? `${s.since} or earlier (the scan starts at ${s.since})` : s.since;
    return `Experimental in ${s.name} since ${since}${part}${how ? `: ${how}` : ''}${note}`;
  }
  return s.parts
    ? `Not ${verb} ${s.name} ${s.newest} by name; write its parts instead: ${spellParts(s)}`
    : `Not ${verb} ${s.name} ${s.newest}, the newest release`;
}

function StandingRow({ label, title, support }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span
        className="w-10 text-[10px] uppercase tracking-widest font-semibold"
        style={{ color: 'var(--riscv-text-3)' }}
        title={title}
      >
        {label}
      </span>
      {support.map((s) => (
        <Chip key={s.key} state={s.state} title={standingTitle(s)}>
          {s.state === 'none' ? `${s.name}: not yet` : `${s.name} ${s.since}+`}
          {s.state === 'experimental' && <span className="italic">experimental</span>}
          {s.assemblyOnly && <span className="italic">assembly only</span>}
        </Chip>
      ))}
    </div>
  );
}

/* The extension panel's rows: what builds code for it, and what runs it. */
export function ExtensionToolchains({ id }) {
  const build = extensionSupport(toolchainData, id, BUILD_TOOLS);
  if (!build) return null;
  const run = extensionSupport(toolchainData, id, RUN_TOOLS);
  return (
    <div>
      <h3
        className="text-[11px] uppercase tracking-widest font-semibold mb-1.5"
        style={{ color: 'var(--riscv-text-3)' }}
        title="The first release of each tool that accepts, assembles, emulates or detects it, read from each release's source"
      >
        Toolchain support
      </h3>
      <div className="space-y-1.5">
        <StandingRow
          label="Tools"
          title="Compilers that accept it in -march, and the assembler"
          support={build}
        />
        <StandingRow label="Run" title="Emulator and kernel" support={run} />
      </div>
    </div>
  );
}

/* The builder's row under the -march string: the oldest release of each
   tool that accepts all of it, which is not a promise of code generation.
   QEMU and Linux stay off it: Linux never lists profile-only extensions such
   as Ssccptr, so every profile would read "not yet". */
const assemblyNote = (r) =>
  r.assemblyOnly.length
    ? `. LLVM lists ${r.assemblyOnly.join(', ')} as Assembly Support: Clang assembles ${r.assemblyOnly.length > 1 ? 'them' : 'it'} but generates no code for ${r.assemblyOnly.length > 1 ? 'them' : 'it'}`
    : '';
// An assembly-only base means Clang cannot compile for this -march at all.
const noCodegen = (r) => r.assemblyOnly.some((token) => /^rv\d+[ie]$/.test(token));
export function MarchToolchains({ march }) {
  const requirements = marchRequirements(toolchainData, march);
  if (!requirements.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span
        className="text-[11px] uppercase tracking-widest font-semibold"
        style={{ color: 'var(--riscv-text-3)' }}
      >
        Accepted by
      </span>
      {requirements.map((r) => {
        if (r.missing.length) {
          return (
            <Chip
              key={r.key}
              state="none"
              title={`No ${r.name} release takes ${r.missing.join(', ')} yet (checked up to ${r.newest})`}
            >
              {r.name}: no release takes {r.missing.join(', ')}
            </Chip>
          );
        }
        if (r.experimental.length) {
          return (
            <Chip
              key={r.key}
              state="experimental"
              title={`${r.experimental.join(', ')} ${r.experimental.length > 1 ? 'are' : 'is'} experimental in ${r.name}: ${r.key === 'llvm' ? `needs ${LLVM_FLAG}` : ''}${assemblyNote(r)}`}
            >
              {r.name} {r.minimum}+ <span className="italic">experimental</span>
              {noCodegen(r) && <span className="italic">assembly only</span>}
            </Chip>
          );
        }
        return (
          <Chip
            key={r.key}
            state="supported"
            title={`${r.name} ${r.minimum} and later accept every extension in this -march${assemblyNote(r)}`}
          >
            {r.name} {r.minimum}+{noCodegen(r) && <span className="italic">assembly only</span>}
          </Chip>
        );
      })}
    </div>
  );
}
