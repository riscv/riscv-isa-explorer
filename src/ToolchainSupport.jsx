import React from 'react';
import toolchainData from './toolchain-support.json';
import { extensionSupport, marchRequirements } from './toolchainSupport.js';

const EXPERIMENTAL_HOW =
  'needs -menable-experimental-extensions and the extension version spelled out in -march';

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
  if (s.state === 'supported') {
    const since = s.earliest
      ? `Accepted by ${s.name} ${s.since} and later (the scan starts at ${s.since}, so it may be older)`
      : `Accepted since ${s.name} ${s.since}`;
    return s.experimentalSince
      ? `${since}; experimental from ${s.experimentalSince}, which ${EXPERIMENTAL_HOW}`
      : since;
  }
  if (s.state === 'experimental') {
    return `Experimental in ${s.name} since ${s.since}: ${EXPERIMENTAL_HOW}`;
  }
  return `Not accepted by ${s.name} ${s.newest}, the newest release`;
}

/* The extension panel's row: one chip per toolchain. */
export function ExtensionToolchains({ id }) {
  const support = extensionSupport(toolchainData, id);
  if (!support) return null;
  return (
    <div>
      <h3
        className="text-[11px] uppercase tracking-widest font-semibold mb-1.5"
        style={{ color: 'var(--riscv-text-3)' }}
        title="The first release whose -march accepts it, read from each release's source"
      >
        Toolchain support
      </h3>
      <div className="flex flex-wrap gap-1.5">
        {support.map((s) => (
          <Chip key={s.key} state={s.state} title={standingTitle(s)}>
            {s.state === 'none' ? `${s.name}: not yet` : `${s.name} ${s.since}+`}
            {s.state === 'experimental' && <span className="opacity-80">experimental</span>}
          </Chip>
        ))}
      </div>
    </div>
  );
}

/* The builder's row under the -march string: the oldest release of each
   toolchain that accepts all of it. */
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
              title={`No ${r.name} release accepts ${r.missing.join(', ')} yet (checked up to ${r.newest})`}
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
              title={`${r.experimental.join(', ')} ${r.experimental.length > 1 ? 'are' : 'is'} experimental in ${r.name}: ${EXPERIMENTAL_HOW}`}
            >
              {r.name} {r.minimum}+ <span className="opacity-80">experimental</span>
            </Chip>
          );
        }
        return (
          <Chip
            key={r.key}
            state="supported"
            title={`Every extension in this -march is accepted by ${r.name} ${r.minimum} and later`}
          >
            {r.name} {r.minimum}+
          </Chip>
        );
      })}
    </div>
  );
}
