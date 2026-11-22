#!/usr/bin/env node
/**
 * Report the results of validate.rb (#589).
 *
 *   node scripts/udb-validate/report.mjs <results.json> [--baseline <file>]
 *        [--summary <file>] [--strict]
 *
 * Default (the matrix): fails only on a STRUCTURAL failure the baseline does
 * not accept, and lists baseline entries that now pass so they can be removed.
 * --strict (one configuration someone asked about): fails on any reason, and
 * prints every one, value failures included.
 *
 * --summary appends Markdown, for $GITHUB_STEP_SUMMARY.
 * --configs <dir> also compares the builder's parameter model with UDB's
 * verdicts on those files (agree.mjs) and fails on any disagreement.
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { classifyReason, compareWithBaseline } from './classify.mjs';
import { compareWithModel } from './agree.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const resultsPath = args[0];
if (!resultsPath || resultsPath.startsWith('--')) {
  console.error('usage: report.mjs <results.json> [--baseline f] [--summary f] [--strict]');
  process.exit(2);
}
const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
const baselinePath = flag('--baseline');
const baseline = baselinePath ? JSON.parse(fs.readFileSync(baselinePath, 'utf8')).accepted : {};
const summaryPath = flag('--summary');
const strict = args.includes('--strict');
const md = [];
// Backslashes first, so an escaped pipe cannot be un-escaped by one in the input.
const cell = (s) => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, '<br>');

let failed;
if (strict) {
  md.push('## udb validate cfg', '');
  for (const r of results) {
    md.push(`**${r.name}**: ${r.valid ? 'valid' : 'invalid'}`, '');
    if (r.error) md.push(`UDB raised \`${r.error}\``, '');
    if (r.reasons?.length) {
      md.push('| Kind | Reason |', '|---|---|');
      for (const reason of r.reasons) md.push(`| ${classifyReason(reason)} | ${cell(reason)} |`);
      md.push('');
    }
  }
  failed = results.some((r) => !r.valid);
} else {
  const { fresh, stillKnown, fixed, valueFailures, checked } = compareWithBaseline(
    results,
    baseline,
  );
  const valid = results.filter((r) => r.valid).length;
  md.push(
    '## UDB export check',
    '',
    `${checked} configurations: ${valid} valid as filled; ${fresh.length} new structural ` +
      `failure(s), ${stillKnown.length} accepted in the baseline, ${valueFailures} value ` +
      'failure(s) from the filled values (not checked).',
    '',
  );
  if (fresh.length) {
    md.push('### New structural failures', '', '| Configuration | Reason |', '|---|---|');
    for (const f of fresh) md.push(`| ${f.name} | ${cell(f.reason)} |`);
    md.push('');
  }
  if (fixed.length) {
    md.push(
      '### Baseline entries that now pass',
      '',
      'Remove these from `scripts/udb-validate/baseline.json`.',
      '',
      '| Configuration | Reason |',
      '|---|---|',
    );
    for (const f of fixed) md.push(`| ${f.name} | ${cell(f.reason)} |`);
    md.push('');
  }
  failed = fresh.length > 0;
}

const configsDir = flag('--configs');
if (configsDir) {
  const configs = {};
  for (const file of fs.readdirSync(configsDir).filter((f) => f.endsWith('.yaml'))) {
    const text = fs.readFileSync(path.join(configsDir, file), 'utf8');
    configs[file.slice(0, -5)] = YAML.parse(text, { intAsBigInt: true });
  }
  const disagreements = compareWithModel(results, configs);
  md.push(
    '### Parameter model against UDB',
    '',
    disagreements.length
      ? `${disagreements.length} disagreement(s) between the builder's parameter model and UDB:`
      : `The builder's parameter model agrees with UDB on all ${results.length} configurations.`,
    '',
  );
  if (disagreements.length) {
    md.push('| Configuration | Check | Parameter | Flagged by |', '|---|---|---|---|');
    for (const d of disagreements.slice(0, 200)) {
      md.push(`| ${d.name} | ${d.kind} | ${d.param} | ${d.udb ? 'UDB only' : 'model only'} |`);
    }
    md.push('');
    failed = true;
  }
}

const text = md.join('\n');
console.log(text);
if (summaryPath) fs.appendFileSync(summaryPath, `${text}\n`);
process.exit(failed ? 1 : 0);
