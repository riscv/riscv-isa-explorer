/**
 * The embedded vector subsets, and the other extensions that had no upstream
 * instruction source.
 *
 * Zve32x, Zve32f, Zve64x, Zve64f and Zve64d shipped with empty instruction
 * maps. Every check the project runs passed anyway, and that is the point of
 * this file: riscv-opcodes has no `rv_zve*` tag, unified-db attributes all 627
 * vector instructions to one owner (Zvl32b), and the completeness gate only
 * ever asked whether an encoding was in the catalogue *somewhere* — which it
 * was, under V. Nothing upstream can catch a mistake in the derivation, so the
 * rules are pinned here instead.
 *
 * The counts are deliberately exact. A rule change that moves one instruction
 * should have to say so.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const catalogue = JSON.parse(
  fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'riscv_extensions.json'),
    'utf8',
  ),
);

const byId = new Map();
for (const group of Object.values(catalogue)) {
  if (Array.isArray(group)) for (const entry of group) byId.set(entry.id, entry);
}
const mnemonics = (id) => new Set(Object.keys(byId.get(id)?.instructions ?? {}));
const count = (id) => mnemonics(id).size;

// ---------------------------------------------------------------------------
// Zve*
// ---------------------------------------------------------------------------

test('every Zve* subset carries instructions', () => {
  for (const id of ['Zve32x', 'Zve32f', 'Zve64x', 'Zve64f', 'Zve64d']) {
    assert.ok(count(id) > 0, `${id} is empty — the derivation did not run`);
  }
});

test('the subsets nest the way the spec orders them', () => {
  // §30.1.18.2: Zve32f and Zve64x depend on Zve32x, Zve64f on both, Zve64d on
  // Zve64f. The chain forks: neither Zve32f nor Zve64x contains the other.
  const subsetOf = (sub, sup) => {
    const [a, b] = [mnemonics(sub), mnemonics(sup)];
    const escaped = [...a].filter((m) => !b.has(m));
    assert.deepEqual(escaped, [], `${sub} should be a subset of ${sup}`);
  };
  subsetOf('Zve32x', 'Zve32f');
  subsetOf('Zve32x', 'Zve64x');
  subsetOf('Zve32f', 'Zve64f');
  subsetOf('Zve64x', 'Zve64f');
  subsetOf('Zve64f', 'Zve64d');

  const f32 = mnemonics('Zve32f');
  const x64 = mnemonics('Zve64x');
  assert.ok([...f32].some((m) => !x64.has(m)), 'Zve32f should hold FP that Zve64x lacks');
  assert.ok([...x64].some((m) => !f32.has(m)), 'Zve64x should hold EEW=64 that Zve32f lacks');
});

test('Zve64d is V, because V is Zve64d plus a wider VLEN', () => {
  // V depends on Zve64d and Zvl128b; the extra requirement is minimum VLEN,
  // not instructions. Anything else here means the derivation dropped one.
  assert.deepEqual([...mnemonics('Zve64d')].sort(), [...mnemonics('V')].sort());
});

test('the x-variants exclude floating point and nothing else', () => {
  const v = mnemonics('V');
  const isFP = (m) => (/^VF/.test(m) && m !== 'VFIRST.M') || /^VMF/.test(m);
  const expected = [...v].filter((m) => !isFP(m)).sort();
  assert.deepEqual([...mnemonics('Zve64x')].sort(), expected);

  // The mnemonics that read as floating point and are not.
  assert.ok(mnemonics('Zve32x').has('VFIRST.M'), 'VFIRST.M is a mask instruction');
  for (const m of ['VSEXT.VF2', 'VZEXT.VF4', 'VSEXT.VF8']) {
    assert.ok(mnemonics('Zve32x').has(m), `${m} is integer — the VF is a widening factor`);
  }
  // ...and the FP compares, which are spelled VMF rather than VF.
  for (const m of ['VMFEQ.VV', 'VMFLT.VF']) {
    assert.ok(!mnemonics('Zve64x').has(m), `${m} is a floating-point compare`);
  }
});

test('Zve32* stop at EEW=32, so the EEW=64 encodings are absent', () => {
  const z32 = mnemonics('Zve32x');
  for (const m of ['VLE64.V', 'VSE64.V', 'VL4RE64.V', 'VLSEG8E64.V', 'VLE64FF.V']) {
    assert.ok(!z32.has(m), `${m} names EEW=64`);
  }
  for (const m of ['VLOXEI64.V', 'VSUXSEG3EI64.V']) {
    assert.ok(!z32.has(m), `${m} is a 64-bit indexed form`);
  }
  // The Zve64* pair carries all of them.
  for (const m of ['VLE64.V', 'VLOXEI64.V']) {
    assert.ok(mnemonics('Zve64x').has(m), `${m} should be in Zve64x`);
  }
  // Nothing else is dropped: EEW 8/16/32 stay.
  for (const m of ['VLE8.V', 'VLE16.V', 'VLE32.V', 'VADD.VV', 'VMULH.VV', 'VSMUL.VV']) {
    assert.ok(z32.has(m), `${m} is within EEW=32`);
  }
});

test('the f-variants take FP32 but not the work that needs FP64', () => {
  for (const id of ['Zve32f', 'Zve64f']) {
    const set = mnemonics(id);
    for (const m of ['VFADD.VV', 'VFMUL.VF', 'VFSQRT.V', 'VFREDUSUM.VS', 'VFMV.F.S']) {
      assert.ok(set.has(m), `${id} should carry ${m} at EEW=32`);
    }
    // Widening FP arithmetic produces a 2×SEW float, which is FP64 here.
    for (const m of ['VFWADD.VV', 'VFWMUL.VF', 'VFWMACC.VV', 'VFWNMSAC.VF']) {
      assert.ok(!set.has(m), `${id} cannot widen to FP64 (${m})`);
    }
    // §30.1.18.2 lists widening FP reductions for Zve64d only.
    for (const m of ['VFWREDUSUM.VS', 'VFWREDOSUM.VS']) {
      assert.ok(!set.has(m), `${id} has no widening FP reduction (${m})`);
    }
    // Float-to-float conversions need two float widths.
    for (const m of ['VFWCVT.F.F.V', 'VFNCVT.F.F.W', 'VFNCVT.ROD.F.F.W']) {
      assert.ok(!set.has(m), `${id} has only one float width (${m})`);
    }
  }
  assert.ok(mnemonics('Zve64d').has('VFWADD.VV'), 'Zve64d has FP64 and so widens');
});

test('an FP/integer conversion turns on the integer width, not the float', () => {
  /*
   * These are the ones that separate Zve32f from Zve64f, and the reason the
   * carve-out cannot be a single flat list. Both extensions offer FP32 and no
   * FP64; they differ in whether an integer may be 64 bits wide.
   */
  const f32 = mnemonics('Zve32f');
  const f64 = mnemonics('Zve64f');

  for (const m of ['VFWCVT.X.F.V', 'VFWCVT.RTZ.XU.F.V', 'VFNCVT.F.X.W', 'VFNCVT.F.XU.W']) {
    assert.ok(!f32.has(m), `${m} needs a 64-bit integer, which Zve32f lacks`);
    assert.ok(f64.has(m), `${m} is available in Zve64f, which has EEW=64 integers`);
  }
  // Their mirror images stay in both: int16 → FP32 and FP32 → int16.
  for (const m of ['VFWCVT.F.X.V', 'VFWCVT.F.XU.V', 'VFNCVT.X.F.W', 'VFNCVT.RTZ.XU.F.W']) {
    assert.ok(f32.has(m), `${m} stays within EEW=32`);
    assert.ok(f64.has(m), `${m} stays within EEW=32`);
  }
});

