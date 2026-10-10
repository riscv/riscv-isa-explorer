# RISC-V ISA Explorer MCP server

An [MCP](https://modelcontextprotocol.io) server that gives LLM clients such as
Claude, Codex, Gemini, Cursor and VS Code Copilot the
[RISC-V ISA Explorer](https://tech.riscv.org/isa-explorer/)'s data and logic as
tools. A model can then look up an extension, resolve dependencies, build a
valid `-march` string, read a profile, or decode an instruction word, instead
of answering from memory.

The tools run the Explorer's own code on its own data. Extension metadata and
dependencies are synced from
[riscv-unified-db](https://github.com/riscv/riscv-unified-db), and instruction
encodings come from [riscv-opcodes](https://github.com/riscv/riscv-opcodes).
Every dependency carries its citation (`udb`, `isa-manual` or `clang`), and the
`-march` strings it builds are the ones the Explorer's CI checks against clang.

It runs locally over stdio, needs Node.js 22.12 or later, makes no network
calls, and every tool is read-only.

## Tools

| Tool | What it answers |
|---|---|
| `about` | Data version, counts, accepted profile and base ISA names, sources |
| `list_extensions` | Search the catalogue by text, status (`ratified`, `frozen`, ...) or group |
| `get_extension` | One extension: description, status, version, spec link, requirements with citations, transitive implications, what requires it, conflicts, parameters, profiles, instructions |
| `resolve_configuration` | Base ISA plus extensions → canonical `-march`, everything implied and why, conflicts, redundant picks, one-of choices, implied parameters such as VLEN |
| `parse_march` | An existing `-march` string → base, extensions, unknown tokens, what it implies but does not write, its canonical form |
| `explain_dependency` | Does A require B? The shortest chain with a citation for each step |
| `list_profiles` | The profiles known (RVA20/22/23, RVB23, RVI20, the 23.1 minor profiles) |
| `get_profile` | Every extension in a profile, marked mandatory, implied (and by what) or optional, plus its `-march` |
| `compare_profiles` | Two or more profiles side by side, with what appears in only one |
| `lookup_instruction` | A mnemonic → name, synopsis, encoding, match/mask, operand fields, providing extensions |
| `decode_instruction` | A 16- or 32-bit word → the instruction(s) it encodes, most specific first |

## Setup

Each client starts the server with `npx -y riscv-isa-explorer-mcp`. The name
`riscv-isa` below is only the label the client shows.

**Claude Code**

```bash
claude mcp add riscv-isa -- npx -y riscv-isa-explorer-mcp
```

**Codex CLI**

```bash
codex mcp add riscv-isa -- npx -y riscv-isa-explorer-mcp
```

or in `~/.codex/config.toml`:

```toml
[mcp_servers.riscv-isa]
command = "npx"
args = ["-y", "riscv-isa-explorer-mcp"]
```

**Gemini CLI**

```bash
gemini mcp add --scope user riscv-isa npx -y riscv-isa-explorer-mcp
```

**Claude Desktop, Cursor, Windsurf** (`claude_desktop_config.json`,
`~/.cursor/mcp.json`, ...)

```json
{
  "mcpServers": {
    "riscv-isa": { "command": "npx", "args": ["-y", "riscv-isa-explorer-mcp"] }
  }
}
```

**VS Code** (`.vscode/mcp.json`)

```json
{
  "servers": {
    "riscv-isa": { "type": "stdio", "command": "npx", "args": ["-y", "riscv-isa-explorer-mcp"] }
  }
}
```

### From a checkout

To run the working tree instead of a published release:

```bash
git clone https://github.com/riscv/riscv-isa-explorer.git
cd riscv-isa-explorer && npm ci
claude mcp add riscv-isa -- node "$PWD/mcp/bin/riscv-isa-explorer-mcp.mjs"
```

In a checkout the server reads `src/` directly, so an edit to the catalogue
shows up on the next start.

## Examples

Questions the tools answer from data rather than recall:

- "What `-march` should I pass for RV64GC plus Zba, Zbb and the vector crypto NIST suite?"
- "Which extensions does RVA23 add over RVA22?"
- "Why does enabling Zvkn pull in Zve64x?"
- "Is Zicond ratified, and is it mandatory in RVB23?"
- "What is `0x00b50533`?"

## Versions

The package version (`0.1.0`) tracks the server. The data version (`about`, or
`riscv-isa-explorer-mcp --version`) is the Explorer release the data was packed
from. A new Explorer release with catalogue changes is published as a new
package version.

## Licence

Apache-2.0. Source:
[github.com/riscv/riscv-isa-explorer](https://github.com/riscv/riscv-isa-explorer/tree/main/mcp).
