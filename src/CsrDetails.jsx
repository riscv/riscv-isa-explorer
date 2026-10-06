import React, { useMemo, useState } from 'react';

function bitRange(bits, xlen) {
  const selected = typeof bits === 'string' ? bits : bits?.[`rv${xlen}`];
  if (!selected || !/^\d+(?:-\d+)?$/.test(selected)) return null;
  const [high, low = high] = selected.split('-').map(Number);
  if (high < low || high >= xlen) return null;
  return { high, low };
}

function formatAddress(address) {
  if (typeof address === 'number' || /^\d+$/.test(String(address || ''))) {
    const numeric = Number(address);
    if (Number.isSafeInteger(numeric) && numeric >= 0) {
      return `0x${numeric.toString(16).toUpperCase()}`;
    }
  }
  if (/^0x[\da-f]+$/i.test(String(address || ''))) {
    return `0x${String(address).slice(2).toUpperCase()}`;
  }
  return address ? String(address).toUpperCase() : 'unknown';
}

function conditionLabel(condition) {
  if (!condition) return 'No additional condition recorded';
  if (condition.xlen) return `XLEN = ${condition.xlen}`;
  if (condition.extension?.name) return `Extension ${condition.extension.name}`;
  if (condition.extension?.anyOf) {
    return condition.extension.anyOf
      .map((item) => conditionLabel({ extension: item }))
      .join(' OR ');
  }
  for (const operator of ['allOf', 'anyOf', 'oneOf']) {
    if (condition[operator]) {
      return condition[operator].map(conditionLabel).join(` ${operator} `);
    }
  }
  return JSON.stringify(condition);
}

