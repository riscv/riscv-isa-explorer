/**
 * The exported configuration file.
 *
 * A real export was 5,974 lines, 97% of it a derived instruction catalogue; its
 * isa_string omitted 14 extensions that march carried while claiming to hold
 * them all; and a timestamp made two exports of one configuration differ.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIsaConfigYaml } from '../src/exportUtils.js';
import { COMPILER_COMPAT_NOTES, SHORTHAND_BUNDLES } from '../src/marchUtils.js';
import { resolveSelection } from '../src/isaGraph.js';
import { PROFILES } from '../src/profiles.js';

const ALL = (() => {
  const file = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'src',
    'riscv_extensions.json',
  );
  return Object.values(JSON.parse(fs.readFileSync(file, 'utf8')))
    .flat()
    .filter(Boolean);
})();
const IDS = new Set(ALL.map((e) => e.id));
const resolve = (sel) =>
  resolveSelection({ selected: sel, base: 'RV64I' }).resolved.filter((i) => IDS.has(i));
const RVA23 = resolve(PROFILES.RVA23);

test('the instruction catalogue is opt-in', () => {
  const lean = buildIsaConfigYaml(RVA23, ALL).yaml;
  const full = buildIsaConfigYaml(RVA23, ALL, { includeInstructions: true }).yaml;
  // The export that prompted this was 5,974 lines. The ceiling is deliberately
  // loose: what matters is that the derived catalogue is gone, not an exact count.
  assert.ok(lean.split('\n').length < 500, `default export is ${lean.split('\n').length} lines`);
  assert.ok(full.split('\n').length > 1000, 'opting in should bring the catalogue back');
  assert.ok(!lean.includes('mnemonic:'), 'the default must not carry instructions');
});

test('the same selection exports byte-identically', () => {
  // No timestamp: two exports of one configuration differing on a date defeats
  // diffing and version control, which is what a config file is for.
  assert.equal(buildIsaConfigYaml(RVA23, ALL).yaml, buildIsaConfigYaml(RVA23, ALL).yaml);
  assert.ok(!/Generated:/.test(buildIsaConfigYaml(RVA23, ALL).yaml));
});

test('isa_string holds everything march does', () => {
  const { yaml } = buildIsaConfigYaml(RVA23, ALL);
  const isa = yaml
    .match(/^isa_string: (\S+)/m)[1]
    .toLowerCase()
    .split('_')
    .slice(1);
  const march = yaml
    .match(/^march: (\S+)/m)[1]
    .split('_')
    .slice(1);
  const missing = march.filter((t) => !isa.includes(t));
  assert.deepEqual(missing, [], 'isa_string must not omit extensions march carries');
});

test('the file says where its facts came from', () => {
  const { yaml } = buildIsaConfigYaml(RVA23, ALL);
  assert.match(yaml, /riscv-unified-db [0-9a-f]{7,}/, 'no UDB commit recorded');
  assert.match(yaml, /riscv-opcodes/);
});

test('inferred fields are labelled as inferred', () => {
  const { yaml } = buildIsaConfigYaml(RVA23, ALL);
  for (const field of ['user_spec_version', 'privilege_spec_version']) {
    const line = yaml.split('\n').find((l) => l.startsWith(field));
    assert.match(line, /# inferred/, `${field} is a guess and should say so`);
  }
});

test('the riscv-config format carries its required fields', () => {
  // Its schema requires exactly these five per hart, plus Vendor and Device.
  const { yaml } = buildIsaConfigYaml(RVA23, ALL, { format: 'riscv-config' });
  for (const field of [
    'ISA:',
    'User_Spec_Version:',
    'Privilege_Spec_Version:',
    'supported_xlen:',
    'physical_addr_sz:',
  ]) {
    assert.ok(yaml.includes(field), `riscv-config requires ${field}`);
  }
  assert.ok(yaml.includes('Vendor:') && yaml.includes('Device:'));
  assert.ok(yaml.includes('hart0:'));
});

test('the riscv-config ISA string follows their spelling, not ours', () => {
  const { yaml } = buildIsaConfigYaml(resolve(['RV64I', 'M', 'A', 'F', 'D', 'C']), ALL, {
    format: 'riscv-config',
  });
  const isa = yaml.match(/^ {2}ISA: (\S+)/m)[1];
  // First sub-extension attaches directly; theirs is not an underscore-led list.
  assert.match(isa, /^RV64I[A-Z]*Z[a-z]/, `first sub-extension must attach directly: ${isa}`);
  assert.ok(!/^RV64[A-Z]+_/.test(isa), 'no underscore before the first sub-extension');
});

test('V absorbs its vector members in the riscv-config format', () => {
  // riscv-config: "V and Zve* cannot exist together". clang tolerates the
  // redundant form, so only this format has to fold them in.
  const { yaml } = buildIsaConfigYaml(resolve(['RV64I', 'V']), ALL, { format: 'riscv-config' });
  const isa = yaml.match(/^ {2}ISA: (\S+)/m)[1];
  assert.ok(!/Zve|Zvl/i.test(isa), `V should absorb the vector sub-extensions: ${isa}`);
  assert.match(yaml, /folded into V/, 'the omission should be stated in the file');
});

test('the UDB format pins every extension to a version', () => {
  const { yaml } = buildIsaConfigYaml(resolve(['RV32I', 'M', 'C', 'Zba']), ALL, { format: 'udb' });
  // The whole point of the format: arch-test writes `version: "= 1.0.0"`, and
  // a name without one does not validate.
  assert.match(yaml, /kind: architecture configuration/);
  assert.match(yaml, /- \{ name: Zba, version: "= \d+\.\d+(\.\d+)?" \}/);
  for (const line of yaml.split('\n').filter((l) => l.trim().startsWith('- { name:'))) {
    assert.match(line, /version: "= \d/, `unpinned extension: ${line}`);
  }
});

test('the UDB format separates what it knows from what it cannot', () => {
  const { yaml, warnings } = buildIsaConfigYaml(resolve(['RV32I', 'M']), ALL, { format: 'udb' });
  // Someone hand-writing one of these cannot tell which params their extension
  // picks already forced. Losing that split makes the export a liability: it
  // would look complete while being roughly half a config.
  assert.match(yaml, /# GENERATED/, 'derived content should be labelled');
  assert.match(yaml, /# TODO — implementation choices/, 'undecidable content should be labelled');
  assert.match(yaml, /THIS FILE IS NOT COMPLETE/, 'the file must not read as ready to run');
  assert.ok(
    warnings.some((w) => /must be filled from your design document/.test(w)),
    'the caller should be warned, not only the file',
  );
});

test('the UDB format reports constraints with the extension that forced them', () => {
  const { yaml } = buildIsaConfigYaml(resolve(['RV64I', 'V', 'Zvl256b']), ALL, { format: 'udb' });
  // A bare "VLEN: 256" invites someone to lower it. Naming Zvl256b makes the
  // contradiction visible at the point of editing.
  assert.match(yaml, /# CONSTRAINED/);
  assert.match(yaml, /VLEN: 256.*required by .*Zvl256b/);
});

test('the UDB format flags unratified pins rather than hiding them', () => {
  // A ratified extension pins to a settled number; an unratified one pins to a
  // moving target. Both are legitimate, but only one is safe to forget about.
  const draft = ALL.find((e) => e.version && e.state && e.state !== 'ratified');
  if (!draft) return;
  const { yaml, warnings } = buildIsaConfigYaml(resolve(['RV64I', draft.id]), ALL, {
    format: 'udb',
  });
  if (!yaml.includes(`name: ${draft.id},`)) return;
  assert.match(yaml, new RegExp(`name: ${draft.id},.*version may still change`));
  assert.ok(warnings.some((w) => /not ratified/.test(w)));
});

test('the UDB export is reproducible', () => {
  const a = buildIsaConfigYaml(resolve(['RV64I', 'M', 'A']), ALL, { format: 'udb' }).yaml;
  const b = buildIsaConfigYaml(resolve(['RV64I', 'M', 'A']), ALL, { format: 'udb' }).yaml;
  assert.equal(a, b);
  assert.ok(!/Generated:/.test(a), 'no timestamp');
});

/**
 * A regression test that cannot go red is not a regression test.
 *
 * The first attempt at this assertion matched `^  - Sdext$` against the whole
 * document. Privileged extensions are emitted in the general `extensions:` list
 * as well, so the match landed there and the test passed even when nothing had
 * reached `privilege_extensions:` at all. Scope every assertion to the block it
 * is actually about.
 */
