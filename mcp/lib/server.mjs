/**
 * server.mjs — the MCP server: tool names, descriptions and input schemas.
 *
 * The descriptions are written for the model that reads them. They say when to
 * call a tool instead of answering from memory, because a model that guesses a
 * dependency or a -march string is the failure this server exists to prevent.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createTools, ToolInputError, STATUSES } from './tools.mjs';

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const INSTRUCTIONS = `RISC-V ISA Explorer (https://tech.riscv.org/isa-explorer/).
Use these tools for RISC-V facts instead of answering from memory: extension status and versions,
which extensions require which, valid -march strings, profile contents (RVA23, RVB23, ...), and
instruction encodings. Answers come from data synced from riscv-unified-db and riscv-opcodes, every
dependency carries a citation, and generated -march strings are validated against clang in CI.
Cite the spec_url or explorer_url fields when you report a result.`;

export function createServer(explorer) {
  const tools = createTools(explorer);
  const server = new McpServer(
    { name: 'riscv-isa-explorer', version: explorer.serverVersion ?? '0.0.0' },
    { instructions: INSTRUCTIONS },
  );

  const register = (name, config, handler) =>
    server.registerTool(
      name,
      { ...config, annotations: { ...READ_ONLY, title: config.title } },
      async (args) => {
        try {
          const result = handler(args ?? {});
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
          if (!(error instanceof ToolInputError)) throw error;
          return { isError: true, content: [{ type: 'text', text: error.message }] };
        }
      },
    );

  const extensionId = z
    .string()
    .describe('Extension id, case-insensitive, e.g. "Zba", "V", "Zvkn", "Sv39"');
  const profileName = z
    .string()
    .describe('Profile name, e.g. "RVA23", "RVB23", "RVA22", "RVI20U64"');

  register(
    'about',
    {
      title: 'About the data',
      description:
        'What this server knows: data version, counts, the profile and base ISA names it accepts, and where the data comes from.',
      inputSchema: {},
    },
    tools.about,
  );

  register(
    'list_extensions',
    {
      title: 'List or search extensions',
      description:
        'Search the RISC-V extension catalogue by text, ratification status or group. Returns ids, names, status, version and ratification date. Use get_extension for the full record.',
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(
            'Text matched against id, name, description and use case, e.g. "crypto", "half-precision"',
          ),
        status: z.enum(STATUSES).optional().describe('Only extensions with this status'),
        group: z
          .string()
          .optional()
          .describe(
            'Catalogue group, matched by substring, e.g. "Vector", "Cryptography", "Bit Manipulation"',
          ),
        limit: z.number().int().min(1).max(300).optional().describe('Maximum results (default 50)'),
      },
    },
    tools.listExtensions,
  );

  register(
    'get_extension',
    {
      title: 'Get an extension',
      description:
        'Everything about one extension: description, status, version, ratification date, spec link, its direct requirements with citations, everything it implies transitively, what requires it, conflicts, parameters, the profiles that include it, and its instructions.',
      inputSchema: {
        id: extensionId,
        include_instructions: z
          .boolean()
          .optional()
          .describe('Also list every instruction mnemonic (default false)'),
      },
    },
    tools.getExtension,
  );

  register(
    'resolve_configuration',
    {
      title: 'Resolve a configuration and build -march',
      description:
        'Given a base ISA and a set of extensions, resolve every dependency and return the canonical -march string, what was pulled in and why (with citations), conflicts, redundant picks, one-of choices and implied parameters such as VLEN. Call this instead of writing a -march string by hand.',
      inputSchema: {
        base: z.string().describe('Base ISA: RV32I, RV64I, RV32E, RV64E or RV128I'),
        extensions: z
          .array(z.string())
          .describe('Extension ids, e.g. ["M", "A", "F", "D", "C", "Zba", "V"]'),
      },
    },
    tools.resolveConfiguration,
  );

  register(
    'parse_march',
    {
      title: 'Parse a -march string',
      description:
        'Parse an existing -march string (e.g. "rv64gcv_zba_zbb"): XLEN, base, the extensions it names, tokens nobody recognises, extensions it implies without writing them, conflicts, and the canonical form of the same configuration.',
      inputSchema: { march: z.string().describe('A -march string, e.g. "rv64imafdc_zicsr_zba"') },
    },
    tools.parseMarch,
  );

  register(
    'explain_dependency',
    {
      title: 'Explain a dependency',
      description:
        'Does extension A require extension B, directly or transitively? Returns the shortest chain with the citation for each step (riscv-unified-db, the ISA manual or clang), or says that it does not.',
      inputSchema: {
        extension: extensionId.describe('The extension that may require the other, e.g. "Zvkn"'),
        requires: extensionId.describe('The possible requirement, e.g. "Zve32x"'),
      },
    },
    tools.explainDependency,
  );

  register(
    'list_profiles',
    {
      title: 'List profiles',
      description:
        'The RISC-V profiles this server knows, with XLEN, scope, description and mandatory/optional counts.',
      inputSchema: {},
    },
    tools.listProfiles,
  );

  register(
    'get_profile',
    {
      title: 'Get a profile',
      description:
        "Every extension in a RISC-V profile, each classified as mandatory, implied (required by a mandatory extension, with what implies it) or optional, plus the profile's -march string.",
      inputSchema: {
        profile: profileName,
        include_implied: z
          .boolean()
          .optional()
          .describe(
            'Classify dependency-implied extensions (default true). False gives the lists as the specification writes them.',
          ),
      },
    },
    tools.getProfile,
  );

  register(
    'compare_profiles',
    {
      title: 'Compare profiles',
      description:
        'Side-by-side comparison of two or more profiles: for each extension, whether it is mandatory, implied, optional or absent in each, which extensions appear in only one profile, and how many rows differ.',
      inputSchema: {
        profiles: z
          .array(z.string())
          .min(2)
          .max(8)
          .describe('Profiles to compare, e.g. ["RVA22", "RVA23"]'),
        include_implied: z
          .boolean()
          .optional()
          .describe('Count dependency-implied extensions (default true)'),
        differences_only: z
          .boolean()
          .optional()
          .describe('Return only rows that differ (default false)'),
      },
    },
    tools.compareProfiles,
  );

  register(
    'lookup_instruction',
    {
      title: 'Look up an instruction',
      description:
        'An instruction by mnemonic: name, synopsis, bit-level encoding, match and mask, operand fields, and the extensions that provide it.',
      inputSchema: {
        mnemonic: z
          .string()
          .describe('Mnemonic, case-insensitive, e.g. "sh1add", "vsetvli", "c.addi"'),
      },
    },
    tools.lookupInstruction,
  );

  register(
    'decode_instruction',
    {
      title: 'Decode an instruction word',
      description:
        'Which instruction(s) a 16- or 32-bit machine word encodes. Accepts hex (0x00b50533), binary (0b...) or decimal. Returns every match, most specific first.',
      inputSchema: { word: z.string().describe('Instruction word, e.g. "0x00b50533" or "0x4505"') },
    },
    tools.decodeInstruction,
  );

  return server;
}
