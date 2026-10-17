#!/usr/bin/env node
/** Stdio remains protocol-only; browser jobs belong to the shared coordinator. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createToolService } from './service-tools.mjs';

export function createMcpServer(options = {}) {
  const tools = createToolService(options);
  const server = new Server({ name: 'playwright-image-gen', version: '3.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => tools.listTools());
  server.setRequestHandler(CallToolRequestSchema, async request => tools.callTool(request.params.name, request.params.arguments));
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await createMcpServer().connect(new StdioServerTransport()); }
  catch { console.error('[image-gen] MCP stdio server could not start.'); process.exitCode = 1; }
}
