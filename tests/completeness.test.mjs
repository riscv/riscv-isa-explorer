import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AQ_BIT,
  RL_BIT,
  ORDERING_BITS,
  patternCovers,
  encodingIsWellFormed,
  extraFixedBits,
  isOrderingRefinement,
  flattenCatalogue,
  compareAgainstUpstream,
  isVariantSpelling,
} from '../src/completeness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const catalogue = JSON.parse(
  fs.readFileSync(path.join(here, '..', 'src', 'riscv_extensions.json'), 'utf8'),
);

/*
 * The real encodings these tests lean on, taken from the catalogue rather than
 * retyped, so a data change cannot leave the tests asserting against fiction.
 */
const rowFor = (id, mnemonic) =>
  flattenCatalogue(catalogue).find(
    (r) => r.extension === id && r.mnemonic === mnemonic.toUpperCase(),
  );

// ── the bit arithmetic ─────────────────────────────────────────────────────

test('aq and rl are bits 26 and 25', () => {
  assert.equal(AQ_BIT, 1n << 26n);
  assert.equal(RL_BIT, 1n << 25n);
  assert.equal(ORDERING_BITS, (1n << 26n) | (1n << 25n));
});

test('a row covers an upstream encoding that pins more bits to the same values', () => {
  const local = { match: 0x202fn, mask: 0xf800707fn }; // AMOADD.W, aq/rl free
  const upstreamAq = { match: 0x202fn | AQ_BIT, mask: 0xf800707fn | AQ_BIT };
  assert.equal(patternCovers(local, upstreamAq), true);
});

test('a row does NOT cover an encoding that disagrees on a bit it fixes', () => {
  const local = { match: 0x202fn, mask: 0xf800707fn };
  const different = { match: 0x302fn, mask: 0xf800707fn }; // different funct
  assert.equal(patternCovers(local, different), false);
});

test('a row that fixes MORE than upstream does not cover it', () => {
  // This is the regression case: our mask quietly narrows, so we would stop
  // matching encodings we used to match. Name comparison cannot see this.
  const narrowed = { match: 0x202fn | AQ_BIT, mask: 0xf800707fn | AQ_BIT };
  const upstream = { match: 0x202fn, mask: 0xf800707fn };
  assert.equal(patternCovers(narrowed, upstream), false);
});

test('coverage is reflexive', () => {
  const row = { match: 0x202fn, mask: 0xf800707fn };
  assert.equal(patternCovers(row, row), true);
});

test('match bits outside the mask are malformed', () => {
  assert.equal(encodingIsWellFormed({ match: 0x202fn, mask: 0xf800707fn }), true);
  // a bit set in match that the mask never tests: dead, and always a mistake
  assert.equal(encodingIsWellFormed({ match: 0x1000000n, mask: 0x707fn }), false);
});

test('extra fixed bits are reported, and ordering-only is distinguished', () => {
  const local = { match: 0x202fn, mask: 0xf800707fn };
  const aq = { match: 0x202fn | AQ_BIT, mask: 0xf800707fn | AQ_BIT };
  assert.equal(extraFixedBits(local, aq), AQ_BIT);
  assert.equal(isOrderingRefinement(local, aq), true);

  /*
   * Bit 20, chosen because 0xf800707f leaves it free. An earlier version of
   * this used bit 31, which that mask ALREADY fixes, so extraFixedBits was zero
   * and the assertion held whatever isOrderingRefinement did. Mutation testing
   * found it: breaking the function changed nothing here.
   */
  const otherBit = { match: 0x202fn, mask: 0xf800707fn | (1n << 20n) };
  assert.equal(extraFixedBits(local, otherBit), 1n << 20n, 'bit 20 must be free in the local mask');
  assert.equal(isOrderingRefinement(local, otherBit), false, 'bit 20 is not an ordering bit');

  // And a mixture is not ordering-only either.
  const mixed = { match: 0x202fn, mask: 0xf800707fn | AQ_BIT | (1n << 20n) };
  assert.equal(isOrderingRefinement(local, mixed), false, 'aq plus a non-ordering bit');
});

