/**
 * InstructionUsage — how to write the selected instruction: its assembly
 * syntax and a concrete line, the facts that limit where it runs, the C
 * intrinsic that emits it, and a Compiler Explorer link that compiles either.
 *
 * Shared by the instruction side panel and the expanded view; `expanded`
 * only changes the type scale. Everything shown is derived in
 * instructionUsage.js from synced upstream data, so a missing piece renders
 * nothing rather than a placeholder.
 */
import React from 'react';
import { ArrowUpRight, Terminal } from 'lucide-react';
import instructionMetadata from './instruction-metadata.json';
import instructionIntrinsics from './instruction-intrinsics.json';
import instructionReferences from './instruction-references.json';
import {
  assemblySyntax,
  compilerExplorerUrl,
  exampleAssembly,
  inlineAsmSource,
  instructionMarch,
  intrinsicExtensions,
  intrinsicSource,
  preferredXlen,
  prototypeFor,
  referenceLinks,
  takesImmediate,
  xlenRestriction,
} from './instructionUsage.js';

function Label({ children, expanded }) {
  return (
    <div
      className={`text-[11px] uppercase font-bold mb-1 ${expanded ? 'tracking-widest' : 'tracking-wider'}`}
      style={{ color: 'var(--riscv-text-3)' }}
    >
      {children}
    </div>
  );
}

function Code({ children, expanded }) {
  return (
    <code
      className={`block font-mono rounded-sm px-2 py-1 break-words whitespace-pre-wrap ${
        expanded ? 'text-[13px]' : 'text-[12px]'
      }`}
      style={{
        background: 'var(--riscv-surface-2)',
        border: '1px solid var(--riscv-border-2)',
        color: 'var(--riscv-text)',
      }}
    >
      {children}
    </code>
  );
}

function Fact({ children, title }) {
  return (
    <span
      className="px-1.5 py-0.5 rounded-sm text-[11px] font-mono"
      title={title}
      style={{
        background: 'var(--riscv-violet-dim)',
        color: 'var(--riscv-violet)',
        border: '1px solid rgba(139, 124, 248, 0.3)',
      }}
    >
      {children}
    </span>
  );
}

const REFERENCE_MODELS = [
  { key: 'sail', name: 'Sail', model: 'the Sail formal model' },
  { key: 'spike', name: 'Spike', model: 'the Spike simulator' },
];

function ReferenceLink({ name, model, url, commit }) {
  if (!url) {
    return (
      <span
        className="inline-flex items-center px-2 py-1 rounded-sm text-[11px] cursor-not-allowed"
        title={`Not implemented in ${model} yet (checked at ${commit})`}
        style={{
          color: 'var(--riscv-text-3)',
          border: '1px dashed var(--riscv-border-2)',
          opacity: 0.7,
        }}
      >
        {name}
        <span className="sr-only"> (not available)</span>
      </span>
    );
  }
  return (
    <a
      className="inline-flex items-center gap-0.5 px-2 py-1 riscv-btn"
      href={url}
      target="_blank"
      rel="noreferrer"
      data-tooltip={`Open the implementation in ${model} (commit ${commit})`}
    >
      {name}
      <ArrowUpRight size={11} />
    </a>
  );
}

