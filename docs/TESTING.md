# What is tested, and where

Every key part of the explorer, the files that make it up, and the tests that
cover it. All of them run in CI on every push and pull request, and in the
pre-push hook before code leaves your machine (see "Running them" below).

`tests/coverage-map.test.mjs` reads this table. It fails when a file in `src/`
or `scripts/` is not listed, when a listed file or test does not exist, or
when none of a module's tests mentions it. So a new module cannot ship without
a row here and a test behind it.

| Part | Files | Tests |
|---|---|---|
| Extension catalogue | `src/riscv_extensions.json` | `data-integrity`, `catalog-coverage`, `zve-subsets`, `copy-counts` |
| Instruction encodings | `src/instr_dict.json`, `scripts/sync_instructions.mjs` | `catalog-coverage`, `data-integrity`, `sync-tooling` |
| Dependency graph and resolution | `src/isa-dependency-graph.json`, `src/isaGraph.js`, `scripts/seed-dependency-graph.mjs` | `isa-graph`, `dependency-closure`, `riscv-config-rules`, `sync-tooling`, `pipeline` |
| `-march` strings | `src/marchUtils.js`, `scripts/emit-march-matrix.mjs` | `march`, `profiles`, `dependency-closure` |
| Profiles | `src/profiles.js`, `src/profile-optional.json`, `scripts/sync-profile-optional.mjs` | `profiles`, `compare-model`, `pipeline` |
| Parameters | `src/isa-params.json`, `src/isaParams.js`, `scripts/sync_udb_params.mjs` | `isa-params`, `pipeline` |
| Exports (YAML, riscv-config, CSV, XLSX) | `src/exportUtils.js`, `src/profileExport.js`, `src/xlsxWriter.js` | `export`, `profile-export` |
| Share links and builder state | `src/configPermalink.js`, `src/workspaceLock.js` | `config-permalink`, `workspace-lock`, `render-smoke` |
| ISA Configuration Builder | `src/WorkspacePanel.jsx`, `src/ProfileDownloadMenu.jsx` | `render-smoke`, `render-views`, `profile-export` |
| Compare | `src/compareModel.js`, `src/CompareView.jsx`, `src/CompareTray.jsx` | `compare-model`, `render-smoke` |
| Encoding tools | `src/encodingUtils.js`, `src/encodingMap.js`, `src/EncodingMap.jsx`, `src/EncodingDiagram.jsx` | `encoding-utils`, `encoding-map`, `render-views` |
| Extension Sandbox | `src/sandboxModel.js`, `src/SandboxPanel.jsx` | `sandbox-model`, `render-views` |
| Instruction details (syntax, intrinsics, Compiler Explorer) | `src/instructionUsage.js`, `src/InstructionUsage.jsx`, `src/DetailSection.jsx`, `src/instructionMetadata.js`, `src/instruction-metadata.json`, `src/instruction-intrinsics.json`, `scripts/sync_instruction_metadata.mjs`, `scripts/sync_intrinsics.mjs` | `instruction-usage`, `pipeline`, `render-views` |
| Sail, Spike and ACT links | `src/instruction-references.json`, `scripts/sail-assembly.mjs`, `scripts/sync_reference_impls.mjs` | `reference-implementations`, `pipeline` |
| Toolchain support and timeline | `src/toolchain-support.json`, `src/toolchainSupport.js`, `src/ToolchainSupport.jsx`, `src/ToolchainTimeline.jsx`, `scripts/toolchain-support.mjs`, `scripts/sync_toolchain_support.mjs` | `toolchain-support`, `render-views` |
| CSR details | `src/CsrDetails.jsx` | `csr-fields`, `render-views` |
| Evolution | `src/evolutionModel.js`, `src/ExtensionEvolution.jsx` | `profile-export`, `copy-counts`, `render-views` |
| Specification link | `src/specLink.js` | `spec-link`, `render-views` |
| Main view, tiles and entry point | `src/risc_v_visualizer.jsx`, `src/ExtensionTile.jsx`, `src/tileMemo.js`, `src/main.jsx`, `src/RiscvLogo.jsx` | `render-smoke`, `render-views`, `extension-tile` |
| Focus handling in dialogs | `src/focusTrap.js` | `focus-trap` |
| Ask AI (feature-flagged off) | `src/AskAiLauncher.jsx`, `feature-flags.cjs` | `render-views` |
| Ratified list from the ISA manual (catches UDB lagging the manual) | `src/isa-manual-status.json`, `scripts/manual-status.mjs`, `scripts/sync_manual_status.mjs` | `manual-status`, `pipeline` |
| Completeness against UDB | `src/completeness.js`, `scripts/check-udb-completeness.mjs` | `completeness`, `udb-parser`, `sync-tooling` |
| Weekly UDB sync | `scripts/sync_udb_extensions.cjs` | `sync-tooling`, `csr-fields`, `catalog-coverage` |
| Opcodes drift report | `scripts/check-opcodes-drift.mjs` | `opcodes-drift` |
| Documentation links | `scripts/map-doc-links.mjs` | `doc-links` |
| Crawler pages and sitemap | `scripts/static-pages.mjs` | `static-pages` |
| Scheduled workflows (bot identity, build before test, failure alert) | `.github/workflows/` | `sync-tooling` |

Test names are files in `tests/`, without `.test.mjs`.

## What runs where

| Check | CI (`ci.yml`) | Pre-push hook |
|---|---|---|
| `npm run build` | yes | yes |
| `npm run lint` | yes | yes |
| `npm run sync:check` (instruction data matches `instr_dict.json`) | yes | yes |
| `npm test`, with riscv-unified-db at the pinned commit | yes | yes, when `../riscv-unified-db` or `UDB_DIR` is checked out (UDB checks skip otherwise) |
| Generated `-march` strings against clang | yes | no |

CI clones riscv-unified-db at the commit `src/isa-dependency-graph.json`
records, and riscv-isa-manual at the commit `src/isa-manual-status.json`
records, so those checks run against exactly the upstream the data came from,
and a clone fails if its commit is not on GitHub.

Two tests skip everywhere unless `RISCV_CLANG` names a recent RISC-V clang:
assembling every instruction example and compiling every intrinsic. Run them
after a sync of instruction metadata or intrinsics.

## Running them

```bash
npm run build && npm test          # what CI and the hook run (plus lint and sync:check)
node --test tests/render-views.test.mjs
UDB_DIR=../riscv-unified-db npm test   # include the UDB checks
```

The hook is installed by `npm install` (the `prepare` script sets
`core.hooksPath` to `.githooks`). Skip it for one push with
`git push --no-verify`, for example on a docs-only branch.