// ── the Zalasr trap ────────────────────────────────────────────────────────

test('Zalasr really does fix an ordering bit in the mnemonic', () => {
  // The premise the whole design rests on. If this ever stops being true the
  // reasoning in completeness.js needs revisiting, so it is asserted, not
  // assumed.
  const lbaq = rowFor('Zalasr', 'LB.AQ');
  const sbrl = rowFor('Zalasr', 'SB.RL');
  assert.ok(lbaq, 'Zalasr LB.AQ must exist');
  assert.ok(sbrl, 'Zalasr SB.RL must exist');
  assert.equal((lbaq.mask & AQ_BIT) !== 0n, true, 'LB.AQ pins aq');
  assert.equal((lbaq.mask & RL_BIT) !== 0n, false, 'LB.AQ leaves rl free');
  assert.equal((sbrl.mask & RL_BIT) !== 0n, true, 'SB.RL pins rl');
  assert.equal((sbrl.mask & AQ_BIT) !== 0n, false, 'SB.RL leaves aq free');
});

test('Zalasr LB.AQ is not covered by the base ISA LB', () => {
  // The exact failure a suffix-stripping gate would produce: LB.AQ normalises
  // to LB, matches a different instruction, and a real gap is hidden.
  const zalasr = rowFor('Zalasr', 'LB.AQ');
  const baseLb = flattenCatalogue(catalogue).find(
    (r) => r.mnemonic === 'LB' && r.extension !== 'Zalasr',
  );
  assert.ok(baseLb, 'the base ISA LB must exist for this test to mean anything');
  assert.equal(
    patternCovers(baseLb, zalasr),
    false,
    'base LB must not be treated as covering Zalasr LB.AQ',
  );
});

test('an upstream LB.AQ is matched to Zalasr, not to the base ISA', () => {
  const zalasr = rowFor('Zalasr', 'LB.AQ');
  const result = compareAgainstUpstream(catalogue, {
    extensions: [],
    instructions: [
      {
        mnemonic: 'LB.AQ',
        match: zalasr.match,
        mask: zalasr.mask,
        definedBy: ['Zalasr'],
      },
    ],
  });
  assert.deepEqual(result.missingInstructions, [], 'Zalasr LB.AQ is present and should match');
});

test('ownership decides the bucket: right encoding, wrong extension is an attribution', () => {
  // Ownership is still checked first, but failing it no longer means "missing".
  // Carrying the encoding somewhere is a different fact from not carrying it at
  // all, and conflating the two is what made 664 rows out of roughly 30 real
  // gaps when this was first run against unified-db.
  const zalasr = rowFor('Zalasr', 'LB.AQ');
  const result = compareAgainstUpstream(catalogue, {
    extensions: [],
    instructions: [
      {
        mnemonic: 'LB.AQ',
        match: zalasr.match,
        mask: zalasr.mask,
        definedBy: ['Zicsr'], // an extension that does not define it
      },
    ],
  });
  assert.equal(result.missingInstructions.length, 0);
  assert.equal(result.attributedDifferently.length, 1);
  assert.equal(result.attributedDifferently[0].localExtension, 'Zalasr');
});

