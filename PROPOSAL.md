# RISC-V ISA Explorer: Project Proposal

## 1. Problem Statement

The RISC-V Instruction Set Architecture (ISA) is modular by design. Its ecosystem
spans a base integer ISA plus hundreds of standard, optional, and vendor-specific
extensions across multiple categories: cryptography, vector processing, bit
manipulation, atomics, compressed instructions, supervisor-level features, and more.

This modularity is a strength, but it creates a practical challenge: there is no
single, interactive reference that lets engineers quickly browse extensions, inspect
per-instruction encoding details, search by mnemonic or hex value, and validate
new encodings against the existing instruction space. The official RISC-V ISA manual
is a multi-volume PDF, and the machine-readable sources (e.g., `riscv-opcodes`) are
raw data files that require tooling to interpret.

## 2. Project Vision

The **RISC-V ISA Explorer** is a web-based, interactive visualization and
reference tool that makes the full RISC-V extension and instruction catalog
accessible, searchable, and verifiable in a single page.

It targets hardware engineers, compiler developers, verification teams, educators,
and anyone who needs to navigate the RISC-V ISA quickly and accurately.

## 3. Goals and Objectives

| Goal | Description |
|------|-------------|
| **Comprehensive catalog** | Provide a single source of truth for all ratified, draft, and discontinued RISC-V extensions, organized by category. |
| **Per-instruction detail** | Display the full 32-bit encoding diagram, match/mask values, and variable fields for every instruction. |
| **Search** | Allow lookup by mnemonic (e.g., `SC.W`) or hex encoding (e.g., `0x1800202f`). |
| **Filtering** | Support filtering by RISC-V profile (RVI20, RVA20, RVA22, RVA23, RVB23) and ISA volume (Unprivileged / Privileged). |
| **Encoding validation** | Provide a built-in Encoder Validator that checks a proposed encoding pattern against every existing instruction to detect conflicts (identical, subset, or partial overlap). |
| **Compressed mapping** | Show the relationship between compressed (16-bit, C extension) instructions and their standard 32-bit equivalents. |
| **Zero infrastructure** | Run as a static site (GitHub Pages) with no backend, database, or authentication. |

## 4. Scope

### In scope

- All base ISAs (RV32I, RV64I, RV32E, RV64E, RV128I).
- All single-letter standard extensions (M, A, F, D, Q, C, V, H, and others).
- All multi-letter Z/S/Ss/Sv extensions across categories: bit manipulation,
  atomics, compressed, floating-point, load/store, integer, vector, security,
  cryptography, vector-crypto, system, caches, supervisor memory, supervisor
  interrupt, and supervisor trap.
- Instruction encoding data sourced from the `riscv-opcodes` project.
- Profile membership for RVI20, RVA20, RVA22, RVA23, RVB23.
- Volume classification (Unprivileged Volume I, Privileged Volume II).

### Out of scope

- Vendor-specific (non-standard) extensions not tracked in `riscv-opcodes`.
- Simulation or execution of instructions.
- Automatic tracking of ISA manual revisions (data updates are manual).

## 5. Architecture

### 5.1 High-Level Data Flow

```
                ┌─────────────────────┐
                │   instr_dict.json   │  Canonical instruction encodings
                │   (1,188 entries)   │  sourced from riscv-opcodes
                └─────────┬───────────┘
                          │
                          ▼
              ┌───────────────────────┐
              │ sync_instructions.mjs │  Node.js merge script
              └───────────┬───────────┘
                          │
       ┌──────────────────┼──────────────────┐
       │                  │                  │
       ▼                  ▼                  ▼
┌──────────────┐  ┌───────────────┐  ┌──────────────────┐
│ riscv_       │  │ risc_v_       │  │ extensionInstr-  │
│ extensions   │  │ visualizer    │  │ uctions mapping  │
│ .json        │◄─┤ .jsx          │──┤ (in visualizer)  │
│ (catalog)    │  │ (React app)   │  │                  │
└──────┬───────┘  └───────┬───────┘  └──────────────────┘
       │                  │
       │                  ▼
       │          ┌───────────────┐
       └─────────►│  Webpack      │
                  │  Build        │
                  └───────┬───────┘
                          │
                          ▼
                  ┌───────────────┐
                  │  dist/        │   Static site
                  │  bundle.js    │   (GitHub Pages
                  │  index.html   │    via gh-pages)
                  └───────────────┘
```

