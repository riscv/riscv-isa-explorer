/**
 * Toolchain support (src/toolchain-support.json): the first Clang and GCC
 * release whose -march accepts each extension. The parsers are fed small
 * pieces of each source format the toolchains have used, the data is checked
 * against facts from the release notes, and the builder's arithmetic is
 * checked on a real -march.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import {
  parseGccCommon,
  parseGccExtDef,
  parseLlvmFeatures,
  parseLlvmIsaInfo,
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
  for (const [key, tool] of Object.entries(data.tools)) {
    const versions = tool.releases.map((r) => Number(r.version));
    assert.deepEqual(
      versions,
      [...versions].sort((a, b) => a - b),
      key,
    );
    for (const [token, entry] of Object.entries(data.extensions)) {
      const e = entry[key];
      if (!e) continue;
      for (const v of [e.supported, e.experimental].filter(Boolean)) {
        assert.ok(versions.includes(Number(v)), `${token} ${key} ${v}`);
      }
      if (e.supported && e.experimental) {
        assert.ok(Number(e.experimental) < Number(e.supported), `${token} ${key}`);
      }
    }
  }
  assert.ok(Number(data.tools.llvm.releases.at(-1).version) >= 23);
  assert.ok(Number(data.tools.gcc.releases.at(-1).version) >= 16);
});

test('the data agrees with the release notes', () => {
  const at = (token) => data.extensions[token];
  // Clang rejected _zicsr until 17; GCC 12 already required it.
  assert.deepEqual(at('zicsr'), { llvm: { supported: '17' }, gcc: { supported: '12' } });
  // Vector crypto: experimental in LLVM 17, ratified support in LLVM 18 and GCC 14.
  assert.deepEqual(at('zvbb'), {
    llvm: { supported: '18', experimental: '17' },
    gcc: { supported: '14' },
  });
  assert.deepEqual(at('zvabd'), { llvm: { experimental: '23' } });
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
  assert.deepEqual(plain.llvm.experimental, []);

  const proposal = byTool('rv64imafdcv_zvabd');
  assert.deepEqual(proposal.llvm.experimental, ['zvabd']);
  assert.deepEqual(proposal.gcc.missing, ['zvabd']);

  // A token the data does not know (a sandbox extension) is not guessed at.
  assert.equal(byTool('rv64i_xmycustom').llvm.minimum, '14');
});

test('extensionSupport: one standing per tool, and none for non-march ids', () => {
  const zvbb = Object.fromEntries(extensionSupport(data, 'Zvbb').map((s) => [s.key, s]));
  assert.equal(zvbb.llvm.state, 'supported');
  assert.equal(zvbb.llvm.experimentalSince, '17');
  assert.equal(extensionSupport(data, 'RV64I')[0].earliest, true);
  assert.equal(extensionSupport(data, 'Zvabd').find((s) => s.key === 'gcc').state, 'none');
  assert.equal(extensionSupport(data, 'RV128I'), null);
});