test('the two coverage questions are answered separately', () => {
  /*
   * The bug this guards: "is the encoding in the catalogue anywhere" reads
   * 100% while an extension lists nothing at all. That is not hypothetical —
   * it is exactly how Zve32x, Zve32f, Zve64x, Zve64f and Zvkb shipped empty
   * past every check, their instructions all present under V and Zvbb.
   *
   * One instruction, attributed by upstream to an extension that does not list
   * it locally, must count as covered globally and uncovered per-extension.
   */
  const zalasr = rowFor('Zalasr', 'LB.AQ');
  const result = compareAgainstUpstream(catalogue, {
    extensions: [],
    instructions: [
      { mnemonic: 'LB.AQ', match: zalasr.match, mask: zalasr.mask, definedBy: ['Zicsr'] },
    ],
  });

  assert.equal(result.coverage.considered, 1);
  assert.deepEqual(result.coverage.global, { covered: 1, uncovered: 0, percent: 100 });
  assert.equal(result.coverage.perExtension.covered, 0);
  assert.equal(result.coverage.perExtension.filedElsewhere, 1);
  assert.equal(result.coverage.perExtension.percent, 0);

  // `complete` is global coverage, and now says so rather than implying it.
  assert.equal(result.complete, true, 'nothing is absent, so the gate passes');
});

test('coverage buckets account for every instruction considered', () => {
  // considered = covered here + filed elsewhere + encoding disagrees + absent.
  // If they ever stop adding up, a bucket is being double-counted.
  const zalasr = rowFor('Zalasr', 'LB.AQ');
  const result = compareAgainstUpstream(catalogue, {
    extensions: [],
    instructions: [
      { mnemonic: 'LB.AQ', match: zalasr.match, mask: zalasr.mask, definedBy: ['Zalasr'] },
      { mnemonic: 'LB.AQ', match: zalasr.match, mask: zalasr.mask, definedBy: ['Zicsr'] },
      { mnemonic: 'NOSUCH.INSN', match: '0xdeadbeef', mask: '0xffffffff', definedBy: ['Zicsr'] },
    ],
  });
  const { considered, perExtension: pe } = result.coverage;
  assert.equal(considered, 3);
  assert.equal(pe.covered + pe.filedElsewhere + pe.encodingDisagrees + pe.uncovered, considered);
  assert.equal(pe.covered, 1);
  assert.equal(pe.filedElsewhere, 1);
  assert.equal(pe.uncovered, 1);
  assert.equal(result.complete, false, 'a genuinely absent encoding still fails the gate');
});

// ── the ordering variants, against real data ───────────────────────────────

test('all four orderings of a real AMO are covered by the one catalogue row', () => {
  const amo = rowFor('Zaamo', 'AMOADD.W') || rowFor('A', 'AMOADD.W');
  assert.ok(amo, 'AMOADD.W must exist somewhere in the catalogue');

  const variants = [
    { suffix: '', extra: 0n },
    { suffix: '.AQ', extra: AQ_BIT },
    { suffix: '.RL', extra: RL_BIT },
    { suffix: '.AQRL', extra: ORDERING_BITS },
  ].map(({ suffix, extra }) => ({
    mnemonic: `AMOADD.W${suffix}`,
    match: amo.match | extra,
    mask: amo.mask | extra,
    definedBy: [amo.extension],
  }));

  const result = compareAgainstUpstream(catalogue, { extensions: [], instructions: variants });
  assert.deepEqual(result.missingInstructions, [], 'no ordering variant should read as missing');
  assert.equal(
    result.coveredByBroaderRow.filter((c) => c.orderingOnly).length,
    3,
    'the three suffixed forms are covered by the base row, on ordering bits alone',
  );
});

test('a variant whose base is absent is still reported missing', () => {
  // The gate must not be fooled by the shape of a name. FOO.W.AQ has no base
  // row anywhere, so it is a genuine gap and has to surface as one.
  const result = compareAgainstUpstream(catalogue, {
    extensions: [],
    instructions: [
      { mnemonic: 'FOO.W.AQ', match: 0x1234567n, mask: 0xfffffffn, definedBy: ['Zaamo'] },
    ],
  });
  assert.equal(result.missingInstructions.length, 1);
  assert.equal(result.missingInstructions[0].mnemonic, 'FOO.W.AQ');
});

// ── extensions ─────────────────────────────────────────────────────────────

