/**
 * exportFormats.js — the export menu's three files: their labels, the options
 * each passes to buildIsaConfigYaml, and their filenames. Pure, so the tests
 * can pin what ExportMenu.jsx offers (#611).
 */
import { buildMarchString } from './marchUtils.js';

/** What a format's file contains, for the values set so far. */
export function exportDetail(f, paramChoices) {
  return typeof f.detail === 'function' ? f.detail(paramChoices ?? {}) : f.detail;
}

/** The three files, in the order shown, and what each one is for. */
export const EXPORT_FORMATS = [
  {
    format: 'landscape',
    label: 'Download .yaml (Standard)',
    detail: 'Extensions, versions, constraints and the parameter values you set.',
    suffix: 'config',
  },
  {
    format: 'udb',
    label: 'Download UDB config (arch-test)',
    detail:
      'riscv-unified-db configuration for riscv-arch-test. Lists every parameter UDB requires, with TODO where you have not set one.',
    suffix: 'udb_config',
  },
  {
    format: 'riscv-config',
    label: 'Download riscv-config ISA spec',
    // Named, not counted: the export leaves Vendor and Device for you, and the
    // physical address width too unless the Parameters tab has set it.
    detail: (paramChoices = {}) =>
      Object.prototype.hasOwnProperty.call(paramChoices, 'PHYS_ADDR_WIDTH')
        ? 'ISA specification for riscv-config. You fill in Vendor and Device; the physical address width comes from the Parameters tab.'
        : 'ISA specification for riscv-config. You fill in Vendor, Device and the physical address width (or set PHYS_ADDR_WIDTH in the Parameters tab).',
    suffix: 'riscv_config_isa',
  },
];

/** The options the exporter takes for one format: always an object. */
export function exportOptions(format, { includeInstructions, paramChoices }) {
  return format === 'landscape'
    ? { includeInstructions, paramChoices: paramChoices ?? {} }
    : { format, paramChoices: paramChoices ?? {} };
}

/** riscv_rv64imafdc_udb_config.yaml */
export function exportFilename(format, ids, allExts) {
  const { march } = buildMarchString(ids, allExts);
  const base = march ? march.split('_')[0] : 'core';
  const { suffix } = EXPORT_FORMATS.find((f) => f.format === format) ?? EXPORT_FORMATS[0];
  return `riscv_${base}_${suffix}.yaml`;
}
