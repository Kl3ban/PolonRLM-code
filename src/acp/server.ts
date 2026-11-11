import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { AgentClient, type AgentClientLike, type AgentDescription, type AgentRunResult, type AgentSdkOptions, type AgentToolInfo } from '../sdk/index.js';
import type { ApprovalRequest, RuntimeEvent } from '../core/types.js';

export interface AcpClient extends AgentClientLike {
  describe(): AgentDescription;
  tools(): AgentToolInfo[];
  run(prompt: string, onEvent?: (event: RuntimeEvent) => void): Promise<AgentRunResult>;
  cancel(): void;
  close(): Promise<void>;
}

export interface AcpServerOptions extends Partial<AgentSdkOptions> {
  /** Inject a client factory for tests or a custom host. */
  createClient?: (cwd: string) => Promise<AcpClient>;
  /** Ask the ACP client for permission. Without this or a stdio transport, approval-required tools are denied. */
  requestClient?: (method: string, params: unknown) => Promise<unknown>;
  onNotification?: (message: Record<string, unknown>) => void;
}

type JsonRpc = Record<string, unknown> & { jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown };
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

const PROTOCOL_VERSION = 1;
const ERROR = { parse: -32700, invalidRequest: -32600, method: -32601, params: -32602, internal: -32603, auth: -32000, notFound: -32002 };

/** ACP v1 agent over newline-delimited JSON-RPC. */
export class AcpServer {
  private readonly sessions = new Map<string, AcpClient>();
  private readonly busy = new Set<string>();
  private readonly pending = new Map<number, Pending>();
  private nextRequestId = 1;
  private write?: (message: Record<string, unknown>) => void;

  constructor(private readonly options: AcpServerOptions = {}) {}

  private async clientFor(cwd: string): Promise<AcpClient> {
    if (this.options.createClient) return this.options.createClient(cwd);
    if (!path.isAbsolute(cwd)) throw new Error('ACP session cwd must be an absolute path.');
    const { createClient: _createClient, onNotification: _onNotification, requestClient: _requestClient, ...sdkOptions } = this.options;
    const sessionRef = { id: '' };
    const customApprove = sdkOptions.approve;
    const client = await AgentClient.create({
      ...sdkOptions,
      workspace: cwd,
      approve: async (request: ApprovalRequest, signal?: AbortSignal) => {
        if (customApprove && !(await customApprove(request, signal))) return false;
        return this.requestPermission(sessionRef.id, request);
      },
    });
    sessionRef.id = client.sessionId;
    return client;
  }

  private notify(method: string, params: unknown): void {
    this.options.onNotification?.({ jsonrpc: '2.0', method, params });
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    if (this.options.requestClient) return this.options.requestClient(method, params);
    if (!this.write) throw new Error('ACP client transport is not connected.');
    const id = this.nextRequestId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`ACP request ${method} timed out.`)); }, 300_000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.write!({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** Ask the connected ACP client to approve one tool call. Exposed for tests and custom transports. */
  async requestPermission(sessionId: string, request: ApprovalRequest): Promise<boolean> {
    try {
      const response = await this.request('session/request_permission', {
        sessionId,
        toolCall: { toolCallId: `acp_${randomUUID()}`, title: request.tool, kind: 'other', status: 'pending', rawInput: { description: request.description } },
        options: [
          { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
        ],
      }) as { outcome?: { outcome?: string; optionId?: string } } | undefined;
      return response?.outcome?.outcome === 'selected' && response.outcome.optionId === 'allow_once';
    } catch { return false; }
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
            loadSession: true,
            promptCapabilities: { image: true, audio: false, embeddedContext: false },
            mcpCapabilities: { http: false, sse: false },
            sessionCapabilities: { close: {}, list: {}, resume: {} },
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
      if (method === 'session/load' || method === 'session/resume') {
        const params = (message.params ?? {}) as { cwd?: unknown; sessionId?: unknown };
        const cwd = typeof params.cwd === 'string' ? path.resolve(params.cwd) : '';
        const requested = typeof params.sessionId === 'string' ? params.sessionId : '';
        if (!cwd || !requested) return fail(ERROR.params, `${method} requires an absolute cwd and a sessionId.`);
        const client = await this.clientFor(cwd);
        if (client.resumeSession) client.resumeSession(requested);
        this.sessions.set(requested, client);
        if (method === 'session/load' && client.history) {
          for (const message of client.history()) {
            if (!message.text) continue;
            this.notify('session/update', { sessionId: requested, update: {
              sessionUpdate: message.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk',
              content: { type: 'text', text: message.text },
            } });
          }
        }
        return respond({ modes: null, configOptions: null });
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
        const content = promptContent(params.prompt);
        if (content.images.length && !client.addImageData) return fail(ERROR.params, 'This ACP session does not support image input.');
        if (!content.text && !content.images.length) return fail(ERROR.params, 'session/prompt needs text or image content.');
        this.busy.add(sessionId);
        try {
          for (const image of content.images.slice(0, 5)) client.addImageData?.(image.data, image.name ?? 'ACP image');
          const prompt = content.text || 'Describe the attached image.';
          await client.run(prompt, event => {
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
    this.write = write;
    this.options.onNotification = this.options.onNotification ?? (message => write(message as Record<string, unknown>));
    lines.on('line', line => {
      if (!line.trim()) return;
      let parsed: JsonRpc;
      try { parsed = JSON.parse(line); }
      catch { write({ jsonrpc: '2.0', id: null, error: { code: ERROR.parse, message: 'Invalid JSON.' } }); return; }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { write({ jsonrpc: '2.0', id: null, error: { code: ERROR.invalidRequest, message: 'Invalid request.' } }); return; }
      if (typeof parsed.method !== 'string' && parsed.id !== undefined && parsed.id !== null) {
        const pending = this.pending.get(Number(parsed.id));
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(Number(parsed.id));
          if (parsed.error) pending.reject(new Error(String((parsed.error as any).message ?? 'ACP client request failed.')));
          else pending.resolve(parsed.result);
          return;
        }
      }
      void this.handle(parsed).then(response => { if (response) write(response); }).catch(error => write({ jsonrpc: '2.0', id: parsed.id ?? null, error: { code: ERROR.internal, message: String(error?.message ?? error) } }));
    });
    lines.on('close', async () => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('ACP transport closed.')); }
      this.pending.clear();
      for (const client of this.sessions.values()) await client.close().catch(() => {});
    });
  }
}

function promptContent(value: unknown): { text: string; images: Array<{ data: string; name?: string }> } {
  if (!Array.isArray(value)) return { text: '', images: [] };
  const parts: string[] = [];
  const images: Array<{ data: string; name?: string }> = [];
  for (const block of value) {
    if (!block || typeof block !== 'object') continue;
    const item = block as Record<string, unknown>;
    if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text);
    else if (item.type === 'resource' && typeof item.resource === 'object' && item.resource) {
      const resource = item.resource as Record<string, unknown>;
      if (typeof resource.text === 'string') parts.push(resource.text);
    } else if (item.type === 'image' && typeof item.data === 'string' && typeof item.mimeType === 'string' && /^image\/(?:png|jpeg|webp|gif)$/.test(item.mimeType)) {
      images.push({ data: item.data, ...(typeof item.uri === 'string' ? { name: item.uri } : {}) });
    }
  }
  return { text: parts.join('\n').trim(), images };
}