test('an upstream extension we lack is reported, case-insensitively', () => {
  const result = compareAgainstUpstream(catalogue, {
    extensions: ['Zvfofp4min', 'zba', 'ZBB'],
    instructions: [],
  });
  assert.deepEqual(result.missingExtensions, ['Zvfofp4min']);
});

test('an allowlisted extension is not reported', () => {
  const result = compareAgainstUpstream(
    catalogue,
    { extensions: ['I'], instructions: [] },
    { allowMissingExtensions: ['I'] },
  );
  assert.deepEqual(result.missingExtensions, []);
});

// ── narrowing, surplus, malformed ──────────────────────────────────────────

test('a name that exists but whose bits disagree is a mismatch, not a gap', () => {
  const amo = rowFor('Zaamo', 'AMOADD.W') || rowFor('A', 'AMOADD.W');
  const result = compareAgainstUpstream(catalogue, {
    extensions: [],
    instructions: [
      {
        mnemonic: 'AMOADD.W',
        // upstream leaves a bit free that we pin: we are narrower than upstream
        match: amo.match,
        mask: amo.mask & ~0x7fn,
        definedBy: [amo.extension],
      },
    ],
  });
  assert.equal(result.missingInstructions.length, 0);
  assert.equal(result.encodingMismatches.length, 1);
  assert.equal(result.encodingMismatches[0].mnemonic, 'AMOADD.W');
  assert.equal(result.encodingMismatches[0].narrower, true, 'we pin bits upstream leaves free');
  assert.match(result.encodingMismatches[0].local, /match 0x/, 'both halves are reported');
  assert.match(result.encodingMismatches[0].upstream, /mask 0x/);
});

test('instructions we carry that upstream does not are reported as surplus', () => {
  const result = compareAgainstUpstream(catalogue, { extensions: [], instructions: [] });
  assert.ok(result.surplusInstructions.length > 0, 'with an empty upstream, everything is surplus');
  assert.ok(
    result.surplusInstructions.every((s) => s.mnemonic && s.extension),
    'each surplus row names its instruction and its extension',
  );
});

test('the real catalogue contains no malformed encodings', () => {
  // match must never set a bit its own mask leaves untested.
  const result = compareAgainstUpstream(catalogue, { extensions: [], instructions: [] });
  assert.deepEqual(
    result.malformed,
    [],
    `malformed encodings: ${JSON.stringify(result.malformed)}`,
  );
});

test('complete is true only when nothing is missing', () => {
  const empty = compareAgainstUpstream(catalogue, { extensions: [], instructions: [] });
  assert.equal(empty.complete, true);

  const gap = compareAgainstUpstream(catalogue, {
    extensions: ['DefinitelyNotHere'],
    instructions: [],
  });
  assert.equal(gap.complete, false);
});

test('flattenCatalogue skips entries with no encoding rather than throwing', () => {
  const rows = flattenCatalogue({
    g: [
      { id: 'X', instructions: { GOOD: { match: '0x1', mask: '0x1' }, BAD: {} } },
      { id: 'Y' },
      null,
    ],
  });
  assert.deepEqual(
    rows.map((r) => r.mnemonic),
    ['GOOD'],
  );
});

// ── attribution versus absence ─────────────────────────────────────────────

test('an instruction we file under a different extension is not "missing"', () => {
  // unified-db attributes AMOCAS.B to Zabha; this catalogue files it under
  // Zacas. Both readings are defensible, so it is an attribution difference
  // and must not be reported as a gap.
  const amocas = rowFor('Zacas', 'AMOCAS.B');
  assert.ok(amocas, 'AMOCAS.B is expected under Zacas');

  const result = compareAgainstUpstream(catalogue, {
    extensions: [],
    instructions: [
      { mnemonic: 'AMOCAS.B', match: amocas.match, mask: amocas.mask, definedBy: ['Zabha'] },
    ],
  });

  assert.deepEqual(result.missingInstructions, []);
  assert.equal(result.attributedDifferently.length, 1);
  assert.equal(result.attributedDifferently[0].localExtension, 'Zacas');
  assert.deepEqual(result.attributedDifferently[0].upstreamOwners, ['Zabha']);
});