### 5.2 Data Files

| File | Role | Entries |
|------|------|---------|
| `src/instr_dict.json` | Instruction dictionary with encoding, match, mask, variable fields, and extension tags. | ~1,188 instructions |
| `src/riscv_extensions.json` | Extension catalog organized by category group, with embedded instruction details after sync. | ~222 extensions across 17 groups |
| `src/risc_v_visualizer.jsx` | Contains `extensionInstructions`, a mapping of extension IDs to ordered mnemonic arrays. Also contains the full React application. | ~3,600 lines |

### 5.3 Extension Data Schema

Each extension in `riscv_extensions.json` follows this structure:

```json
{
  "id": "Zba",
  "name": "Zba",
  "desc": "Address generation instructions",
  "use": "Accelerate address calculation for array indexing",
  "discontinued": 0,
  "url": "https://github.com/riscv/riscv-isa-manual",
  "instructions": {
    "SH1ADD": {
      "encoding": "0010000----------010-----0110011",
      "variable_fields": ["rd", "rs1", "rs2"],
      "extension": ["rv_zba"],
      "match": "0x20002033",
      "mask": "0xfe00707f"
    }
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier used for lookups and UI keys. |
| `name` | string | Display name. |
| `desc` | string | Short description of the extension's purpose. |
| `use` | string | Typical use cases or motivation. |
| `discontinued` | 0 or 1 | `1` marks the extension as deprecated/discontinued. |
| `url` | string | Link to the relevant specification or manual section. |
| `instructions` | object | Map of mnemonic to encoding details (populated by sync script). |

### 5.4 Instruction Data Schema

Each entry in `instr_dict.json`:

```json
{
  "sh1add": {
    "encoding": "0010000----------010-----0110011",
    "variable_fields": ["rd", "rs1", "rs2"],
    "extension": ["rv_zba"],
    "match": "0x20002033",
    "mask": "0xfe00707f"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `encoding` | string (32 chars) | Bit pattern: `0` and `1` are fixed bits, `-` marks variable (don't-care) bits. |
| `variable_fields` | string[] | Names of the variable bit regions (e.g., `rd`, `rs1`, `rs2`, `imm`, `aq`, `rl`). |
| `extension` | string[] | Extension(s) this instruction belongs to, using `riscv-opcodes` naming (e.g., `rv_zba`). |
| `match` | string (hex) | Hex value representing the fixed bits that must match. |
| `mask` | string (hex) | Hex value representing which bits are fixed (1 = fixed, 0 = variable). |

### 5.5 Category Groups

Extensions are organized into the following groups in `riscv_extensions.json`:

| Group Key | Category | Examples |
|-----------|----------|----------|
| `base` | Base integer ISAs | RV32I, RV64I, RV32E, RV64E, RV128I |
| `standard` | Single-letter standard | M, A, F, D, Q |
| `z_bit` | Bit manipulation | Zba, Zbb, Zbc, Zbs |
| `z_atomics` | Atomics | Zaamo, Zalrsc, Zacas, Zabha, Zawrs |
| `z_compress` | Compressed | C, Zca, Zcb, Zcd, Zcf, Zcmt |
| `z_float` | Floating-point | Zfh, Zfhmin, Zfa, Zfbfmin, Zfinx, Zdinx |
| `z_load_store` | Load/Store | Zicbom, Zicboz |
| `z_integer` | Integer | Zicfiss |
| `z_vector` | Vector | V and variants |
| `z_security` | Security | Zkr, Zkt, Ssectrex |
| `z_crypto` | Cryptography | Zk, Zkn, Zks, Zknd, Zkne, Zknh |
| `z_vector_crypto` | Vector cryptography | Zvk, Zvkb, Zvkg, Zvkn, Zvks |
| `z_system` | System | Zicsr, Zifencei, Zihintpause |
| `z_caches` | Caches | Zicbom, Zicbop, Zicboz |
| `s_mem` | Supervisor memory | Sv32, Sv39, Sv48, Svnapot |
| `s_interrupt` | Supervisor interrupt | Sstc, Sscofpmf, Ssaia |
| `s_trap` | Supervisor trap | Smstateen, Smnpm, Ssdbltrp |

## 6. How It Works

### 6.1 Extension Browser

The main view presents all extensions as a color-coded tile grid, grouped by
category. Each tile shows the extension ID, a short description, and a visual
indicator for discontinued extensions. Clicking a tile opens a detail panel with
the full description, use case, specification link, and a list of all instructions
in that extension.

### 6.2 Instruction Details

Selecting an instruction opens an encoding diagram showing all 32 bits, with
fixed bits (`0`/`1`) and variable fields (e.g., `rd`, `rs1`, `imm`) color-coded
and labeled. The diagram is horizontally scrollable on narrow screens. Below the
diagram, the match/mask hex values and the list of variable fields are displayed.
A copy button formats the instruction details for pasting into documentation or
emails.

### 6.3 Profile and Volume Filtering

A toolbar lets users filter extensions by RISC-V profile (RVI20, RVA20, RVA22,
RVA23, RVB23) and ISA volume (Unprivileged Volume I, Privileged Volume II).
Selecting a profile highlights which extensions are mandatory, optional, or absent
in that profile. Volume filtering separates unprivileged from privileged
(supervisor-level) extensions.

### 6.4 Search

The search bar indexes all instruction mnemonics and hex match values. Typing a
query instantly filters and highlights matching instructions across all extensions.
Both mnemonic search (e.g., `add`, `sc.w`) and hex search (e.g., `0x33`) are
supported.

### 6.5 Compressed Instruction Mapping

A dedicated section shows the 43 compressed (16-bit) instructions from the C
extension alongside their standard 32-bit equivalents, with descriptions and
notes about architecture-specific variants (RV32-only, RV64/128-only).

### 6.6 Encoder Validator

The Encoder Validator is a built-in tool for checking proposed instruction
encodings against the entire existing instruction database. Users can input:

- A 32-character encoding pattern (`0`, `1`, `-`), or
- A match + mask pair in hexadecimal.

The validator converts between representations, then performs pairwise comparison
against all existing instructions using BigInt arithmetic. Conflicts are classified
as:

| Type | Meaning |
|------|---------|
| `identical` | Exact same encoding pattern. |
| `proposed_subset_of_existing` | Every word matching the proposed also matches an existing instruction. |
| `existing_subset_of_proposed` | Every word matching an existing instruction also matches the proposed. |
| `partial_overlap` | Some words match both, but neither is a subset of the other. |

Each conflict includes a plain-language explanation, the common mask, and an
example 32-bit word that satisfies both patterns. The full report can be copied
to the clipboard.

## 7. How to Add Data

### 7.1 Adding a New Extension

1. **Choose the category group.** Open `src/riscv_extensions.json` and identify
   the appropriate group key (e.g., `z_bit`, `z_crypto`, `s_mem`). If no existing
   group fits, a new top-level key can be added.

2. **Add the extension entry** to the chosen group array:

   ```json
   {
     "id": "Znew",
     "name": "Znew",
     "desc": "Brief description of what the extension provides",
     "use": "Target use cases and motivation",
     "discontinued": 0,
     "url": "https://github.com/riscv/riscv-isa-manual"
   }
   ```

3. **Update volume membership** (if applicable). If the extension belongs to
   Privileged Volume II, ensure it is represented in the volume filtering logic
   in `src/risc_v_visualizer.jsx`.

4. **Update profile membership** (if applicable). If the extension is part of a
   ratified profile (RVA22, RVA23, etc.), add it to the corresponding profile
   definition in `src/risc_v_visualizer.jsx`.

### 7.2 Adding Instructions to an Extension

1. **Register the mnemonic list.** In `src/risc_v_visualizer.jsx`, find the
   `extensionInstructions` object and add or update the extension's mnemonic
   array:

   ```javascript
   Znew: [
     'NEWINST1', 'NEWINST2', 'NEWINST3',
   ],
   ```

   The order of mnemonics in this array determines display order in the UI.

2. **Add encoding details.** In `src/instr_dict.json`, add an entry for each
   instruction using the normalized key format (lowercase, `.` replaced with `_`):

   ```json
   "newinst1": {
     "encoding": "0000001----------000-----0110011",
     "variable_fields": ["rd", "rs1", "rs2"],
     "extension": ["rv_znew"],
     "match": "0x2000033",
     "mask": "0xfe00707f"
   }
   ```

   The encoding string must be exactly 32 characters. Use `0` and `1` for fixed
   bits and `-` for variable bits. The match and mask values must be consistent
   with the encoding pattern.

3. **Run the sync script** to merge instruction details into the extension
   catalog:

   ```bash
   node scripts/sync_instructions.mjs
   ```

   The script reports statistics: how many instructions were added, and any
   missing extensions or instructions that could not be resolved.

4. **Build and verify:**

   ```bash
   npm run build
   python3 -m http.server 8080 -d dist
   ```

   Then open `http://localhost:8080` and verify the new extension and instructions
   appear correctly. Test search by mnemonic and by hex value.

### 7.3 Adding a Compressed Instruction Mapping

To add a new compressed (16-bit) to standard (32-bit) instruction mapping, edit
the `compressedMappings` array in `src/risc_v_visualizer.jsx`:

```javascript
{
  mnemonic: 'C.NEWOP',
  compressed: 'C.NEWOP rd, rs2',
  standard: 'NEWOP rd, x0, rs2',
  description: 'Compressed form of NEWOP',
  notes: ''
}
```

### 7.4 Adding a New Category Group

If a new family of extensions does not fit any existing group, add a new top-level
key to `src/riscv_extensions.json`:

```json
{
  "z_newcategory": [
    {
      "id": "Znc1",
      "name": "Znc1",
      "desc": "...",
      "use": "...",
      "discontinued": 0,
      "url": "..."
    }
  ]
}
```

Then update `src/risc_v_visualizer.jsx` to render the new group with an
appropriate label and color.

## 8. Technology Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| UI framework | React 18 | Component-based rendering |
| Styling | Tailwind CSS 3 | Utility-first responsive design |
| Icons | Lucide React | UI icons (search, copy, info, grid) |
| Bundler | Webpack 5 | Module bundling and optimization |
| Transpiler | Babel | JSX to JavaScript |
| CSS processing | PostCSS + Autoprefixer | Tailwind compilation and vendor prefixes |
| Deployment | GitHub Pages (gh-pages) | Static site hosting |
| Data sync | Node.js (ES modules) | Instruction data merge script |

## 9. Deployment

### GitHub Pages

CI builds every push to `main` and publishes `dist/` to the `gh-pages` branch.
The site is available at `https://tech.riscv.org/isa-explorer/`.

### Local development

```bash
npm install
npm run build
python3 -m http.server 8080 -d dist
```

## 10. Data Sources

- **Instruction encodings**: Derived from the
  [riscv-opcodes](https://github.com/riscv/riscv-opcodes) project, which provides
  machine-readable instruction definitions used by assemblers, simulators, and
  verification tools.
- **Extension metadata**: Curated from the
  [RISC-V ISA Manual](https://github.com/riscv/riscv-isa-manual) and ratified
  profile specifications.
- **Profile definitions**: Based on the RISC-V Profiles specification
  (RVI20, RVA20, RVA22, RVA23, RVB23).

## 11. Maintenance

### Keeping data current

When the RISC-V ISA manual or `riscv-opcodes` is updated:

1. Update `src/instr_dict.json` with new or changed instruction encodings.
2. Update `src/riscv_extensions.json` with new or modified extensions.
3. Update `extensionInstructions` in `src/risc_v_visualizer.jsx` with new
   mnemonic assignments.
4. Run `node scripts/sync_instructions.mjs` to merge changes.
5. Run `npm run build` and verify.
6. Merge to `main`; CI publishes the site.

### Validating new encodings

Before adding a new instruction, use the Encoder Validator to check for conflicts
with existing encodings. This prevents introducing overlapping instruction
patterns that would be ambiguous for decoders.

## 12. License

This project is released under the [ISC License](LICENSE).
