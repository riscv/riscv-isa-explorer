import React from 'react';
import toolchainData from './toolchain-support.json';
import { BUILD_TOOLS, RUN_TOOLS, extensionSupport, marchRequirements } from './toolchainSupport.js';

/*
 * What "knows an extension" means for each tool, for the tooltips. Clang and
 * QEMU also have an experimental tier, each switched on its own way.
 */
const WORDS = {
  llvm: {
    verb: 'accepted in -march by',
    how: () =>
      'needs -menable-experimental-extensions and the extension version spelled out in -march',
  },
  gcc: { verb: 'accepted in -march by' },
  binutils: { verb: 'assembled by' },
  qemu: {
    verb: 'emulated by',
    how: (token) => `enable it with its x- property, as in -cpu rv64,x-${token}=on`,
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

function standingTitle(s) {
  const { verb, how, note = '' } = WORDS[s.key] ?? { verb: 'supported by' };
  if (s.state === 'supported') {
    const since = s.earliest
      ? `${capitalise(verb)} ${s.name} ${s.since} and later (the scan starts at ${s.since}, so it may be older)`
      : `${capitalise(verb)} ${s.name} ${s.since} and later`;
    const before =
      s.experimentalSince && how
        ? `; experimental from ${s.experimentalSince}, which ${how(s.token)}`
        : '';
    return `${since}${before}${note}`;
  }
  if (s.state === 'experimental') {
    return `Experimental in ${s.name} since ${s.since}: ${how ? how(s.token) : ''}`;
  }
  return `Not ${verb} ${s.name} ${s.newest}, the newest release`;
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
        title="The first release of each tool that knows it, read from each release's source"
      >
        Toolchain support
      </h3>
      <div className="space-y-1.5">
        <StandingRow label="Build" title="Compilers and assembler" support={build} />
        <StandingRow label="Run" title="Emulator and kernel" support={run} />
      </div>
    </div>
  );
}

/* The builder's row under the -march string: the oldest release of each
   build tool that takes all of it. QEMU and Linux stay off it: Linux never
   lists profile-only extensions such as Ssccptr, so every profile would read
   "not yet". */
export function MarchToolchains({ march }) {
  const requirements = marchRequirements(toolchainData, march);
  if (!requirements.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span
        className="text-[11px] uppercase tracking-widest font-semibold"
        style={{ color: 'var(--riscv-text-3)' }}
      >
        Needs
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
              title={`${r.experimental.join(', ')} ${r.experimental.length > 1 ? 'are' : 'is'} experimental in ${r.name}: ${WORDS[r.key]?.how?.(r.experimental[0]) ?? ''}`}
            >
              {r.name} {r.minimum}+ <span className="italic">experimental</span>
            </Chip>
          );
        }
        return (
          <Chip
            key={r.key}
            state="supported"
            title={`${r.name} ${r.minimum} and later take every extension in this -march`}
          >
            {r.name} {r.minimum}+
          </Chip>
        );
      })}
    </div>
  );
}
