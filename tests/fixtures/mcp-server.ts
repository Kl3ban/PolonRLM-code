import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

export function createTestMCPServer(): McpServer {
  const server = new McpServer({ name: 'polonrlm-test', version: '1.0.0' });
  server.registerTool('sum', {
    description: 'Adds two integers.', inputSchema: { a: z.number().int(), b: z.number().int() },
  }, async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }));
  server.registerTool('slow', {
    description: 'Waits until completed or cancelled.', inputSchema: { milliseconds: z.number().int().min(0).max(10_000) },
  }, async ({ milliseconds }, extra) => {
    await setTimeout(milliseconds, undefined, { signal: extra.signal });
    return { content: [{ type: 'text', text: 'completed' }] };
  });
  server.registerTool('failure', { inputSchema: {} }, async () => ({ isError: true, content: [{ type: 'text', text: 'test failure' }] }));
  return server;
}

if (process.argv.includes('--stdio') && resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  await createTestMCPServer().connect(new StdioServerTransport());
}
