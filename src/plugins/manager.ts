import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { TrustedPluginConfig } from '../core/types.js';
import {
  POLONRLM_PLUGIN_API_VERSION,
  type PluginTaskContext, type PluginTaskResult, type PluginToolContext,
  type PluginToolDefinition, type PluginToolResult, type PolonRLMPluginAPI,
} from './api.js';

const PLUGIN_ID = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_SOURCE_BYTES = 256_000;
const MAX_ACTIVE_PLUGINS = 16;
const MAX_TASK_CONTEXT_BYTES = 12_000;
const HOOK_TIMEOUT_MS = 5_000;
const TOOL_TIMEOUT_MS = 30_000;
const TOOL_NAME = /^[a-z][a-z0-9_]{1,48}$/;
const HOOKS = ['beforeTask', 'beforeTool', 'afterTool', 'afterTask'] as const;
type HookName = typeof HOOKS[number];
const PLUGIN_BOOTSTRAP = `
import { pathToFileURL } from 'node:url';
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
const send = message => { if (process.send) process.send(message); };
const hooks = { beforeTask: [], beforeTool: [], afterTool: [], afterTask: [] };
const tools = new Map();
const add = (name, handler) => { if (typeof handler === 'function') hooks[name].push(handler); };
const api = {
  version: 1,
  hooks: {
    beforeTask: handler => add('beforeTask', handler),
    beforeTool: handler => add('beforeTool', handler),
    afterTool: handler => add('afterTool', handler),
    afterTask: handler => add('afterTask', handler),
  },
  tools: { register(tool) { tools.set(tool.name, tool); } },
};
let plugin;
process.on('disconnect', () => process.exit(0));
process.on('message', async message => {
  try {
    if (!plugin) {
      plugin = (await import(pathToFileURL(message.entry).href)).default;
      if (!plugin || typeof plugin.activate !== 'function') throw new Error('Plugin has no activate function.');
      if (plugin.id !== message.id || plugin.version !== message.version) throw new Error('Plugin code id/version must match plugin.json.');
      await plugin.activate(api);
      send({ type: 'ready', id: plugin.id, version: plugin.version, hooks: Object.fromEntries(Object.entries(hooks).map(([name, list]) => [name, list.length])), tools: [...tools.values()] });
      return;
    }
    if (message.action === 'deactivate') {
      await plugin.deactivate?.();
      send({ type: 'result', id: message.id, ok: true });
      return;
    }
    let value;
    if (message.kind === 'tool') {
      const tool = tools.get(message.name);
      if (!tool) throw new Error('Plugin tool ' + message.name + ' was not registered during activation.');
      value = await tool.run(freeze(message.args), freeze(message.context));
    } else {
      const handler = hooks[message.hook]?.[message.index];
      if (typeof handler !== 'function') throw new Error('Plugin hook ' + message.hook + '[' + message.index + '] was not registered during activation.');
      value = await handler(freeze(message.event));
    }
    send({ type: 'result', id: message.id, ok: true, value });
  } catch (error) {
    send({ type: 'result', id: message.id, ok: false, error: String(error && error.stack ? error.stack : error) });
  }
});
`;
const manifestSchema = z.object({
  id: z.string().regex(PLUGIN_ID),
  name: z.string().min(1).max(80),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/),
  description: z.string().min(1).max(1_000),
  entry: z.literal('index.mjs'),
}).strict();
type PluginManifest = z.infer<typeof manifestSchema>;
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type ActivePlugin = {
  manifest: PluginManifest;
  hash: string;
  entryPath: string;
  child: ChildProcess;
  pending: Map<number, Pending>;
  nextId: number;
  hooks: Record<HookName, number>;
  tools: PluginToolDefinition[];
};

