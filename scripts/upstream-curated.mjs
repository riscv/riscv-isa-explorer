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
  adds: ['A', 'C', 'D', 'F', 'M'],
  // Linux 4.15 (2018-01) is where the port, and with it these extensions, arrived.
  why: 'Supported since the original port; listed in the kernel table only in 6.6, in bulk',
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
export const UNCOLLECTED = {
  RV32I: 'a base, not an extension the kernel adds',
  RV64I: 'a base, not an extension the kernel adds',
  Sscofpmf:
    'its landing patch ("RISC-V: Add sscofpmf extension support") matches no posting found on lore',
};
