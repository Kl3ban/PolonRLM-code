import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { JsonSchemaValidator } from '@modelcontextprotocol/sdk/validation';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { secureMcpServerSchema } from '../core/config.js';
import type { MCPConfig, ToolSpec } from '../core/types.js';

interface ConnectedServer { client: Client; transport: Transport; timeout: number }
interface RegisteredTool { server: string; remoteName: string; spec: ToolSpec; validate: JsonSchemaValidator<Record<string, unknown>> }

export function mcpConfigPreview(config: MCPConfig): MCPConfig {
  const preview = structuredClone(config);
  if (preview.env) for (const [key, value] of Object.entries(preview.env)) {
    if (!/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)) preview.env[key] = '[REDACTED]';
  }
  if (preview.url) {
    try { const url = new URL(preview.url); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; preview.url = url.toString(); }
    catch { preview.url = '[INVALID URL]'; }
  }
  if (preview.args) {
    let hideNext = false;
    preview.args = preview.args.map(argument => {
      if (hideNext) { hideNext = false; return '[REDACTED]'; }
      const safe = argument.replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]');
      if (!/(?:api[_-]?key|auth(?:entication|orization)?|token|secret|password|credential|cookie|bearer|private[_-]?key|signature|jwt)/i.test(argument)) return safe;
      const equal = argument.indexOf('=');
      if (equal >= 0) return `${argument.slice(0, equal + 1)}[REDACTED]`;
      const colon = argument.indexOf(':');
      if (colon >= 0) return `${argument.slice(0, colon + 1)}[REDACTED]`;
      if (safe !== argument) return safe;
      hideNext = true;
      return argument;
    });
  }
  return preview;
}

/** Connections are started only by connect(), never by configuration discovery. */
export class MCPManager {
  private readonly servers = new Map<string, ConnectedServer>();
  private readonly registered = new Map<string, RegisteredTool>();
  private readonly connecting = new Map<string, Promise<ToolSpec[]>>();
  private readonly validator = new AjvJsonSchemaValidator();
  private readonly secrets = new Set<string>();

  constructor(private readonly configs: Record<string, MCPConfig>) {}

  async connect(name: string): Promise<ToolSpec[]> {
    if (this.servers.has(name)) return this.toolsFor(name);
    const pending = this.connecting.get(name);
    if (pending) return pending;
    const operation = this.open(name);
    this.connecting.set(name, operation);
    try { return await operation; } finally { this.connecting.delete(name); }
  }

