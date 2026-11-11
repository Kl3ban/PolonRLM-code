import { mkdir, readFile, writeFile, rename, lstat, cp, mkdtemp, readdir, unlink, rm, open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync, backup } from 'node:sqlite';
import { z } from 'zod';
import { AGENT_MODEL_ROLES, type Settings } from './types.js';
import { PROVIDER_PRESETS } from '../providers/provider.js';
import { isSecretEnvironmentName } from './secrets.js';

// Node timers clamp larger delays to 1 ms; zero continues to mean no timeout.
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const CURRENT_CONFIG_VERSION = 2;

// Keep stored configs readable for legacy recovery. New entries and connections use the stricter schema below.
const mcpServerSchema = z.object({
  type: z.enum(['stdio', 'http']), command: z.string().optional(), args: z.array(z.string()).optional(), url: z.url().optional(),
  env: z.record(z.string(), z.string()).optional(), headersEnv: z.record(z.string(), z.string()).optional(), timeoutMs: z.number().int().positive().optional(),
});
function validateMcpTransport(config: { type: 'stdio' | 'http'; command?: string; args?: string[]; url?: string; env?: Record<string, string>; headersEnv?: Record<string, string> }, context: z.RefinementCtx): void {
  if (config.type === 'stdio') {
    if (!config.command?.trim()) context.addIssue({ code: 'custom', path: ['command'], message: 'MCP stdio requires a non-empty command.' });
    if (config.url !== undefined) context.addIssue({ code: 'custom', path: ['url'], message: 'MCP stdio cannot use a URL.' });
    if (config.headersEnv !== undefined) context.addIssue({ code: 'custom', path: ['headersEnv'], message: 'MCP stdio uses env, not headersEnv.' });
  } else {
    if (!config.url) context.addIssue({ code: 'custom', path: ['url'], message: 'MCP HTTP requires a URL.' });
    if (config.command !== undefined) context.addIssue({ code: 'custom', path: ['command'], message: 'MCP HTTP cannot use a command.' });
    if (config.args !== undefined) context.addIssue({ code: 'custom', path: ['args'], message: 'MCP HTTP cannot use process arguments.' });
    if (config.env !== undefined) context.addIssue({ code: 'custom', path: ['env'], message: 'MCP HTTP uses headersEnv, not env.' });
  }
}
const secureMcpUrlSchema = z.url().refine(value => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && ![...url.searchParams.keys()].some(isSecretEnvironmentName);
  } catch { return false; }
}, 'MCP address must use HTTP(S). Pass secrets through headersEnv, not the URL.');
function hasInlineSecretArgument(args: string[] | undefined): boolean {
  if (!args) return false;
  const secretFlag = /^(?:--?|\/)(?:api[_-]?key|auth|authorization|access[_-]?token|token|secret|password|credential|cookie|bearer|private[_-]?key|signature|jwt)(?:$|[=:])/i;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (/^(?:--?|\/)(?:api[_-]?key|auth|authorization|access[_-]?token|token|secret|password|credential|cookie|bearer|private[_-]?key|signature|jwt)(?:=|:).+/i.test(argument)) return true;
    if (secretFlag.test(argument) && args[index + 1] !== undefined) return true;
    if (/^(?:proxy-)?authorization\s*:\s*.+/i.test(argument) || /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/i.test(argument)) return true;
  }
  return false;
}
export const secureMcpServerSchema = z.object({
  type: z.enum(['stdio', 'http']), command: z.string().optional(), args: z.array(z.string()).optional(), url: secureMcpUrlSchema.optional(),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).refine(values => Object.entries(values).every(([key, value]) => !isSecretEnvironmentName(key) || /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)), 'Pass MCP secrets as ${ENV_NAME}, not as plaintext.').optional(),
  headersEnv: z.record(z.string().regex(/^[A-Za-z0-9-]+$/), z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).optional(), timeoutMs: z.number().int().positive().optional(),
}).refine(config => !hasInlineSecretArgument(config.args), 'Pass MCP secrets through environment variables or headersEnv, not as process arguments.')
  .superRefine(validateMcpTransport);

