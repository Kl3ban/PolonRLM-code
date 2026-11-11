import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { redact } from '../core/secrets.js';
import type { RuntimeEvent } from '../core/types.js';
import { AgentClient, type AgentDescription, type AgentRunResult, type AgentSdkOptions, type AgentToolInfo } from '../sdk/index.js';

export interface AgentClientLike {
  readonly sessionId: string;
  describe(): AgentDescription;
  tools(): AgentToolInfo[];
  run(prompt: string, onEvent?: (event: RuntimeEvent) => void): Promise<AgentRunResult>;
  cancel(): void;
  close(): Promise<void>;
}

export interface AgentServerOptions extends AgentSdkOptions {
  host?: string;
  port?: number;
  token?: string;
  /** Inject a client for tests or a custom host. */
  client?: AgentClientLike;
}

export interface AgentServer {
  url: string;
  host: string;
  port: number;
  client: AgentClientLike;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 1_000_000;

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload), 'Cache-Control': 'no-store' });
  response.end(payload);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes.`);
    chunks.push(buffer);
  }
  if (size === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Request body must be a JSON object.');
  return parsed as Record<string, unknown>;
}

function authorized(request: IncomingMessage, token?: string): boolean {
  if (!token) return true;
  return request.headers.authorization === `Bearer ${token}`;
}

/** Local HTTP/SSE agent server. Bind to loopback by default and require a token when exposed. */
export async function startAgentServer(options: AgentServerOptions): Promise<AgentServer> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  const client: AgentClientLike = options.client ?? await AgentClient.create(options);
  let closed = false;
  const server: Server = createServer(async (request, response) => {
    try {
      if (!authorized(request, options.token)) { sendJson(response, 401, { error: 'A bearer token is required.' }); return; }
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `${host}:${port}`}`);
      if (request.method === 'GET' && url.pathname === '/health') { sendJson(response, 200, { status: 'ok', sessionId: client.sessionId }); return; }
      if (request.method === 'GET' && url.pathname === '/v1/session') { sendJson(response, 200, client.describe()); return; }
      if (request.method === 'GET' && url.pathname === '/v1/tools') { sendJson(response, 200, { tools: client.tools() }); return; }
      if (request.method === 'POST' && url.pathname === '/v1/cancel') { client.cancel(); sendJson(response, 200, { cancelled: true, sessionId: client.sessionId }); return; }
      if (request.method === 'POST' && url.pathname === '/v1/messages') {
        const body = await readJson(request);
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
        if (!prompt) { sendJson(response, 400, { error: 'prompt must be a non-empty string.' }); return; }
        const wantsStream = body.stream === true || String(request.headers.accept ?? '').includes('text/event-stream');
        if (!wantsStream) {
          const result = await client.run(prompt);
          sendJson(response, 200, result); return;
        }
        response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        const send = (event: string, data: unknown): void => {
          if (!response.writableEnded) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        send('ready', { sessionId: client.sessionId });
        try {
          const result = await client.run(prompt, event => send('runtime', event));
          send('done', result);
        } catch (error: any) {
          send('error', { error: redact(String(error?.message ?? error)) });
        } finally { response.end(); }
        return;
      }
      sendJson(response, 404, { error: `No route for ${request.method} ${url.pathname}.` });
    } catch (error: any) {
      if (!response.headersSent) sendJson(response, 500, { error: redact(String(error?.message ?? error)) });
      else if (!response.writableEnded) response.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return {
    host, port: actualPort, url: `http://${host}:${actualPort}`, client,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await client.close();
    },
  };
}
