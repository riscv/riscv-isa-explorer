/**
 * completeness.js — is the catalogue missing anything the upstream spec has?
 *
 * Pure functions, no I/O and no data imports: both sides are passed in, the
 * same contract marchUtils.js keeps. The script that reads riscv-unified-db
 * off disk lives in scripts/; everything decidable lives here so it can be
 * tested without a checkout.
 *
 * WHY ENCODING COVERAGE RATHER THAN NAME MATCHING
 *
 * unified-db enumerates memory-ordering forms as separate instructions:
 * amoadd.w, amoadd.w.aq, amoadd.w.rl, amoadd.w.aqrl. This catalogue models one
 * AMOADD.W whose mask leaves the aq and rl bits unconstrained, which is how
 * riscv-opcodes models them too (both appear in variable_fields beside rd and
 * rs1). One row already covers all four encodings.
 *
 * The tempting shortcut is to strip a trailing .aq/.rl/.aqrl from the upstream
 * name before comparing. That is wrong, and Zalasr is the proof: its loads are
 * LB.AQ with the aq bit FIXED, because forms without it are reserved, and its
 * stores are SB.RL with rl fixed. Stripping turns LB.AQ into LB, which is a
 * different instruction in the base ISA with a different encoding. The gate
 * would either match the wrong row and hide a real gap, or collide.
 *
 * So coverage is decided on the bits. An upstream encoding is covered when a
 * local row in the SAME extension constrains a subset of the same bits to the
 * same values. That answers the question actually being asked -- "would this
 * upstream instruction decode as something we already list" -- and it cannot be
 * fooled by a name.
 */

/** aq is bit 26, rl is bit 25, per the A extension's AMO format. */
export const AQ_BIT = 1n << 26n;
export const RL_BIT = 1n << 25n;
export const ORDERING_BITS = AQ_BIT | RL_BIT;

const big = (v) => (typeof v === 'bigint' ? v : BigInt(v));

/**
 * Does the local pattern cover the upstream one?
 *
 * True when local fixes a subset of the bits upstream fixes, and agrees with it
 * on every bit local does fix. A local row with aq/rl unconstrained therefore
 * covers all four ordering forms, while a local row that fixed MORE bits than
 * upstream does not cover it, which is what catches a mask quietly narrowing.
 */
export function patternCovers(local, upstream) {
  const lMask = big(local.mask);
  const lMatch = big(local.match);
  const uMask = big(upstream.mask);
  const uMatch = big(upstream.match);

  if ((uMask & lMask) !== lMask) return false;
  return ((uMatch ^ lMatch) & lMask) === 0n;
}

/**
 * An encoding is well formed when it sets no bit its own mask leaves free.
 *
 * A match bit outside the mask can never be tested, so it is silently dead. It
 * usually means a hand-edited entry drifted.
 */
export function encodingIsWellFormed({ match, mask }) {
  return (big(match) & ~big(mask)) === 0n;
}

/**
 * The bits upstream pins that we leave free, and whether they are only ordering
 * bits. Used to explain WHY something is covered rather than merely that it is.
 */
export function extraFixedBits(local, upstream) {
  return big(upstream.mask) & ~big(local.mask);
}

export function isOrderingRefinement(local, upstream) {
  const extra = extraFixedBits(local, upstream);
  return extra !== 0n && (extra & ~ORDERING_BITS) === 0n;
}

/**
 * Is `local` a variant spelling of the same instruction as `upstream`?
 *
 * Coverage by a differently-named row is only meaningful for names that denote
 * the SAME instruction spelled differently: an ordering suffix upstream
 * enumerates and we fold into the base row, or an XLEN suffix we use where
 * upstream keys the encoding by XLEN instead.
 *
 * Anything looser is dangerous. Letting any broader pattern in the same
 * extension claim coverage reported C.ADDIW as covered by C.JAL and C.JALR by
 * C.ADD -- different instructions that merely share an encoding slot -- and
 * ZEXT.H as covered by PACKW, which it is only because zext.h is packw with
 * rs2 = 0. A completeness gate that accepts those is reporting a catalogue
 * complete because somebody else's bits happen to be a superset.
 */
export function isVariantSpelling(local, upstream) {
  const strip = (m) => m.replace(/\.(AQRL|AQ|RL)$/, '').replace(/\.(RV32|RV64)$/, '');
  if (local === upstream) return true;
  return strip(local) === strip(upstream) && strip(local).length > 0;
}

/** Every instruction in the catalogue, flattened, keeping its owning entry. */
export function flattenCatalogue(catalogue) {
  const rows = [];
  for (const group of Object.values(catalogue || {})) {
    for (const entry of group || []) {
      if (!entry || !entry.id) continue;
      for (const [mnemonic, details] of Object.entries(entry.instructions || {})) {
        if (!details || details.match == null || details.mask == null) continue;
        rows.push({
          extension: entry.id,
          mnemonic: mnemonic.toUpperCase(),
          match: big(details.match),
          mask: big(details.mask),
          variableFields: details.variable_fields || [],
        });
      }
    }
  }
  return rows;
}

