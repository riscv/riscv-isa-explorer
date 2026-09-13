# RISC-V ISA Explorer

An interactive reference for RISC-V extensions, profiles, and per-instruction
encodings. Pick a base ISA or start from a ratified profile, add extensions, and
get a dependency-resolved configuration with a valid `-march` string.

**[Open the live site](https://riscv.github.io/riscv-isa-explorer/)**

[![The explorer showing the extension catalogue with Zba selected, its description, use case and instruction set alongside](docs/screenshot.jpg)](https://riscv.github.io/riscv-isa-explorer/)

[![CI](https://github.com/riscv/riscv-isa-explorer/actions/workflows/ci.yml/badge.svg)](https://github.com/riscv/riscv-isa-explorer/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![DCO](https://img.shields.io/badge/DCO-required-brightgreen.svg)](DCO)

## What it does

- **Browse** every catalogued extension, grouped and searchable by name,
  mnemonic, or hex encoding.
- **Build a configuration.** Select extensions and dependencies resolve
  automatically, with conflicts blocked and a reason shown for every implied
  extension.
- **Start from a profile.** RVA23, RVB23 and the other ratified profiles load as
  a starting point rather than being rebuilt by hand.
- **Export** a `-march` string, a YAML configuration, or a `riscv-config`
  compatible file.
- **Compare entries.** Pin extensions, instructions or profiles and read them
  side by side; a comparison has its own URL and can be shared.
- **Check an encoding.** The Encoder Validator tests a proposed instruction
  pattern against every existing one and reports overlaps.
- **See the encoding space.** The Encoding Map draws the 32 base opcode slots,
  shaded by how many instructions each holds, and shows what is still free.
- **Design an extension that does not exist yet.** The Custom Extension Sandbox
  lets you draft a custom vendor extension or an addition to a ratified one,
  lay out the bit encodings, check them against every instruction in the
  catalogue, and export `riscv-opcodes` JSON plus a proposal document.
  See [docs/sandbox.md](docs/sandbox.md).
- **Link out to the specification.** Each extension links to its section on
  docs.riscv.org.

## Something look wrong?

The catalogue is the product, so a bad description, a missing dependency or a
wrong encoding matters more here than most bugs. Open an issue and cite the
specification section or the `riscv-unified-db` file that says otherwise. That
turns a report into a fix, and it is usually a small change.

## Quickstart

Node.js and npm are the only requirements.

```bash
npm ci
npm run build
python3 -m http.server 8080 -d dist
```

Then open `http://localhost:8080`.

Docker, if you prefer:

```bash
docker compose up --build
```

## Where the data comes from

Four files carry the data, and they do not have the same authority. Worth
knowing before changing anything:

| file | holds | source of truth |
|---|---|---|
| `src/riscv_extensions.json` | the extension catalogue, plus the instruction encodings routed into each extension | [riscv-unified-db](https://github.com/riscv/riscv-unified-db) for metadata and ratification state; `src/instr_dict.json` for encodings |
| `src/instr_dict.json` | the instruction encodings themselves | **hand-maintained.** Checked against [riscv-opcodes](https://github.com/riscv/riscv-opcodes), but it carries entries upstream lacks and is never regenerated |
| `src/isa-dependency-graph.json` | dependencies, conflicts and parameters, with a citation on every edge | [riscv-unified-db](https://github.com/riscv/riscv-unified-db) |
| `src/profiles.js` | the ratified profiles | the profile specifications |

Two things fall outside that table, because no upstream carries them. The
**Zve\* embedded vector subsets** are derived from V by the EEW/FP rules in
unpriv §30.1.18.2 — riscv-opcodes has no `rv_zve*` tag and unified-db attributes
every vector instruction to a single owner, so neither can say what belongs in
Zve32x. And the **SPMP family** (Sspmp, Sspmpen, Smpmpdeleg) is ratified in a
specification of its own that unified-db does not model at all; its dependency
edges cite that document through the graph's `spec` provenance source. Both are
places where the usual checks cannot help, so both are pinned by tests.

`riscv-unified-db` is normative for dependencies. clang is the check that what we
emit is actually usable: CI feeds every generated `-march` string to a real
compiler. `riscv-config`, RISC-V International's own validator, disagrees with
clang in a few places, and where it does both opinions are recorded rather than
one being quietly preferred.

Regenerate with:

```bash
npm run sync          # route src/instr_dict.json into the catalogue
npm run sync:udb      # extension metadata from riscv-unified-db
node scripts/seed-dependency-graph.mjs --udb <path-to-riscv-unified-db>
node scripts/map-doc-links.mjs                # documentation links
```

Or check for drift without writing anything:

```bash
npm run sync:check
npm run graph:check -- <path-to-riscv-unified-db>
npm run links:check
npm run opcodes:check -- <path-to-riscv-opcodes>
```

### What updates itself, and what does not

| | how it refreshes |
|---|---|
| extension metadata, CSRs, ratification state | the `sync-udb-extensions` workflow, daily at 06:00 UTC, opens or updates a PR when a file changes |
| the published site | any push to `main` rebuilds and publishes to `gh-pages` |
| instruction encodings | **by hand.** The `check-opcodes-drift` workflow, Mondays at 07:00 UTC, files an issue when upstream is ahead |

`src/instr_dict.json` is hand-maintained on purpose and is not regenerated from
riscv-opcodes. It carries entries upstream does not: the 56 `vlseg` segment
loads, which riscv-opcodes does not express at all, and the MOP and C.MOP
encodings expanded from upstream's three `_n` templates. A regenerate would
delete them, so the drift check reports and leaves the decision to a person.

It compares mnemonics rather than encodings, ignores upstream's
`$pseudo_op` aliases (`mv` is `addi rd, rs, 0`, an encoding we already carry),
and counts `extensions/unratified/` separately rather than treating drafts as
gaps to fill.

## Code layout

| file | responsibility |
|---|---|
| `src/risc_v_visualizer.jsx` | the main view |
| `src/ExtensionTile.jsx` | a single extension tile, memoised per tile |
| `src/WorkspacePanel.jsx` | the ISA Configuration Builder panel |
| `src/isaGraph.js` | dependency resolution: `resolveSelection`, `closure`, `explain`, `validateGraph` |
| `src/marchUtils.js` | `-march` assembly and canonical ordering |
| `src/exportUtils.js` | YAML and `riscv-config` export |
| `src/profiles.js` | profile definitions |

## Tests

```bash
npm test
```

CI runs the tests, builds, then validates the generated `-march` strings against
clang. Rows needing a newer clang than the job provides are skipped and reported
rather than failed, so the check is a floor rather than full coverage. The suite covers dependency closure, graph integrity, profile
correctness, `riscv-config` conventions, export formats, documentation links, and
a jsdom smoke test that fails if the page renders blank.

## Adding an extension

Add an entry to the appropriate group in `src/riscv_extensions.json`:

```json
{
  "id": "Zfoo",
  "name": "Zfoo",
  "tags": ["rv_zfoo"],
  "desc": "Short description",
  "use": "What it enables",
  "url": "https://docs.riscv.org/reference/..."
}
```

- `tags` are riscv-opcodes extension names. Instruction membership is derived
  from them, so a wrong tag produces a wrong instruction count.
- `url` points at the extension's page on docs.riscv.org; `npm run links:check`
  verifies it resolves.
- `discontinued: 1` adds the "Discontinued" badge.

Then add a graph node, or the tests fail:

```bash
node scripts/seed-dependency-graph.mjs --udb <path-to-riscv-unified-db>
npm test
```

## Adding an instruction

Encodings live in `src/instr_dict.json`, keyed by the mnemonic lowercased with
`.` replaced by `_`, so `SC.W` becomes `sc_w`:

```json
"sc_w": {
  "encoding": "00011------------010-----0101111",
  "variable_fields": ["rd", "rs1", "rs2", "aq", "rl"],
  "extension": ["rv_a"],
  "match": "0x1800202f",
  "mask": "0xf800707f"
}
```

The `extension` values match the `tags` on a catalogue entry, and that is what
places the instruction. Merge it in and verify:

```bash
npm run sync
npm test && npm run build
```

## Encoder Validator

The **Encoder Validator** in the header checks a proposed encoding against every
instruction in the database. Give it either a 32-bit pattern of `0`, `1` and `-`,
or a `match` and `mask` pair in hex; supplying both cross-checks them against
each other.

Overlaps are reported as `identical`, `proposed_subset_of_existing`,
`existing_subset_of_proposed`, or `partial_overlap`, each with a plain-language
reason and an example 32-bit word that satisfies both patterns.

## Encoding Map

The **Encoding Map**, also in the header, answers the question the extension
list cannot: how much of the base encoding space is spoken for. It lays the 32
opcode slots out as the ISA manual does, rows `inst[4:2]` and columns
`inst[6:5]`, with every cell implying `inst[1:0]=11`, and shades each by
occupancy on a log scale. Compressed instructions sit outside that grid and are
summarised by quadrant. Selecting a cell lists its instructions and links
through to the extensions that define them.

It is computed from `src/riscv_extensions.json` at runtime, so there is nothing
to regenerate: sync the catalogue and the map follows.

## Deployment

Pushes to `main` build and publish to the `gh-pages` branch automatically. To
publish by hand:

```bash
npm run deploy
```

## Contributing

Contributions are welcome, data corrections especially. See
[CONTRIBUTING.md](CONTRIBUTING.md) for setup, the invariants the tests enforce,
and the sign-off requirement.

All commits must be signed off under the [Developer Certificate of Origin](DCO):

```bash
git commit -s
```

Participation is governed by our [Code of Conduct](CODE_OF_CONDUCT.md). To report
a vulnerability, see [SECURITY.md](SECURITY.md).

## Licence

[Apache License 2.0](LICENSE).
