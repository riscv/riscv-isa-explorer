# AGENTS.md

## What this project is

An interactive, static web reference for RISC-V extensions, profiles, and
per-instruction encodings. A React SPA (bundled by webpack, published to GitHub
Pages) lets you pick a base ISA or ratified profile, add extensions, and get a
dependency-resolved config with a valid `-march` string, plus encoding-overlap
and encoding-space tools.

Mental model: it is a **data project with a UI on top**. Three JSON/JS data
files are the real content; the `.jsx` files render them. The hard correctness
lives in the data and in `src/isaGraph.js` (dependency resolution). Data is
synced from upstream sources (riscv-opcodes, riscv-unified-db) and validated in
CI against a real clang — a wrong dependency that "looks right" is the failure
mode this project guards against.

## Setup

Node.js + npm are the only requirements (CI uses Node 22).

```bash
npm ci
npm run build                      # outputs to dist/
python3 -m http.server 8080 -d dist   # then open http://localhost:8080
```

For live-reload development: `npm run dev` (serves on :8080 with source maps).

## Commands

| Command | When |
|---|---|
| `npm ci` | Install (clean, from lockfile) |
| `npm run build` | Production bundle → `dist/` (webpack, no `--mode` = production) |
| `npm run dev` | Dev server with HMR + source maps |
| `npm test` | Full suite (`node --test tests/*.test.mjs`) |
| `node --test tests/march.test.mjs` | Run a **single test file** |
| `node --test --test-name-pattern="never emits the g shorthand"` | Run **one test by name** |
| `npm run lint` | ESLint (flat config, must stay green — it's a ratchet) |
| `npm run format` | Prettier over `src/**/*.{js,jsx,css}` |
| `npm run sync` | Regenerate instruction data from `src/instr_dict.json` |
| `npm run sync:check` | Check instruction drift, write nothing (`sync --strict`) |
| `npm run sync:udb` | Sync extension metadata from riscv-unified-db |
| `npm run sync:params -- <path-to-udb>` | Regenerate `src/isa-params.json` (UDB parameter definitions) |
| `npm run graph:check -- <path-to-udb>` | Check dependency graph vs UDB |
| `npm run links:check` | Verify doc URLs resolve on docs.riscv.org |
| `npm run opcodes:check -- <path-to-riscv-opcodes>` | Report instruction-encoding drift |
| `npm run udb:check -- <path-to-udb>` | Report ratified extensions/instructions we lack |
| `npm run deploy` | Manual publish of `dist/` to `gh-pages` (normally automatic) |

There is no separate typecheck (no TypeScript).

## Architecture

Entry: `src/main.jsx` mounts `<RISCVExplorer/>` (`src/risc_v_visualizer.jsx`).

```
src/
  main.jsx                    # React entry, imports index.css
  risc_v_visualizer.jsx       # main view
  WorkspacePanel.jsx          # ISA Configuration Builder panel
  ExtensionTile.jsx           # one extension tile (memoised; see tileMemo.js)
  CompareView / CompareTray / compareModel.js   # side-by-side comparison
  EncodingMap.jsx / encodingMap.js              # opcode-space map
  EncodingDiagram.jsx                           # bit-field diagram
  isaGraph.js                 # dependency resolution: resolveSelection, closure, explain, validateGraph
  marchUtils.js               # -march assembly + canonical ordering (pure, no React, no catalog import)
  exportUtils.js              # YAML + riscv-config export
  focusTrap.js                # modal focus trapping
  profiles.js                 # ratified profile definitions
  --- data (the source of truth) ---
  riscv_extensions.json       # extension catalogue + per-extension instruction encodings
  isa-dependency-graph.json   # dependencies/conflicts/params, one citation per edge
  isa-params.json             # UDB parameter DEFINITIONS, generated (see gotchas)
  instr_dict.json             # instruction encodings, HAND-MAINTAINED (see gotchas)
scripts/                      # sync/seed/check tooling (.mjs / .cjs)
tests/                        # node:test suites (*.test.mjs)
public/index.html             # webpack HTML template
```

Data flow: upstream (riscv-opcodes, riscv-unified-db) → `scripts/*` sync → data
files → `isaGraph.js` resolves a selection → `marchUtils.js`/`exportUtils.js`
emit strings/files → React renders. `marchUtils.js` never imports the catalog;
callers pass the flat array. Dependency data is owned only by `isaGraph.js`.

**To add an extension:** add an entry to the right group in
`src/riscv_extensions.json` (`id`, `name`, `tags`, `desc`, `use`, `url`; `tags`
are riscv-opcodes extension names and drive instruction membership), then
`node scripts/seed-dependency-graph.mjs --udb <path-to-udb>` to create its graph
node, then `npm test`. A catalogue entry without a graph node fails the tests.

**To add an instruction:** add to `src/instr_dict.json` keyed by mnemonic
lowercased with `.`→`_` (`SC.W` → `sc_w`), with `encoding`/`variable_fields`/
`extension`/`match`/`mask`. `extension` must match a catalogue entry's `tags`.
Then `npm run sync` and `npm test && npm run build`.

**To add a profile:** edit `src/profiles.js` by hand from the spec.

## Conventions

- Prettier: single quotes, `printWidth: 100`, trailing commas `all`, always
  parenthesise arrow params. Run `npm run format`.
- JSX uses the **classic** React transform (Babel `@babel/preset-react`, no
  `runtime` option) — every `.jsx` needs `React` in scope even if unused;
  `react/react-in-jsx-scope` is an error. Do not "clean up" that import.
- Data files carry provenance: every dependency-graph edge needs a citation
  (`udb`, `isa-manual`, or `clang`); an uncited edge fails `validateGraph`.
- Pure modules (`marchUtils.js`, `exportUtils.js`) take no React and don't
  import data — the catalog is passed in. Keep it that way.
- Tests are `node:test` + `assert`, one `*.test.mjs` per concern; no framework.
- Commit subjects: Conventional Commits (`fix:`, `feat:`, `chore:`, `data:`,
  `ci:`), imperative, often ending with the PR number.

## Gotchas / do-not-touch

- **`src/instr_dict.json` is hand-maintained, NOT regenerated.** It carries
  entries upstream lacks (the 56 `vlseg` segment loads; expanded MOP/C.MOP). A
  regenerate would delete them. `npm run opcodes:check` only *reports* drift and
  leaves the call to a human — never auto-apply it.
- **The daily UDB sync cannot ADD an extension.** `scripts/sync_udb_extensions.cjs`
  iterates the catalogue, so it enriches entries that already exist and is blind
  to anything upstream has that we do not. `npm run udb:check` watches that
  direction, and a weekly workflow files the result as one issue it keeps
  updated. Adding an extension stays a human decision: it needs a description, a
  use case, a doc link and a graph node, none of which UDB supplies.
  Its "Still missing from UDB" watchlist is *derived* — an entry carrying a
  `long_name` counts as already synced — so describing an extension ourselves is
  what drops it off the list. Anything UDB has never carried therefore has to be
  named in `ALWAYS_WATCH`, or the one part of the catalogue where we are ahead
  of UDB is the one part the report goes quiet about. The SPMP family is there
  now; remove an id once UDB ships it. `tests/sync-tooling.test.mjs` guards it.
- **The Zve\* instruction sets are DERIVED, not synced.** riscv-opcodes has no
  `rv_zve*` tag and unified-db files all 627 vector instructions under one owner
  (`Zvl32b`), so nothing upstream says what each embedded subset contains. The
  rules in `scripts/sync_instructions.mjs` compute them from V using the EEW and
  FP table in unpriv §30.1.18.2. No upstream check can catch an error in this;
  `tests/zve-subsets.test.mjs` pins the rules and the exact counts instead.
  Change a rule, never the 2,500 generated entries.
- **`npm run udb:check` reports two coverage numbers, and only the first
  gates.** Global coverage asks "is this encoding in the catalogue anywhere" —
  that is `complete`, and a failure there is unambiguous. Per-extension coverage
  asks "does an extension upstream attributes it to actually list it", and sits
  far lower (≈49%) because attribution differences are often legitimate: UDB
  files AMOCAS.B under Zabha, this catalogue under Zacas. Watch it move; do not
  gate on it. Reporting only the first is how five extensions shipped with empty
  instruction maps while every check passed.
- **`src/isa-params.json` is definitions, not values.** It says what a parameter
  IS: type, admissible values, and the conditions under which it exists. It
  chooses nothing. Values come from two other places: the constraints in
  `isa-dependency-graph.json` (resolved by `resolveParams`) and the user's own
  picks (`paramChoices`). `definedBy` is stored as UDB writes it, a predicate
  tree, because 23 of the 228 parameters are gated on another PARAMETER'S value
  rather than on an extension; flattening it to one owner per parameter loses
  that distinction silently. Regenerate with `npm run sync:params`, never by hand.
- **The UDB export's `UDB_REQUIRED_PARAMS` floor is deliberately not derived.**
  All 15 are defined by `Sm` upstream, but no graph node requires `Sm`, so a
  selection-derived list is empty for a bare RV32I and the export would silently
  drop every param riscv-arch-test needs. `tests/export.test.mjs` guards this.
- **`dist/` and `node_modules/` are generated** (dist is git-ignored / rebuilt;
  eslint ignores both). Don't hand-edit `dist/`.
- **`gh-pages` branch is machine-published** by CI on every push to `main`.
  Don't commit to it by hand.
- After editing the catalogue, **re-run the graph seeder** or `tests/isa-graph.test.mjs`
  fails (every extension needs a node).
- Never declare a React component inside another component's render body — it
  remounts the whole subtree. `react/no-unstable-nested-components` is an error
  and there's a test for it.
- Light and dark themes must both work; text contrast must clear WCAG AA 4.5:1.
- Unit tests don't render the UI (except the shallow `render-smoke` test) —
  verify interface changes in a real browser.

## Workflow

- Branch off `main`; branch names are prefixed (`fix/…`, `feat/…`, `docs/…`,
  `chore/…`). PRs merge squashed with the number in the subject.
- **Every commit must be signed off** (`git commit -s`, DCO 1.1). CI enforces it
  (`.github/workflows/dco.yml`). Fix a whole branch with
  `git rebase --signoff origin/main` then force-push with `--force-with-lease`.
- Before a PR: `npm test && npm run build` (both must pass — see the PR template
  checklist).
- CI (`.github/workflows/ci.yml`) runs install → build → test → feeds every
  generated `-march` string to clang. Distro clang (18) skips four `modern`
  profile strings; they're covered by tests instead. A `-march` string no
  compiler accepts fails the build.

## Where to look for more

- `README.md` — feature tour, data-source authority table, Encoder Validator /
  Encoding Map explanations, regeneration commands.
- `CONTRIBUTING.md` — DCO details, the invariants the tests enforce (and why
  each exists), interface-change checklist.
- `src/isaGraph.js` and `src/marchUtils.js` header comments — the design
  rationale for the dependency model and `-march` assembly.
- `.github/workflows/` — exact CI, DCO, and scheduled sync/drift jobs.