const section = (yaml, key) => {
  const lines = yaml.split('\n');
  const start = lines.indexOf(`${key}:`);
  if (start === -1) return null;
  const items = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[A-Za-z_]/.test(lines[i])) break; // next top-level key ends the block
    const m = /^ {2}- (\S+)$/.exec(lines[i]);
    if (m) items.push(m[1]);
  }
  return items;
};

test('every S-mode privileged family reaches privilege_extensions', () => {
  // One representative per S-family. Sd* and Su* were classified as ordinary
  // multi-letter extensions and silently fell through to `extensions:`.
  const families = ['Sdext', 'Sdtrig', 'Sddbltrp', 'Supm', 'Smepmp', 'Sv39'];
  const { yaml } = buildIsaConfigYaml(resolve(['RV64I', ...families]), ALL);
  const priv = section(yaml, 'privilege_extensions');

  assert.ok(priv, 'the export must contain a privilege_extensions block');
  for (const ext of families) {
    assert.ok(
      priv.includes(ext),
      `${ext} must appear under privilege_extensions; that block holds [${priv.join(', ')}]`,
    );
  }
});

/** The Z-extension tokens in a riscv-config ISA string, as exact names.
 *
 * Substring checks cannot do this job: `isa.includes('Zkn')` is satisfied by a
 * stray `Zknd`, so it passes in exactly the case the assertion exists to catch.
 */
