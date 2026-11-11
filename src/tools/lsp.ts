import { execa } from 'execa';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { z } from 'zod';
import type { ToolRegistry } from './registry.js';
import type { Workspace } from './workspace.js';
import { subprocessEnvironment } from '../core/secrets.js';
import type { SandboxExecutor, PreparedCommand } from './sandbox.js';

const actions = ['hover', 'definition', 'implementation', 'type_definition', 'references', 'symbols', 'workspace_symbols', 'prepare_call_hierarchy', 'incoming_calls', 'outgoing_calls', 'diagnostics'] as const;
const positionActions = new Set(['hover', 'definition', 'implementation', 'type_definition', 'references', 'symbols', 'prepare_call_hierarchy', 'incoming_calls', 'outgoing_calls', 'diagnostics']);

/** A bounded stdio LSP client. Server requests never execute edits, commands or UI actions. */
export function registerLspTool(registry: ToolRegistry, workspace: Workspace, sandbox?: SandboxExecutor): void {
  registry.add('lsp_request', 'Use an installed stdio language server for hover, definitions, implementations, type definitions, references, document/workspace symbols, call hierarchy or diagnostics. Call hierarchy actions prepare and inspect a symbol in one server session. Workspace symbol search needs a query; all other actions need a file path, language ID and 1-based UTF-16 position. Uses OS isolation when available; host fallback follows the permission policy. No automatic installation or server-requested edits.', z.object({
    command: z.string().min(1),
    args: z.array(z.string()).max(30).default([]),
    path: z.string().optional(),
    languageId: z.string().min(1).optional(),
    action: z.enum(actions),
    query: z.string().max(500).optional(),
    line: z.number().int().positive().default(1),
    column: z.number().int().positive().default(1),
    timeoutMs: z.number().int().min(1000).max(60000).default(15000),
  }), false, async (args, context) => {
    if (positionActions.has(args.action) && (!args.path || !args.languageId)) throw new Error('This LSP action requires a workspace file path and language ID.');
    if (args.action === 'workspace_symbols' && !args.query?.trim()) throw new Error('Provide a query for workspace symbol search.');

    const needsDocument = positionActions.has(args.action);
    const filename = needsDocument ? await workspace.resolve(args.path!) : workspace.root;
    const text = needsDocument ? await workspace.readText(args.path!) : undefined;
    const details = JSON.stringify({ command: args.command, args: args.args, path: args.path, query: args.query });
    const sandboxStatus = sandbox ? await sandbox.status(workspace.root) : undefined;
    if (sandbox?.mode === 'required' && sandboxStatus && !sandboxStatus.available) throw new Error(`OS sandbox is required but unavailable: ${sandboxStatus.reason ?? sandboxStatus.backend}. No language server was started.`);
    await workspace.permissions.check('lsp_request', 'shell', sandboxStatus?.available ? `Start the language server for ${args.action} inside the ${sandboxStatus.backend} OS sandbox.${sandboxStatus.reason ? ` Setup note: ${sandboxStatus.reason}` : ''}` : `OS sandbox is unavailable${sandboxStatus?.reason ? ` (${sandboxStatus.reason})` : ''}; start the language server on the host only after approval.`, details, context.mode, context.signal);
    context.signal.throwIfAborted();

    const abort = new AbortController(); const onAbort = () => abort.abort(); context.signal.addEventListener('abort', onAbort, { once: true });
    let launch: PreparedCommand | undefined;
    if (sandbox) {
      if (sandboxStatus?.available) {
        try { launch = await sandbox.prepare(args.command, args.args, workspace.root, context.signal); }
        catch (error: any) {
          if (sandbox.mode === 'required') { context.signal.removeEventListener('abort', onAbort); throw error; }
          await workspace.permissions.check('sandbox_fallback', 'shell', `Sandbox setup failed (${String(error?.message ?? error)}). Approve starting this language server on the host.`, details, context.mode, context.signal);
        }
      } else if (sandbox.needsFallbackApproval('lsp_request')) {
        await workspace.permissions.check('sandbox_fallback', 'shell', 'The language server tool is set to auto, but OS isolation is unavailable. Approve starting it directly on the host.', details, context.mode, context.signal);
      }
    }
    const child = execa(launch?.command ?? args.command, launch?.args ?? args.args, { cwd: workspace.root, env: launch?.sandboxed ? launch.env : subprocessEnvironment(context.isolated), windowsHide: true, cancelSignal: abort.signal, killDescendants: true, timeout: args.timeoutMs, buffer: false, reject: false });
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
      const initialized = await request('initialize', {
        processId: process.pid,
        rootUri: pathToFileURL(workspace.root).href,
        workspaceFolders: [{ uri: pathToFileURL(workspace.root).href, name: path.basename(workspace.root) }],
        capabilities: {
          workspace: { symbol: {}, workspaceFolders: { supported: true, changeNotifications: false } },
          textDocument: {
            publishDiagnostics: {}, diagnostic: {},
            implementation: { linkSupport: true }, typeDefinition: { linkSupport: true },
            documentSymbol: { hierarchicalDocumentSymbolSupport: true }, callHierarchy: {},
          },
        },
      });
      send({ jsonrpc: '2.0', method: 'initialized', params: {} });
      const uri = pathToFileURL(filename).href;
      if (text !== undefined) send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: args.languageId!, version: 1, text } } });

      if (args.action === 'workspace_symbols') return await request('workspace/symbol', { query: args.query!.trim() });
      if (args.action === 'diagnostics' && !initialized?.capabilities?.diagnosticProvider) {
        const deadline = Date.now() + Math.min(args.timeoutMs, 3000);
        while (diagnostics === undefined && Date.now() < deadline) { context.signal.throwIfAborted(); await new Promise(resolve => setTimeout(resolve, 50)); }
        return { received: diagnostics !== undefined, diagnostics: diagnostics ?? [], note: diagnostics === undefined ? 'The server did not publish diagnostics before the timeout. This does not mean there are no errors.' : undefined };
      }

      const position = { textDocument: { uri }, position: { line: args.line - 1, character: args.column - 1 } };
      if (args.action === 'incoming_calls' || args.action === 'outgoing_calls') {
        const items = await request('textDocument/prepareCallHierarchy', position);
        if (!Array.isArray(items) || items.length === 0) return { items: [], truncated: false };
        const selected = items.slice(0, 10), method = args.action === 'incoming_calls' ? 'callHierarchy/incomingCalls' : 'callHierarchy/outgoingCalls';
        const calls = await Promise.all(selected.map(item => request(method, { item })));
        return { items: selected.map((item, index) => ({ item, calls: calls[index] })), truncated: items.length > selected.length };
      }

      const methods: Record<string, string> = {
        hover: 'textDocument/hover', definition: 'textDocument/definition', implementation: 'textDocument/implementation',
        type_definition: 'textDocument/typeDefinition', references: 'textDocument/references', symbols: 'textDocument/documentSymbol',
        prepare_call_hierarchy: 'textDocument/prepareCallHierarchy', diagnostics: 'textDocument/diagnostic',
      };
      return await request(methods[args.action]!, { ...position, ...(args.action === 'references' ? { context: { includeDeclaration: true } } : {}) });
    } finally { abort.abort(); await outcome; context.signal.removeEventListener('abort', onAbort); await launch?.cleanup(); }
  });
}
