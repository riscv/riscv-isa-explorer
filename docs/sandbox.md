# Custom Extension Sandbox

A place to design a RISC-V extension that does not exist yet, and to check the
encodings you invent against every instruction that does.

Open it from **Extension Sandbox** in the toolbar.

## What it is, and what it is not

The sandbox produces **no authoritative data**. It generates instruction
templates from the base instruction formats in the specification, and it checks
your encodings against `src/riscv_extensions.json` — the same catalogue and the
same bit arithmetic the Encoder Validator uses. Every validation result traces
back to real catalogue data.

What it does not do is confer any status. A clean validation means "this bit
pattern does not collide with anything the catalogue knows about today". It does
not mean the extension is reserved, registered, ratified, or that anyone has
agreed to it. Nothing you build here leaves your browser unless you export it.

Sandbox extensions are also deliberately walled off from the rest of the app:
they never enter a generated `-march` string, and they cannot be added to an ISA
configuration. They exist to be designed, checked and exported, not to be
shipped as a config.

## The two modes

The sandbox asks which kind of thing you are designing before it lets you start,
because the answer changes which opcodes are legal.

### Mode A — a custom vendor extension

**Create Custom Extension.** For a non-standard extension of your own: an
accelerator, a domain-specific instruction, anything that is not going upstream.

Ids are forced to begin with `X`, the specification's prefix for non-standard
extensions. Instructions default into the **custom opcode space** — `custom-0`
(`0x0b`), `custom-1` (`0x2b`), `custom-2` (`0x5b`) and `custom-3` (`0x7b`) —
which the specification sets aside precisely so vendor extensions cannot collide
with future standard ones.

### Mode B — an addition to a ratified extension

**Select Official Extension.** For drafting an instruction you would like to see
added to an extension that already exists — the shape of an upstream RFC.

Pick the target extension and the sandbox reads its **designated opcodes**: the
major opcodes its existing instructions actually occupy. A proposal to `Zba`
starts in `OP-32` because that is where Zba lives. The id becomes
`<Target>__sandbox` (for example `Zba__sandbox`), which cannot collide with a
real catalogue id, and the proposal is tracked as an addition to the real
extension rather than as a new one.

Two guards apply here:

- **One proposal per extension.** Asking for a second addition to a target you
  already have open switches to the existing one instead of creating a duplicate.
- **32-bit extensions only.** An extension that lives entirely in compressed
  space — `Zca`, `Zcb`, `Zcmp` — has no 32-bit major opcode to extend, and the
  sandbox declines and says so rather than picking an arbitrary slot.

## Designing an instruction

Add an instruction and pick a base format — **R, I, S, B, U** or **J** — and the
sandbox lays out a 32-bit template with that format's fields in the right places.
`R4` is available for the four-register fused-multiply forms.

**Clone Sibling Template** copies an existing instruction from the target
extension as a starting point, keeping its real `variable_fields`. Cloning is
refused for 16-bit compressed instructions, since the sandbox models 32-bit
encodings only and silently substituting a 32-bit template would misrepresent
what you cloned.

The encoding is edited bit by bit. Each bit is `0`, `1`, or `-` for don't-care,
which is how `riscv-opcodes` writes an operand field. The mnemonic and the
description are free text; the mnemonic is what both exports key on.

Limits: **8 extensions** per sandbox, **32 instructions** per extension.

## What validation actually checks

Diagnostics appear as you type, at three levels.

**Errors** — the encoding is wrong or it collides:

| Check | Meaning |
|---|---|
| Encoding is not 32 bits, or contains something other than `0`, `1`, `-` | Malformed pattern |
| Opcode is `0x1f`, `0x3f`, `0x5f`, `0x7f` | These designate 48-, 64- and ≥80-bit instructions. They are not 32-bit opcode slots. |
| Opcode is in custom space, on a **standard-track** proposal | Custom slots are reserved for non-standard extensions (ISA §27); an upstream proposal must not use them |
| Identical encoding to an existing instruction | Exact match against the catalogue |
| Every word matching yours also matches an existing instruction, or the reverse | One pattern wholly contains the other |
| Partial overlap with an existing instruction | Some words decode as both; the message gives an example word |
| Encoding conflict with another sandbox instruction | Your own two instructions collide |
| Duplicate mnemonic within the extension | Both would export to the same key and one would overwrite the other |

**Warnings** — legal but questionable: an unrecognised major opcode, or a
standard-space opcode outside the extension you are proposing to.

**Info** — an opcode in space reserved for future standard extensions. Safe
today; it is telling you the space is not yours.

The collision checks run against every instruction in the catalogue, not just
the target extension.

## Exports

**Download JSON** produces a `riscv-opcodes`-format file, keyed the way that
project keys instructions: the mnemonic lowercased with `.` replaced by `_`, so
`X.MAC` becomes `x_mac`. This is the form you would contribute upstream.

**Download Specification Package (.md)** produces a proposal document: target
extension and id, whether the track is standard or proprietary, the base
extension's instruction inventory, the opcodes in play, architectural
dependencies, the description, a compliance section citing ISA §27, the full
collision and validation report, and the candidate encodings.

The validation report is included deliberately. A proposal that says which
overlaps were checked, and against what, is a stronger proposal than one that
asserts the encoding is free.

## Saving and sharing

Work is kept in `localStorage` under `riscv-landscape-sandbox`, separate from the
ISA Configuration Builder's state. It survives a reload; it does not follow you
to another browser or machine.

Sharing uses a `?sandbox=` permalink that carries the whole sandbox, compressed,
in the URL. Anyone opening the link gets your extensions in their own sandbox.
Malformed or truncated links are dropped rather than partially loaded — an
addition arriving without a valid opcode is discarded instead of being given a
default one, because inventing an opcode is exactly the kind of quiet wrongness
this tool exists to avoid.

## Limits worth knowing

- **32-bit encodings only.** No compressed (16-bit) instruction design, and no
  48-bit or longer forms.
- **Nothing is reserved.** Two people can design the same encoding in the same
  custom slot and both get a clean report. Custom opcode space is intentionally
  unmanaged.
- **Checked against this catalogue, at this moment.** A future extension can
  land in space that is free today. The reserved-space info diagnostic is the
  warning about that.
- **The sandbox is not an assembler.** It models encodings and their collisions,
  not semantics, side effects, or whether the instruction is a good idea.