export interface PluginPreview { manifest: PluginManifest; path: string; sha256: string }
export interface PluginStatus { id: string; enabled: boolean; loaded: boolean; name?: string; version?: string; problem?: string }

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function clipBytes(value: string, limit: number): string {
  let bytes = 0, end = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > limit) break;
    bytes += size;
    end += character.length;
  }
  return value.slice(0, end);
}
function validateTool(tool: unknown): PluginToolDefinition {
  if (!tool || typeof tool !== 'object') throw new Error('Plugin tool must be an object.');
  const value = tool as PluginToolDefinition;
  if (!TOOL_NAME.test(value.name ?? '')) throw new Error('Plugin tool name must start with a lowercase letter and contain only lowercase letters, digits and underscores.');
  if (typeof value.description !== 'string' || !value.description.trim() || value.description.length > 1_000) throw new Error('Plugin tool description must be 1-1000 characters.');
  if (!value.parameters || typeof value.parameters !== 'object' || Array.isArray(value.parameters)) throw new Error('Plugin tool parameters must be a JSON Schema object.');
  if (value.run !== undefined && typeof value.run !== 'function') throw new Error('Plugin tool run must be a function.');
  return { name: value.name, description: value.description, parameters: value.parameters, readOnly: value.readOnly === true, run: async () => { throw new Error('Plugin tools execute in the plugin host process.'); } };
}

/** Loads only explicitly enabled, hash-pinned single-file plugins from the user's PolonRLM home. Plugin code runs in a child process. */
export class PluginManager {
  private readonly root: string;
  private active = new Map<string, ActivePlugin>();
  private pendingReviews = new Map<string, string>();
  private problems: string[] = [];
  private registrationCount = 0;

  constructor(home: string) { this.root = path.resolve(home, 'plugins'); }

