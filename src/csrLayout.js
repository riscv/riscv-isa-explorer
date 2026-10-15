/**
 * csrLayout.js — turns a catalogue CSR entry into what the CSR details view
 * draws: a register diagram in 32-bit rows, plus readable access, reset and
 * condition text for the field table.
 *
 * Pure: no React, no catalogue import. The entry comes from UDB through the
 * extension sync, so values are kept as UDB states them and only their
 * presentation changes here.
 *
 * Two things the old flat strip got wrong and this module exists to get right:
 *  - The diagram width is the register's own width. A CSR UDB records as 32 or
 *    64 bits has that width at either XLEN; only an MXLEN register follows the
 *    RV32/RV64 choice. Drawing a 32-bit CSR on a 64-bit strip left half of it
 *    labelled "Unspecified".
 *  - 64 one-bit columns do not fit a side panel, so the register is drawn as
 *    rows of 32 bits, high row first, the way the ISA manual draws mstatus.
 */

export const ROW_BITS = 32;

/** The register's width in bits for the chosen XLEN. */
export function csrWidth(csr, xlen) {
  const fixed = Number(csr?.length);
  return fixed === 32 || fixed === 64 ? fixed : xlen;
}

/** Whether the RV32/RV64 choice changes anything for this register. */
export function csrDependsOnXlen(csr) {
  if (csrWidth(csr, 32) !== csrWidth(csr, 64)) return true;
  return Object.values(csr?.fields || {}).some(
    (field) => field.bits && typeof field.bits === 'object',
  );
}

function selectedBits(bits, xlen) {
  return typeof bits === 'string' ? bits : bits?.[`rv${xlen}`];
}

/** `{ high, low }` for a field at this XLEN, or null when it has no position. */
export function bitRange(bits, xlen, width = xlen) {
  const selected = selectedBits(bits, xlen);
  if (!selected || !/^\d+(?:-\d+)?$/.test(selected)) return null;
  const [high, low = high] = selected.split('-').map(Number);
  if (high < low || high >= width) return null;
  return { high, low };
}

/** Whether a defined_by tree rules the field out at this XLEN. */
function excludedAtXlen(condition, xlen) {
  if (!condition) return false;
  if (condition.xlen) return Number(condition.xlen) !== xlen;
  if (condition.allOf) return condition.allOf.some((item) => excludedAtXlen(item, xlen));
  if (condition.anyOf) return condition.anyOf.every((item) => excludedAtXlen(item, xlen));
  return false;
}

/**
 * The fields present at this XLEN, highest bit first, each with its range.
 * Fields that exist only at the other XLEN are counted, not returned, so the
 * table does not list bits the reader cannot have.
 */
export function csrFields(csr, xlen) {
  const width = csrWidth(csr, xlen);
  const present = [];
  let otherXlen = 0;
  for (const [name, field] of Object.entries(csr?.fields || {})) {
    if (excludedAtXlen(field.defined_by, xlen) || (field.bits && !selectedBits(field.bits, xlen))) {
      otherXlen += 1;
      continue;
    }
    present.push({ ...field, name, range: bitRange(field.bits, xlen, width) });
  }
  present.sort((a, b) => (b.range?.high ?? -1) - (a.range?.high ?? -1));
  return { fields: present, otherXlen };
}

/**
 * The register diagram: rows of up to ROW_BITS bits, high row first. Each
 * segment is a field (or the part of one that falls in this row) or a gap no
 * field describes. A field wider than a row appears once per row it covers.
 */
export function csrRows(fields, width) {
  const placed = fields.filter((field) => field.range);
  const rows = [];
  for (let top = width - 1; top >= 0; top -= ROW_BITS) {
    const bottom = Math.max(0, top - ROW_BITS + 1);
    const segments = [];
    let bit = top;
    while (bit >= bottom) {
      const field = placed.find(({ range }) => range.high >= bit && range.low <= bit);
      if (field) {
        const low = Math.max(field.range.low, bottom);
        segments.push({ field, high: bit, low, width: bit - low + 1 });
        bit = low - 1;
        continue;
      }
      const next = placed
        .filter(({ range }) => range.high < bit)
        .reduce((best, f) => (!best || f.range.high > best.range.high ? f : best), null);
      const low = Math.max(next ? next.range.high + 1 : 0, bottom);
      segments.push({ field: null, high: bit, low, width: bit - low + 1 });
      bit = low - 1;
    }
    rows.push({ high: top, low: bottom, bits: top - bottom + 1, segments });
  }
  return rows;
}

/**
 * UDB's field types, grouped by what a reader needs to know: can software
 * write it, and can hardware change it underneath.
 */
