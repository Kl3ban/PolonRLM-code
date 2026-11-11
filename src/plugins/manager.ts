import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { TrustedPluginConfig } from '../core/types.js';
import {
  POLONRLM_PLUGIN_API_VERSION,
  type PluginHandler, type PluginTaskContext, type PluginTaskResult, type PluginToolContext,
  type PluginToolResult, type PolonRLMPlugin, type PolonRLMPluginAPI,
} from './api.js';

const PLUGIN_ID = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_SOURCE_BYTES = 256_000;
const MAX_ACTIVE_PLUGINS = 16;
const MAX_TASK_CONTEXT_BYTES = 12_000;
const HOOK_TIMEOUT_MS = 5_000;
const manifestSchema = z.object({
  id: z.string().regex(PLUGIN_ID),
  name: z.string().min(1).max(80),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/),
  description: z.string().min(1).max(1_000),
  entry: z.literal('index.mjs'),
}).strict();
type PluginManifest = z.infer<typeof manifestSchema>;

type ActivePlugin = {
  manifest: PluginManifest;
  plugin: PolonRLMPlugin;
  hash: string;
  beforeTask: Array<PluginHandler<PluginTaskContext, string | void>>;
  beforeTool: Array<PluginHandler<PluginToolContext, string | void>>;
  afterTool: Array<PluginHandler<PluginToolResult>>;
  afterTask: Array<PluginHandler<PluginTaskResult>>;
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
function frozenCopy<T>(value: T): T {
  if (!value || typeof value !== 'object') return value;
  const copy = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (!item || typeof item !== 'object' || Object.isFrozen(item)) return;
    for (const child of Object.values(item as Record<string, unknown>)) freeze(child);
    Object.freeze(item);
  };
  freeze(copy);
  return copy;
}

