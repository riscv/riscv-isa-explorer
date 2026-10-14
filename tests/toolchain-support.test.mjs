/**
 * Toolchain support (src/toolchain-support.json): the first Clang, GCC,
 * binutils, QEMU and Linux release that knows each extension. The parsers are fed small
 * pieces of each source format the toolchains have used, the data is checked
 * against facts from the release notes, and the builder's arithmetic is
 * checked on a real -march.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import {
  addBases,
  addBundles,
  bundlesByParts,
  addQemuImplied,
  parseBinutils,
  parseGccCommon,
  parseGccExtDef,
  parseLinux,
  parseLlvmFeatures,
  parseLlvmIsaInfo,
  parseLlvmUsage,
  parseQemu,
  standing,
  suspiciousDrops,
  unacceptedDrops,
} from '../scripts/toolchain-support.mjs';
import {
  extensionSupport,
  marchRequirements,
  marchToken,
  marchTokens,
} from '../src/toolchainSupport.js';
import { NON_MARCH_IDS } from '../src/marchUtils.js';
import {
  COMPILER_EXPLORER_COMPILERS,
  COMPILER_EXPLORER_UNSUPPORTED,
} from '../src/instructionUsage.js';

const require = createRequire(import.meta.url);
const data = require('../src/toolchain-support.json');
const graph = require('../src/isa-dependency-graph.json');
const catalog = require('../src/riscv_extensions.json');
const extensions = Object.values(catalog).flat().filter(Boolean);

test('LLVM 14-18: the two arrays in RISCVISAInfo.cpp', () => {
  const parsed = parseLlvmIsaInfo(`
static const RISCVSupportedExtension SupportedExtensions[] = {
    {"i", RISCVExtensionVersion{2, 0}},
    {"zba", RISCVExtensionVersion{1, 0}},
};
static const RISCVSupportedExtension SupportedExperimentalExtensions[] = {
    {"zvbb", {0, 9}},
};`);
  assert.deepEqual(Object.fromEntries(parsed), {
    i: 'supported',
    zba: 'supported',
    zvbb: 'experimental',
  });
});

test('LLVM 19+: named and unnamed extension records, and the Zvl loop', () => {
  const named = parseLlvmFeatures(`
def FeatureStdExtZba
    : RISCVExtension<"zba", 1, 0, "'Zba' (Address Generation)">;
def FeatureStdExtZacas
    : RISCVExperimentalExtension<"zacas", 1, 0, "'Zacas'">;
def FeatureStdExtZvl32b : RISCVExtension<"zvl32b", 1, 0, "Zvl", [], "ZvlLen", "32">;
foreach i = { 6-8 } in {
  defvar I = !shl(1, i);
  def FeatureStdExtZvl#I#b :
      RISCVExtension<"zvl"#I#"b", 1, 0, "Zvl "#I>;
}`);
  assert.deepEqual(Object.fromEntries(named), {
    zba: 'supported',
    zacas: 'experimental',
    zvl32b: 'supported',
    zvl64b: 'supported',
    zvl128b: 'supported',
    zvl256b: 'supported',
  });
  // LLVM 21 dropped the name from the record; it comes from the def.
  const unnamed = parseLlvmFeatures(`
def FeatureStdExtZvbb
    : RISCVExtension<1, 0, "Vector basic bit-manipulation instructions",
                     [FeatureStdExtZvkb]>;
def FeatureStdExtZvabd
    : RISCVExperimentalExtension<0, 7, "Vector Absolute Difference">;`);
  assert.deepEqual(Object.fromEntries(unnamed), { zvbb: 'supported', zvabd: 'experimental' });
});

test('GCC: the version table before 16 and riscv-ext.def from 16', () => {
  const common = parseGccCommon(`
static const struct riscv_ext_version riscv_ext_version_table[] =
{
  /* name, ISA spec, major version, minor_version.  */
  {"i", ISA_SPEC_CLASS_20191213, 2, 1},
  {"zba", ISA_SPEC_CLASS_NONE, 1, 0},
  /* Terminate the list.  */
  {NULL, ISA_SPEC_CLASS_NONE, 0, 0}
};`);
  assert.deepEqual([...common.keys()], ['i', 'zba']);
  const def = parseGccExtDef(`