  async create(id: string): Promise<string> {
    this.checkId(id);
    await this.prepareRoot();
    const directory = path.join(this.root, id);
    try { await lstat(directory); throw new Error(`Plugin ${id} already exists.`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await mkdir(directory);
    const manifest: PluginManifest = { id, name: id, version: '1.0.0', description: 'A local PolonRLM plugin.', entry: 'index.mjs' };
    const source = `export default {\n  id: ${JSON.stringify(id)},\n  version: '1.0.0',\n  activate(api) {\n    api.hooks.beforeTask(({ task }) => {\n      // Return short, task-specific context or return nothing.\n      if (task.toLowerCase().includes('example')) return 'Example plugin context.';\n    });\n  },\n};\n`;
    try {
      await writeFile(path.join(directory, 'plugin.json'), JSON.stringify(manifest, null, 2), { encoding: 'utf8', flag: 'wx' });
      await writeFile(path.join(directory, 'index.mjs'), source, { encoding: 'utf8', flag: 'wx' });
      return directory;
    } catch (error) { await rm(directory, { recursive: true, force: true }).catch(() => {}); throw error; }
  }

  async preview(id: string): Promise<PluginPreview> {
    const files = await this.files(id);
    const manifest = manifestSchema.parse(JSON.parse(files.manifestText));
    if (manifest.id !== id) throw new Error(`Plugin folder ${id} does not match manifest id ${manifest.id}.`);
    const sha256 = createHash('sha256').update(files.manifestText).update('\0').update(files.source).digest('hex');
    return { manifest, path: files.entryPath, sha256 };
  }

  async review(id: string): Promise<PluginPreview> {
    const preview = await this.preview(id);
    this.pendingReviews.set(id, preview.sha256);
    return preview;
  }

  consumeReview(id: string, hash: string): boolean {
    const reviewedHash = this.pendingReviews.get(id);
    this.pendingReviews.delete(id);
    return reviewedHash === hash;
  }

  async loadEnabled(configs: Record<string, TrustedPluginConfig>): Promise<string[]> {
    const warnings: string[] = [];
    for (const [id, config] of Object.entries(configs).sort(([left], [right]) => left.localeCompare(right))) {
      if (!config.enabled) continue;
      if (!config.sha256) { warnings.push(`${id}: plugin has no approval hash; review and enable it with /plugins enable ${id} confirm.`); continue; }
      try { await this.activate(id, config.sha256); }
      catch (error) { warnings.push(`${id}: plugin was not loaded: ${String((error as Error)?.message ?? error)}`); }
    }
    this.addProblems(warnings);
    return warnings;
  }

  async activate(id: string, expectedHash: string): Promise<void> {
    this.checkId(id);
    const preview = await this.preview(id);
    if (!/^[a-f0-9]{64}$/i.test(expectedHash) || preview.sha256 !== expectedHash.toLowerCase()) throw new Error('Plugin files changed since approval. Review the current plugin and confirm it again.');
    const current = this.active.get(id);
    if (current?.hash === preview.sha256) return;
    if (current) await this.deactivate(id);
    if (this.active.size >= MAX_ACTIVE_PLUGINS) throw new Error(`At most ${MAX_ACTIVE_PLUGINS} plugins can be active at once.`);

    const child = spawn(process.execPath, ['--input-type=module', '-e', PLUGIN_BOOTSTRAP], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
    const active: ActivePlugin = {
      manifest: preview.manifest, hash: preview.sha256, entryPath: preview.path, child, pending: new Map(), nextId: 1,
      hooks: { beforeTask: 0, beforeTool: 0, afterTool: 0, afterTask: 0 }, tools: [],
    };
    this.attachHost(active, id);
    try {
      const ready = await this.startHost(active, preview) as { hooks?: Record<string, unknown>; tools?: unknown[]; id?: unknown; version?: unknown };
      if (ready.id !== id || ready.version !== preview.manifest.version) throw new Error('Plugin host id/version does not match the reviewed plugin.');
      const hooks = { beforeTask: 0, beforeTool: 0, afterTool: 0, afterTask: 0 };
      for (const hook of HOOKS) {
        const count = Number((ready.hooks ?? {})[hook]);
        if (!Number.isInteger(count) || count < 0 || count > 64) throw new Error(`Plugin host returned an invalid ${hook} hook count.`);
        hooks[hook] = count;
      }
      const tools = (ready.tools ?? []).map(validateTool);
      const names = new Set<string>();
      for (const tool of tools) {
        if (names.has(tool.name)) throw new Error(`Plugin tool ${tool.name} is registered twice.`);
        names.add(tool.name);
        for (const other of this.active.values()) if (other.tools.some(entry => entry.name === tool.name)) throw new Error(`Plugin tool ${tool.name} is already registered.`);
      }
      const registrations = HOOKS.reduce((sum, hook) => sum + hooks[hook], 0) + tools.length;
      if (this.registrationCount + registrations >= 64) throw new Error('PolonRLM allows at most 64 hooks and tools across active plugins.');
      active.hooks = hooks;
      active.tools = tools;
      this.registrationCount += registrations;
      this.active.set(id, active);
    } catch (error) {
      child.kill();
      throw error;
    }
  }

  async deactivate(id: string): Promise<void> {
    const active = this.active.get(id);
    if (!active) return;
    this.active.delete(id);
    this.registrationCount -= HOOKS.reduce((sum, hook) => sum + active.hooks[hook], 0) + active.tools.length;
    try { await this.hostCall(active, { action: 'deactivate' }, HOOK_TIMEOUT_MS, 'deactivate'); }
    finally { active.child.kill(); }
  }

  async close(): Promise<void> {
    const ids = [...this.active.keys()].reverse();
    for (const id of ids) {
      try { await this.deactivate(id); }
      catch (error) { this.addProblems([`${id}: deactivate hook failed: ${String((error as Error)?.message ?? error)}`]); }
    }
  }

  toolDefinitions(): Array<{ pluginId: string; definition: PluginToolDefinition }> {
    return [...this.active].flatMap(([pluginId, active]) => active.tools.map(definition => ({ pluginId, definition })));
  }

  async callTool(pluginId: string, name: string, args: Readonly<Record<string, unknown>>, context: PluginToolContext): Promise<string> {
    const active = this.active.get(pluginId);
    if (!active || !active.tools.some(tool => tool.name === name)) throw new Error(`Plugin tool ${name} is not loaded.`);
    const result = await this.hostCall(active, { action: 'call', kind: 'tool', name, args, context }, TOOL_TIMEOUT_MS, `Plugin tool ${name}`);
    if (typeof result === 'string') return result;
    try { return JSON.stringify(result) ?? String(result); } catch { return String(result); }
  }

  async list(configs: Record<string, TrustedPluginConfig>): Promise<PluginStatus[]> {
    const statuses: PluginStatus[] = [];
    for (const [id, config] of Object.entries(configs).sort(([left], [right]) => left.localeCompare(right))) {
      const active = this.active.get(id);
      try {
        const preview = await this.preview(id);
        const problem = config.enabled && config.sha256 !== preview.sha256 ? 'Files changed; confirm again to load.' : undefined;
        statuses.push({ id, enabled: config.enabled, loaded: Boolean(active && active.hash === preview.sha256), name: preview.manifest.name, version: preview.manifest.version, ...(problem ? { problem } : {}) });
      } catch (error) {
        statuses.push({ id, enabled: config.enabled, loaded: false, problem: String((error as Error)?.message ?? error) });
      }
    }
    return statuses;
  }

  async beforeTask(context: PluginTaskContext): Promise<Array<{ id: string; context: string }>> {
    const registrations = this.hookRegistrations('beforeTask');
    const settled = await Promise.allSettled(registrations.map(({ active, index }) => this.hostCall(active, { action: 'call', kind: 'hook', hook: 'beforeTask', index, event: context }, HOOK_TIMEOUT_MS, 'beforeTask')));
    const output: Array<{ id: string; context: string }> = [];
    let remaining = MAX_TASK_CONTEXT_BYTES;
    settled.forEach((result, index) => {
      const { id } = registrations[index]!;
      if (result.status === 'rejected') { this.addProblems([`${id}: beforeTask hook failed: ${String((result.reason as Error)?.message ?? result.reason)}`]); return; }
      if (typeof result.value !== 'string' || !result.value.trim() || remaining <= 0) return;
      const value = clipBytes(result.value.trim(), Math.min(4_000, remaining));
      remaining -= Buffer.byteLength(value, 'utf8');
      output.push({ id, context: value });
    });
    return output;
  }

  async beforeTool(context: PluginToolContext): Promise<void> {
    const registrations = this.hookRegistrations('beforeTool');
    const settled = await Promise.allSettled(registrations.map(({ active, index }) => this.hostCall(active, { action: 'call', kind: 'hook', hook: 'beforeTool', index, event: context }, HOOK_TIMEOUT_MS, 'beforeTool')));
    const failures = settled.flatMap((result, index) => result.status === 'rejected'
      ? [`Plugin ${registrations[index]!.id} beforeTool hook failed; the tool was blocked: ${String((result.reason as Error)?.message ?? result.reason)}`]
      : typeof result.value === 'string' && result.value.trim()
        ? [`Plugin ${registrations[index]!.id} blocked ${context.tool}: ${result.value.trim().slice(0, 1_000)}`]
        : []);
    if (failures.length) throw new Error(failures.join('\n'));
  }

  async afterTool(context: PluginToolResult): Promise<void> {
    const registrations = this.hookRegistrations('afterTool');
    const settled = await Promise.allSettled(registrations.map(({ active, index }) => this.hostCall(active, { action: 'call', kind: 'hook', hook: 'afterTool', index, event: context }, HOOK_TIMEOUT_MS, 'afterTool')));
    settled.forEach((result, index) => { if (result.status === 'rejected') this.addProblems([`${registrations[index]!.id}: afterTool hook failed: ${String((result.reason as Error)?.message ?? result.reason)}`]); });
  }

  async afterTask(context: PluginTaskResult): Promise<void> {
    const registrations = this.hookRegistrations('afterTask');
    const settled = await Promise.allSettled(registrations.map(({ active, index }) => this.hostCall(active, { action: 'call', kind: 'hook', hook: 'afterTask', index, event: context }, HOOK_TIMEOUT_MS, 'afterTask')));
    settled.forEach((result, index) => { if (result.status === 'rejected') this.addProblems([`${registrations[index]!.id}: afterTask hook failed: ${String((result.reason as Error)?.message ?? result.reason)}`]); });
  }

  drainProblems(): string[] { return this.problems.splice(0); }

  private hookRegistrations(hook: HookName): Array<{ id: string; active: ActivePlugin; index: number }> {
    return [...this.active].flatMap(([id, active]) => Array.from({ length: active.hooks[hook] }, (_value, index) => ({ id, active, index })));
  }

  private attachHost(active: ActivePlugin, id: string): void {
    active.child.on('message', (message: any) => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'ready') { active.pending.get(0)?.resolve(message); active.pending.delete(0); return; }
      if (message.type === 'result') {
        const pending = active.pending.get(Number(message.id));
        if (!pending) return;
        active.pending.delete(Number(message.id));
        clearTimeout(pending.timer);
        if (message.ok) pending.resolve(message.value);
        else pending.reject(new Error(String(message.error ?? 'Plugin host call failed.')));
      }
    });
    active.child.once('exit', code => {
      for (const pending of active.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(`Plugin host ${id} exited with code ${code ?? 'unknown'}.`)); }
      active.pending.clear();
      this.addProblems([`${id}: plugin host exited with code ${code ?? 'unknown'}.`]);
    });
  }