/**
 * Compare the catalogue against an upstream inventory.
 *
 * `upstream` is { extensions: [id...], instructions: [{ mnemonic, match, mask,
 * definedBy }] }, already normalised by the caller from whatever upstream
 * ships. definedBy is a list, because unified-db can attribute one instruction
 * to several extensions.
 *
 * Reports rather than throws. A completeness gate that fails the build the day
 * upstream adds something is a gate people switch off.
 */
export function compareAgainstUpstream(catalogue, upstream, options = {}) {
  const {
    allowMissingExtensions = [],
    allowMissingInstructions = [],
    /*
     * Upstream ids that this catalogue models under different ones. Upstream's
     * bare `I` is our RV32I and RV64I, for instance. Without this, a deliberate
     * modelling choice reads as hundreds of missing instructions and buries the
     * real gaps.
     */
    extensionAliases = {},
    /*
     * Restrict the report to extensions upstream has ever ratified.
     *
     * unified-db carries drafts and in-development work alongside ratified
     * material, and treating its presence as ratification over-reports badly:
     * the first run of this gate called Zilx a gap, with nineteen instructions
     * behind it, when Zilx is state `development` and nobody should be waiting
     * on it. "Ever ratified" is the question the catalogue actually answers, so
     * an extension counts if ANY of its versions reached ratified, even if a
     * later one is frozen.
     */
    onlyRatified = false,
    ratifiedExtensions = [],
  } = options;

  const ratified = new Set(ratifiedExtensions.map((x) => x.toLowerCase()));
  const isRatified = (id) => ratified.has(String(id).toLowerCase());

  const aliasesFor = (id) => {
    const mapped = extensionAliases[id] || extensionAliases[id.toLowerCase()];
    return (mapped ? [id, ...mapped] : [id]).map((x) => x.toLowerCase());
  };

  const local = flattenCatalogue(catalogue);
  const localIds = new Set(
    Object.values(catalogue || {})
      .flat()
      .filter(Boolean)
      .map((e) => e.id.toLowerCase()),
  );

  const byExtension = new Map();
  for (const row of local) {
    const key = row.extension.toLowerCase();
    if (!byExtension.has(key)) byExtension.set(key, []);
    byExtension.get(key).push(row);
  }

  const missingExtensions = (upstream.extensions || [])
    .filter((id) => !localIds.has(id.toLowerCase()))
    .filter((id) => !allowMissingExtensions.includes(id))
    .filter((id) => !onlyRatified || isRatified(id))
    .sort();

  // An instruction is only a ratified gap if something ratified defines it.
  const upstreamIsRatified = (inst) =>
    !onlyRatified || (inst.definedBy || []).some((owner) => isRatified(owner));

  const missingInstructions = [];
  const attributedDifferently = [];
  const coveredByBroaderRow = [];
  const encodingMismatches = [];
  let considered = 0;

  for (const inst of upstream.instructions || []) {
    const mnemonic = inst.mnemonic.toUpperCase();
    if (allowMissingInstructions.includes(mnemonic)) continue;
    if (!upstreamIsRatified(inst)) continue;
    considered++;

    /*
     * Only rows in an extension upstream attributes the instruction to are
     * eligible. Without this, Zalasr's LB.AQ could be "covered" by the base
     * ISA's LB, which is a different instruction that happens to share a name
     * prefix.
     */
    const owners = (inst.definedBy || []).flatMap(aliasesFor);
    const candidates = owners.flatMap((o) => byExtension.get(o) || []);

    /*
     * ANY row with this mnemonic that covers the encoding settles it, not the
     * first one found.
     *
     * Upstream declares two encodings for the shift-immediates, one per XLEN,
     * and this catalogue carries them as separate rows: RV32I pins bit 25
     * because the shamt is five bits, RV64I leaves it free for the sixth. With
     * a first-match rule the RV64 encoding was compared against the RV32I row
     * and reported as a disagreement, when the matching row was sitting right
     * beside it.
     */
    const named = candidates.filter((c) => c.mnemonic === mnemonic);
    const covering = candidates.find(
      (c) => patternCovers(c, inst) && isVariantSpelling(c.mnemonic, mnemonic),
    );

    /*
     * Coverage is decided before naming. A row that carries the bits covers the
     * encoding whatever it is called, and only when NOTHING covers it does the
     * name become evidence of a disagreement.
     *
     * rev8 is why. Upstream declares both XLEN encodings under one name; this
     * catalogue follows riscv-opcodes and splits them into REV8 and REV8.RV32,
     * the latter filed under Zbkb. Checking the same-named row first found REV8,
     * saw the RV64 bits, and reported a mismatch without ever looking at
     * REV8.RV32 sitting beside it with exactly the encoding in question.
     */
    if (covering) {
      if (covering.mnemonic !== mnemonic) {
        coveredByBroaderRow.push({
          upstream: mnemonic,
          coveredBy: covering.mnemonic,
          extension: covering.extension,
          orderingOnly: isOrderingRefinement(covering, inst),
        });
      }
      continue;
    }

    const exact = named[0];
    if (exact) {
      // The name is here but the bits disagree: either we pin something
      // upstream leaves free, or we pin it to a different value.
      /*
       * The name is here but the bits disagree. Two different faults land here
       * and the report has to show both halves to tell them apart: we may pin
       * a bit upstream leaves free (a narrowing), or we may pin it to a
       * different value, which usually means upstream carries several
       * encodings under one mnemonic and we carry one. REV8 is the live
       * example, with distinct RV32 and RV64 forms.
       */
      encodingMismatches.push({
        mnemonic,
        extension: exact.extension,
        local: `match 0x${exact.match.toString(16)} mask 0x${exact.mask.toString(16)}`,
        upstream: `match 0x${big(inst.match).toString(16)} mask 0x${big(inst.mask).toString(16)}`,
        narrower: (big(inst.mask) & exact.mask) !== exact.mask,
      });
      continue;
    }

    /*
     * Before calling it missing, check whether we carry the encoding at all,
     * just filed elsewhere. AMOCAS.B is the case that forced this: unified-db
     * attributes it to Zabha (byte and halfword AMOs), this catalogue to Zacas
     * (compare-and-swap), and both readings are defensible.
     *
     * That is an attribution difference, not a gap, and it has to be reported
     * separately or 600-odd of them bury the handful of instructions genuinely
     * absent. The encoding check still applies, so this cannot quietly match
     * Zalasr's LB.AQ against the base ISA's LB: their bits differ.
     */
    const elsewhere = local.find(
      (c) => patternCovers(c, inst) && isVariantSpelling(c.mnemonic, mnemonic),
    );
    if (elsewhere) {
      attributedDifferently.push({
        mnemonic,
        upstreamOwners: inst.definedBy || [],
        localExtension: elsewhere.extension,
        localMnemonic: elsewhere.mnemonic,
      });
      continue;
    }

    missingInstructions.push({ mnemonic, definedBy: inst.definedBy || [] });
  }

  const upstreamNames = new Set((upstream.instructions || []).map((i) => i.mnemonic.toUpperCase()));
  const surplusInstructions = local
    .filter((r) => !upstreamNames.has(r.mnemonic))
    .map((r) => ({ mnemonic: r.mnemonic, extension: r.extension }));

  const malformed = local
    .filter((r) => !encodingIsWellFormed(r))
    .map((r) => ({ mnemonic: r.mnemonic, extension: r.extension }));

  /*
   * TWO COVERAGE QUESTIONS, NOT ONE
   *
   * "Do we carry this encoding anywhere?" and "does the extension upstream
   * attributes it to list it?" are different questions with different answers,
   * and reporting only the first is how five real gaps passed this gate.
   *
   * Zve32x is the clearest: every one of its instructions is present in the
   * catalogue, under V, so global coverage is perfect while the Zve32x entry
   * itself listed nothing. Zvkb and Zilsd were the same shape. Each showed up
   * here only as another attributedDifferently row among hundreds, and the
   * `complete` flag never looked at that bucket.
   *
   * So both numbers are reported. Global coverage is the build gate, because a
   * missing encoding is unambiguously a gap. Per-extension coverage is NOT a
   * gate: attribution differences are frequently legitimate — unified-db puts
   * AMOCAS.B under Zabha and this catalogue under Zacas, and both readings are
   * defensible — so it is a number to watch move, not a threshold to pass.
   */
  const coveredInAttributedExtension =
    considered -
    encodingMismatches.length -
    attributedDifferently.length -
    missingInstructions.length;
  const pct = (n) => (considered === 0 ? 100 : Math.round((n / considered) * 1000) / 10);

  const coverage = {
    considered,
    // "Is the encoding in the catalogue at all?"
    global: {
      covered: considered - missingInstructions.length,
      uncovered: missingInstructions.length,
      percent: pct(considered - missingInstructions.length),
    },
    // "Does an extension upstream attributes it to actually list it?"
    perExtension: {
      covered: coveredInAttributedExtension,
      filedElsewhere: attributedDifferently.length,
      encodingDisagrees: encodingMismatches.length,
      uncovered: missingInstructions.length,
      percent: pct(coveredInAttributedExtension),
    },
  };

  return {
    missingExtensions,
    missingInstructions: missingInstructions.sort((a, b) => a.mnemonic.localeCompare(b.mnemonic)),
    attributedDifferently: attributedDifferently.sort((a, b) =>
      a.mnemonic.localeCompare(b.mnemonic),
    ),
    coveredByBroaderRow,
    encodingMismatches,
    surplusInstructions,
    malformed,
    coverage,
    /*
     * What `complete` does and does not assert, stated rather than implied.
     * It is global coverage only. Encoding disagreements and malformed rows are
     * reported beside it and deliberately excluded: REV8 legitimately carries
     * two XLEN encodings under one upstream name, so gating on
     * encodingMismatches would fail every run for a reason nobody can fix.
     */
    complete: missingExtensions.length === 0 && missingInstructions.length === 0,
  };
}
