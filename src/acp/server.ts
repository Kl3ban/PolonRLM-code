import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { AgentClient, type AgentDescription, type AgentRunResult, type AgentSdkOptions, type AgentToolInfo } from '../sdk/index.js';
import type { RuntimeEvent } from '../core/types.js';

export interface AcpClient {
  readonly sessionId: string;
  describe(): AgentDescription;
  tools(): AgentToolInfo[];
  run(prompt: string, onEvent?: (event: RuntimeEvent) => void): Promise<AgentRunResult>;
  cancel(): void;
  close(): Promise<void>;
}

export interface AcpServerOptions extends Partial<AgentSdkOptions> {
  /** Inject a client factory for tests or a custom host. */
  createClient?: (cwd: string) => Promise<AcpClient>;
  onNotification?: (message: Record<string, unknown>) => void;
}

type JsonRpc = Record<string, unknown> & { jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown };

const PROTOCOL_VERSION = 1;
const ERROR = { parse: -32700, invalidRequest: -32600, method: -32601, params: -32602, internal: -32603, auth: -32000, notFound: -32002 };

/** Minimal ACP v1 agent over newline-delimited JSON-RPC. It supports initialize, session/new, prompt, cancel and close. */
export class AcpServer {
  private readonly sessions = new Map<string, AcpClient>();
  private readonly busy = new Set<string>();

  constructor(private readonly options: AcpServerOptions = {}) {}

  private async clientFor(cwd: string): Promise<AcpClient> {
    if (this.options.createClient) return this.options.createClient(cwd);
    if (!path.isAbsolute(cwd)) throw new Error('ACP session cwd must be an absolute path.');
    const { createClient: _createClient, onNotification: _onNotification, ...sdkOptions } = this.options;
    return AgentClient.create({ ...sdkOptions, workspace: cwd });
  }

  private notify(method: string, params: unknown): void {
    this.options.onNotification?.({ jsonrpc: '2.0', method, params });
  }

  async handle(message: JsonRpc): Promise<Record<string, unknown> | undefined> {
    const id = message.id;
    const respond = (result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id: id ?? null, result });
    const fail = (code: number, text: string): Record<string, unknown> => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message: text } });
    const method = typeof message.method === 'string' ? message.method : '';
    try {
      if (method === 'initialize') {
        return respond({
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: {
            loadSession: false,
            promptCapabilities: { image: false, audio: false, embeddedContext: false },
            mcpCapabilities: { http: false, sse: false },
            sessionCapabilities: { close: {}, list: {} },
          },
          authMethods: [],
          agentInfo: { name: 'PolonRLM', version: '0.5.0' },
        });
      }
      if (method === 'authenticate' || method === 'logout') return respond({});
      if (method === 'session/new') {
        const params = (message.params ?? {}) as { cwd?: unknown };
        const cwd = typeof params.cwd === 'string' ? path.resolve(params.cwd) : '';
        if (!cwd) return fail(ERROR.params, 'session/new requires an absolute cwd.');
        const client = await this.clientFor(cwd);
        let sessionId = client.sessionId;
        while (this.sessions.has(sessionId)) sessionId = `sess_${randomUUID()}`;
        this.sessions.set(sessionId, client);
        return respond({ sessionId, modes: null, configOptions: null });
      }
      if (method === 'session/list') {
        return respond({ sessions: [...this.sessions.entries()].map(([sessionId, client]) => ({ sessionId, cwd: client.describe().workspace, title: null, updatedAt: null })), nextCursor: null });
      }
      if (method === 'session/prompt') {
        const params = (message.params ?? {}) as { sessionId?: unknown; prompt?: unknown };
        const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
        const client = this.sessions.get(sessionId);
        if (!client) return fail(ERROR.notFound, `Unknown session ${sessionId || '(missing)'}.`);
        if (this.busy.has(sessionId)) return fail(ERROR.internal, 'A prompt is already running for this session.');
        const text = promptText(params.prompt);
        if (!text) return fail(ERROR.params, 'session/prompt needs at least one text content block.');
        this.busy.add(sessionId);
        try {
          await client.run(text, event => {
            if (event.type === 'text' && event.text) this.notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: event.text } } });
            else if (event.type === 'tool' && event.name) {
              this.notify('session/update', { sessionId, update: {
                sessionUpdate: event.state === 'done' || event.state === 'error' ? 'tool_call_update' : 'tool_call',
                toolCallId: event.id ?? event.name, title: event.name, kind: 'other',
                status: event.state === 'done' ? 'completed' : event.state === 'error' ? 'failed' : 'in_progress',
              } });
            }
          });
          return respond({ stopReason: 'end_turn' });
        } catch (error: any) {
          const cancelled = /abort|cancel/i.test(String(error?.name ?? error?.message ?? error));
          if (cancelled) return respond({ stopReason: 'cancelled' });
          return fail(ERROR.internal, String(error?.message ?? error));
        } finally { this.busy.delete(sessionId); }
      }
      if (method === 'session/cancel') {
        const params = (message.params ?? {}) as { sessionId?: unknown };
        if (typeof params.sessionId === 'string') this.sessions.get(params.sessionId)?.cancel();
        return undefined; // Notification, no response.
      }
      if (method === 'session/close') {
        const params = (message.params ?? {}) as { sessionId?: unknown };
        const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
        const client = this.sessions.get(sessionId);
        if (!client) return fail(ERROR.notFound, `Unknown session ${sessionId || '(missing)'}.`);
        client.cancel();
        await client.close();
        this.sessions.delete(sessionId);
        return respond({});
      }
      return fail(ERROR.method, `ACP method ${method || '(missing)'} is not supported.`);
    } catch (error: any) {
      return fail(ERROR.internal, String(error?.message ?? error));
    }
  }

  startStdio(): void {
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    const write = (message: Record<string, unknown>): void => { process.stdout.write(`${JSON.stringify(message)}\n`); };
    this.options.onNotification = this.options.onNotification ?? (message => write(message as Record<string, unknown>));
    lines.on('line', line => {
      if (!line.trim()) return;
      let parsed: JsonRpc;
      try { parsed = JSON.parse(line); }
      catch { write({ jsonrpc: '2.0', id: null, error: { code: ERROR.parse, message: 'Invalid JSON.' } }); return; }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { write({ jsonrpc: '2.0', id: null, error: { code: ERROR.invalidRequest, message: 'Invalid request.' } }); return; }
      void this.handle(parsed).then(response => { if (response) write(response); }).catch(error => write({ jsonrpc: '2.0', id: parsed.id ?? null, error: { code: ERROR.internal, message: String(error?.message ?? error) } }));
    });
    lines.on('close', async () => { for (const client of this.sessions.values()) await client.close().catch(() => {}); });
  }
}

function promptText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  const parts: string[] = [];
  for (const block of value) {
    if (!block || typeof block !== 'object') continue;
    const item = block as Record<string, unknown>;
    if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text);
    else if (item.type === 'resource' && typeof item.resource === 'object' && item.resource) {
      const resource = item.resource as Record<string, unknown>;
      if (typeof resource.text === 'string') parts.push(resource.text);
    }
  }
  return parts.join('\n').trim();
}
