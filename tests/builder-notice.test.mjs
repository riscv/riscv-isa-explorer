/**
 * The builder's "verify this" caveat (src/builderNotice.js, #581).
 *
 * The builder's output reads like a recommendation, so the caveat has to reach
 * every place that output goes: the builder itself, the -march line people
 * copy, and every exported file, which travels without the UI. These tests
 * check each surface carries it, rather than the exact wording.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import {
  BUILDER_NOTICE,
  MARCH_NOTE,
  CONFIG_EXPORT_NOTICE,
  PROFILE_EXPORT_NOTICE,
  REPORT_URL,
} from '../src/builderNotice.js';
import { buildIsaConfigYaml } from '../src/exportUtils.js';
import {
  buildProfileExport,
  profileMembership,
  profileExtensionRows,
} from '../src/profileExport.js';
import { PROFILES, PROFILE_METADATA } from '../src/profiles.js';
import { closure } from '../src/isaGraph.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const catalogue = JSON.parse(read('../src/riscv_extensions.json'));
const ALL = Object.values(catalogue).flat().filter(Boolean);

test('every configuration export carries the notice in its header', () => {
  for (const format of [undefined, 'udb', 'riscv-config']) {
    const { yaml } = buildIsaConfigYaml(['RV64I', 'M', 'A'], ALL, format ? { format } : {});
    const header = yaml.split('\n').filter((l) => l.startsWith('#'));
    for (const line of CONFIG_EXPORT_NOTICE) {
      assert.ok(header.includes(`# ${line}`), `${format ?? 'landscape'} lacks "${line}"`);
    }
  }
});

test('the configuration export stays byte-identical across runs', () => {
  // The notice must not bring a date or version in with it.
  const a = buildIsaConfigYaml(['RV64I', 'M'], ALL).yaml;
  assert.equal(a, buildIsaConfigYaml(['RV64I', 'M'], ALL).yaml);
  assert.doesNotMatch(CONFIG_EXPORT_NOTICE.join(' '), /\d{4}-\d{2}-\d{2}/);
});

test('every profile export with metadata carries the notice', () => {
  const rows = profileExtensionRows({
    membership: profileMembership({ mandatory: PROFILES.RVA23, closure }),
    catalog: catalogue,
  });
  const input = { profile: 'RVA23', metadata: PROFILE_METADATA.RVA23, rows };
  const json = JSON.parse(buildProfileExport('json', input).data);
  assert.equal(json.notice, PROFILE_EXPORT_NOTICE);
  const yamlText = buildProfileExport('yaml', input).data;
  assert.equal(YAML.parse(yamlText).notice, PROFILE_EXPORT_NOTICE);
  assert.ok(yamlText.split('\n')[1].includes(PROFILE_EXPORT_NOTICE));
  // The .xlsx is a stored (uncompressed) zip, so the text is in its bytes.
  const xlsx = Buffer.from(buildProfileExport('xlsx', input).data).toString('utf8');
  assert.ok(xlsx.includes(PROFILE_EXPORT_NOTICE), 'xlsx Profile sheet lacks the notice');
});

test('the builder renders the notice, the -march note and an info toggle', () => {
  const src = read('../src/WorkspacePanel.jsx');
  assert.match(src, /<BuilderNotice onDismiss=\{dismissNotice\} \/>/);
  assert.match(src, /\{MARCH_NOTE\}/);
  assert.match(src, /aria-label="About these results"/);
  // Storage can throw; the notice must fall back to showing, never crash.
  assert.match(src, /function noticeDismissed\(\) \{\s*try \{/);
});

test('the notice names the toolchain row by its real label', () => {
  const label = read('../src/ToolchainSupport.jsx').includes('Accepted by');
  assert.ok(label, 'ToolchainSupport no longer says "Accepted by"; update the notice');
  assert.ok(BUILDER_NOTICE.points.some((p) => p.includes('“Accepted by”')));
});

test('the notice says what the output is not, and where to report', () => {
  const text = [BUILDER_NOTICE.intro, ...BUILDER_NOTICE.points, MARCH_NOTE].join(' ');
  assert.match(text, /not a compliance or certification statement/);
  assert.match(text, /Verify/);
  assert.match(REPORT_URL, /^https:\/\/github\.com\/riscv\/riscv-isa-explorer\/issues\/new$/);
});
