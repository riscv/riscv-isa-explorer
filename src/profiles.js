/**
 * profiles.js — ratified RISC-V profile definitions.
 *
 * Extracted from risc_v_visualizer.jsx so that scripts and tests can reach it.
 * While it was a local const inside the component, nothing outside the UI could
 * validate it — which is how all four profiles came to generate a -march string
 * clang rejects (they mandate Sv39, and `sv39` is a satp translation mode rather
 * than an -march token). scripts/emit-march-matrix.mjs now emits a string per
 * profile so CI checks them against a real toolchain on every commit.
 *
 * Each entry lists the MANDATORY extensions of a profile, by catalog id.
 * Dependencies are deliberately NOT expanded here: the graph does that, so
 * this stays a faithful transcription of the specification.
 *
 * For the A and B families an entry is the profile's U64+S64 pair merged, so
 * "RVA23" means RVA23U64 plus RVA23S64. RVI20 has no supervisor half, so its
 * two profiles appear under their own names.
 */

// ---------------------------------------------------------------------------
// Profile Definitions – RVI20 (unprivileged), and the mandatory U64+S64 sets
// for RVA20/22/23 and RVB23
// ---------------------------------------------------------------------------
export const PROFILES = {
  /*
   * RVI20U32 / RVI20U64 — the unprivileged profiles, and the floor of the
   * whole scheme: "the minimum level of compatibility with RISC-V ratified
   * standards" (Profiles v1.0 §4.1).
   *
   * Both lists are the base ISA alone, which is not an omission. §4.1.1.2 and
   * §4.1.2.2 each read, in full, "There are no mandatory extensions for
   * RVI20U32/RVI20U64." M, A, F, D, C, Zifencei, Zicntr and Zihpm are all
   * *options* here, which is exactly what separates RVI20 from RVA20.
   *
   * They are also the only entries named U32/U64 rather than by family. The
   * others below merge a U64 and an S64 profile under one name; RVI20 is
   * unprivileged, has no supervisor half to merge, and exists in both XLENs.
   */
  RVI20U32: ['RV32I'],
  RVI20U64: ['RV64I'],

  // RVA20U64 + RVA20S64 – baseline “RV64GC-like” profile
  RVA20: [
    'RV64I',
    'M',
    'A',
    'F',
    'D',
    'C',
    'Zicsr',
    'Zicntr',
    'Ziccif',
    'Ziccrse',
    'Ziccamoa',
    'Za128rs',
    'Zicclsm',
    'Zifencei',
    'Ss1p11',
    'Svbare',
    'Sv39',
    'Svade',
    'Ssccptr',
    'Sstvecd',
    'Sstvala',
  ],

  // RVA22U64 + RVA22S64 – as referenced by RVA23 spec
  RVA22: [
    'RV64I',
    'M',
    'A',
    'F',
    'D',
    'C',
    'Zicsr',
    'Zicntr',
    'Zihpm',
    'Ziccif',
    'Ziccrse',
    'Ziccamoa',
    'Zicclsm',
    'Za64rs',
    'Zihintpause',
    'Zba',
    'Zbb',
    'Zbs',
    'Zic64b',
    'Zicbom',
    'Zicbop',
    'Zicboz',
    'Zfhmin',
    'Zkt',
    'Zifencei',
    'Ss1p12',
    'Svbare',
    'Sv39',
    'Svade',
    'Ssccptr',
    'Sstvecd',
    'Sstvala',
    'Sscounterenw',
    'Svpbmt',
    'Svinval',
  ],

  // RVA23U64 + RVA23S64 – full mandatory set
  RVA23: [
    'RV64I',
    'M',
    'A',
    'F',
    'D',
    'C',
    'Zicsr',
    'Zicntr',
    'Zihpm',
    'Ziccif',
    'Ziccrse',
    'Ziccamoa',
    'Zicclsm',
    'Za64rs',
    'Zihintpause',
    'Zba',
    'Zbb',
    'Zbs',
    'Zic64b',
    'Zicbom',
    'Zicbop',
    'Zicboz',
    'Zfhmin',
    'Zkt',

    // New mandatory in RVA23U64
    'V',
    'Zvfhmin',
    'Zvbb',
    'Zvkt',
    'Zihintntl',
    'Zicond',
    'Zimop',
    'Zcmop',
    'Zcb',
    'Zfa',
    'Zawrs',
    'Supm',

    // S-profile extras
    'Zifencei',
    'Ss1p13',
    'Svbare',
    'Sv39',
    'Svade',
    'Ssccptr',
    'Sstvecd',
    'Sstvala',
    'Sscounterenw',
    'Svpbmt',
    'Svinval',
    'Svnapot',
    'Sstc',
    'Sscofpmf',
    'Ssnpm',
    'Ssu64xl',

    // Hypervisor bundle
    'Sha',
    'H',
  ],

  // RVB23U64 + RVB23S64 – embedded-leaning profile
  RVB23: [
    'RV64I',
    'M',
    'A',
    'F',
    'D',
    'C',
    'Zicsr',
    'Zicntr',
    'Zihpm',
    'Ziccif',
    'Ziccrse',
    'Ziccamoa',
    'Zicclsm',
    'Za64rs',
    'Zihintpause',
    // Bit manipulation. The ratified RVB23U64 mandatory list names *B*;
    // spelled out as its components here to match how RVA22 and RVA23
    // express the same requirement in this file. Omitted when RVB23 was
    // added, which left the B profile generating a -march with no
    // bit-manipulation at all.
    'Zba',
    'Zbb',
    'Zbs',
    'Zic64b',
    'Zicbom',
    'Zicbop',
    'Zicboz',
    'Zkt',

    // RVA23-style unprivileged add-ons (minus V/Zfhmin/Supm mandates)
    'Zihintntl',
    'Zicond',
    'Zimop',
    'Zcmop',
    'Zcb',
    'Zfa',
    'Zawrs',

    'Zifencei',

    'Ss1p13',
    'Svnapot',
    'Svbare',
    'Sv39',
    'Svade',
    'Ssccptr',
    'Sstvecd',
    'Sstvala',
    'Sscounterenw',
    'Svpbmt',
    'Svinval',
    'Sstc',
    'Sscofpmf',
    'Ssu64xl',
  ],
};
