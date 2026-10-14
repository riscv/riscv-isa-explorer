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
  parseBinutils,
  parseGccCommon,
  parseGccExtDef,
  parseLinux,
  parseLlvmFeatures,
  parseLlvmIsaInfo,
  parseQemu,
  standing,
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

test('Linux: every riscv_isa_ext entry kind', () => {
  const parsed = parseLinux(`
	__RISCV_ISA_EXT_DATA(i, RISCV_ISA_EXT_i),
	__RISCV_ISA_EXT_SUPERSET_VALIDATE(v, RISCV_ISA_EXT_v, riscv_v_exts, validate),
	__RISCV_ISA_EXT_BUNDLE(zk, riscv_zk_bundled_exts),
	__RISCV_ISA_EXT_DATA_VALIDATE(zilsd, RISCV_ISA_EXT_ZILSD, validate),`);
  assert.deepEqual([...parsed.keys()], ['i', 'v', 'zk', 'zilsd']);
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
  assert.deepEqual(at('zce').binutils, { supported: '2.45' });
  // QEMU had Smaia only as x-aia until 9.0.
  assert.deepEqual(at('smaia').qemu, { supported: '9.0', experimental: '7.0' });
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
    'i',
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

  // A token the data does not know (a sandbox extension) is not guessed at.
  assert.equal(byTool('rv64i_xmycustom').llvm.minimum, '14');
});

test('extensionSupport: one standing per tool, and none for non-march ids', () => {
  const zvbb = Object.fromEntries(extensionSupport(data, 'Zvbb').map((s) => [s.key, s]));
  assert.equal(zvbb.llvm.state, 'supported');
  assert.equal(zvbb.llvm.experimentalSince, '17');
  assert.equal(extensionSupport(data, 'RV64I')[0].earliest, true);
  assert.deepEqual(
    extensionSupport(data, 'Zvbb', ['qemu', 'linux']).map((s) => `${s.name} ${s.since}`),
    ['QEMU 8.2', 'Linux 6.8'],
  );
  assert.equal(extensionSupport(data, 'Zvabd').find((s) => s.key === 'gcc').state, 'none');
  assert.equal(extensionSupport(data, 'RV128I'), null);
});