test('attribution fallback still cannot match Zalasr LB.AQ to the base LB', () => {
  // The fallback searches every extension, so this is where a bits-blind
  // implementation would finally leak. It must not: the encodings differ.
  const zalasr = rowFor('Zalasr', 'LB.AQ');
  const result = compareAgainstUpstream(catalogue, {
    extensions: [],
    instructions: [
      { mnemonic: 'LB.AQ', match: zalasr.match, mask: zalasr.mask, definedBy: ['Zicsr'] },
    ],
  });
  // Found, but only because Zalasr genuinely carries this exact encoding.
  assert.equal(result.missingInstructions.length, 0);
  assert.equal(result.attributedDifferently[0].localExtension, 'Zalasr');
});

test('an encoding nobody carries is missing, wherever it claims to live', () => {
  const result = compareAgainstUpstream(catalogue, {
    extensions: [],
    instructions: [
      // opcode 0x0b is custom-0: nothing in the catalogue can cover it. An
      // earlier version used 0x73, the SYSTEM opcode, and matched a real row.
      { mnemonic: 'NOPE.W', match: 0x7f00000bn, mask: 0xffffffffn, definedBy: ['Zbb'] },
    ],
  });
  assert.equal(result.missingInstructions.length, 1);
  assert.equal(result.attributedDifferently.length, 0);
});

test('extensionAliases map an upstream id onto the local ones', () => {
  const add = flattenCatalogue(catalogue).find((r) => r.mnemonic === 'ADD');
  assert.ok(add, 'ADD must exist');

  const upstream = {
    extensions: [],
    instructions: [{ mnemonic: 'ADD', match: add.match, mask: add.mask, definedBy: ['I'] }],
  };

  const without = compareAgainstUpstream(catalogue, upstream);
  const withAlias = compareAgainstUpstream(catalogue, upstream, {
    extensionAliases: { I: ['RV32I', 'RV64I'] },
  });

  assert.equal(withAlias.missingInstructions.length, 0);
  assert.equal(withAlias.attributedDifferently.length, 0, 'the alias makes it a direct match');
  assert.equal(
    without.attributedDifferently.length,
    1,
    'without the alias it is merely attributed elsewhere, never missing',
  );
});

// ── ratification state ─────────────────────────────────────────────────────

test('unratified upstream work is not a completeness gap', () => {
  // The correction that mattered most. Zilx is state `development` in
  // unified-db, and the first version of this gate reported it plus nineteen
  // instructions as missing. Nobody is waiting on a draft.
  /*
   * Synthetic names on purpose. An earlier version used Shlcofideleg and Zilx,
   * the real gaps at the time, and adding Shlcofideleg to the catalogue broke
   * this test. A fixture that stops being a gap the moment someone fixes the
   * gap is testing the data, not the logic.
   */
  const upstream = {
    extensions: ['Zratifiedmissing', 'Zdevelopmentmissing'],
    instructions: [
      {
        mnemonic: 'DRAFTONLY',
        match: 0x1000000bn,
        mask: 0xffffffffn,
        definedBy: ['Zdevelopmentmissing'],
      },
      {
        mnemonic: 'RATIFIEDONLY',
        match: 0x2000000bn,
        mask: 0xffffffffn,
        definedBy: ['Zratifiedmissing'],
      },
    ],
  };

  const ratifiedOnly = compareAgainstUpstream(catalogue, upstream, {
    onlyRatified: true,
    ratifiedExtensions: ['Zratifiedmissing'],
  });
  assert.deepEqual(ratifiedOnly.missingExtensions, ['Zratifiedmissing'], 'only the ratified one');
  assert.deepEqual(
    ratifiedOnly.missingInstructions.map((m) => m.mnemonic),
    ['RATIFIEDONLY'],
    'an instruction owned only by a development extension is not a gap',
  );

  const everything = compareAgainstUpstream(catalogue, upstream, {
    onlyRatified: false,
    ratifiedExtensions: ['Zratifiedmissing'],
  });
  assert.deepEqual(everything.missingExtensions, ['Zdevelopmentmissing', 'Zratifiedmissing']);
  assert.equal(everything.missingInstructions.length, 2, 'the wider view still shows both');
});