/** Loads only explicitly enabled, hash-pinned single-file plugins from the user's PolonRLM home. */
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

    const moduleUrl = pathToFileURL(preview.path);
    moduleUrl.searchParams.set('sha256', preview.sha256);
    const loaded = await import(moduleUrl.href) as { default?: unknown };
    const pluginSchema = z.object({
      id: z.string().regex(PLUGIN_ID),
      version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/),
      activate: z.function(),
      deactivate: z.function().optional(),
    }).passthrough();
    const plugin = pluginSchema.parse(loaded.default) as PolonRLMPlugin;
    if (plugin.id !== id || plugin.version !== preview.manifest.version) throw new Error('Plugin code id/version must match plugin.json.');
    const handlers: ActivePlugin = { manifest: preview.manifest, plugin, hash: preview.sha256, beforeTask: [], beforeTool: [], afterTool: [], afterTask: [] };
    let registrations = 0;
    const add = <T>(collection: Array<PluginHandler<T, any>>, handler: PluginHandler<T, any>): void => {
      if (typeof handler !== 'function') throw new Error('Plugin hook must be a function.');
      if (this.registrationCount + registrations >= 64) throw new Error('PolonRLM allows at most 64 hooks across active plugins.');
      registrations++;
      collection.push(handler);
    };
    const api: PolonRLMPluginAPI = Object.freeze({
      version: POLONRLM_PLUGIN_API_VERSION,
      hooks: Object.freeze({
        beforeTask: (handler: PluginHandler<PluginTaskContext, string | void>) => add(handlers.beforeTask, handler),
        beforeTool: (handler: PluginHandler<PluginToolContext, string | void>) => add(handlers.beforeTool, handler),
        afterTool: (handler: PluginHandler<PluginToolResult>) => add(handlers.afterTool, handler),
        afterTask: (handler: PluginHandler<PluginTaskResult>) => add(handlers.afterTask, handler),
      }),
    });
    try { await this.runTimed(id, 'activate', () => plugin.activate(api)); }
    catch (error) {
      try { await plugin.deactivate?.(); } catch { /* Preserve the activation error. */ }
      throw error;
    }
    this.registrationCount += registrations;
    this.active.set(id, handlers);
  }

  async deactivate(id: string): Promise<void> {
    const active = this.active.get(id);
    if (!active) return;
    this.active.delete(id);
    this.registrationCount -= active.beforeTask.length + active.beforeTool.length + active.afterTool.length + active.afterTask.length;
    if (active.plugin.deactivate) await this.runTimed(id, 'deactivate', () => active.plugin.deactivate!());
  }

  async close(): Promise<void> {
    const ids = [...this.active.keys()].reverse();
    for (const id of ids) {
      try { await this.deactivate(id); }
      catch (error) { this.addProblems([`${id}: deactivate hook failed: ${String((error as Error)?.message ?? error)}`]); }
    }
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
    const handlers = [...this.active].flatMap(([id, active]) => active.beforeTask.map(handler => ({ id, handler })));
    const settled = await Promise.allSettled(handlers.map(({ id, handler }) => this.runTimed(id, 'beforeTask', () => handler(frozenCopy(context)))));
    const output: Array<{ id: string; context: string }> = [];
    let remaining = MAX_TASK_CONTEXT_BYTES;
    settled.forEach((result, index) => {
      const { id } = handlers[index]!;
      if (result.status === 'rejected') {
        this.addProblems([`${id}: beforeTask hook failed: ${String((result.reason as Error)?.message ?? result.reason)}`]);
        return;
      }
      if (typeof result.value !== 'string' || !result.value.trim() || remaining <= 0) return;
      const value = clipBytes(result.value.trim(), Math.min(4_000, remaining));
      remaining -= Buffer.byteLength(value, 'utf8');
      output.push({ id, context: value });
    });
    return output;
  }

  async beforeTool(context: PluginToolContext): Promise<void> {
    const handlers = [...this.active].flatMap(([id, active]) => active.beforeTool.map(handler => ({ id, handler })));
    const settled = await Promise.allSettled(handlers.map(({ id, handler }) => this.runTimed(id, 'beforeTool', () => handler(frozenCopy(context)))));
    const failures = settled.flatMap((result, index) => result.status === 'rejected'
      ? [`Plugin ${handlers[index]!.id} beforeTool hook failed; the tool was blocked: ${String((result.reason as Error)?.message ?? result.reason)}`]
      : typeof result.value === 'string' && result.value.trim()
        ? [`Plugin ${handlers[index]!.id} blocked ${context.tool}: ${result.value.trim().slice(0, 1_000)}`]
        : []);
    if (failures.length) throw new Error(failures.join('\n'));
  }

  async afterTool(context: PluginToolResult): Promise<void> {
    const handlers = [...this.active].flatMap(([id, active]) => active.afterTool.map(handler => ({ id, handler })));
    const settled = await Promise.allSettled(handlers.map(({ id, handler }) => this.runTimed(id, 'afterTool', () => handler(frozenCopy(context)))));
    settled.forEach((result, index) => {
      if (result.status === 'rejected') this.addProblems([`${handlers[index]!.id}: afterTool hook failed: ${String((result.reason as Error)?.message ?? result.reason)}`]);
    });
  }

  async afterTask(context: PluginTaskResult): Promise<void> {
    const handlers = [...this.active].flatMap(([id, active]) => active.afterTask.map(handler => ({ id, handler })));
    const settled = await Promise.allSettled(handlers.map(({ id, handler }) => this.runTimed(id, 'afterTask', () => handler(frozenCopy(context)))));
    settled.forEach((result, index) => {
      if (result.status === 'rejected') this.addProblems([`${handlers[index]!.id}: afterTask hook failed: ${String((result.reason as Error)?.message ?? result.reason)}`]);
    });
  }

  drainProblems(): string[] { return this.problems.splice(0); }

  private async runTimed<T>(id: string, hook: string, work: () => T | Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(work),
        new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${hook} hook exceeded ${HOOK_TIMEOUT_MS}ms`)), HOOK_TIMEOUT_MS); timer.unref(); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
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