  private startHost(active: ActivePlugin, preview: PluginPreview): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { active.child.kill(); reject(new Error('Plugin activation timed out.')); }, TOOL_TIMEOUT_MS);
      timer.unref();
      active.pending.set(0, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); }, timer });
      active.child.once('error', error => { clearTimeout(timer); reject(error); });
      active.child.send({ action: 'init', entry: preview.path, id: preview.manifest.id, version: preview.manifest.version });
    });
  }

  private hostCall(active: ActivePlugin, payload: Record<string, unknown>, timeoutMs: number, label: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = active.nextId++;
      const timer = setTimeout(() => { active.pending.delete(id); reject(new Error(`${label} exceeded ${timeoutMs}ms.`)); }, timeoutMs);
      timer.unref();
      active.pending.set(id, { resolve, reject, timer });
      try { active.child.send({ ...payload, id }); }
      catch (error) { active.pending.delete(id); clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  private async files(id: string): Promise<{ manifestText: string; source: string; entryPath: string }> {
    this.checkId(id);
    const root = await this.prepareRoot();
    const directory = path.join(root, id);
    const directoryStat = await lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('Plugin directory must be a real directory.');
    const realDirectory = await realpath(directory);
    if (!isInside(root, realDirectory)) throw new Error('Plugin directory resolves outside the PolonRLM plugins folder.');
    const entries = await readdir(realDirectory);
    if (entries.some(entry => !['plugin.json', 'index.mjs'].includes(entry))) throw new Error('A plugin must be one self-contained index.mjs file plus plugin.json. Extra files are not loaded.');
    const manifestPath = path.join(realDirectory, 'plugin.json'), entryPath = path.join(realDirectory, 'index.mjs');
    for (const filename of [manifestPath, entryPath]) {
      const stat = await lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SOURCE_BYTES) throw new Error('Plugin files must be regular files up to 256 KB.');
      if (!isInside(realDirectory, await realpath(filename))) throw new Error('Plugin file resolves outside its plugin directory.');
    }
    return { manifestText: await readFile(manifestPath, 'utf8'), source: await readFile(entryPath, 'utf8'), entryPath };
  }

  private async prepareRoot(): Promise<string> {
    await mkdir(this.root, { recursive: true });
    const stat = await lstat(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Plugins folder must be a real directory.');
    return realpath(this.root);
  }

  private checkId(id: string): void { if (!PLUGIN_ID.test(id)) throw new Error('Plugin ID must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens (up to 64 characters).'); }

  private addProblems(values: string[]): void {
    this.problems.push(...values);
    if (this.problems.length > 64) this.problems.splice(0, this.problems.length - 64);
  }
}