test('the derived sets have not silently moved', () => {
  assert.deepEqual(
    {
      Zve32x: count('Zve32x'),
      Zve32f: count('Zve32f'),
      Zve64x: count('Zve64x'),
      Zve64f: count('Zve64f'),
      Zve64d: count('Zve64d'),
    },
    { Zve32x: 450, Zve32f: 522, Zve64x: 526, Zve64f: 604, Zve64d: 627 },
  );
});

// ---------------------------------------------------------------------------
// The other extensions that were present in name only
// ---------------------------------------------------------------------------

test('Zvkb carries the nine forms the crypto extensions share', () => {
  // riscv-opcodes has no rv_zvkb tag; the nine appear there with three
  // memberships (rv_zvbb, rv_zvkn, rv_zvks), so tag routing left Zvkb empty.
  assert.deepEqual([...mnemonics('Zvkb')].sort(), [
    'VANDN.VV',
    'VANDN.VX',
    'VBREV8.V',
    'VREV8.V',
    'VROL.VV',
    'VROL.VX',
    'VROR.VI',
    'VROR.VV',
    'VROR.VX',
  ]);
  // They are exactly the intersection of the two bundles that share them.
  const shared = [...mnemonics('Zvkn')].filter((m) => mnemonics('Zvks').has(m)).sort();
  assert.deepEqual([...mnemonics('Zvkb')].sort(), shared);
});