const isaZTokens = (yaml) => yaml.match(/^ {2}ISA: (\S+)/m)[1].match(/Z[a-z][a-z0-9]*/g) || [];

test('every shorthand bundle absorbs its member subsets in the riscv-config format', () => {
  // riscv-config: "In presence of Zkn the subsets must be ignored in the ISA string".
  // clang tolerates the redundant form, but riscv-config rejects it outright.
  // Same absorption rule as V folding its Zve* and Zvl* vector members.
  for (const [shorthand, members] of Object.entries(SHORTHAND_BUNDLES)) {
    const { yaml } = buildIsaConfigYaml(resolve(['RV64I', shorthand]), ALL, {
      format: 'riscv-config',
    });
    const tokens = isaZTokens(yaml);
    assert.ok(tokens.includes(shorthand), `${shorthand} should survive: ${tokens.join('_')}`);
    for (const member of members) {
      assert.ok(
        !tokens.includes(member),
        `${shorthand} should absorb ${member}: ${tokens.join('_')}`,
      );
    }
    assert.match(
      yaml,
      new RegExp(`folded into ${shorthand}`),
      `${shorthand} absorption should be stated`,
    );
  }
});

test('an overlapping shorthand yields to the wider one, but a sibling suite survives', () => {
  // Zk lists Zkn among its members, so selecting both must leave Zk alone. Which
  // one wins depends on Object.entries order over SHORTHAND_BUNDLES, so this
  // regresses silently if that object is ever reordered.
  const nested = isaZTokens(
    buildIsaConfigYaml(resolve(['RV64I', 'Zk', 'Zkn']), ALL, { format: 'riscv-config' }).yaml,
  );
  assert.ok(nested.includes('Zk'), `Zk should survive: ${nested.join('_')}`);
  assert.ok(!nested.includes('Zkn'), `Zk should absorb Zkn: ${nested.join('_')}`);

  // Zks is the ShangMi suite and is NOT a member of Zk, so over-absorbing it
  // would silently drop crypto from the string rather than merely shorten it.
  const sibling = isaZTokens(
    buildIsaConfigYaml(resolve(['RV64I', 'Zk', 'Zks']), ALL, { format: 'riscv-config' }).yaml,
  );
  assert.ok(sibling.includes('Zk'), `Zk should survive: ${sibling.join('_')}`);
  assert.ok(
    sibling.includes('Zks'),
    `Zks is not a Zk member and must survive: ${sibling.join('_')}`,
  );
});

test('mutually exclusive base letters (I and E) are not emitted as extensions in export', () => {
  const { yaml, warnings } = buildIsaConfigYaml(['RV32E', 'I', 'M'], ALL, { format: 'landscape' });
  const isa = yaml.match(/^isa_string: (\S+)/m)[1];
  assert.ok(!/rv32ei/i.test(isa), `mutually exclusive base letters must not be combined: ${isa}`);
  assert.match(isa, /^RV32EM/);
  assert.ok(warnings.some((w) => /mutually exclusive/i.test(w)));
});