DEFINE_RISCV_EXT(
  /* NAME */ zvbb,
  /* UPPERCASE_NAME */ ZVBB,
  /* FULL_NAME */ "Vector basic bit-manipulation",
  /* DESC */ "")`);
  assert.deepEqual([...def.keys()], ['zvbb']);
});

test('binutils: every standard array, no vendor ones', () => {
  const parsed = parseBinutils(`
static const struct riscv_supported_ext riscv_supported_std_ext[] =
{
  {"i",		ISA_SPEC_CLASS_20191213,	2, 1, 0 },
  {NULL, 0, 0, 0, 0}
};
static const struct riscv_supported_ext riscv_supported_std_z_ext[] =
{
  {"zba",		ISA_SPEC_CLASS_DRAFT,		1, 0,  0 },
  {NULL, 0, 0, 0, 0}
};
static const struct riscv_supported_ext riscv_supported_vendor_x_ext[] =
{
  {"xtheadba",		ISA_SPEC_CLASS_DRAFT,	1, 0, 0 },
  {NULL, 0, 0, 0, 0}
};`);
  assert.deepEqual([...parsed.keys()], ['i', 'zba']);
});

test('QEMU: properties, x- for experimental, ISA entries and old names', () => {
  // 7.x: plain properties, some capitalised; x-aia is today's Smaia and Ssaia.
  const old = parseQemu(`
    DEFINE_PROP_BOOL("v", RISCVCPU, cfg.ext_v, false),
    DEFINE_PROP_BOOL("Zfh", RISCVCPU, cfg.ext_zfh, false),
    DEFINE_PROP_BOOL("mmu", RISCVCPU, cfg.mmu, true),
    DEFINE_PROP_BOOL("x-aia", RISCVCPU, cfg.aia, false),`);
  assert.equal(old.get('v'), 'supported');
  assert.equal(old.get('zfh'), 'supported');
  assert.equal(old.get('smaia'), 'experimental');
  assert.equal(old.get('ssaia'), 'experimental');
  // The property keeps QEMU's own spelling, for the command it suggests.
  assert.equal(old.properties.get('smaia'), 'x-aia');
  // 8.x: an ISA entry alone is supported, unless an x- property says otherwise.
  const mid = parseQemu(`
    ISA_EXT_DATA_ENTRY(zba, PRIV_VERSION_1_12_0, ext_zba),
    ISA_EXT_DATA_ENTRY(zvfh, PRIV_VERSION_1_12_0, ext_zvfh),
    MULTI_EXT_CFG_BOOL("x-zvfh", ext_zvfh, false),
    MISA_EXT_INFO(RVB, "x-b", "Bit manipulation"),`);
  assert.equal(mid.get('zba'), 'supported');
  assert.equal(mid.get('zvfh'), 'experimental');
  assert.equal(mid.get('b'), 'experimental');
  // 11.x: the experimental macro.
  const recent = parseQemu(`
    ISA_EXPERIMENTAL_EXT_DATA_ENTRY(zvabd, PRIV_VERSION_1_13_0, ext_zvabd),
    ISA_INTERNAL_EXT_DATA_ENTRY(zic64b, PRIV_VERSION_1_12_0, ext_zic64b),`);
  assert.equal(recent.get('zvabd'), 'experimental');
  assert.equal(recent.get('zic64b'), 'supported');
});

test('bases are read per XLEN from each tool’s own restriction', () => {
  const bases = (key, names, ...texts) => {
    const extensions = new Map(names.map((n) => [n, 'supported']));
    const options = addBases(key, extensions, texts);
    return { set: [...extensions.keys()].filter((k) => k.startsWith('rv')).sort(), options };
  };
  const both = ['rv32e', 'rv32i', 'rv64e', 'rv64i'];
  // LLVM 14-16 refused e on RV64.
  assert.deepEqual(
    bases('llvm', ['i', 'e'], `"standard user-level extension 'e' requires 'rv32'"`).set,
    ['rv32e', 'rv32i', 'rv64i'],
  );
  assert.deepEqual(bases('llvm', ['i', 'e'], '').set, both);
  // GCC needs the lp64e ABI for RV64E.
  assert.deepEqual(bases('gcc', ['i', 'e'], 'ABI_LP64').set, ['rv32e', 'rv32i', 'rv64i']);
  assert.deepEqual(bases('gcc', ['i', 'e'], 'ABI_LP64E').set, both);
  assert.deepEqual(bases('binutils', ['i', 'e'], "rv%d does not support the `e' extension").set, [
    'rv32e',
    'rv32i',
    'rv64i',
  ]);
  // QEMU: a dedicated CPU type, not the bare e property; RV128I is x-rv128.
  const qemu = bases('qemu', ['i', 'e'], 'TYPE_RISCV_CPU_RV32E TYPE_RISCV_CPU_BASE128');
  assert.deepEqual(qemu.set, ['rv128i', 'rv32e', 'rv32i', 'rv64i']);
  assert.equal(qemu.options.get('rv128i'), '-cpu x-rv128 -accel tcg,thread=single');
  assert.deepEqual(bases('linux', ['i', 'e'], '').set, ['rv32i', 'rv64i']);
});

