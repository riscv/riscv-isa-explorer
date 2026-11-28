/**
 * The instruction "how to write it" block (src/instructionUsage.js) is
 * generated for 1,200 instructions and read by eye for a handful, so these
 * tests check the generator rather than individual outputs: every template
 * yields an example, every intrinsic names a real instruction, every upstream
 * fix is still needed, and the Compiler Explorer link carries what it claims.
 *
 * The last two tests feed the whole catalogue to a real RISC-V clang. They
 * run only when RISCV_CLANG names one (`RISCV_CLANG=$(brew --prefix llvm)/bin/clang
 * npm test`), because CI's distro clang is too old for half the catalogue.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

import {
  ASSEMBLY_FIXES,
  COMPILER_EXPLORER_COMPILERS,
  abiForMarch,
  assemblySyntax,
  compilerExplorerSupports,
  compilerExplorerUrl,
  exampleAssembly,
  inlineAsmSource,
  instructionMarch,
  intrinsicExtensions,
  intrinsicSource,
  preferredXlen,
  prototypeFor,
  requiredExtensions,
  takesImmediate,
  xlenRestriction,
} from '../src/instructionUsage.js';
import { resolveSelection } from '../src/isaGraph.js';
import { BASE_ISA_IDS, parseMarchString } from '../src/marchUtils.js';

const require = createRequire(import.meta.url);
const metadata = require('../src/instruction-metadata.json');
const intrinsics = require('../src/instruction-intrinsics.json');
const catalog = require('../src/riscv_extensions.json');

const extensions = Object.values(catalog).flat().filter(Boolean);
const catalogIds = new Set(extensions.map((ext) => ext.id));

// Each mnemonic once, with the first extension that lists it.
const instructions = new Map();
for (const ext of extensions) {
  for (const [mnemonic, instruction] of Object.entries(ext.instructions || {})) {
    const key = mnemonic.toLowerCase();
    if (!instructions.has(key)) instructions.set(key, { ext, instruction });
  }
}

const marchOf = (key, extra = []) => {
  const { ext, instruction } = instructions.get(key);
  return instructionMarch({
    extensionId: ext.id,
    extensionTags: instruction.extension,
    definedBy: metadata[key]?.defined_by,
    catalogIds,
    extra,
  });
};

test('syntax is written the way the specification writes it', () => {
  assert.equal(assemblySyntax('VAADD.VV', 'vd, vs2, vs1, vm'), 'vaadd.vv vd, vs2, vs1[, v0.t]');
  assert.equal(assemblySyntax('lw', 'xd, imm(xs1)'), 'lw rd, imm(rs1)');
  assert.equal(assemblySyntax('vmerge.vvm', 'vd, vs2, vs1, v0'), 'vmerge.vvm vd, vs2, vs1, v0');
  assert.equal(assemblySyntax('ecall', ''), 'ecall');
  assert.equal(assemblySyntax('fli.s', 'fd, xs1'), 'fli.s fd, imm', 'upstream fix applied');
  assert.equal(assemblySyntax('add', undefined), '');
});

test('examples use operands an assembler accepts for that family', () => {
  const cases = {
    'vaadd.vv': 'vaadd.vv v8, v16, v24, v0.t',
    lw: 'lw a0, 16(a1)',
    'vadc.vim': 'vadc.vim v8, v16, 1, v0',
    'cm.push': 'cm.push {ra, s0}, -16',
    'prefetch.r': 'prefetch.r 32(a1)',
    'c.lh': 'c.lh a0, 2(a1)',
    'fli.s': 'fli.s fa0, 1.0',
    'fcvtmod.w.d': 'fcvtmod.w.d a0, fa1, rtz',
    vsetvli: 'vsetvli a0, a1, e32, m1, ta, ma',
    'fadd.d': 'fadd.d fa0, fa1, fa2, rne',
  };
  for (const [key, expected] of Object.entries(cases)) {
    assert.equal(exampleAssembly(key, metadata[key].assembly), expected, key);
  }
});

// Every (extension, instruction) listing under Zfinx and its relatives, which
// the map above skips: their instructions are listed under F, D and Zfh first.
const INX = new Set(['Zfinx', 'Zdinx', 'Zhinx', 'Zhinxmin']);
const inxListings = extensions
  .filter((ext) => INX.has(ext.id))
  .flatMap((ext) =>
    Object.entries(ext.instructions || {}).map(([mnemonic, instruction]) => ({
      ext,
      instruction,
      key: mnemonic.toLowerCase(),
    })),
  );

test('examples under Zfinx and its relatives use integer registers', () => {
  const example = (key, extensionId) => exampleAssembly(key, metadata[key].assembly, extensionId);
  assert.equal(example('fmadd.s', 'Zfinx'), 'fmadd.s a0, a1, a2, a3, rne');
  assert.equal(example('fcvt.s.h', 'Zhinxmin'), 'fcvt.s.h a0, a1, rne');
  assert.equal(example('fmadd.d', 'Zdinx'), 'fmadd.d a0, a2, a4, a6, rne', 'even pairs');
  assert.equal(example('fmadd.s', 'F'), 'fmadd.s fa0, fa1, fa2, fa3, rne', 'F is unchanged');

  assert.equal(inxListings.length, 84);
  const withFpRegisters = inxListings
    .map(({ ext, key }) => [ext.id, exampleAssembly(key, metadata[key]?.assembly, ext.id)])
    .filter(([, line]) => !line || /\bf[ast]\d+\b/.test(line));
  assert.deepEqual(withFpRegisters, []);
});

test('every catalogue instruction with a UDB template gets an example', () => {
  const missing = [...instructions.keys()].filter(
    (key) =>
      typeof metadata[key]?.assembly === 'string' && !exampleAssembly(key, metadata[key].assembly),
  );
  assert.deepEqual(missing, [], `no concrete operands for: ${missing.join(', ')}`);
});

test('every upstream template fix is still needed', () => {
  for (const [key, fixed] of Object.entries(ASSEMBLY_FIXES)) {
    assert.ok(metadata[key], `${key} is no longer in the catalogue; drop its fix`);
    assert.notEqual(metadata[key].assembly, fixed, `UDB now writes ${key} correctly; drop its fix`);
  }
});

test('width restrictions follow UDB, with tags only where UDB has no record', () => {
  const only = (key) => xlenRestriction(instructions.get(key).instruction.extension, metadata[key]);
  assert.equal(only('lwu'), 'RV64');
  assert.equal(only('aes32esi'), 'RV32');
  assert.equal(only('c.zext.w'), 'RV64');
  // Tagged rv64_* for their 6-bit shamt encoding, but present on RV32 too.
  for (const key of ['slli', 'srai', 'rori', 'rev8', 'bclri', 'c.slli'])
    assert.equal(only(key), null, key);
  // RV64 through I, RV32 through Zilsd: no single width to claim.
  assert.equal(only('ld'), null);
  // The catalogue's own RV32 duplicates have no UDB record; their tags decide.
  assert.equal(only('ld.rv32'), 'RV32');

  // The example's base width may still lean on the tags.
  assert.equal(preferredXlen(['rv32_c_f'], metadata['c.flw'].defined_by), 32);
  assert.equal(preferredXlen(['rv64_i'], metadata.slli.defined_by), 64);
  assert.equal(preferredXlen(['rv_i'], null), 64);
});

test('definedBy adds what the listed extension alone does not provide', () => {
  const zextw = metadata['c.zext.w'].defined_by;
  assert.deepEqual(requiredExtensions(zextw, ['RV64I', 'Zcb'], catalogIds), ['Zba']);
  // anyOf already met by the selection adds nothing.
  assert.deepEqual(requiredExtensions(metadata.ror.defined_by, ['Zbkb'], catalogIds), []);
  // 'I' is not a catalogue id.
  assert.deepEqual(requiredExtensions(metadata.add.defined_by, [], catalogIds), []);

  assert.match(marchOf('c.zext.w'), /_zba/);
  assert.match(marchOf('fleq.d'), /^rv64i?\w*d/);
  assert.match(marchOf('aes32esi'), /^rv32/);
});

test('definedBy never adds an extension the listed one excludes', () => {
  // UDB defines fmadd.s by F alone; under Zfinx, which forbids F, that gave
  // rv64if_zfinx_zicsr, an -march clang rejects.
  const zfinx = extensions.find((ext) => ext.id === 'Zfinx');
  const fmadd = instructionMarch({
    extensionId: 'Zfinx',
    extensionTags: zfinx.instructions['FMADD.S'].extension,
    definedBy: metadata['fmadd.s'].defined_by,
    catalogIds,
  });
  assert.equal(fmadd, 'rv64i_zfinx_zicsr');
  assert.equal(abiForMarch(fmadd), 'lp64', 'Zfinx has no floating-point registers');

  // Every instruction, under every extension that lists it.
  const clashes = [];
  for (const ext of extensions) {
    for (const [mnemonic, instruction] of Object.entries(ext.instructions || {})) {
      const key = mnemonic.toLowerCase();
      const march = instructionMarch({
        extensionId: ext.id,
        extensionTags: instruction.extension,
        definedBy: metadata[key]?.defined_by,
        catalogIds,
      });
      const ids = parseMarchString(march, extensions).resolvedIds;
      const base = ids.find((id) => BASE_ISA_IDS.has(id));
      if (resolveSelection({ selected: ids, base }).conflicts.length) {
        clashes.push(`${ext.id} ${key}: ${march}`);
      }
    }
  }
  assert.deepEqual(clashes, []);
});

test('an instruction shown under a base ISA is built for that base', () => {
  const add = (extensionId) =>
    instructionMarch({
      extensionId,
      extensionTags: ['rv_i'],
      definedBy: metadata.add.defined_by,
      catalogIds,
    });
  assert.equal(add('RV32E'), 'rv32e');
  assert.equal(add('RV32I'), 'rv32i');
  assert.equal(add('RV64E'), 'rv64e');
  assert.equal(add('RV128I'), 'rv64i', 'no compiler targets RV128I');
  assert.equal(abiForMarch('rv64e'), 'lp64e');
});

test('vector crypto is raised to the VLEN its element groups need', () => {
  assert.match(marchOf('vaeskf1.vi'), /_zvl128b/);
  assert.match(marchOf('vsm3c.vi'), /_zvl256b/);
  assert.doesNotMatch(marchOf('vaadd.vv'), /_zvl256b/);
});

test('the ABI follows the floating-point registers in -march', () => {
  assert.equal(abiForMarch('rv64imafdc_zicsr'), 'lp64d');
  assert.equal(abiForMarch('rv32if_zicsr'), 'ilp32f');
  assert.equal(abiForMarch('rv32i_zkne'), 'ilp32');
  assert.equal(abiForMarch('rv32e_zca'), 'ilp32e');
});

test('every intrinsic record names a catalogue instruction and a parsable prototype', () => {
  for (const [key, record] of Object.entries(intrinsics)) {
    assert.ok(instructions.has(key), `${key} is not a catalogue instruction`);
    assert.ok(record.prototypes.length >= 1, key);
    assert.ok(record.count >= record.prototypes.length, key);
    assert.match(
      record.source,
      /^https:\/\/github\.com\/riscv-non-isa\/[\w-]+\/blob\/[0-9a-f]{40}\//,
    );
    for (const prototype of record.prototypes) assert.match(prototype, /\b__riscv_\w+\(/, key);
    if (record.header) {
      assert.ok(
        intrinsicSource(record.header, record.prototypes[0]),
        `${key}: cannot build a call`,
      );
    }
  }
  assert.equal(intrinsics['vaadd.vv'].header, 'riscv_vector.h');
  assert.equal(
    intrinsics['vcpop.m'].prototypes.length,
    1,
    'mask suffix _m is not the policy suffix',
  );
  // Upstream's Instruction column says aes32es; the intrinsic's name is right.
  assert.match(intrinsics.aes64es.prototypes[0], /__riscv_aes64es\(/);
});

test('the intrinsic example is a complete file that calls it', () => {
  assert.equal(
    intrinsicSource('riscv_vector.h', intrinsics['vaadd.vv'].prototypes[0]),
    '#include <riscv_vector.h>\n\n' +
      'vint32m1_t f(vint32m1_t vs2, vint32m1_t vs1, size_t vl) {\n' +
      '  return __riscv_vaadd_vv_i32m1(vs2, vs1, __RISCV_VXRM_RNU, vl);\n}\n',
  );
  // rori shares __riscv_ror_*; a constant shift is what selects it.
  const rori = prototypeFor(intrinsics.rori.prototypes, 64);
  assert.match(rori, /__riscv_ror_64/);
  assert.ok(takesImmediate('rori', metadata.rori.assembly));
  assert.match(
    intrinsicSource('riscv_bitmanip.h', rori, { immediate: true }),
    /__riscv_ror_64\(x, 1\)/,
  );
  assert.match(prototypeFor(intrinsics.ror.prototypes, 32), /__riscv_ror_32/);
  assert.deepEqual(intrinsicExtensions('vfloat32m1_t __riscv_x(vfloat16mf2_t vs2);'), [
    'Zvfh',
    'Zve32f',
  ]);
});

// Listings under the vector subsets, whose ELEN or element types are narrower than V's.
const VECTOR_SUBSETS = new Set([
  'Zve32x',
  'Zve32f',
  'Zve64x',
  'Zve64f',
  'Zve64d',
  'Zvfh',
  'Zvfhmin',
]);
const subsetIntrinsics = extensions
  .filter((ext) => VECTOR_SUBSETS.has(ext.id))
  .flatMap((ext) => Object.keys(ext.instructions || {}).map((m) => [ext.id, m.toLowerCase()]))
  .filter(([, key]) => intrinsics[key]?.header);

const intrinsicMarch = (extensionId, key) =>
  instructionMarch({
    extensionId,
    extensionTags: instructions.get(key).instruction.extension,
    definedBy: metadata[key]?.defined_by,
    catalogIds,
    extra: intrinsicExtensions(prototypeFor(intrinsics[key].prototypes, 64)),
  });

test('an intrinsic under a vector subset gets the element types it uses', () => {
  const tokens = (extensionId, key) => intrinsicMarch(extensionId, key).split('_');
  assert.ok(!tokens('Zve32x', 'vle8.v').includes('zve32f'), 'vint8m1_t fits Zve32x');
  assert.ok(tokens('Zve32x', 'vle32.v').includes('zve32f'), 'vfloat32m1_t');
  assert.ok(tokens('Zve32x', 'vnsra.wv').includes('zve64x'), 'vint64m2_t');
  assert.ok(tokens('Zve32f', 'vfncvt.x.f.w').includes('zve64d'), 'vfloat64m2_t');
  assert.ok(tokens('Zvfh', 'vfwcvt.x.f.v').includes('zve64x'), 'vfloat32mf2_t');
  assert.ok(subsetIntrinsics.length > 2000, `found ${subsetIntrinsics.length}`);
});

test('the Compiler Explorer link carries the source, compiler and options', () => {
  const march = marchOf('vaadd.vv');
  const source = inlineAsmSource('vaadd.vv v8, v16, v24, v0.t');
  const url = compilerExplorerUrl({ source, march });
  assert.match(url, /^https:\/\/godbolt\.org\/clientstate\//);
  const state = JSON.parse(
    Buffer.from(decodeURIComponent(url.split('/clientstate/')[1]), 'base64').toString('utf8'),
  );
  const [session] = state.sessions;
  assert.equal(session.language, 'c');
  assert.equal(session.source, source);
  assert.equal(session.compilers[0].id, COMPILER_EXPLORER_COMPILERS[64]);
  assert.equal(session.compilers[0].options, `-O2 -ffreestanding -march=${march} -mabi=lp64d`);

  assert.equal(compilerExplorerSupports(marchOf('beqi')), false, 'Zibi is experimental in clang');
  assert.equal(compilerExplorerUrl({ source, march: marchOf('beqi') }), null);
});

/* ── Against a real compiler (opt-in) ───────────────────────────────────── */