test('an instruction counts as ratified if ANY of its owners is', () => {
  // unified-db attributes some instructions to several extensions. If one of
  // them is ratified the instruction is reachable from ratified material, so
  // its absence is a real gap.
  const upstream = {
    extensions: [],
    instructions: [
      { mnemonic: 'SHARED', match: 0x3000000bn, mask: 0xffffffffn, definedBy: ['Draft', 'Zbb'] },
    ],
  };
  const result = compareAgainstUpstream(catalogue, upstream, {
    onlyRatified: true,
    ratifiedExtensions: ['Zbb'],
  });
  assert.equal(result.missingInstructions.length, 1);
});

test('ratification filtering is case-insensitive and defaults to off', () => {
  // Synthetic, for the same reason as above.
  const upstream = { extensions: ['Zsynthetic'], instructions: [] };

  const lower = compareAgainstUpstream(catalogue, upstream, {
    onlyRatified: true,
    ratifiedExtensions: ['zsynthetic'],
  });
  assert.deepEqual(lower.missingExtensions, ['Zsynthetic'], 'case should not matter');

  const off = compareAgainstUpstream(catalogue, upstream);
  assert.deepEqual(off.missingExtensions, ['Zsynthetic'], 'unfiltered by default');
});

// ── variant spellings ──────────────────────────────────────────────────────

test('a variant spelling is an ordering or XLEN suffix, nothing looser', () => {
  assert.equal(isVariantSpelling('AMOADD.W', 'AMOADD.W.AQ'), true);
  assert.equal(isVariantSpelling('REV8.RV32', 'REV8'), true);
  assert.equal(isVariantSpelling('LR.W', 'LR.W.AQRL'), true);
  assert.equal(isVariantSpelling('ADD', 'ADD'), true);

  /*
   * The cases that made this necessary. Letting any broader pattern in the same
   * extension claim coverage reported C.ADDIW as covered by C.JAL and C.JALR by
   * C.ADD, which merely share an encoding slot, and ZEXT.H as covered by PACKW,
   * which it is only because zext.h is packw with rs2 = 0. A completeness gate
   * that accepts those reports a catalogue complete because somebody else's
   * bits happen to be a superset.
   */
  assert.equal(isVariantSpelling('C.JAL', 'C.ADDIW'), false);
  assert.equal(isVariantSpelling('C.ADD', 'C.JALR'), false);
  assert.equal(isVariantSpelling('PACKW', 'ZEXT.H'), false);
  assert.equal(isVariantSpelling('FENCE', 'FENCE.TSO'), false);
});

test('a broader row with an unrelated name does not count as coverage', () => {
  // FENCE's mask is broad enough to cover FENCE.TSO's bits. They are different
  // instructions, so this must surface rather than pass.
  const fence = flattenCatalogue(catalogue).find((r) => r.mnemonic === 'FENCE');
  assert.ok(fence, 'FENCE must exist');

  const result = compareAgainstUpstream(catalogue, {
    extensions: [],
    instructions: [
      {
        mnemonic: 'FENCE.TSO',
        match: fence.match | (0x8330n << 16n),
        mask: 0xffffffffn,
        definedBy: [fence.extension],
      },
    ],
  });
  assert.equal(result.coveredByBroaderRow.length, 0, 'FENCE must not cover FENCE.TSO');
});