  tools(): ToolSpec[] { return [...this.registered.values()].map(tool => structuredClone(tool.spec)); }

  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const tool = this.registered.get(name);
    if (!tool) throw new Error(`Unknown MCP tool: ${name}. Connect the server first.`);
    const server = this.servers.get(tool.server);
    if (!server) throw new Error(`MCP server ${tool.server} is disconnected.`);
    const validated = tool.validate(args);
    if (!validated.valid) throw new Error(`Invalid MCP arguments: ${validated.errorMessage}`);
    try {
      const result = await server.client.callTool(
        { name: tool.remoteName, arguments: validated.data }, undefined,
        { timeout: server.timeout, maxTotalTimeout: server.timeout, signal },
      );
      // Images and audio are described rather than dumping large binary data into context.
      const content = Array.isArray(result.content) ? result.content.map(item => {
        if (item.type === 'text') return { type: 'text', text: item.text };
        if (item.type === 'image' || item.type === 'audio') return { type: item.type, mimeType: item.mimeType, omitted: 'binary content' };
        return item;
      }) : result.content;
      const output = JSON.stringify({ isError: result.isError ?? false, content, structuredContent: result.structuredContent });
      return this.redact(output.length > 300_000 ? `${output.slice(0, 300_000)}\n[MCP output truncated to 300,000 characters]` : output);
    } catch (error) { throw new Error(this.redact(`MCP ${tool.server}: ${error instanceof Error ? error.message : String(error)}`)); }
  }

  async disconnect(name: string): Promise<void> {
    const pending = this.connecting.get(name);
    if (pending) { try { await pending; } catch { /* No live connection remains. */ } }
    const server = this.servers.get(name);
    this.remove(name);
    if (server) await server.client.close();
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.connecting.values()]);
    const results = await Promise.allSettled([...this.servers.keys()].map(name => this.disconnect(name)));
    const failed = results.filter(result => result.status === 'rejected');
    if (failed.length) throw new Error(`Could not close ${failed.length} MCP connection(s).`);
  }

  private async open(name: string): Promise<ToolSpec[]> {
    const storedConfig = Object.hasOwn(this.configs, name) ? this.configs[name] : undefined;
    if (!storedConfig) throw new Error(`MCP configuration not found: ${name}`);
    const parsedConfig = secureMcpServerSchema.safeParse(storedConfig);
    if (!parsedConfig.success) throw new Error(`Unsafe MCP configuration for ${name}. Move secrets to environment variables as \${ENV_NAME} and add the server again.`);
    const config = parsedConfig.data;
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(name)) throw new Error('MCP server name must contain 1 to 80 letters, numbers, underscores, or hyphens.');
    const timeout = Math.min(300_000, Math.max(100, config.timeoutMs ?? 30_000));
    let transport: Transport;
    if (config.type === 'stdio') {
      if (!config.command?.trim() || config.command.includes('\0')) throw new Error('MCP stdio requires a valid command.');
      const environment = { ...getDefaultEnvironment() };
      for (const [key, value] of Object.entries(config.env ?? {})) {
        const reference = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
        if (reference) {
          const resolved = process.env[reference[1]!];
          if (resolved === undefined) throw new Error(`Missing MCP environment variable: ${reference[1]}`);
          environment[key] = resolved;
          if (resolved.length > 3) this.secrets.add(resolved);
        } else {
          environment[key] = value;
          if (value.length > 3) this.secrets.add(value);
        }
      }
      transport = new StdioClientTransport({ command: config.command, args: config.args, env: environment, stderr: 'pipe', maxBufferSize: 2_000_000 });
      // Drain stderr to avoid deadlock; untrusted process output never reaches the TUI or logs.
      (transport as StdioClientTransport).stderr?.on('data', () => {});
    } else if (config.type === 'http') {
      if (!config.url) throw new Error('MCP HTTP requires a URL.');
      const url = new URL(config.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('MCP requires an HTTP(S) URL without credentials.');
      const headers: Record<string, string> = {};
      for (const [header, variable] of Object.entries(config.headersEnv ?? {})) {
        const value = process.env[variable];
        if (value === undefined) throw new Error(`Missing MCP environment variable: ${variable}`);
        headers[header] = value;
        if (value.length > 3) this.secrets.add(value);
      }
      transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers }, redirectPolicy: 'same-origin',
        reconnectionOptions: { initialReconnectionDelay: 500, maxReconnectionDelay: 5_000, reconnectionDelayGrowFactor: 2, maxRetries: 2 },
      });
    } else throw new Error('Unsupported MCP transport. Use stdio or http.');

    const client = new Client({ name: 'PolonRLM', version: '0.5.0' }, { capabilities: {} });
    client.onclose = () => this.remove(name);
    try {
      await client.connect(transport, { timeout, signal: AbortSignal.timeout(timeout) });
      const staged: RegisteredTool[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < 16; page++) {
        const result = await client.listTools(cursor ? { cursor } : undefined, { timeout, signal: AbortSignal.timeout(timeout) });
        for (const tool of result.tools) {
          if (staged.length >= 256) throw new Error('MCP server exceeds the limit of 256 tools.');
          if (JSON.stringify(tool.inputSchema).length > 200_000) throw new Error('MCP tool schema is too large.');
          const registeredName = this.toolName(name, tool.name);
          if (staged.some(item => item.spec.name === registeredName)) throw new Error('MCP server returned duplicate tool names.');
          if (this.registered.has(registeredName)) throw new Error(`Tool name conflicts with another MCP server: ${registeredName}. Rename the server.`);
          const spec: ToolSpec = { name: registeredName, description: `[MCP ${name}] ${(tool.description ?? tool.name).slice(0, 8_000)}`, parameters: tool.inputSchema };
          staged.push({ server: name, remoteName: tool.name, spec, validate: this.validator.getValidator<Record<string, unknown>>(tool.inputSchema) });
        }
        cursor = result.nextCursor;
        if (!cursor) break;
        if (seenCursors.has(cursor) || page === 15) throw new Error('Invalid or excessive MCP pagination.');
        seenCursors.add(cursor);
      }
      this.servers.set(name, { client, transport, timeout });
      for (const tool of staged) this.registered.set(tool.spec.name, tool);
      return this.toolsFor(name);
    } catch (error) {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      throw new Error(this.redact(`MCP connection ${name}: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  private toolsFor(server: string): ToolSpec[] { return [...this.registered.values()].filter(tool => tool.server === server).map(tool => structuredClone(tool.spec)); }
  private remove(server: string): void {
    this.servers.delete(server);
    for (const [name, tool] of this.registered) if (tool.server === server) this.registered.delete(name);
  }
  private toolName(server: string, tool: string): string {
    const raw = `mcp_${server}_${tool}`;
    const safe = raw.replace(/[^a-zA-Z0-9_-]/g, '_');
    const hash = createHash('sha256').update(`${server}\0${tool}`).digest('hex').slice(0, 8);
    return safe === raw && safe.length <= 64 ? safe : `${safe.slice(0, 55)}_${hash}`;
  }
  private redact(text: string): string {
    for (const secret of this.secrets) text = text.replaceAll(secret, '[REDACTED]');
    return text;
  }
}