const CLANG = process.env.RISCV_CLANG;
// A toolchain that predates an extension is not a defect in the example.
const TOOLCHAIN_LAG =
  /unsupported standard user-level extension|experimental extension|unrecognized instruction mnemonic|requires '-menable-experimental-extensions'/;

const compile = (march, args, input) => {
  const xlen = march.startsWith('rv32') ? 32 : 64;
  try {
    return {
      out: execFileSync(CLANG, [`--target=riscv${xlen}`, `-march=${march}`, ...args], {
        input,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).toString(),
    };
  } catch (error) {
    return {
      error: String(error.stderr)
        .split('\n')
        .find((line) => /error/.test(line)),
    };
  }
};

test('every example assembles', { skip: !CLANG && 'set RISCV_CLANG to run' }, () => {
  const failures = [];
  for (const [key] of instructions) {
    const line = exampleAssembly(key, metadata[key]?.assembly);
    if (!line) continue;
    const march = marchOf(key);
    const { error } = compile(
      march,
      ['-c', '-x', 'assembler', '-', '-o', '/dev/null'],
      `${line}\n`,
    );
    if (error && !TOOLCHAIN_LAG.test(error)) failures.push(`${line} [${march}]: ${error}`);
  }
  // The *inx listings, also on RV32 where Zdinx needs even register pairs.
  for (const { ext, instruction, key } of inxListings) {
    const line = exampleAssembly(key, metadata[key]?.assembly, ext.id);
    const march = instructionMarch({
      extensionId: ext.id,
      extensionTags: instruction.extension,
      definedBy: metadata[key]?.defined_by,
      catalogIds,
    });
    const marches = [march];
    if (
      march.startsWith('rv64') &&
      xlenRestriction(instruction.extension, metadata[key]) !== 'RV64'
    ) {
      marches.push(march.replace(/^rv64/, 'rv32'));
    }
    for (const target of marches) {
      const { error } = compile(
        target,
        ['-c', '-x', 'assembler', '-', '-o', '/dev/null'],
        `${line}\n`,
      );
      if (error && !TOOLCHAIN_LAG.test(error)) failures.push(`${line} [${target}]: ${error}`);
    }
  }
  assert.deepEqual(failures, []);
});

test(
  'every intrinsic example compiles to its instruction',
  { skip: !CLANG && 'set RISCV_CLANG to run' },
  () => {
    // vmv.v.v is a copy the optimiser removes; the call itself is correct.
    // LLVM 20 emits vsha2ch for the vsha2cl intrinsic; the pinned clang 23.1
    // emits vsha2cl, so this is the local compiler's bug, not the example's.
    const elided = new Set(['vmv.v.v', 'vsha2cl.vv']);
    const failures = [];
    for (const [key, record] of Object.entries(intrinsics)) {
      if (!record.header || elided.has(key)) continue;
      const { instruction } = instructions.get(key);
      const xlen = preferredXlen(instruction.extension, metadata[key]?.defined_by);
      const prototype = prototypeFor(record.prototypes, xlen);
      const march = marchOf(key, intrinsicExtensions(prototype));
      const source = intrinsicSource(record.header, prototype, {
        immediate: takesImmediate(key, metadata[key]?.assembly),
      });
      const { out, error } = compile(
        march,
        [`-mabi=${abiForMarch(march)}`, '-O2', '-S', '-ffreestanding', '-x', 'c', '-', '-o', '-'],
        source,
      );
      if (error) {
        if (!TOOLCHAIN_LAG.test(error)) failures.push(`${key} [${march}]: ${error}`);
      } else if (!new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(out)) {
        failures.push(`${key} [${march}]: compiled, but not to ${key}`);
      }
    }
    assert.deepEqual(failures, []);
  },
);

test(
  'every intrinsic example under a vector subset compiles',
  { skip: !CLANG && 'set RISCV_CLANG to run' },
  () => {
    const failures = [];
    for (const [extensionId, key] of subsetIntrinsics) {
      const march = intrinsicMarch(extensionId, key);
      const source = intrinsicSource(
        intrinsics[key].header,
        prototypeFor(intrinsics[key].prototypes, 64),
        { immediate: takesImmediate(key, metadata[key]?.assembly) },
      );
      const args = [`-mabi=${abiForMarch(march)}`, '-S', '-ffreestanding', '-x', 'c', '-'];
      const { error } = compile(march, [...args, '-o', '/dev/null'], source);
      if (error && !TOOLCHAIN_LAG.test(error)) failures.push(`${extensionId} ${key}: ${error}`);
    }
    assert.deepEqual(failures, []);
  },
);