export default function CsrDetails({ name, csr, owners = [], onClose }) {
  const [xlen, setXlen] = useState(64);
  const fields = useMemo(() => Object.entries(csr?.fields || {}), [csr]);
  const resolved = fields
    .map(([fieldName, field]) => ({ ...field, name: fieldName, range: bitRange(field.bits, xlen) }))
    .filter((field) => field.range)
    .sort((a, b) => b.range.high - a.range.high);
  const segments = [];
  let bit = xlen - 1;
  while (bit >= 0) {
    const field = resolved.find(({ range }) => range.high === bit);
    if (field) {
      const width = field.range.high - field.range.low + 1;
      segments.push({ field, high: bit, low: field.range.low, width });
      bit = field.range.low - 1;
      continue;
    }
    const nextField = resolved.find(({ range }) => range.high < bit);
    const low = nextField ? nextField.range.high + 1 : 0;
    segments.push({ high: bit, low, width: bit - low + 1 });
    bit = low - 1;
  }

  return (
    <section
      aria-label={`${name} CSR details`}
      className="mt-3 rounded-sm border p-3"
      style={{ borderColor: 'var(--riscv-border-2)', background: 'var(--riscv-surface-2)' }}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h4 className="font-mono font-bold" style={{ color: 'var(--riscv-text)' }}>
            {name.toUpperCase()}
          </h4>
          <p className="text-xs" style={{ color: 'var(--riscv-text-3)' }}>
            {csr?.desc || 'No description in the current source'} · address{' '}
            {formatAddress(csr?.address)}
            {csr?.priv_mode ? ` · ${csr.priv_mode}-mode` : ''} · {csr?.length || 'MXLEN'} bits
          </p>
          {owners.length > 0 && (
            <p className="mt-1 text-[11px]" style={{ color: 'var(--riscv-text-3)' }}>
              Listed with: {owners.join(', ')}
            </p>
          )}
        </div>
        <button type="button" className="riscv-btn px-2 py-1 text-xs" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="mt-3 flex items-center gap-2 text-xs" role="group" aria-label="CSR width">
        <span style={{ color: 'var(--riscv-text-3)' }}>Register width</span>
        {[32, 64].map((width) => (
          <button
            key={width}
            type="button"
            aria-pressed={xlen === width}
            className="riscv-btn px-2 py-1"
            onClick={() => setXlen(width)}
          >
            RV{width}
          </button>
        ))}
      </div>

      {resolved.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <div
            className="grid gap-px"
            style={{
              gridTemplateColumns: `repeat(${xlen}, minmax(0, 1fr))`,
              minWidth: `${xlen * 12}px`,
            }}
            aria-label={`Known ${xlen}-bit CSR fields`}
          >
            {segments.map((segment, index) => {
              const { field } = segment;
              return (
                <div
                  key={`${segment.high}-${segment.low}-${index}`}
                  title={
                    field
                      ? `${field.name} [${segment.high}:${segment.low}]`
                      : `Bits ${segment.high}:${segment.low} are not described in the source`
                  }
                  className="h-8 overflow-hidden text-center text-[9px] leading-8"
                  style={{
                    background: field ? 'var(--riscv-violet-dim)' : 'var(--riscv-surface)',
                    color: 'var(--riscv-text)',
                    border: '1px solid var(--riscv-border-2)',
                    gridColumn: `span ${segment.width}`,
                  }}
                >
                  {field ? `${field.name} ${segment.high}:${segment.low}` : 'Unspecified'}
                </div>
              );
            })}
          </div>
          <div
            className="mt-1 flex justify-between font-mono text-[10px]"
            style={{ color: 'var(--riscv-text-3)' }}
          >
            <span>{xlen - 1}</span>
            <span>0</span>
          </div>
        </div>
      )}

      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead style={{ color: 'var(--riscv-text-3)' }}>
            <tr>
              <th className="pr-2">Bits</th>
              <th className="pr-2">Field</th>
              <th className="pr-2">Access</th>
              <th className="pr-2">Reset</th>
              <th>Defined when</th>
            </tr>
          </thead>
          <tbody>
            {fields.map(([fieldName, field]) => {
              const bits = typeof field.bits === 'string' ? field.bits : field.bits?.[`rv${xlen}`];
              return (
                <tr key={fieldName} style={{ color: 'var(--riscv-text)' }}>
                  <td className="pr-2 font-mono">{bits || 'not defined for this XLEN'}</td>
                  <td className="pr-2 font-mono">{fieldName}</td>
                  <td className="pr-2">
                    {field.type === 'dynamic' ? 'Configuration-dependent' : field.type || 'Unknown'}
                  </td>
                  <td>
                    {field.reset === 'dynamic'
                      ? 'Configuration-dependent'
                      : field.reset || 'Unknown'}
                  </td>
                  <td>{conditionLabel(field.defined_by)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {resolved.length !== fields.length && (
        <p className="mt-2 text-[11px]" style={{ color: 'var(--riscv-text-3)' }}>
          Some field positions are symbolic, out of range for RV{xlen}, or unspecified in the source
          and are listed without a diagram position.
        </p>
      )}
      {!csr?.fields && (
        <p className="mt-2 text-xs" style={{ color: 'var(--riscv-text-3)' }}>
          Field data is not available in the current catalogue source.
        </p>
      )}
      {csr?.fields && Object.keys(csr.fields).length === 0 && (
        <p className="mt-2 text-xs" style={{ color: 'var(--riscv-text-3)' }}>
          The source defines this CSR but does not provide a field map yet.
        </p>
      )}
      <p className="mt-2 text-[10px]" style={{ color: 'var(--riscv-text-3)' }}>
        Field positions, access types, reset values, and conditions follow the recorded source;
        dynamic values depend on the implementation configuration.
      </p>
      {csr?.source ? (
        <a
          className="mt-1 inline-flex items-center text-[10px] underline"
          style={{ color: 'var(--riscv-violet)' }}
          href={csr.source}
          target="_blank"
          rel="noreferrer"
        >
          Open pinned CSR source
        </a>
      ) : (
        <p className="mt-1 text-[10px]" style={{ color: 'var(--riscv-text-3)' }}>
          No upstream CSR source is recorded for this entry.
        </p>
      )}
    </section>
  );
}