test('Zilsd and Zclsd carry their RV32 register-pair encodings', () => {
  assert.deepEqual([...mnemonics('Zilsd')].sort(), ['LD.RV32', 'SD.RV32']);
  assert.deepEqual([...mnemonics('Zclsd')].sort(), [
    'C.LD.RV32',
    'C.LDSP.RV32',
    'C.SD.RV32',
    'C.SDSP.RV32',
  ]);

  /*
   * The whole point is that these are NOT the RV64 rows. Each pins one extra
   * bit — the even-register constraint that makes the operand a pair — so the
   * mask must differ from the RV64 instruction of the same name.
   */
  const rv64 = byId.get('RV64I').instructions;
  const zilsd = byId.get('Zilsd').instructions;
  assert.equal(zilsd['LD.RV32'].match, rv64.LD.match, 'same opcode as the RV64 load');
  assert.notEqual(zilsd['LD.RV32'].mask, rv64.LD.mask, 'but a narrower mask');
  assert.ok(
    zilsd['LD.RV32'].variable_fields.includes('rd_e'),
    'the destination is an even register pair',
  );
  assert.ok(
    zilsd['SD.RV32'].variable_fields.includes('rs2_e'),
    'the source is an even register pair',
  );
});

test('the bundles resolve to the union of their members', () => {
  // Modelled with `members`, the same umbrella mechanism B and Zk use. The
  // dependency graph always had the relation, so a resolved selection was
  // right; the entries' own maps were empty, which is what compare reads.
  const union = (...ids) => new Set(ids.flatMap((id) => [...mnemonics(id)]));
  const same = (id, ...members) =>
    assert.deepEqual([...mnemonics(id)].sort(), [...union(...members)].sort(), id);

  same('Zvknc', 'Zvkn', 'Zvbc');
  same('Zvkng', 'Zvkn', 'Zvkg');
  same('Zvksc', 'Zvks', 'Zvbc');
  same('Zvksg', 'Zvks', 'Zvkg');
  // Zce omits Zcf: that member is conditional on RV32+F, and an umbrella
  // carries no conditionals.
  same('Zce', 'Zca', 'Zcb', 'Zcmp', 'Zcmt');
});

// ---------------------------------------------------------------------------
// SPMP
// ---------------------------------------------------------------------------

test('the SPMP family is catalogued', () => {
  for (const id of ['Sspmp', 'Sspmpen', 'Smpmpdeleg']) {
    const entry = byId.get(id);
    assert.ok(entry, `${id} missing from the catalogue`);
    assert.equal(entry.state, 'ratified');
    assert.equal(entry.ratification_date, '2026-08');
    // CSR-only extensions. An empty instruction map is correct here, unlike
    // the Zve* case above.
    assert.equal(count(id), 0, `${id} defines no instructions`);
  }
  assert.equal(byId.get('Sspmpen').csrs.spmpen.address, '0x183');
  assert.equal(byId.get('Smpmpdeleg').csrs.mpmpdeleg.address, '0x316');
});