const providerSchema = z.object({
  id: z.string().min(1), kind: z.enum(['openai', 'compatible', 'anthropic', 'google']),
  baseURL: z.url().refine(value => /^https?:\/\//.test(value), 'HTTP or HTTPS is required'), model: z.string(),
  apiKeyEnv: z.string().optional(), reasoning: z.string().min(1).max(48).regex(/^[A-Za-z0-9][A-Za-z0-9_. -]*$/).optional(),
  reasoningControl: z.enum(['effort', 'toggle', 'thinking-level', 'thinking-budget']).optional(),
  reasoningEfforts: z.array(z.string().min(1).max(32).regex(/^[A-Za-z0-9][A-Za-z0-9_. -]*$/)).max(16).optional(),
  temperature: z.number().min(0).max(2).optional(), inputPrice: z.number().nonnegative().optional(), outputPrice: z.number().nonnegative().optional(),
  contextWindow: z.number().int().positive().optional(), maxOutputTokens: z.number().int().positive().optional(), reasoningSupported: z.boolean().optional(), toolCalling: z.boolean().optional(), vision: z.boolean().optional(),
  requestTimeoutMs: z.number().int().nonnegative().max(MAX_TIMER_DELAY_MS).optional()
});
export const sandboxDomainSchema = z.string().min(1).max(253).regex(/^(?:\*\.)?[A-Za-z0-9.-]+(?::\d{1,5})?$/).refine(value => {
  const [host = '', port] = value.replace(/^\*\./, '').split(/:(?=\d+$)/, 2);
  if (!host || host.startsWith('.') || host.endsWith('.') || host.includes('..')) return false;
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return false;
  try { return new URL(`https://${host}`).hostname.toLowerCase() === host.toLowerCase(); } catch { return false; }
}, 'Enter a hostname or *.hostname with an optional port from 1 to 65535.');
const modelRouteSchema = z.object({ provider: z.string().min(1), model: z.string().trim().min(1).optional() });
const modelRoleBudgetSchema = z.object({ maxCalls: z.number().int().nonnegative().safe().optional(), maxTokens: z.number().int().nonnegative().safe().optional(), maxCost: z.number().nonnegative().optional() }).refine(value => Object.values(value).some(limit => limit !== undefined), 'Set at least one role budget limit.');
const trustedPluginSchema = z.object({ enabled: z.boolean(), sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional() }).strict();
export const settingsSchema = z.object({
  configVersion: z.literal(CURRENT_CONFIG_VERSION),
  provider: z.string(), providers: z.record(z.string(), providerSchema), fallback: z.array(z.string()),
  mode: z.enum(['PLAN', 'BUILD', 'REVIEW']), cortex: z.number().int().min(0).max(5), cortexStrategy: z.enum(['adaptive', 'fixed']).default('adaptive'),
  repeatFailureThreshold: z.number().int().min(0).max(20).default(3),
  maxSteps: z.number().int().nonnegative().safe(), maxInputTokens: z.number().int().nonnegative().safe(),
  maxOutputTokens: z.number().int().nonnegative().safe(), tokenBudget: z.preprocess(value => value === null ? 0 : value, z.number().int().nonnegative().safe().refine(value => value === 0 || value >= 1000, 'Minimum 1,000 or 0 for unlimited')),
  dollarBudget: z.number().nonnegative(), maxAgents: z.number().int().nonnegative().safe(), maxProcesses: z.number().int().nonnegative().safe(), maxDepth: z.number().int().min(-1).safe(),
  permissions: z.enum(['ask', 'workspace', 'readonly', 'all']), toolPermissions: z.record(z.string(), z.enum(['ask', 'auto', 'off'])).default({}), allowTools: z.array(z.string()), denyTools: z.array(z.string()),
  theme: z.enum(['dark', 'light']), toolOutputLimit: z.number().int().nonnegative().safe(), timeoutMs: z.number().int().nonnegative().max(MAX_TIMER_DELAY_MS),
  webSearchMode: z.preprocess(value => value === 'duckduckgo' ? 'auto' : value, z.enum(['auto', 'bing', 'brave', 'yahoo']).default('auto')),
  browserEngine: z.enum(['auto', 'chromium', 'chrome', 'edge', 'brave', 'firefox']).default('auto'),
  verificationCommands: z.array(z.string().trim().min(1)).default([]),
  verificationMode: z.enum(['manual', 'after_changes']).default('after_changes'),
  verificationRepairAttempts: z.number().int().min(0).max(3).default(1),
  agentToolProfiles: z.record(z.string().regex(/^(planner|coder|researcher|reviewer|tester|debugger)$/), z.array(z.string().min(1).max(100)).max(256).refine(names => new Set(names).size === names.length, 'Tool names must be unique.')).default({}),
  modelRoutes: z.partialRecord(z.enum(AGENT_MODEL_ROLES), modelRouteSchema).default({}),
  modelRoleBudgets: z.partialRecord(z.enum(AGENT_MODEL_ROLES), modelRoleBudgetSchema).default({}),
  plugins: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), trustedPluginSchema).default({}),
  sandboxMode: z.enum(['off', 'auto', 'required']).default('auto'),
  sandboxNetworkDomains: z.array(sandboxDomainSchema).max(256).refine(values => new Set(values).size === values.length, 'Sandbox domains must be unique.').default([]),
  mcp: z.record(z.string(), mcpServerSchema)
}).superRefine((settings, context) => {
  if (!Object.hasOwn(settings.providers, settings.provider)) context.addIssue({ code: 'custom', path: ['provider'], message: 'Selected provider is not configured.' });
  for (const [index, provider] of settings.fallback.entries()) {
    if (!Object.hasOwn(settings.providers, provider)) context.addIssue({ code: 'custom', path: ['fallback', index], message: `Fallback provider ${provider} is not configured.` });
  }
  for (const [role, route] of Object.entries(settings.modelRoutes)) {
    if (!Object.hasOwn(settings.providers, route.provider)) context.addIssue({ code: 'custom', path: ['modelRoutes', role, 'provider'], message: `Model route provider ${route.provider} is not configured.` });
  }
});
export function defaultSettings(): Settings {
  return { configVersion: CURRENT_CONFIG_VERSION, provider: 'openrouter', providers: structuredClone(PROVIDER_PRESETS), fallback: [], mode: 'BUILD', cortex: 1, cortexStrategy: 'adaptive', repeatFailureThreshold: 3,
    maxSteps: 0, maxInputTokens: 0, maxOutputTokens: 0, tokenBudget: 0, dollarBudget: 0,
    maxAgents: 0, maxProcesses: 0, maxDepth: -1, permissions: 'ask', toolPermissions: {}, allowTools: [], denyTools: [], theme: 'dark', toolOutputLimit: 0, timeoutMs: 0, webSearchMode: 'auto', browserEngine: 'auto', verificationCommands: [], verificationMode: 'after_changes', verificationRepairAttempts: 1, mcp: {}, agentToolProfiles: {}, modelRoutes: {}, modelRoleBudgets: {}, plugins: {}, sandboxMode: 'auto', sandboxNetworkDomains: [] };
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
const previousDefaultLimits: Record<string, number> = { maxSteps: 24, maxInputTokens: 32000, maxOutputTokens: 4096, tokenBudget: 200000, dollarBudget: 5, maxAgents: 3, maxDepth: 1, toolOutputLimit: 10000, timeoutMs: 120000 };
function migrateConfig(saved: unknown): unknown {
  if (!isRecord(saved)) return saved;
  const migrated = { ...saved };
  const version = Object.hasOwn(saved, 'configVersion') ? saved.configVersion : 1;
  if (version === 1) {
    for (const [key, previousDefault] of Object.entries(previousDefaultLimits)) {
      if (migrated[key] === previousDefault) migrated[key] = key === 'maxDepth' ? -1 : 0;
    }
    migrated.configVersion = CURRENT_CONFIG_VERSION;
  }
  return migrated;
}
function mergeProviderConfigs(saved: unknown): Record<string, unknown> {
  const merged: Record<string, unknown> = structuredClone(PROVIDER_PRESETS);
  if (!isRecord(saved)) return merged;
  for (const [id, value] of Object.entries(saved)) {
    merged[id] = isRecord(value) ? { ...(PROVIDER_PRESETS[id] ?? {}), ...value } : value;
  }
  return merged;
}
function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((item, index) => sameValue(item, right[index]));
  if (!isRecord(left) || !isRecord(right)) return false;
  const a = Object.keys(left), b = Object.keys(right);
  return a.length === b.length && a.every(key => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
}
function mergeChanged(base: unknown, desired: unknown, latest: unknown): unknown {
  if (sameValue(base, desired)) return structuredClone(latest);
  if (isRecord(desired) && isRecord(latest) && (base === undefined || isRecord(base))) {
    const original = isRecord(base) ? base : {};
    const result: Record<string, unknown> = { ...latest };
    for (const key of new Set([...Object.keys(original), ...Object.keys(desired)])) {
      if (!Object.hasOwn(desired, key)) { if (Object.hasOwn(original, key)) delete result[key]; continue; }
      if (!Object.hasOwn(original, key) || !sameValue(original[key], desired[key])) result[key] = mergeChanged(original[key], desired[key], latest[key]);
    }
    return result;
  }
  return structuredClone(desired);
}
function updateObjectInPlace(target: Record<string, any>, source: Record<string, unknown>): void {
  for (const key of Object.keys(target)) if (!Object.hasOwn(source, key)) delete target[key];
  for (const [key, value] of Object.entries(source)) {
    const current = target[key];
    if (Array.isArray(current) && Array.isArray(value)) current.splice(0, current.length, ...structuredClone(value));
    else if (isRecord(current) && isRecord(value)) updateObjectInPlace(current, value);
    else target[key] = structuredClone(value);
  }
}
export class ConfigManager {
  private saveQueue: Promise<void> = Promise.resolve();
  private baseline: Settings = defaultSettings();
  readonly home: string;
  readonly legacyHome?: string;
  migration?: { from: string; to: string };
  settings: Settings = defaultSettings();
  constructor(home?: string, environment: NodeJS.ProcessEnv = process.env) {
    const custom = home ?? environment.POLONRLM_HOME ?? environment.JANUSZGPT_HOME;
    const directory = environment.LOCALAPPDATA ?? path.join(os.homedir(), '.local', 'share');
    this.home = path.resolve(custom ?? path.join(directory, 'PolonRLM'));
    // An explicit home, including either environment override, always retains its own data path.
    if (custom === undefined) this.legacyHome = path.resolve(directory, 'JanuszGPT');
  }
  private async exists(target: string): Promise<boolean> {
    try { await lstat(target); return true; }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
  private async migrateLegacy(): Promise<void> {
    const legacy = this.legacyHome;
    if (!legacy || await this.exists(this.home) || !await this.exists(legacy)) return;
    const source = await lstat(legacy);
    if (!source.isDirectory() || source.isSymbolicLink()) throw new Error(`Migration requires a regular data directory: ${legacy}`);
    const parent = path.dirname(this.home);
    await mkdir(parent, { recursive: true });
    const stage = await mkdtemp(path.join(parent, '.PolonRLM-migrate-'));
    // Staging and publication stay within the selected app-data directory.
    if (path.dirname(stage) !== parent || !path.basename(stage).startsWith('.PolonRLM-migrate-')) throw new Error('Invalid migration directory.');
    try {
      const database = 'sessions.sqlite';
      const excluded = new Set([database, `${database}-wal`, `${database}-shm`, `${database}-journal`]);
      for (const entry of await readdir(legacy)) {
        await cp(path.join(legacy, entry), path.join(stage, entry), {
          recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true,
          filter: input => {
            const relative = path.relative(legacy, input);
            return !excluded.has(process.platform === 'win32' ? relative.toLowerCase() : relative);
          },
        });
      }
      const originalDatabase = path.join(legacy, database);
      if (await this.exists(originalDatabase)) {
        const databaseStat = await lstat(originalDatabase);
        if (!databaseStat.isFile() || databaseStat.isSymbolicLink()) throw new Error('Session database is not a regular file.');
        const original = new DatabaseSync(originalDatabase, { readOnly: true });
        try {
          original.exec('PRAGMA busy_timeout=5000');
          // SQLite's online backup includes committed WAL data in a consistent snapshot.
          // Copying the live database and sidecars separately could lose or corrupt history.
          await backup(original, path.join(stage, database));
        } finally { original.close(); }
        const snapshot = new DatabaseSync(path.join(stage, database), { readOnly: true });
        try {
          const check = snapshot.prepare('PRAGMA quick_check').all();
          if (check.length !== 1 || check[0]?.quick_check !== 'ok') throw new Error('SQLite backup verification failed.');
        } finally { snapshot.close(); }
      } else if (await this.exists(`${originalDatabase}-wal`) || await this.exists(`${originalDatabase}-journal`)) {
        throw new Error('Legacy directory contains a SQLite journal without a database file.');
      }
      try {
        const data = JSON.parse(await readFile(path.join(stage, 'config.json'), 'utf8'));
        const migrated = migrateConfig(data);
        settingsSchema.parse({ ...defaultSettings(), ...(isRecord(migrated) ? migrated : {}) });
      } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (await this.exists(this.home)) { await rm(stage, { recursive: true, force: true }); return; } // Another start or user-created destination owns its data.
      try { await rename(stage, this.home); }
      catch (error: unknown) {
        // A concurrent successful migration wins; never merge into or overwrite its home.
        if (await this.exists(this.home)) { await rm(stage, { recursive: true, force: true }); return; }
        throw error;
      }
      this.migration = { from: legacy, to: this.home };
    } catch (error: unknown) {
      // Keep failed staging for inspection. The original directory remains available for rollback.
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`JanuszGPT to PolonRLM migration failed. Stare dane: ${legacy}. Kopia robocza: ${stage}. ${reason}`);
    }
  }
  async load(): Promise<void> {
    await this.migrateLegacy();
    await mkdir(this.home, { recursive: true });
    try {
      const saved = migrateConfig(JSON.parse(await readFile(path.join(this.home, 'config.json'), 'utf8')));
      const config = isRecord(saved) ? saved : {};
      this.settings = settingsSchema.parse({ ...defaultSettings(), ...config, providers: mergeProviderConfigs(config.providers) });
    }
    catch (error: any) { if (error.code !== 'ENOENT') throw new Error(`Invalid configuration: ${error.message}`); }
    this.baseline = structuredClone(this.settings);
  }
  private async acquireSaveLock(lockFile: string): Promise<() => Promise<void>> {
    const token = randomUUID(), deadline = Date.now() + 30_000;
    while (true) {
      let lock;
      try {
        lock = await open(lockFile, 'wx', 0o600);
        await lock.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }), 'utf8'); await lock.sync(); await lock.close(); lock = undefined;
        return async () => {
          try { const owner = JSON.parse(await readFile(lockFile, 'utf8')); if (owner.token === token) await unlink(lockFile); }
          catch (error: any) { if (error.code !== 'ENOENT') throw error; }
        };
      } catch (error: any) {
        await lock?.close().catch(() => {});
        if (error.code !== 'EEXIST') { await unlink(lockFile).catch(() => {}); throw error; }
      }
      let stale = false;
      try {
        const owner = JSON.parse(await readFile(lockFile, 'utf8'));
        if (Number.isInteger(owner.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0); } catch (error: any) { stale = error.code === 'ESRCH'; }
        } else stale = Date.now() - (await lstat(lockFile)).mtimeMs > 5_000;
      } catch (error: any) {
        if (error.code === 'ENOENT') continue;
        try { stale = Date.now() - (await lstat(lockFile)).mtimeMs > 5_000; }
        catch (statError: any) { if (statError.code === 'ENOENT') continue; throw statError; }
      }
      if (stale) { await unlink(lockFile).catch((error: any) => { if (error.code !== 'ENOENT') throw error; }); continue; }
      if (Date.now() >= deadline) throw new Error('Timed out waiting for another process to save the configuration.');
      await new Promise(resolve => setTimeout(resolve, 25 + Math.floor(Math.random() * 35)));
    }
  }
  private async readCurrentSettings(target: string): Promise<Settings> {
    try {
      const saved = migrateConfig(JSON.parse(await readFile(target, 'utf8')));
      const config = isRecord(saved) ? saved : {};
      return settingsSchema.parse({ ...defaultSettings(), ...config, providers: mergeProviderConfigs(config.providers) });
    } catch (error: any) {
      if (error.code === 'ENOENT') return defaultSettings();
      throw new Error(`Invalid configuration while saving: ${error.message}`);
    }
  }
  async save(): Promise<void> {
    const requested = settingsSchema.parse(structuredClone(this.settings));
    const operation = this.saveQueue.then(async () => {
      const target = path.join(this.home, 'config.json');
      await mkdir(this.home, { recursive: true });
      const release = await this.acquireSaveLock(`${target}.lock`);
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      try {
        const latest = await this.readCurrentSettings(target);
        const merged = settingsSchema.parse(mergeChanged(this.baseline, requested, latest));
        const snapshot = JSON.stringify(merged, null, 2);
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(snapshot, 'utf8'); await file.sync(); } finally { await file.close(); }
        await rename(temporary, target);
        updateObjectInPlace(this.settings as any, merged as any);
        this.baseline = structuredClone(merged);
      } finally {
        await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
        await release();
      }
    });
    this.saveQueue = operation.catch(() => {});
    return operation;
  }
}
