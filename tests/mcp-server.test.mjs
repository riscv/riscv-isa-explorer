/**
 * The MCP server (mcp/): its tools, the protocol surface and the published
 * bundle.
 *
 * The tools must agree with the web app, so the -march and profile checks
 * compare against the same functions the app and CI's clang matrix call
 * rather than against stored strings. The protocol tests go through the SDK's
 * own client, once in memory and once over stdio against the real binary,
 * because a server that answers correctly but never completes the handshake
 * is useless to every client.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { explorer } from '../mcp/lib/explorer.mjs';
import { createTools, ToolInputError } from '../mcp/lib/tools.mjs';
import { createServer } from '../mcp/lib/server.mjs';
import { FILES } from '../mcp/scripts/bundle.mjs';
import { resolveSelection, EDGE_SOURCES } from '../src/isaGraph.js';
import { buildMarchString } from '../src/marchUtils.js';
import { PROFILES } from '../src/profiles.js';

const tools = createTools(explorer);
const ALL = Object.values(explorer.catalog).flat();
const IDS = new Set(ALL.map((e) => e.id));

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

test('every profile gets the same -march string the app and the clang matrix build', () => {
  for (const [profile, members] of Object.entries(PROFILES)) {
    const base = members.find((id) => /^RV(32|64|128)[IE]$/.test(id)) ?? null;
    const { resolved } = resolveSelection({ selected: members, base });
    const expected = buildMarchString(
      resolved.filter((id) => IDS.has(id)),
      ALL,
    ).march;
    assert.equal(tools.getProfile({ profile }).march, expected, profile);
  }
});

test('resolve_configuration resolves, cites and builds -march', () => {
  const r = tools.resolveConfiguration({ base: 'rv64i', extensions: ['m', 'A', 'F', 'D', 'C'] });
  assert.equal(r.base, 'RV64I');
  assert.equal(r.valid, true);
  assert.match(r.march, /^rv64imafdc_/);
  const zmmul = r.implied.find((i) => i.ext === 'Zmmul');
  assert.deepEqual(zmmul.path, ['M', 'Zmmul']);
  assert.ok(EDGE_SOURCES.has(zmmul.because[0].source));
});

test('resolve_configuration reports conflicts and unknown ids instead of hiding them', () => {
  const conflict = tools.resolveConfiguration({ base: 'RV32E', extensions: ['F'] });
  assert.equal(conflict.valid, false);
  assert.ok(conflict.conflicts.some((c) => c.ext === 'F' || c.with === 'F'));

  const unknown = tools.resolveConfiguration({ base: 'RV64I', extensions: ['Zbx'] });
  assert.equal(unknown.valid, false);
  assert.equal(unknown.unknown[0].ext, 'Zbx');
  assert.ok(unknown.unknown[0].suggestions.includes('Zbb'));
});

test('a parsed -march string comes back canonical, with what it left unwritten', () => {
  const p = tools.parseMarch({ march: 'rv64gc_zba' });
  assert.equal(p.base, 'RV64I');
  assert.ok(p.extensions.includes('Zba'));
  assert.match(p.canonical_march, /^rv64imafdc_/, 'g is written out, never emitted');
  assert.ok(p.implied_but_not_written.some((i) => i.ext === 'Zca'));
});

test('every step of an explained dependency carries a citation', () => {
  const e = tools.explainDependency({ extension: 'zvkn', requires: 'zve32x' });
  assert.equal(e.answer, true);
  assert.equal(e.path[0], 'Zvkn');
  assert.equal(e.path.at(-1), 'Zve32x');
  for (const step of e.because) assert.ok(EDGE_SOURCES.has(step.source), JSON.stringify(step));

  const no = tools.explainDependency({ extension: 'F', requires: 'D' });
  assert.equal(no.answer, false);
  assert.match(no.explanation, /D requires F/);
});

test('get_extension links the spec and the site, and lists profiles', () => {
  const zba = tools.getExtension({ id: 'zba' });
  assert.equal(zba.explorer_url, 'https://tech.riscv.org/isa-explorer/ext/zba/');
  assert.match(zba.spec_url, /^https:\/\//);
  assert.deepEqual(
    zba.profiles.find((p) => p.profile === 'RVA23'),
    { profile: 'RVA23', requirement: 'mandatory' },
  );
  assert.ok(!('instructions' in zba));
  assert.ok(
    tools.getExtension({ id: 'Zba', include_instructions: true }).instructions.includes('SH1ADD'),
  );
});

test('profile comparison classifies every extension once per profile', () => {
  const c = tools.compareProfiles({ profiles: ['RVA22', 'rva23'] });
  assert.deepEqual(c.profiles, ['RVA22', 'RVA23']);
  assert.equal(c.rows.length, c.extensions_compared);
  const allowed = new Set(['mandatory', 'implied', 'optional', null]);
  for (const row of c.rows) for (const p of c.profiles) assert.ok(allowed.has(row[p]), row.id);
  assert.ok(c.only_in.RVA23.includes('H'));
  const diff = tools.compareProfiles({ profiles: ['RVA22', 'RVA23'], differences_only: true });
  assert.equal(diff.rows.length, c.differing);
  assert.throws(() => tools.compareProfiles({ profiles: ['RVA23', 'rva23'] }), ToolInputError);
});

test('every instruction decodes back from its own match value', () => {
  for (const ext of ALL) {
    for (const [mnemonic, details] of Object.entries(ext.instructions ?? {})) {
      const decoded = tools.decodeInstruction({ word: details.match });
      assert.ok(
        decoded.matches.some((m) => m.mnemonic === mnemonic),
        `${mnemonic} (${details.match}) did not decode to itself`,
      );
    }
  }
});

test('decode_instruction reads 16-bit words and names the most specific match first', () => {
  assert.equal(tools.decodeInstruction({ word: '0x00b50533' }).matches[0].mnemonic, 'ADD');
  const c = tools.decodeInstruction({ word: '0x4505' });
  assert.equal(c.length, 16);
  assert.equal(c.matches[0].mnemonic, 'C.LI');
  assert.equal(tools.decodeInstruction({ word: '0b0100010100000101' }).matches[0].mnemonic, 'C.LI');
});

test('bad input is a ToolInputError that says what would work', () => {
  const cases = [
    [() => tools.getExtension({ id: 'Zbx' }), /Did you mean: .*Zbb/],
    [() => tools.getProfile({ profile: 'RVA99' }), /Known profiles: .*RVA23/],
    [() => tools.resolveConfiguration({ base: 'RV16I', extensions: [] }), /RV64I/],
    [() => tools.lookupInstruction({ mnemonic: 'sh1' }), /SH1ADD/],
    [() => tools.decodeInstruction({ word: '0x1ffffffff' }), /32-bit/],
    [() => tools.parseMarch({ march: '' }), /required/],
  ];
  for (const [call, message] of cases) {
    assert.throws(call, (e) => e instanceof ToolInputError && message.test(e.message));
  }
});

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

async function connectedClient() {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(explorer).connect(serverSide);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientSide);
  return client;
}

test('the server lists every tool, each read-only and described', async () => {
  const client = await connectedClient();
  const { tools: listed } = await client.listTools();
  assert.deepEqual(listed.map((t) => t.name).sort(), [
    'about',
    'compare_profiles',
    'decode_instruction',
    'explain_dependency',
    'get_extension',
    'get_profile',
    'list_extensions',
    'list_profiles',
    'lookup_instruction',
    'parse_march',
    'resolve_configuration',
  ]);
  for (const t of listed) {
    assert.equal(t.annotations?.readOnlyHint, true, t.name);
    assert.ok(t.description.length > 40, `${t.name} needs a description a model can act on`);
  }
  assert.match(client.getInstructions(), /instead of answering from memory/);
  await client.close();
});

test('a tool call returns JSON text, and bad input comes back as a tool error', async () => {
  const client = await connectedClient();
  const ok = await client.callTool({
    name: 'resolve_configuration',
    arguments: { base: 'RV64I', extensions: ['M', 'C'] },
  });
  assert.ok(!ok.isError);
  assert.match(JSON.parse(ok.content[0].text).march, /^rv64imc/);

  const bad = await client.callTool({ name: 'get_extension', arguments: { id: 'Nope' } });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /Unknown extension/);

  const invalid = await client.callTool({
    name: 'resolve_configuration',
    arguments: { base: 'RV64I' },
  });
  assert.equal(invalid.isError, true, 'a missing required argument is rejected by the schema');
  await client.close();
});

test('the published binary completes the handshake over stdio', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../mcp/bin/riscv-isa-explorer-mcp.mjs', import.meta.url))],
    stderr: 'ignore',
  });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(transport);
  const pkg = JSON.parse(readFileSync(new URL('../mcp/package.json', import.meta.url), 'utf8'));
  assert.equal(client.getServerVersion().version, pkg.version);
  const about = await client.callTool({ name: 'about', arguments: {} });
  assert.equal(JSON.parse(about.content[0].text).extensions, ALL.length);
  await client.close();
});

// ---------------------------------------------------------------------------
// Bundle
// ---------------------------------------------------------------------------

test('the bundle copies every module the server loads, and everything they import', () => {
  const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
  const loaded = [
    ...readFileSync(new URL('../mcp/lib/explorer.mjs', import.meta.url), 'utf8').matchAll(
      /(?:load|readJson\(join\(SOURCE_DIR,)\s*\(?'([^']+)'/g,
    ),
  ].map((m) => m[1]);
  assert.ok(loaded.length >= 10, `found only ${loaded.length} loads in explorer.mjs`);
  const pending = [...loaded];
  const seen = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    assert.ok(FILES.includes(file), `${file} is used but not bundled`);
    if (!file.endsWith('.js')) continue;
    for (const [, dep] of src(file).matchAll(/from '\.\/([^']+)'/g)) pending.push(dep);
  }
});