export const ACCESS_TYPES = {
  RW: { kind: 'rw', label: 'RW', meaning: 'Read/write' },
  'RW-R': { kind: 'rw', label: 'RW-R', meaning: 'Read/write, only legal values are kept' },
  'RW-H': { kind: 'hw', label: 'RW-H', meaning: 'Read/write, hardware also updates it' },
  'RW-RH': {
    kind: 'hw',
    label: 'RW-RH',
    meaning: 'Read/write with legal values only, hardware also updates it',
  },
  RO: { kind: 'ro', label: 'RO', meaning: 'Read-only' },
  'RO-H': { kind: 'ro', label: 'RO-H', meaning: 'Read-only, hardware updates it' },
  dynamic: {
    kind: 'cfg',
    label: 'Config',
    meaning: 'Access type depends on the implementation configuration',
  },
};

export function accessInfo(type) {
  return ACCESS_TYPES[type] || { kind: 'cfg', label: type || '?', meaning: 'Not recorded' };
}

/** The reset value as a reader would say it. */
export function resetLabel(reset) {
  if (reset === undefined || reset === null || reset === '') return 'Not recorded';
  if (reset === 'dynamic') return 'Config-dependent';
  if (reset === 'UNDEFINED_LEGAL') return 'Any legal value';
  if (/^\d+$/.test(String(reset))) {
    const n = Number(reset);
    return n > 9 && Number.isSafeInteger(n) ? `0x${n.toString(16)}` : String(n);
  }
  return String(reset);
}

/**
 * A defined_by tree as short terms: a list ANDed together, each term itself
 * possibly an "A or B". An empty list means the field is always present.
 * XLEN terms are dropped when the view is already at that XLEN, since a field
 * failing one is not listed at all.
 */
export function conditionTerms(condition, xlen) {
  if (!condition) return [];
  if (condition.xlen) {
    return Number(condition.xlen) === xlen ? [] : [`RV${condition.xlen}`];
  }
  if (condition.allOf) return condition.allOf.flatMap((item) => conditionTerms(item, xlen));
  if (condition.anyOf || condition.oneOf) {
    const parts = (condition.anyOf || condition.oneOf).map((item) =>
      conditionTerms(item, xlen).join(' + '),
    );
    return parts.some((part) => !part) ? [] : [parts.join(' or ')];
  }
  if (condition.extension) {
    const ext = condition.extension;
    if (ext.name) return [ext.version ? `${ext.name} ${ext.version}` : ext.name];
    if (ext.allOf) return ext.allOf.flatMap((item) => conditionTerms({ extension: item }, xlen));
    if (ext.anyOf || ext.oneOf) {
      return conditionTerms(
        { anyOf: (ext.anyOf || ext.oneOf).map((e) => ({ extension: e })) },
        xlen,
      );
    }
  }
  if (condition.param?.name) {
    const { name, equal } = condition.param;
    return [equal === true ? name : `${name} = ${String(equal)}`];
  }
  return [JSON.stringify(condition)];
}

export function formatAddress(address) {
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

// A numbered family needs at least this many members before it folds into one
// chip; two or three (mstatus/mstatush-style pairs aside) read fine as they are.
const FAMILY_MIN = 4;

/**
 * The CSR chip list: names in natural order (pmpaddr2 before pmpaddr10), with
 * numbered families folded into one entry each. Sm alone lists 64 pmpaddr and
 * 16 pmpcfg registers, which as separate chips buried everything else.
 * The trailing `h` of an RV32 high half stays part of the family key, so
 * mhpmcounter3..31 and mhpmcounter3h..31h are two families.
 */
export function groupCsrNames(names) {
  const families = new Map();
  for (const name of names) {
    const match = /^(.*?[a-z])(\d+)(h?)$/i.exec(name);
    if (!match) continue;
    const key = `${match[1]}#${match[3]}`;
    if (!families.has(key)) families.set(key, []);
    families.get(key).push({ name, index: Number(match[2]) });
  }
  const folded = new Map();
  for (const [key, members] of families) {
    if (members.length < FAMILY_MIN) continue;
    members.sort((a, b) => a.index - b.index);
    const [stem, suffix] = key.split('#');
    const first = members[0].index;
    const last = members[members.length - 1].index;
    const family = {
      kind: 'family',
      key,
      label: `${stem}${first}${suffix}–${last}${suffix}`,
      members,
      sortName: members[0].name,
    };
    for (const member of members) folded.set(member.name, family);
  }
  const items = [];
  const seen = new Set();
  for (const name of names) {
    const family = folded.get(name);
    if (family) {
      if (!seen.has(family.key)) {
        seen.add(family.key);
        items.push(family);
      }
    } else {
      items.push({ kind: 'single', name, sortName: name });
    }
  }
  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  return items.sort((a, b) => collator.compare(a.sortName, b.sortName));
}
