/*
 * Extensions whose Linux history cannot be found from the kernel's extension
 * table (#649). The base extensions and V and H were supported long before
 * they were listed there, and they were listed in one bulk commit for 6.6
 * (effc122ad176, 13 single letters at once), so the commit that "adds" them is
 * bookkeeping, not the work. Each entry names the series that brought the
 * support: its title as posted on the lists, and one commit of it that was
 * applied (its date and trailers stand for the series').
 *
 * Keys are catalogue ids. Entries that share a series list each other in
 * `adds`, so they share one history. tests/upstream-history.test.mjs checks
 * that every entry is a catalogue extension and that the data has it.
 */
const BASE_PORT = {
  title: 'RISC-V Linux Port',
  sha: '76d2a0493a17d4c8ecc781366850c3c4f8e1a446', // RISC-V: Init and Halt Code, Linux 4.15
  adds: ['A', 'C', 'D', 'F', 'M', 'RV64I', 'Sv39'],
  // Linux 4.15 (2018-01) is where the port, and with it these extensions, arrived.
  why: 'Supported since the original port (64-bit, Sv39 paging, from the start); the letters were listed in the kernel table only in 6.6, in bulk',
};

const RV32 = {
  title: 'Building for 32-bit RISC-V kernel',
  sha: '8f79125d285d2d71ed110e875754942256efa51d', // RISC-V: Select GENERIC_UCMPDI2 on RV32I
  adds: ['RV32I', 'Sv32'],
  why: 'RV32, and with it Sv32 paging, was in Kconfig from the 4.15 port but did not build until this series (Zong Li, 4.18)',
};

export const CURATED = {
  V: {
    title: 'riscv: Add vector ISA support',
    sha: '3a2df6323defbb42234aaae804a8ad6af397016a', // riscv: Add task switch support for vector
    adds: ['V'],
    why: 'Vector support merged in 6.5; the table entry came with the 6.6 bulk commit',
  },
  H: {
    title: 'KVM RISC-V Support',
    sha: '3f2401f47d29d669e2cb137709d10dd4c156a02f', // RISC-V: Add hypervisor extension related CSR defines
    adds: ['H'],
    why: 'KVM, the hypervisor extension user, merged in 5.16; the table entry came in bulk for 6.6',
  },
  RV32I: RV32,
  Sv32: RV32,
  // Paging modes are not in the extension table: Linux selects them through
  // satp, so their history is the series that added each mode.
  Sv48: {
    title: 'Introduce sv48 support without relocatable kernel',
    sha: 'e8a62cc26ddf53a3c6ba2a8d33036cf7b84f3923', // riscv: Implement sv48 support, 5.17
    adds: ['Sv48'],
    why: 'A paging mode, chosen through satp, so not in the extension table',
  },
  Sv57: {
    title: 'Add Sv57 page table support',
    sha: '011f09d1205285b215003a6c65408609ef78abac', // riscv: mm: Set sv57 on defaultly, 5.18
    adds: ['Sv57'],
    why: 'A paging mode, chosen through satp, so not in the extension table',
  },
  Supm: {
    title: 'riscv: Userspace pointer masking and tagged address ABI',
    sha: '3c2e0aff7b4f03fbc11b7d63c8db5b94a48978cf', // riscv: hwprobe: Export the Supm ISA extension, 6.13
    adds: ['Supm'],
    why: 'Reported through hwprobe, not the extension table, which lists Ssnpm and Smnpm instead',
  },
  Sscofpmf: {
    title: 'Improve RISC-V Perf support using SBI PMU and sscofpmf extension',
    sha: '4905ec2fb7e6421c14c9fb7276f5aa92f60f2b98', // RISC-V: Add sscofpmf extension support
    adds: ['Sscofpmf'],
    why: 'The landing patch has no Link: trailer, and the series title does not repeat its subject',
  },
  RV64I: BASE_PORT,
  Sv39: BASE_PORT,
  A: BASE_PORT,
  C: BASE_PORT,
  D: BASE_PORT,
  F: BASE_PORT,
  M: BASE_PORT,
};

/**
 * Extensions Linux supports that have no history, each with the reason.
 * tests/upstream-history.test.mjs fails when any other Linux-supported
 * extension goes missing from the data (a parser regression would otherwise
 * delete histories quietly), and when an entry here is collected after all.
 */
export const UNCOLLECTED = {};

/**
 * What a listed-only extension's line says beyond "listed in N": the honest
 * state of Linux's support, from reading the kernel (#665).
 */
export const LISTED_NOTES = {
  Q: 'Linux parses Q in ISA strings, but has no quad-precision support code: the FP context it saves is 64-bit.',
};

/**
 * Titles a series uses for an extension instead of its name, for the "in
 * review" search: the Smctr/Ssctr series is posted as "Control Transfer
 * Records".
 */
export const SERIES_ALIASES = {
  Smctr: ['Control Transfer Records'],
  Ssctr: ['Control Transfer Records'],
};