test('QEMU provides what V brings and what its extensions require', () => {
  const extensions = new Map([
    ['v', 'supported'],
    ['zvbb', 'supported'],
    ['x', 'experimental'],
  ]);
  const requires = new Map([
    ['v', ['zve64d', 'zve32x', 'zvl128b', 'zvl64b', 'zvl32b']],
    ['zvbb', ['zvkb', 'zvl32b']],
    ['x', ['y']],
  ]);
  const impliedBy = addQemuImplied(extensions, '#define RV_VLEN_MAX 1024', requires);
  for (const t of ['zve64d', 'zvl128b', 'zvl256b', 'zvl1024b', 'zvkb']) {
    assert.equal(extensions.get(t), 'supported', t);
  }
  assert.equal(extensions.get('zvl2048b'), undefined);
  assert.equal(extensions.get('y'), 'experimental');
  // Credit goes to V before any other extension that requires the same.
  assert.equal(impliedBy.get('zvl32b'), 'v');
  assert.equal(impliedBy.get('zvkb'), 'zvbb');
});

test('Linux: every riscv_isa_ext entry kind', () => {
  const parsed = parseLinux(`
	__RISCV_ISA_EXT_DATA(i, RISCV_ISA_EXT_i),
	__RISCV_ISA_EXT_SUPERSET_VALIDATE(v, RISCV_ISA_EXT_v, riscv_v_exts, validate),
	__RISCV_ISA_EXT_BUNDLE(zk, riscv_zk_bundled_exts),
	__RISCV_ISA_EXT_DATA_VALIDATE(zilsd, RISCV_ISA_EXT_ZILSD, validate),`);
  assert.deepEqual([...parsed.keys()], ['i', 'v', 'zk', 'zilsd']);
});

test('LLVM: Assembly Support rows and the assembly-only base ISAs', () => {
  const parsed = parseLlvmUsage(`
Currently, LLVM fully supports RV32I, and RV64I.  RV32E and
RV64E are supported by the assembly-based tools only.  RV128I is not supported.

     \`\`H\`\`             Assembly Support
     \`\`Sstc\`\`          Assembly Support (\`See note <#note>\`__)
     \`\`Zba\`\`           Supported`);
  assert.deepEqual([...parsed].sort(), ['h', 'rv32e', 'rv64e', 'sstc']);
  // Once LLVM generates code for E, the sentence goes and so does the flag.
  assert.deepEqual([...parseLlvmUsage('LLVM fully supports RV32I, RV32E and RV64E.')], []);
});

test('a sharp fall in one release’s extension count is reported, not believed', () => {
  const release = (version, n) => ({
    version,
    extensions: new Map(Array.from({ length: n }, (_, i) => [`x${i}`, 'supported'])),
  });
  // 100 -> 97 is ordinary churn; 97 -> 60 is a parser that lost the format.
  assert.deepEqual(suspiciousDrops([release('1', 100), release('2', 97), release('3', 60)]), [
    { version: '3', before: 97, after: 60 },
  ]);
  // A small table losing a few entries is not enough on its own.
  assert.deepEqual(suspiciousDrops([release('1', 20), release('2', 15)]), []);
});

