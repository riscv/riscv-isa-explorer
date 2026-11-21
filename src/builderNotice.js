/**
 * builderNotice.js — the caveat the ISA Configuration Builder shows, and the
 * matching comment every export carries (#581).
 *
 * The builder resolves dependencies and orders -march automatically, and its
 * output reads like a recommendation. These words say what it is not, so they
 * live in one place: the UI and both exporters import them, and the tests
 * check every surface carries them. Pure data, no React.
 */

export const NOTICE_STORAGE_KEY = 'riscv-builder-notice-v1';

export const REPORT_URL = 'https://github.com/riscv/riscv-isa-explorer/issues/new';

export const BUILDER_NOTICE = {
  title: 'Review this configuration before use',
  intro:
    'The ISA Explorer is a technical preview. It resolves dependencies and conflicts from a ' +
    'maintained graph and generates -march strings automatically. The graph is based chiefly on ' +
    'the RISC-V Unified Database, with cited additions from the ISA manual, standalone ' +
    'specifications and Clang. It may be incomplete or lag specification changes.',
  points: [
    'Its output is not a compliance or certification statement. A generated configuration may ' +
      'still be incomplete or unsuitable for your implementation.',
    'Verify dependencies and the generated -march ordering against the applicable RISC-V ' +
      'specifications before relying on the result. Hover a locked extension to see what ' +
      'requires it.',
    'Draft and frozen extensions are not ratified; their dependencies and encodings may change ' +
      'before ratification.',
    '“Accepted by” covers Clang and GCC -march acceptance and binutils assembly support. It ' +
      'does not guarantee compiler code generation for every extension.',
  ],
  report: 'Found an issue? Report it on GitHub and include the builder’s share link.',
  dismiss: 'Got it',
};

export const MARCH_NOTE =
  'Dependencies are resolved and -march ordering is generated automatically. Verify both ' +
  'against the applicable RISC-V specifications.';

/** Comment lines (without the leading "# ") for the configuration exports. */
export const CONFIG_EXPORT_NOTICE = [
  'This is not a compliance or certification statement.',
  'Dependencies were resolved and extension ordering was generated automatically.',
  'Verify both against the applicable RISC-V specifications.',
];

/** One sentence for the profile exports, whose rows are in display order, not spec order. */
export const PROFILE_EXPORT_NOTICE =
  'This is not a compliance or certification statement. Implied dependencies are computed ' +
  'automatically; verify profile membership and dependencies against the applicable profile ' +
  'and extension specifications.';