test('the compiler compatibility comment is emitted from marchUtils, not a local copy', () => {
  // The same prose lived in three hand-maintained places and drifted: the
  // export header claimed the vector-crypto family included Zvkg, the comment
  // written into every export omitted it, and marchUtils listed a fuller set.
  // Reading it from one export is what stops that recurring, so assert the
  // emitted block really is that export rather than a copy that matches today.
  const { yaml } = buildIsaConfigYaml(resolve(['RV64I', 'M', 'C']), ALL, { format: 'landscape' });
  assert.ok(COMPILER_COMPAT_NOTES.length > 0, 'the notes should not be empty');
  for (const note of COMPILER_COMPAT_NOTES) {
    assert.ok(
      yaml.includes(`#   ${note}`),
      `export must carry the note verbatim from marchUtils: ${note}`,
    );
  }

  // Carrying the text is not the same as reading it from one place: a local
  // copy that happens to match today would satisfy the loop above and then
  // drift, which is the exact failure this change exists to end. So also
  // assert exportUtils.js keeps no copy of its own.
  const exportSrc = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'exportUtils.js'),
    'utf8',
  );
  for (const note of COMPILER_COMPAT_NOTES) {
    assert.ok(!exportSrc.includes(note), `exportUtils.js must not hold its own copy of: ${note}`);
  }
});

test('the vector crypto note names its family by prefix, not by enumeration', () => {
  // Naming four of the 21 Zvk* entries in riscv_extensions.json is what went
  // stale. A prefix cannot.
  const note = COMPILER_COMPAT_NOTES.find((n) => /vector crypto/i.test(n));
  assert.ok(note, 'a vector crypto note should exist');
  assert.match(note, /Zvk\*/, 'name the family by prefix so it cannot drift as members are added');
});

test('an absorbed extension is reported once, by the bundle that absorbed it', () => {
  // The fold and the comment describing it used to be computed separately, so
  // with Zk and Zkn both selected Zbkb was absorbed once, by Zk, and reported
  // twice: as folded into Zkn and again into Zk. Two answers, one question.
  const { yaml } = buildIsaConfigYaml(
    ['RV64I', 'Zk', 'Zkn', 'Zbkb', 'Zbkc', 'Zbkx', 'Zknd', 'Zkne', 'Zknh', 'Zkr', 'Zkt'],
    ALL,
    { format: 'riscv-config' },
  );
  const blocks = [...yaml.matchAll(/folded into (\w+)[\s\S]*?carrying both: ([^\n]+)/g)];
  assert.equal(
    blocks.length,
    1,
    `overlapping bundles must yield one fold comment, got ${blocks.length}`,
  );
  assert.equal(blocks[0][1], 'Zk', 'the wider bundle is the one that absorbed them');
  const listed = blocks[0][2].split(',').map((t) => t.trim());
  assert.equal(new Set(listed).size, listed.length, 'no extension listed twice');
  assert.ok(listed.includes('Zbkb'), `Zbkb should be reported as folded: ${listed.join(', ')}`);
});

test('the UDB export keeps its required params for a bare base ISA', () => {
  // The floor. Every one of these is defined by Sm in unified-db, which makes
  // deriving them from the selected extensions look like the obvious cleanup and
  // makes it wrong: isa-dependency-graph.json gives RV32I `requires: []`, Sm is a
  // separate node, and nothing requires Sm. A derived list is EMPTY here, and the
  // export would drop every param riscv-arch-test needs without saying so.
  const yaml = buildIsaConfigYaml(['RV32I'], ALL, { format: 'udb' }).yaml;
  for (const name of [
    'PHYS_ADDR_WIDTH',
    'PRECISE_SYNCHRONOUS_EXCEPTIONS',
    'TRAP_ON_ECALL_FROM_M',
    'TRAP_ON_EBREAK',
    'M_MODE_ENDIANNESS',
    'MTVEC_ILLEGAL_WRITE_BEHAVIOR',
  ]) {
    assert.ok(yaml.includes(`${name}:`), `a bare RV32I export must still ask for ${name}`);
  }
});