test('a drop accepted once stays accepted; only new releases are judged', () => {
  const release = (version, n, asm = 0) => ({
    version,
    extensions: new Map(Array.from({ length: n }, (_, i) => [`x${i}`, 'supported'])),
    assemblyOnly: new Set(Array.from({ length: asm }, (_, i) => `a${i}`)),
  });
  const releases = [release('22', 100, 40), release('23', 60, 40)];
  const measures = [
    ['extension table', (r) => r.extensions.size],
    ['Assembly Support list', (r) => r.assemblyOnly.size],
  ];
  const run = (known, allowed = []) =>
    unacceptedDrops(releases, {
      key: 'llvm',
      name: 'Clang',
      known: new Set(known),
      allowed: new Set(allowed),
      measures,
    });
  // First seen: the sync stops and names it.
  assert.deepEqual(run(['22']), ['Clang 23 extension table: 100 -> 60']);
  // Allowed by hand once, then committed: later runs do not trip on it.
  assert.deepEqual(run(['22'], ['llvm@23']), []);
  assert.deepEqual(run(['22', '23']), []);
  // The documentation parser is guarded the same way.
  const docs = [release('22', 100, 40), release('23', 100, 3)];
  assert.deepEqual(
    unacceptedDrops(docs, {
      key: 'llvm',
      name: 'Clang',
      known: new Set(['22']),
      allowed: new Set(),
      measures,
    }),
    ['Clang 23 Assembly Support list: 40 -> 3'],
  );
});

// The bundles scripts/sync_toolchain_support.mjs treats as pure groups, with
// the parts their specifications give. The graph must still agree.
const BUNDLES = {
  A: ['Zaamo', 'Zalrsc'],
  B: ['Zba', 'Zbb', 'Zbs'],
  Zk: ['Zkn', 'Zkr', 'Zkt'],
  Zkn: ['Zbkb', 'Zbkc', 'Zbkx', 'Zknd', 'Zkne', 'Zknh'],
  Zks: ['Zbkb', 'Zbkc', 'Zbkx', 'Zksed', 'Zksh'],
  Zvkn: ['Zvkb', 'Zvkned', 'Zvknhb', 'Zvkt'],
  Zvknc: ['Zvbc', 'Zvkn'],
  Zvkng: ['Zvkg', 'Zvkn'],
  Zvks: ['Zvkb', 'Zvksed', 'Zvksh', 'Zvkt'],
  Zvksc: ['Zvbc', 'Zvks'],
  Zvksg: ['Zvkg', 'Zvks'],
  Zce: ['Zca', 'Zcb', 'Zcmp', 'Zcmt'],
  Sha: [
    'H',
    'Shcounterenw',
    'Shgatpa',
    'Shtvala',
    'Shvsatpa',
    'Shvstvala',
    'Shvstvecd',
    'Ssstateen',
  ],
};

test('the bundles’ parts in the graph are the specification’s', () => {
  for (const [id, parts] of Object.entries(BUNDLES)) {
    assert.deepEqual(
      (graph.nodes[id]?.requires ?? []).map((e) => e.ext).sort(),
      [...parts].sort(),
      id,
    );
  }
});

test('a runner that knows every part of a bundle knows the bundle', () => {
  const bundles = new Map([
    ['b', ['zba', 'zbb', 'zbs']],
    ['zvkn', ['zvkb', 'zvkned']],
    ['zvknc', ['zvbc', 'zvkn']],
    ['sha', ['h', 'shgatpa']],
  ]);
  const extensions = new Map(
    ['zba', 'zbb', 'zbs', 'zvkb', 'zvkned', 'zvbc', 'h'].map((t) => [t, 'supported']),
  );
  const through = addBundles(extensions, bundles);
  assert.equal(extensions.get('b'), 'supported');
  assert.deepEqual(through.get('b'), ['zba', 'zbb', 'zbs']);
  // A bundle of bundles resolves too.
  assert.equal(extensions.get('zvknc'), 'supported');
  // A missing part means no claim.
  assert.equal(extensions.get('sha'), undefined);
  // An experimental part makes the bundle experimental.
  const mixed = new Map([
    ['zba', 'supported'],
    ['zbb', 'experimental'],
    ['zbs', 'supported'],
  ]);
  addBundles(mixed, bundles);
  assert.equal(mixed.get('b'), 'experimental');
  // -march tools only report that the parts are accepted, never the name.
  const literal = new Map(['zba', 'zbb', 'zbs'].map((t) => [t, 'supported']));
  assert.deepEqual([...bundlesByParts(literal, bundles)], ['b']);
  assert.equal(literal.get('b'), undefined);
});

