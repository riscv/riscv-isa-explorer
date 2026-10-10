#!/usr/bin/env node
/**
 * Starts the RISC-V ISA Explorer MCP server on stdio.
 *
 * stdout carries the protocol, so nothing else may write to it; diagnostics go
 * to stderr.
 */
import { readFileSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { explorer } from '../lib/explorer.mjs';
import { createServer } from '../lib/server.mjs';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

if (process.argv.includes('--version')) {
  process.stderr.write(`riscv-isa-explorer-mcp ${version} (data ${explorer.dataVersion})\n`);
  process.exit(0);
}

const server = createServer({ ...explorer, serverVersion: version });
await server.connect(new StdioServerTransport());
process.stderr.write(`riscv-isa-explorer-mcp ${version} ready (data ${explorer.dataVersion})\n`);
