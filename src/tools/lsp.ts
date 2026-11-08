import { execa } from 'execa';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { z } from 'zod';
import type { ToolRegistry } from './registry.js';
import type { Workspace } from './workspace.js';
import { subprocessEnvironment } from '../core/secrets.js';

/** A bounded stdio LSP client. Server requests never execute edits, commands or UI actions. */
export function registerLspTool(registry: ToolRegistry, workspace: Workspace): void {
  registry.add('lsp_request', 'Use an installed stdio Language Server Protocol server for any supported language: hover, definition, references, document symbols or diagnostics. Starting a server follows the configured permission policy. Positions are 1-based UTF-16. No automatic installation or server-requested edits.', z.object({ command: z.string().min(1), args: z.array(z.string()).max(30).default([]), path: z.string(), languageId: z.string().min(1), action: z.enum(['hover', 'definition', 'references', 'symbols', 'diagnostics']), line: z.number().int().positive().default(1), column: z.number().int().positive().default(1), timeoutMs: z.number().int().min(1000).max(60000).default(15000) }), false, async (args, context) => {
    const filename = await workspace.resolve(args.path), text = await workspace.readText(args.path);
    await workspace.permissions.check('lsp_request', 'shell', 'Start the language server with your permissions.', JSON.stringify({ command: args.command, args: args.args }), context.mode, context.signal);
    context.signal.throwIfAborted();
    const abort = new AbortController(); const onAbort = () => abort.abort(); context.signal.addEventListener('abort', onAbort, { once: true });
    const child = execa(args.command, args.args, { cwd: workspace.root, env: subprocessEnvironment(context.isolated), windowsHide: true, cancelSignal: abort.signal, killDescendants: true, timeout: args.timeoutMs, buffer: false, reject: false });
    let sequence = 0, buffer = Buffer.alloc(0); const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    let diagnostics: unknown[] | undefined;
    const send = (message: unknown) => { const body = Buffer.from(JSON.stringify(message)); child.stdin!.write(`Content-Length: ${body.length}\r\n\r\n`); child.stdin!.write(body); };
    const fail = (error: Error) => { for (const request of pending.values()) request.reject(error); pending.clear(); };
    child.stdin?.on('error', error => fail(error)); child.stderr?.on('data', () => {});
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]); if (buffer.length > 2000000) { fail(new Error('LSP output exceeds the 2 MB limit.')); abort.abort(); return; }
      try {
        while (true) {
          const headerEnd = buffer.indexOf('\r\n\r\n'); if (headerEnd < 0) break;
          const match = /content-length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString('ascii')); if (!match) throw new Error('Invalid LSP frame.');
          const length = Number(match[1]); if (length > 2000000) throw new Error('LSP frame exceeds 2 MB.');
          if (buffer.length < headerEnd + 4 + length) break;
          const message = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8')); buffer = buffer.subarray(headerEnd + 4 + length);
          if (message.method === 'textDocument/publishDiagnostics' && message.params?.uri === pathToFileURL(filename).href) diagnostics = message.params.diagnostics;
          if (message.method && message.id !== undefined) {
            if (message.method === 'workspace/configuration') send({ jsonrpc: '2.0', id: message.id, result: (message.params?.items ?? []).map(() => null) });
            else send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Client does not allow server-initiated operations' } });
          } else if (message.id !== undefined) { const request = pending.get(message.id); if (request) { pending.delete(message.id); if (message.error) request.reject(new Error(String(message.error.message))); else request.resolve(message.result); } }
        }
      } catch (error: any) { fail(error); abort.abort(); }
    });
    const outcome = child.then(() => fail(new Error('LSP server exited.')), error => fail(new Error(error.message)));
    const request = (method: string, params: unknown) => new Promise<any>((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); send({ jsonrpc: '2.0', id, method, params }); });
    try {
      const initialized = await request('initialize', { processId: process.pid, rootUri: pathToFileURL(workspace.root).href, workspaceFolders: [{ uri: pathToFileURL(workspace.root).href, name: path.basename(workspace.root) }], capabilities: { textDocument: { publishDiagnostics: {}, diagnostic: {} } } });
      send({ jsonrpc: '2.0', method: 'initialized', params: {} });
      const uri = pathToFileURL(filename).href;
      send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: args.languageId, version: 1, text } } });
      if (args.action === 'diagnostics' && !initialized?.capabilities?.diagnosticProvider) {
        const deadline = Date.now() + Math.min(args.timeoutMs, 3000);
        while (diagnostics === undefined && Date.now() < deadline) { context.signal.throwIfAborted(); await new Promise(resolve => setTimeout(resolve, 50)); }
        return { received: diagnostics !== undefined, diagnostics: diagnostics ?? [], note: diagnostics === undefined ? 'The server did not publish diagnostics before the timeout. This does not mean there are no errors.' : undefined };
      }
      const methods: Record<string, string> = { hover: 'textDocument/hover', definition: 'textDocument/definition', references: 'textDocument/references', symbols: 'textDocument/documentSymbol', diagnostics: 'textDocument/diagnostic' };
      const method = methods[args.action]!;
      return await request(method, { textDocument: { uri }, position: { line: args.line - 1, character: args.column - 1 }, ...(args.action === 'references' ? { context: { includeDeclaration: true } } : {}) });
    } finally { abort.abort(); await outcome; context.signal.removeEventListener('abort', onAbort); }
  });
}