test('standing: the unbroken run that reaches the newest release', () => {
  const releases = (statuses) =>
    statuses.map((status, i) => ({
      version: String(16 + i),
      extensions: new Map(status ? [['x', status]] : []),
    }));
  assert.deepEqual(standing(releases([null, 'experimental', 'supported', 'supported']), 'x'), {
    supported: '18',
    experimental: '17',
  });
  assert.deepEqual(standing(releases(['experimental', 'experimental']), 'x'), {
    experimental: '16',
  });
  // Dropped since: the newest release does not take it.
  assert.deepEqual(standing(releases(['experimental', null]), 'x'), {});
});

test('every -march token in the catalogue has an entry, and the data is ordered', () => {
  for (const ext of extensions) {
    const token = marchToken(ext.id);
    if (!token || NON_MARCH_IDS.has(ext.id)) continue;
    assert.ok(data.extensions[token], `${ext.id} (${token}) has no entry`);
  }
  // Versions sort as dotted numbers (Linux 6.10 after 6.9), never as decimals.
  const parts = (v) => v.split('.').map(Number);
  const before = (a, b) => {
    const [x, y] = [parts(a), parts(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
    }
    return false;
  };
  for (const [key, tool] of Object.entries(data.tools)) {
    const versions = tool.releases.map((r) => r.version);
    versions.slice(1).forEach((v, i) => assert.ok(before(versions[i], v), `${key} ${v}`));
    for (const [token, entry] of Object.entries(data.extensions)) {
      const e = entry[key];
      if (!e) continue;
      for (const v of [e.supported, e.experimental].filter(Boolean)) {
        assert.ok(versions.includes(v), `${token} ${key} ${v}`);
      }
      if (e.supported && e.experimental) {
        assert.ok(before(e.experimental, e.supported), `${token} ${key}`);
      }
    }
  }
  assert.deepEqual(Object.keys(data.tools), ['llvm', 'gcc', 'binutils', 'qemu', 'linux']);
  const newest = (key) => parts(data.tools[key].releases.at(-1).version);
  assert.ok(newest('llvm')[0] >= 23 && newest('gcc')[0] >= 16);
  assert.ok(!before(data.tools.binutils.releases.at(-1).version, '2.47'));
  assert.ok(!before(data.tools.linux.releases.at(-1).version, '7.2'));
});

test('the data agrees with the release notes', () => {
  const at = (token) => data.extensions[token];
  // Clang rejected _zicsr until 17; GCC 12 already required it.
  assert.deepEqual(at('zicsr').llvm, { supported: '17' });
  assert.deepEqual(at('zicsr').gcc, { supported: '12' });
  // Vector crypto: experimental in LLVM 17, ratified support in LLVM 18 and GCC 14.
  assert.deepEqual(at('zvbb').llvm, { supported: '18', experimental: '17' });
  assert.deepEqual(at('zvbb').gcc, { supported: '14' });
  assert.deepEqual(at('zvabd').llvm, { experimental: '23' });
  assert.equal(at('zvabd').gcc, undefined);
  // binutils 2.44 rejects zce (checked against Debian's 2.44); 2.45 takes it.
  assert.equal(at('zce').binutils.supported, '2.45');
  // QEMU had Smaia as x-aia in 7.0-7.1 and x-smaia from 7.2, until 9.0.
  assert.deepEqual(at('smaia').qemu, {
    supported: '9.0',
    experimental: '7.0',
    options: [
      { option: '-cpu rv64,x-aia=on', from: '7.0' },
      { option: '-cpu rv64,x-smaia=on', from: '7.2' },
    ],
  });
  // Linux has Zba, Zbb and Zbs but no b entry: it detects B through them.
  assert.deepEqual(at('b').linux, { supported: '6.6', through: ['Zba', 'Zbb', 'Zbs'] });
  // GCC took -march=..._b only from 15, but _zba_zbb_zbs from 12.
  assert.deepEqual(at('b').gcc, {
    supported: '15',
    parts: { since: '12', via: ['Zba', 'Zbb', 'Zbs'] },
  });
  // binutils 2.44 rejects zce (checked on Debian's) but takes its parts.
  assert.deepEqual(at('zce').binutils.parts, {
    since: '2.44',
    via: ['Zca', 'Zcb', 'Zcmp', 'Zcmt'],
  });
  // Linux lists none of Sha's Sh* parts, so no claim is made.
  assert.equal(at('sha').linux, undefined);
  // RV64E came years after RV32E: LLVM 17, GCC 14 (lp64e), binutils 2.42.
  assert.deepEqual(at('rv32e').llvm, { supported: '14', assemblyOnly: true });
  assert.deepEqual(at('rv64e').llvm, { supported: '17', assemblyOnly: true });
  assert.deepEqual(at('rv64e').gcc, { supported: '14' });
  assert.deepEqual(at('rv64e').binutils, { supported: '2.42' });
  assert.equal(at('rv64e').linux, undefined);
  // LLVM accepts RV32E and RV64E but documents them as assembly-only.
  assert.equal(at('rv64e').llvm.assemblyOnly, true);
  assert.equal(at('rv32e').llvm.assemblyOnly, true);
  assert.equal(at('zba').llvm.assemblyOnly, undefined);
  // A representative pair from LLVM's Assembly Support rows, so a format
  // change in RISCVUsage.rst that loses them shows up here.
  assert.equal(at('h').llvm.assemblyOnly, true);
  assert.equal(at('q').llvm.assemblyOnly, true);
  // RV128I: no compiler, assembler or kernel; QEMU's experimental x-rv128.
  assert.deepEqual(Object.keys(at('rv128i')), ['qemu']);
  assert.equal(at('rv128i').qemu.experimental, '7.0');
  // QEMU 7.0's V already gave Zve64d and VLEN 128-1024 (RV_VLEN_MAX).
  assert.deepEqual(at('zve64d').qemu.supported, '7.0');
  assert.deepEqual(at('zvl1024b').qemu, { supported: '7.0', impliedBy: 'V' });
  assert.equal(at('zvl2048b')?.qemu, undefined);
  // Linux 6.6 already detected V; Zilsd arrived in 6.19, Zabha in 6.13.
  assert.deepEqual(at('v').linux, { supported: '6.6' });
  assert.deepEqual(at('zilsd').linux, { supported: '6.19' });
  assert.deepEqual(at('zabha').linux, { supported: '6.13' });
});

test('Compiler Explorer’s exclusions are exactly what its clang takes only as experimental', () => {
  const pinned = Number(COMPILER_EXPLORER_COMPILERS[64].match(/clang(\d\d)/)[1]);
  const notAccepted = new Set(
    extensions
      .filter((ext) => Object.keys(ext.instructions || {}).length && !NON_MARCH_IDS.has(ext.id))
      .map((ext) => marchToken(ext.id))
      .filter((token) => {
        const llvm = data.extensions[token]?.llvm;
        return token && !(llvm?.supported && Number(llvm.supported) <= pinned);
      }),
  );
  assert.deepEqual([...notAccepted].sort(), [...COMPILER_EXPLORER_UNSUPPORTED].sort());
});

test('marchTokens splits the single letters from the rest', () => {
  assert.deepEqual(marchTokens('rv64imafdcv_zba_zvbb'), [
    'rv64i',
    'm',
    'a',
    'f',
    'd',
    'c',
    'v',
    'zba',
    'zvbb',
  ]);
  assert.deepEqual(marchTokens('not-a-march'), []);
});

test('marchRequirements: the newest minimum, experimental and missing tokens', () => {
  const byTool = (march) =>
    Object.fromEntries(marchRequirements(data, march).map((r) => [r.key, r]));
  const plain = byTool('rv64imafdcv_zicsr_zvbb');
  assert.equal(plain.llvm.minimum, '18');
  assert.equal(plain.gcc.minimum, '14');
  assert.equal(plain.binutils.minimum, '2.41');
  assert.deepEqual(plain.llvm.experimental, []);
  // The builder lists what builds code; QEMU and Linux are left to the panel.
  assert.deepEqual(Object.keys(plain), ['llvm', 'gcc', 'binutils']);

  const proposal = byTool('rv64imafdcv_zvabd');
  assert.deepEqual(proposal.llvm.experimental, ['zvabd']);
  assert.deepEqual(proposal.gcc.missing, ['zvabd']);

  // Compared by release order: Linux 6.11 is newer than 6.8, though 6.11 < 6.8
  // as a decimal.
  const [linux] = marchRequirements(data, 'rv64imafdcv_zvbb_zawrs', ['linux']);
  assert.equal(linux.minimum, '6.11');

  // The base keeps its width: RV64E needs Clang 17, RV128I builds nowhere.
  assert.equal(byTool('rv64e').llvm.minimum, '17');
  // and Clang only assembles for it.
  assert.deepEqual(byTool('rv64e').llvm.assemblyOnly, ['rv64e']);
  assert.deepEqual(byTool('rv64imafdc_zba').llvm.assemblyOnly, []);
  assert.equal(byTool('rv32e').llvm.minimum, '14');
  for (const tool of Object.values(byTool('rv128i'))) {
    assert.deepEqual(tool.missing, ['rv128i'], tool.key);
    assert.equal(tool.minimum, null, tool.key);
  }

  // A token the data does not know (a sandbox extension) is not guessed at.
  assert.equal(byTool('rv64i_xmycustom').llvm.minimum, '14');
});

test('extensionSupport: one standing per tool, and none for non-march ids', () => {
  // Privilege and satp modes are not -march tokens: no answer, not "not yet".
  for (const id of ['S', 'U', 'N', 'Sm', 'Sv39', 'Sv57']) {
    assert.equal(extensionSupport(data, id), null, id);
  }
  const zvbb = Object.fromEntries(extensionSupport(data, 'Zvbb').map((s) => [s.key, s]));
  assert.equal(zvbb.llvm.state, 'supported');
  assert.equal(zvbb.llvm.experimentalSince, '17');
  assert.equal(extensionSupport(data, 'RV64I')[0].earliest, true);
  assert.deepEqual(
    extensionSupport(data, 'Zvbb', ['qemu', 'linux']).map((s) => `${s.name} ${s.since}`),
    ['QEMU 8.2', 'Linux 6.8'],
  );
  assert.equal(extensionSupport(data, 'Zvabd').find((s) => s.key === 'gcc').state, 'none');
  // Experimental and assembly-only at once: neither flag may hide the other.
  const zvfbfa = Object.fromEntries(extensionSupport(data, 'Zvfbfa').map((s) => [s.key, s]));
  assert.equal(zvfbfa.llvm.state, 'experimental');
  assert.equal(zvfbfa.llvm.assemblyOnly, true);
  const [clang] = marchRequirements(data, 'rv64imafdcv_zvfbfa', ['llvm']);
  assert.deepEqual(clang.assemblyOnly, ['zvfbfa']);
  // The first scanned release is a floor, not a date: say "or earlier".
  const smaia = extensionSupport(data, 'Smaia').find((s) => s.key === 'qemu');
  assert.equal(smaia.experimentalEarliest, true);
  const rv128 = Object.fromEntries(extensionSupport(data, 'RV128I').map((s) => [s.key, s]));
  for (const key of ['llvm', 'gcc', 'binutils', 'linux']) assert.equal(rv128[key].state, 'none');
  assert.equal(rv128.qemu.state, 'experimental');
  assert.equal(rv128.qemu.earliest, true);
  assert.equal(rv128.qemu.options.at(-1).option, '-cpu x-rv128 -accel tcg,thread=single');
});
