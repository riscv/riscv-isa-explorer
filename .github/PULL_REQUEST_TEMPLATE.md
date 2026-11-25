<!--
Thanks for contributing. A short, specific description reviews faster than a
long one. See CONTRIBUTING.md for the full guide.
-->

## What this changes

<!-- One or two sentences. What is different after this merges? -->

## Why

<!-- The problem being solved. Link an issue if there is one: Fixes #123 -->

## How it was verified

<!--
What you actually ran or clicked, rather than what should work in theory.
For interface changes, please say which themes and widths you checked.
-->

- [ ] `npm run check` passes (build, lint, sync:check and tests)

## If this touches ISA data

<!-- Delete this section if it does not apply. -->

- [ ] Cited the source: specification section, `riscv-unified-db` file, or `riscv-opcodes` entry
- [ ] Regenerated rather than hand-edited, where a generator exists
      (`npm run sync`, `npm run sync:udb`, `scripts/seed-dependency-graph.mjs`)

## Sign-off

- [ ] Every commit is signed off (`git commit -s`), per the [DCO](../DCO)