test('UDB param hints come from the real schema, not from prose we wrote', () => {
  const yaml = buildIsaConfigYaml(['RV32I'], ALL, { format: 'udb' }).yaml;
  const line = yaml.split('\n').find((l) => l.trim().startsWith('PHYS_ADDR_WIDTH:'));
  assert.ok(line, 'PHYS_ADDR_WIDTH must be emitted');
  // The hardcoded fallback said "physical address width in bits". UDB says the
  // range, which is the part that stops someone writing 128.
  assert.match(line, /integer, 1 to 64/, `hint should come from UDB's schema, got: ${line}`);
});

test('every comment line in a UDB export is a single line', () => {
  // long_name and description are folded scalars upstream and land inside `#`
  // comments here. An embedded newline does not wrap the comment, it ends it,
  // and the remainder becomes a bare line that no YAML parser accepts.
  const yaml = buildIsaConfigYaml(RVA23, ALL, { format: 'udb' }).yaml;
  const orphans = yaml
    .split('\n')
    .filter(
      (l) =>
        /^\s*[a-z][^:#]*$/i.test(l) && l.trim() && !l.includes(':') && !l.trim().startsWith('-'),
    );
  assert.deepEqual(
    orphans,
    [],
    `comment text leaked onto its own line:\n  ${orphans.join('\n  ')}`,
  );
});

test('no exported param hint leads with an upstream placeholder', () => {
  // Distinct from the export's own TODO section, which is deliberate. This is
  // about `long_name: TODO` leaking from unified-db into a per-param hint, where
  // it reads as though we left the work unfinished.
  const yaml = buildIsaConfigYaml(RVA23, ALL, { format: 'udb' }).yaml;
  const leaked = yaml
    .split('\n')
    .filter((l) => /#\s*(TODO|TBD)[;:·]/i.test(l) || /·\s*(TODO|TBD)\b/i.test(l));
  assert.deepEqual(
    leaked,
    [],
    `placeholder names leaked into the export:\n  ${leaked.join('\n  ')}`,
  );
});

test('a UDB export never emits the same param key twice', () => {
  // YAML forbids duplicate keys, so this is invalidity rather than untidiness.
  // No graph constraint currently names one of the hardcoded floor params, which
  // is exactly why it needs a test: the day one does, the export breaks and
  // nothing else would notice.
  for (const selection of [['RV32I'], ['RV64I'], RVA23]) {
    const yaml = buildIsaConfigYaml(selection, ALL, { format: 'udb' }).yaml;
    const keys = yaml
      .split('\n')
      .map((l) => /^ {2}([A-Z][A-Z0-9_]*):/.exec(l))
      .filter(Boolean)
      .map((m) => m[1]);
    const seen = new Set();
    const dupes = keys.filter((k) => (seen.has(k) ? true : (seen.add(k), false)));
    assert.deepEqual(dupes, [], `duplicate keys for ${selection.join('+')}: ${dupes.join(', ')}`);
  }
});

test('a UDB export keeps the oneOf value the user picked', () => {
  // The builder offers these as buttons and the landscape export has always
  // recorded the pick. Emitting TODO here regardless threw the choice away and
  // asked for it again in a text editor.
  const sel = ['RV64I', 'Ssube'];
  const withChoice = buildIsaConfigYaml(sel, ALL, {
    format: 'udb',
    paramChoices: { U_MODE_ENDIANNESS: 'big' },
  }).yaml;
  const without = buildIsaConfigYaml(sel, ALL, { format: 'udb' }).yaml;

  const line = withChoice.split('\n').find((l) => l.trim().startsWith('U_MODE_ENDIANNESS:'));
  assert.ok(line, 'U_MODE_ENDIANNESS must appear');
  assert.match(line, /U_MODE_ENDIANNESS: "big"/, `the pick should be the value, got: ${line}`);
  assert.doesNotMatch(line, /TODO/, 'a chosen value is not a TODO');
  // And without a choice it stays a TODO, so the test cannot pass vacuously.
  const bare = without.split('\n').find((l) => l.trim().startsWith('U_MODE_ENDIANNESS:'));
  assert.match(bare, /TODO/, `unchosen should still be a TODO, got: ${bare}`);
});