export default function InstructionUsage({ extension, instruction, catalogIds, expanded = false }) {
  const usage = React.useMemo(() => {
    const key = String(instruction?.mnemonic || '').toLowerCase();
    if (!key) return null;
    const meta = instructionMetadata[key];
    const intrinsic = instructionIntrinsics[key];
    const xlenOnly = xlenRestriction(instruction.extension, meta);
    const xlen = preferredXlen(instruction.extension, meta?.defined_by);
    const syntax = assemblySyntax(key, meta?.assembly);
    const example = exampleAssembly(key, meta?.assembly);
    const prototype = intrinsic ? prototypeFor(intrinsic.prototypes, xlen) : null;

    const marchFor = (extra) =>
      instructionMarch({
        extensionId: extension?.id,
        extensionTags: instruction.extension,
        definedBy: meta?.defined_by,
        catalogIds,
        extra,
      });
    // The intrinsic is the more useful thing to compile; inline asm otherwise.
    const cSource =
      intrinsic?.header && prototype
        ? intrinsicSource(intrinsic.header, prototype, {
            immediate: takesImmediate(key, meta?.assembly),
          })
        : null;
    const source = cSource ?? inlineAsmSource(example);
    const march = source ? marchFor(cSource ? intrinsicExtensions(prototype) : []) : null;

    return {
      syntax,
      example: example && example !== syntax ? example : null,
      xlenOnly,
      constantTime: meta?.data_independent_timing === true,
      intrinsic: intrinsic && prototype ? { ...intrinsic, prototype } : null,
      explorer: compilerExplorerUrl({ source, march }),
      explorerKind: cSource ? 'intrinsic' : 'assembly',
      march,
      references: referenceLinks(instructionReferences, key),
    };
  }, [extension?.id, instruction, catalogIds]);

  if (!usage) return null;

  return (
    <div className="space-y-3">
      {usage.syntax && (
        <div>
          <Label expanded={expanded}>Assembly</Label>
          <Code expanded={expanded}>{usage.syntax}</Code>
          {usage.example && (
            <div className="mt-1 text-[11px]" style={{ color: 'var(--riscv-text-3)' }}>
              e.g. <span className="font-mono">{usage.example}</span>
            </div>
          )}
          {(usage.xlenOnly || usage.constantTime) && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {usage.xlenOnly && (
                <Fact title={`Only exists when XLEN is ${usage.xlenOnly.slice(2)}`}>
                  {usage.xlenOnly} only
                </Fact>
              )}
              {usage.constantTime && (
                <Fact title="Execution latency does not depend on operand values when Zkt or Zvkt is implemented">
                  data-independent timing
                </Fact>
              )}
            </div>
          )}
        </div>
      )}

      {usage.intrinsic && (
        <div>
          <Label expanded={expanded}>C intrinsic</Label>
          <Code expanded={expanded}>{usage.intrinsic.prototype}</Code>
          <div
            className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]"
            style={{ color: 'var(--riscv-text-3)' }}
          >
            {usage.intrinsic.header && (
              <span className="font-mono">#include &lt;{usage.intrinsic.header}&gt;</span>
            )}
            {usage.intrinsic.count > 1 && (
              <span>
                {usage.intrinsic.header === 'riscv_vector.h'
                  ? `one of ${usage.intrinsic.count} type variants`
                  : `one of ${usage.intrinsic.count} forms`}
              </span>
            )}
            <a
              className="inline-flex items-center gap-0.5 hover:underline"
              style={{ color: 'var(--riscv-violet)' }}
              href={usage.intrinsic.source}
              target="_blank"
              rel="noreferrer"
            >
              {usage.intrinsic.header === 'riscv_vector.h' ? 'RVV intrinsics spec' : 'C API spec'}
              <ArrowUpRight size={11} />
            </a>
          </div>
        </div>
      )}

      <div>
        <Label expanded={expanded}>Reference implementations</Label>
        <div className="flex flex-wrap gap-1.5">
          {REFERENCE_MODELS.map(({ key, name, model }) => (
            <ReferenceLink key={key} name={name} model={model} {...usage.references[key]} />
          ))}
        </div>
      </div>

      {usage.explorer && (
        <a
          className="inline-flex items-center gap-1.5 px-2 py-1 riscv-btn"
          href={usage.explorer}
          target="_blank"
          rel="noreferrer"
          data-tooltip={`Compile the ${usage.explorerKind === 'intrinsic' ? 'intrinsic' : 'example'} with clang for -march=${usage.march}`}
        >
          <Terminal size={12} />
          Try in Compiler Explorer
          <ArrowUpRight size={11} />
        </a>
      )}
    </div>
  );
}
