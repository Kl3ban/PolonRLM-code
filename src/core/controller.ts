import type { AgentQuestion } from './workflows.js';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { z } from 'zod';
import type { Approve, LLMProvider, ModelInfo, RuntimeEvent, UIController, UIState, ViewMessage, Settings, ProviderConfig, ImageAttachment, ToolSpec } from './types.js';
import { imageFromBuffer, loadUserImage } from './images.js';
import { ConfigManager, secureMcpServerSchema, settingsSchema } from './config.js';
import { SessionStore } from './store.js';
import { RecoveryCipher } from './recovery.js';
import { SecretVault, isSecretEnvironmentName, redact, registerSecret, safeText } from './secrets.js';
import { Permissions } from './permissions.js';
import { Workspace } from '../tools/workspace.js';
import { ToolRegistry } from '../tools/registry.js';
import { registerBuiltins } from '../tools/builtin.js';
import { SkillsManager } from '../integrations/skills.js';
import { MCPManager, mcpConfigPreview } from '../integrations/mcp.js';
import { createProvider, providerConfigForModel, PROVIDER_PRESETS } from '../providers/provider.js';
import { effortChoices, findEffortChoice, normalizeEffort } from '../providers/reasoning.js';
import { AgentRuntime, createRunBudget } from './runtime.js';
import { compactMessages, estimateTokens, clip } from './context.js';
import { CORTEX } from './cortex.js';
import { formatLimit, formatTokenBudget, parseTokenBudget, parseUnlimitedLimit, tokenBudgetMaximum } from './budget.js';
import { SETTINGS_FIELDS } from './settings-fields.js';
import { describeToolCall } from './tool-display.js';
import { formatEvidenceTimeline } from './evidence.js';
import { discoverVerificationPlan, affectedDependents, formatVerificationHistory, formatVerificationReport, hashWorkspaceFiles, makeVerificationReport, parseGitStatusPaths, type VerificationCheck, type VerificationDiagnostic, type VerificationStatus } from './verification.js';
import { SandboxExecutor } from '../tools/sandbox.js';
import { PluginManager } from '../plugins/manager.js';

export const HELP = `/goal [--tokens N] <goal> | status | pause | resume | clear
/grill-me <task> | off            Ask one question at a time
/plan <task> | /build <task> | /review <task>
/retry                            Retry the last task
/connect [provider] [BaseURL]     Set provider and endpoint
/fallback [provider ...|none]    Set ordered fallback providers
/key <key>                        Save API key securely with Windows DPAPI
/models [provider]                Fetch models from an endpoint
/model <id|number>                Change model without restarting
/route [role provider [model]]    Route agent roles to a provider and model
/effort [value]                   Choose an effort supported by the current model
/image <path>|clear               Attach an image to the next message or clear attachments
/tools [filter]                   Show available AI tools
/timeline [count]                 Review recorded model, tool, and verification evidence
/verify [command|reproduce <command>|repair [attempts]|history [count]|report <id>] Verify project checks and inspect saved evidence
/recover [rollback <id>]         Inspect unfinished changes or safely restore one change group
/history changes [count]         Browse persistent file change history
/rollback <change-or-group-id>   Restore saved file changes after hash checks
/settings [name] [value]          Settings and budgets
/sandbox [status|on|off|auto|docker|setup [confirm|docker]] Show readiness, switch isolation, or configure Windows/Docker isolation
/budget [tokens] [USD]            Set the next task's budget
/settings provider.<field> <value> Reasoning, request timeout, temperature, pricing, and capabilities
/agents                           List subagents and limits
/steer <id> <message>             Steer an active subagent
/skills [list|install|enable|disable|remove|update|show|create]
/mcp [list|add|connect|disconnect|remove]
/plugins [list|create|show|enable|disable|remove]
/mode [PLAN|BUILD|REVIEW]          Tab changes mode; Ctrl+P opens commands
/cortex [0-5]                     Set maximum work level; /settings cortexStrategy toggles adaptive selection
/sessions [search]                Search project conversation history
/copy [user|ai|last]               Copy a message; /copy alone opens a picker
/new                              Start a new conversation
/resume [id or prefix]             Resume a conversation
/export <file.md>                  Export the full conversation history
/context                          Estimate context size
/compact [model]                    Compact locally or with one explicit model summary
/cost                             Tokens and known costs
/status                           Current configuration
/permissions [list]               Show effective tool permissions
/permissions all                  Automatically approve every tool
/permissions <tool> ask|auto|off|default  Set or clear a tool rule
/permissions [ask|workspace|readonly|reset]
/permissions [allow|deny|undeny] <tool>  Legacy allow and deny lists
/undo                             Undo the last file change
/memory [forget <name>]            Saved procedures
/forget <id>                      Delete a session and its history
/cancel                           Cancel the task
/clear                            Clear the view
/exit                             Exit`;
const MODEL_METADATA = ['contextWindow', 'maxOutputTokens', 'reasoningSupported', 'reasoningControl', 'reasoningEfforts', 'toolCalling', 'vision', 'inputPrice', 'outputPrice'] as const;
const MAX_IMAGES_PER_TASK = 5;
function updateModel(provider: ProviderConfig, id: string, metadata?: ModelInfo): void {
  if (provider.model !== id) delete provider.reasoning;
  for (const key of MODEL_METADATA) {
    delete provider[key];
    const value = key === 'reasoningSupported' ? metadata?.reasoning : metadata?.[key as keyof ModelInfo];
    if (value !== undefined) (provider as any)[key] = value;
  }
  provider.model = id;
}
function outputLimit(configured: number, provider?: ProviderConfig): number {
  return configured > 0 ? Math.min(configured, provider?.maxOutputTokens ?? configured) : provider?.maxOutputTokens ?? 0;
}
function contextLimit(configuredInput: number, configuredOutput: number, provider?: ProviderConfig): number {
  const appLimit = configuredInput > 0 ? configuredInput : Infinity;
  const modelLimit = provider?.contextWindow === undefined ? Infinity : provider.contextWindow - outputLimit(configuredOutput, provider);
  return Math.max(0, Math.min(appLimit, modelLimit));
}
function contextLimitSource(configuredInput: number, configuredOutput: number, provider?: ProviderConfig): UIState['contextLimitSource'] {
  const appLimit = configuredInput > 0 ? configuredInput : Infinity;
  const modelLimit = provider?.contextWindow === undefined ? Infinity : provider.contextWindow - outputLimit(configuredOutput, provider);
  if (!Number.isFinite(appLimit) && !Number.isFinite(modelLimit)) return 'unknown';
  if (appLimit === modelLimit) return 'both';
  return appLimit < modelLimit ? 'app' : 'model';
}
function displayLimit(name: string, value: number): string {
  return formatLimit(value, name === 'maxDepth' ? -1 : 0);
}
function displayCostLimit(value: number): string { return value === 0 ? 'unlimited cost' : `$${value}`; }

export class Controller implements UIController {
  private events = new EventEmitter();
  private questionAnswer?: (answer: string | null) => void;
  answerQuestion(answer: string | null): void { this.questionAnswer?.(answer); }
  private askQuestion(question: AgentQuestion, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const done = (answer: string | null) => { cleanup(); answer === null ? reject(new Error('Question dismissed by user.')) : resolve(answer); };
      const abort = () => { cleanup(); reject(signal.reason ?? new Error('Question cancelled.')); };
      const cleanup = () => { signal.removeEventListener('abort', abort); this.questionAnswer = undefined; delete this.state.question; this.notify(); };
      this.questionAnswer = done; this.state.question = question; signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort(); else this.notify();
    });
  }
  private state!: UIState;
  private store!: SessionStore;
  private vault!: SecretVault;
  private recoveryCipher!: RecoveryCipher;
  private permissions!: Permissions;
  private workspace!: Workspace;
  private registry!: ToolRegistry;
  private sandbox!: SandboxExecutor;
  private plugins!: PluginManager;
  private skills!: SkillsManager;
  private mcp!: MCPManager;
  private runtime!: AgentRuntime;
  private session!: string;
  private abort?: AbortController;
  private models: ModelInfo[] = [];
  private closing = false;
  private closeOperation?: Promise<void>;
  private active?: Promise<void>;
  private providers = new Map<string, LLMProvider>();
  private pendingImages: ImageAttachment[] = [];
  onEvent?: (event: RuntimeEvent) => void;
  integrityCheck(): string { return this.store.integrityCheck(); }
  private constructor(readonly config: ConfigManager) {}
  static async open(root: string, home?: string, overrides: Partial<Settings> = {}): Promise<Controller> {
    const config = new ConfigManager(home); await config.load();
    Object.assign(config.settings, settingsSchema.parse({ ...config.settings, ...overrides }));
    for (const id of [config.settings.provider, ...config.settings.fallback]) {
      if (!Object.hasOwn(config.settings.providers, id)) throw new Error(`Unknown provider ${id}. Use /connect.`);
    }
    const controller = new Controller(config); await controller.initialize(root);
    if (controller.store.recoveryBackupPath) {
      controller.note(`The chat database failed its integrity check. A fresh database is ready. The old database files were kept as ${path.basename(controller.store.recoveryBackupPath)}.`);
    }
    return controller;
  }
  private async initialize(root: string): Promise<void> {
    const settings = this.config.settings;
    this.permissions = new Permissions(settings); this.workspace = await Workspace.open(root, this.permissions);
    this.store = new SessionStore(this.config.home); this.recoveryCipher = await RecoveryCipher.open(this.config.home); this.workspace.attachRecovery(this.store, this.recoveryCipher); this.vault = new SecretVault(this.config.home);
    for (const [name, value] of Object.entries(process.env)) if (isSecretEnvironmentName(name)) registerSecret(value);
    const credentialWarnings: string[] = [];
    for (const provider of Object.values(settings.providers)) {
      try { await this.vault.get(provider.id, provider.apiKeyEnv); }
      catch { credentialWarnings.push(`Could not read the key ${provider.id}. Select the provider and save the key again.`); }
    }
    this.skills = new SkillsManager(this.config.home, this.workspace.root); this.mcp = new MCPManager(settings.mcp);
    this.registry = new ToolRegistry(this.permissions, () => settings.toolOutputLimit); this.sandbox = new SandboxExecutor(settings, this.workspace.root);
    registerBuiltins(this.registry, this.workspace, settings, { sandbox: this.sandbox, store: this.store });
    this.registry.onClose(() => this.sandbox.close());
    this.session = this.store.create(this.workspace.root);
    this.state = { workspace: this.workspace.root, sessionId: this.session, provider: settings.provider, model: settings.providers[settings.provider]?.model ?? '', mode: settings.mode, cortex: settings.cortex,
      busy: false, status: 'Ready', messages: [], usage: this.store.usage(this.session), taskUsage: { input: 0, output: 0, cached: 0, cost: 0, costKnown: true },
      agents: [], attachments: [], contextTokens: 0, contextLimit: contextLimit(settings.maxInputTokens, settings.maxOutputTokens, settings.providers[settings.provider]), contextLimitSource: contextLimitSource(settings.maxInputTokens, settings.maxOutputTokens, settings.providers[settings.provider]), tokenLimit: settings.tokenBudget, dollarLimit: settings.dollarBudget,
      vision: settings.providers[settings.provider]?.vision, theme: settings.theme };
    this.plugins = new PluginManager(this.config.home);
    const pluginWarnings = await this.plugins.loadEnabled(settings.plugins);
    for (const { pluginId, definition } of this.plugins.toolDefinitions()) {
      if (this.registry.getSpec(definition.name)) { pluginWarnings.push(`Plugin ${pluginId} tool ${definition.name} was skipped because a tool with that name already exists.`); continue; }
      try {
        const pluginSchema = z.fromJSONSchema(definition.parameters as never);
        this.registry.add(definition.name, `[plugin ${pluginId}] ${definition.description}`, pluginSchema, definition.readOnly === true, async (args, context) => this.plugins!.callTool(pluginId, definition.name, args, {
          sessionId: context.sessionId ?? this.session, workspace: this.workspace.root, task: '', role: 'main', mode: context.mode, tool: definition.name, arguments: args,
        }));
      } catch (error) {
        pluginWarnings.push(`Plugin ${pluginId} tool ${definition.name} could not be registered: ${String((error as Error)?.message ?? error)}`);
      }
    }
    this.runtime = new AgentRuntime(settings, this.store, this.registry, this.workspace, this.skills, this.mcp, (id, model) => this.provider(id, true, model), event => this.event(event), undefined, this.sandbox, this.plugins);
    const cliQuestion = this.runtime.askQuestion;
    this.runtime.askQuestion = (question, signal) => this.events.listenerCount('change') ? this.askQuestion(question, signal) : cliQuestion(question, signal);
    for (const warning of credentialWarnings) this.note(warning, 'error');
    for (const warning of pluginWarnings) this.note(`Plugin: ${warning}`, 'error');
  }
  snapshot(): UIState { return { ...this.state, messages: [...this.state.messages], agents: this.state.agents.map(agent => ({ ...agent, changedFiles: agent.changedFiles ? [...agent.changedFiles] : undefined })), usage: { ...this.state.usage }, taskUsage: { ...this.state.taskUsage }, attachments: this.pendingImages.map(image => ({ name: image.name ?? 'image', mediaType: image.mediaType, bytes: Buffer.from(image.data, 'base64').length })) }; }
  subscribe(listener: () => void): () => void { this.events.on('change', listener); return () => this.events.off('change', listener); }
  setApprover(approve: Approve): void { this.permissions.approve = approve; }
  private async persistSettings(rollback: () => void): Promise<void> {
    try { await this.config.save(); } catch (error) { rollback(); throw error; }
  }
  async listModels(providerId = this.config.settings.provider): Promise<ModelInfo[]> {
    if (this.state.busy || this.closing) throw new Error('Wait for the task to finish.');
    const models = await (await this.provider(providerId, false)).listModels();
    if (providerId === this.config.settings.provider) this.models = models;
    return structuredClone(models);
  }
  listProviders(): { id: string; url: string; model: string }[] {
    const providers = new Map(Object.entries(PROVIDER_PRESETS));
    for (const provider of Object.values(this.config.settings.providers)) providers.set(provider.id, provider);
    return [...providers.values()].map(provider => ({ id: provider.id, url: provider.baseURL, model: provider.model }));
  }
  listEfforts(): { id: string; label: string; detail?: string }[] {
    const provider = this.config.settings.providers[this.config.settings.provider]!;
    const current = normalizeEffort(provider.reasoning ?? 'auto');
    return effortChoices(provider, this.models.find(model => model.id === provider.model)).map(option => ({
      id: option.id, label: option.label,
      detail: option.id === current ? 'Current' : option.detail,
    }));
  }
  async setEffort(value: string): Promise<void> {
    if (this.state.busy || this.closing) throw new Error('Change the reasoning effort before starting a task.');
    const provider = this.config.settings.providers[this.config.settings.provider]!;
    const options = effortChoices(provider, this.models.find(model => model.id === provider.model));
    const selected = findEffortChoice(options, value);
    if (!selected) throw new Error(`"${value}" is not available for ${provider.model || 'the selected model'}. Choices: ${options.map(option => option.id).join(', ')}.`);
    const previous = provider.reasoning;
    if (selected.id === 'auto') delete provider.reasoning;
    else provider.reasoning = selected.id;
    try { await this.persistSettings(() => { if (previous === undefined) delete provider.reasoning; else provider.reasoning = previous; }); }
    catch (error) { this.sync(); throw error; }
    this.providers.clear(); this.sync();
  }
  async selectProvider(id: string): Promise<void> {
    if (this.state.busy || this.closing) throw new Error('Wait for the task to finish.');
    const settings = this.config.settings;
    const existing = Object.hasOwn(settings.providers, id) ? settings.providers[id] : undefined;
    const preset = Object.hasOwn(PROVIDER_PRESETS, id) ? PROVIDER_PRESETS[id] : undefined;
    if (!existing && !preset) throw new Error('Unknown provider.');
    const previousProvider = settings.provider, previousFallback = settings.fallback, previousModels = this.models, previousProviders = new Map(this.providers);
    if (!existing) settings.providers[id] = structuredClone(preset!);
    settings.provider = id; settings.fallback = settings.fallback.filter(provider => provider !== id); this.models = []; this.providers.clear();
    await this.persistSettings(() => {
      settings.provider = previousProvider;
      settings.fallback = previousFallback;
      if (!existing) delete settings.providers[id];
      this.models = previousModels; this.providers = previousProviders;
    });
    this.sync();
  }
  async setApiKey(key: string): Promise<void> {
    if (this.state.busy || this.closing) throw new Error('Wait for the task to finish.');
    if (!key.trim()) throw new Error('Paste an API key.');
    await this.vault.set(this.config.settings.provider, key.trim());
    this.providers.clear();
  }
  async configureProvider(provider: ProviderConfig, apiKey?: string): Promise<void> {
    if (this.state.busy || this.closing) throw new Error('Wait for the task to finish.');
    const settings = this.config.settings;
    const previousFallback = settings.fallback;
    const parsed = settingsSchema.parse({ ...settings, provider: provider.id, fallback: settings.fallback.filter(id => id !== provider.id), providers: { ...settings.providers, [provider.id]: provider } });
    const next = parsed.providers[provider.id]!;
    const previousProvider = settings.provider;
    const previousConfig = settings.providers[next.id];
    settings.providers[next.id] = next;
    settings.provider = next.id;
    settings.fallback = parsed.fallback;
    let configSaved = false;
    try {
      await this.config.save(); configSaved = true;
      if (apiKey?.trim()) await this.vault.set(next.id, apiKey.trim());
    }
    catch (error) {
      settings.provider = previousProvider;
      settings.fallback = previousFallback;
      if (previousConfig) settings.providers[next.id] = previousConfig;
      else delete settings.providers[next.id];
      if (configSaved) {
        try { await this.config.save(); }
        catch (rollbackError) { throw new Error(`Could not save the key or roll back the configuration: ${error instanceof Error ? error.message : String(error)}; rollback: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`); }
      }
      throw error;
    }
    this.models = [];
    this.providers.clear();
    this.sync();
  }
  /** CLI overrides update runtime and UI together without persisting unless requested. */
  async setModel(id: string, persist = false): Promise<void> {
    if (this.state.busy || this.closing) throw new Error('Cannot change the model while a task is running or the app is closing.');
    id = id.trim(); if (!id) throw new Error('Model ID cannot be empty.');
    const provider = this.config.settings.providers[this.config.settings.provider]!;
    const previous = { ...provider }, previousProviders = new Map(this.providers);
    updateModel(provider, id, this.models.find(model => model.id === id));
    this.providers.clear();
    if (persist) await this.persistSettings(() => {
      for (const key of ['model', 'reasoning', ...MODEL_METADATA] as const) {
        if (previous[key] === undefined) delete provider[key]; else (provider as any)[key] = previous[key];
      }
      this.providers = previousProviders;
    });
    this.sync();
  }
  listSessions(query = ''): { id: string; title: string; updated: number }[] { return this.store.list(this.workspace.root, query); }
  renameSession(id: string, title: string): void { this.store.rename(id, this.workspace.root, title); this.notify(); }
  async setBudgets(tokenLimit: number, dollarLimit: number): Promise<void> {
    if (this.state.busy || this.closing) throw new Error('Change the budget before the next task.');
    const next = settingsSchema.parse({ ...this.config.settings, tokenBudget: parseTokenBudget(tokenLimit), dollarBudget: parseUnlimitedLimit(dollarLimit) });
    const previousTokenLimit = this.config.settings.tokenBudget, previousDollarLimit = this.config.settings.dollarBudget;
    this.config.settings.tokenBudget = next.tokenBudget; this.config.settings.dollarBudget = next.dollarBudget;
    await this.persistSettings(() => { this.config.settings.tokenBudget = previousTokenLimit; this.config.settings.dollarBudget = previousDollarLimit; });
    this.sync();
  }
  readSettings(): ReturnType<NonNullable<UIController['readSettings']>> {
    const settings = this.config.settings;
    return { values: Object.fromEntries(SETTINGS_FIELDS.map(field => [field.key, ['browserOptions', 'verificationCommands', 'sandboxNetworkDomains', 'fallback', 'agentToolProfiles', 'modelRoutes', 'modelRoleBudgets'].includes(field.key) ? JSON.stringify(settings[field.key as 'browserOptions' | 'verificationCommands' | 'sandboxNetworkDomains' | 'fallback' | 'agentToolProfiles' | 'modelRoutes' | 'modelRoleBudgets']) : settings[field.key as keyof Settings] as string | number])),
      tools: this.registry.discovery(settings.mode).map(tool => ({ name: tool.name, description: tool.description, available: tool.available, policy: settings.toolPermissions[tool.name] ?? 'default' })) };
  }
  async updateSetting(name: string, value: string | number): Promise<void> {
    if (this.state.busy || this.closing) throw new Error('Stop the task before changing settings.');
    const settings = this.config.settings;
    if (name.startsWith('tool.')) {
      const tool = name.slice(5);
      if (!this.registry.getSpec(tool) || !['default', 'ask', 'auto', 'off'].includes(String(value))) throw new Error('Invalid tool rule.');
      const previous = settings.toolPermissions;
      settings.toolPermissions = { ...previous };
      if (value === 'default') delete settings.toolPermissions[tool]; else settings.toolPermissions[tool] = value as 'ask' | 'auto' | 'off';
      try { await this.config.save(); } catch (error) { settings.toolPermissions = previous; throw error; }
    } else {
      if (!SETTINGS_FIELDS.some(field => field.key === name)) throw new Error('Unknown setting.');
      const key = name as keyof Settings;
      let parsedInput: unknown = value;
      if (['browserOptions', 'verificationCommands', 'sandboxNetworkDomains', 'fallback', 'agentToolProfiles', 'modelRoutes', 'modelRoleBudgets'].includes(name) && typeof value === 'string') {
        try { parsedInput = JSON.parse(value); }
        catch { throw new Error(`${name} must be valid JSON.`); }
      }
      const parsedValue = ['browserOptions', 'verificationCommands', 'sandboxNetworkDomains', 'fallback', 'agentToolProfiles', 'modelRoutes', 'modelRoleBudgets'].includes(name) ? parsedInput : name === 'tokenBudget' ? parseTokenBudget(value)
        : name === 'repeatFailureThreshold' ? parseUnlimitedLimit(value, 0)
        : name === 'verificationRepairAttempts' ? Number(value)
        : SETTINGS_FIELDS.some(field => field.key === name && field.section === 'limits') ? parseUnlimitedLimit(value, name === 'maxDepth' ? -1 : 0) : value;
      if (name === 'fallback' && Array.isArray(parsedValue) && parsedValue.every(item => typeof item === 'string')) {
        const providers = parsedValue as string[];
        if (new Set(providers).size !== providers.length) throw new Error('Fallback providers must be unique and keep their listed order.');
        if (providers.includes(settings.provider)) throw new Error('The selected provider cannot also be a fallback provider.');
      }
      const parsed = settingsSchema.safeParse({ ...settings, [name]: parsedValue });
      if (!parsed.success) {
        const issue = parsed.error.issues[0]!;
        throw new Error(issue.code === 'too_small' ? `Minimum value: ${issue.minimum}.` : issue.code === 'too_big' ? `Maximum value: ${issue.maximum}.` : 'Invalid setting value. Check the number or choose an available option.');
      }
      const candidate = parsed.data;
      const previous = settings[key];
      Object.assign(settings, { [key]: candidate[key] });
      try { await this.config.save(); } catch (error) { Object.assign(settings, { [key]: previous }); throw error; }
      this.providers.clear();
    }
    this.sync();
  }
  async addImagePath(filename: string): Promise<void> {
    if (this.state.busy || this.pendingImages.length >= MAX_IMAGES_PER_TASK) throw new Error(this.state.busy ? 'Add attachments before submitting the task.' : `Up to ${MAX_IMAGES_PER_TASK} images per message.`);
    const resolved = path.resolve(this.workspace.root, filename);
    this.pendingImages.push(await loadUserImage(resolved)); this.notify();
  }
  addImageData(data: string, name = 'Screenshot.png'): void {
    if (this.state.busy || this.pendingImages.length >= MAX_IMAGES_PER_TASK) throw new Error(this.state.busy ? 'Add attachments before submitting the task.' : `Up to ${MAX_IMAGES_PER_TASK} images per message.`);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw new Error('The clipboard does not contain a valid image.');
    this.pendingImages.push(imageFromBuffer(Buffer.from(data, 'base64'), name)); this.notify();
  }
  removeImage(index: number): void { if (!Number.isInteger(index) || index < 0 || index >= this.pendingImages.length) return; this.pendingImages.splice(index, 1); this.notify(); }
  clearImages(): void { this.pendingImages = []; this.notify(); }
  stopAgent(id: string): void { this.runtime.cancelAgent(id); this.state.agents = this.runtime.agents.map(agent => ({ ...agent, changedFiles: agent.changedFiles ? [...agent.changedFiles] : undefined })); this.notify(); }
  steerAgent(id: string, message: string): void { this.note(redact(this.runtime.steerAgent(id, redact(message)))); this.state.agents = this.runtime.agents.map(agent => ({ ...agent, changedFiles: agent.changedFiles ? [...agent.changedFiles] : undefined })); this.notify(); }
  resumeSession(id?: string): void {
    if (this.state.busy || this.closing) throw new Error('Wait for the task to finish before resuming a session.');
    id ||= this.store.list(this.workspace.root).find(session => session.id !== this.session && this.store.messages(session.id).length > 0)?.id;
    if (id && !this.store.exists(id, this.workspace.root)) {
      const matches = this.store.list(this.workspace.root).filter(session => session.id.startsWith(id!));
      if (matches.length === 1) id = matches[0]!.id;
      else if (matches.length > 1) throw new Error('This prefix matches multiple sessions. Copy a longer ID from /sessions.');
    }
    if (!id || !this.store.exists(id, this.workspace.root)) throw new Error('No session was found for this project. Use /sessions.');
    this.session = id; this.state.sessionId = id; this.state.agents = [];
    const restored = this.store.messages(id);
    const toolDetails = new Map(restored.flatMap(message => (message.toolCalls ?? []).map(call => [call.id, describeToolCall(call.name, call.arguments)] as const)));
    this.state.messages = restored.flatMap((message): ViewMessage[] => {
      if (message.role === 'tool') return [{ role: 'tool', text: '', toolCallId: message.toolCallId, toolName: message.name ?? 'tool', toolDetail: toolDetails.get(message.toolCallId ?? ''), toolState: message.isError ? 'error' as const : 'done' as const, toolOutput: safeText(message.content), toolDurationMs: message.toolDurationMs }];
      if (message.role === 'assistant' && !message.content && message.toolCalls?.length) return [];
      return [{ role: message.role, text: safeText(message.content), ...(message.role === 'assistant' ? { speaker: message.model ?? this.state.model } : {}) }];
    });
    this.state.usage = this.store.usage(id); this.state.taskUsage = { input: 0, output: 0, cached: 0, cost: 0, costKnown: true }; this.note(`Wznowiono ${id}.`);
  }
  private notify(): void { this.events.emit('change'); }
  private note(text: string, role = 'system'): void { this.state.messages.push({ role, text: safeText(text) }); this.notify(); }
  private event(event: RuntimeEvent): void {
    if (event.type === 'text') {
      const previous = this.state.messages.at(-1);
      if (previous?.role === 'assistant') {
        previous.text = safeText(previous.text + (event.text ?? ''));
        previous.speaker = event.model ?? previous.speaker ?? this.state.model;
      } else this.state.messages.push({ role: 'assistant', text: safeText(event.text ?? ''), speaker: event.model ?? this.state.model });
    } else if (event.type === 'tool') {
      let index = event.id ? this.state.messages.findLastIndex(message => message.toolCallId === event.id) : -1;
      if (event.state === 'running' || index < 0) {
        this.state.messages.push({ role: 'tool', text: '', toolCallId: event.id, toolName: event.name ?? 'tool', toolDetail: event.toolDetail, toolState: event.state === 'running' ? 'running' : event.state === 'error' ? 'error' : 'done', agentRole: event.agentRole, ...(event.state !== 'running' ? { toolOutput: safeText(event.text ?? ''), toolOutputTruncated: event.truncated, toolDurationMs: event.durationMs } : {}) });
      } else {
        this.state.messages[index] = { ...this.state.messages[index]!, role: 'tool', text: '', toolCallId: event.id, toolName: event.name ?? this.state.messages[index]!.toolName ?? 'tool', toolDetail: event.toolDetail ?? this.state.messages[index]!.toolDetail, toolState: event.state === 'error' ? 'error' : 'done', agentRole: event.agentRole ?? this.state.messages[index]!.agentRole, toolOutput: safeText(event.text ?? ''), toolOutputTruncated: event.truncated, toolDurationMs: event.durationMs };
      }
    }
    else if (event.type === 'status') { this.state.status = event.text ?? ''; if (event.contextTokens !== undefined) this.state.contextTokens = event.contextTokens; }
    else if (event.type === 'usage') { this.state.usage = this.store.usage(this.session); if (event.usage) this.state.taskUsage = { ...event.usage }; }
    else if (event.type === 'agent') this.state.agents = this.runtime.agents.map(agent => ({ ...agent, changedFiles: agent.changedFiles ? [...agent.changedFiles] : undefined }));
    this.onEvent?.(event); this.notify();
  }
  private async provider(id = this.config.settings.provider, requireKey = true, modelOverride?: string): Promise<LLMProvider> {
    const configured = this.config.settings.providers[id]; if (!configured) throw new Error(`Unknown provider ${id}. Use /connect.`);
    const config = providerConfigForModel(configured, modelOverride);
    const key = await this.vault.get(config.id, config.apiKeyEnv);
    if (requireKey && !key && !['ollama', 'lmstudio', 'vllm', 'custom'].includes(config.id) && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/)/.test(config.baseURL)) throw new Error(`API key is missing: /key <key> or environment variable ${config.apiKeyEnv ?? 'API'}.`);
    const cacheKey = `${id}:${JSON.stringify(config)}:${key ?? ''}:${this.config.settings.maxOutputTokens}`;
    let result = this.providers.get(cacheKey); if (!result) { result = createProvider(config, key, this.config.settings.maxOutputTokens); this.providers.set(cacheKey, result); }
    return result;
  }
  async submit(text: string): Promise<void> {
    text = text.trim(); if (this.closing || (!text && !this.pendingImages.length)) return;
    if (!text) text = 'Describe the attached image.';
    if (text.startsWith('/')) { try { await this.command(text); } catch (error: any) { this.note(redact(error.message), 'error'); } return; }
    if (this.state.busy) { this.note('The agent is working. Use /cancel to stop the task.'); return; }
    const visionRoute = this.config.settings.modelRoutes.orchestrator;
    const visionPrimaryId = visionRoute?.provider ?? this.config.settings.provider;
    const visionPrimary = this.config.settings.providers[visionPrimaryId];
    const visionCandidates = [
      ...(visionPrimary ? [providerConfigForModel(visionPrimary, visionRoute?.model)] : []),
      ...this.config.settings.fallback.map(id => this.config.settings.providers[id]).filter((provider): provider is ProviderConfig => provider !== undefined),
    ];
    if (this.pendingImages.length && !visionCandidates.some(provider => provider.vision !== false)) { this.note('The selected model and all fallback models do not support images. Choose a model or vision fallback that does, or use /image clear.', 'error'); return; }
    const images = this.pendingImages; this.pendingImages = [];
    this.state.taskUsage = { input: 0, output: 0, cached: 0, cost: 0, costKnown: true };
    this.state.agents = [];
    this.state.busy = true; this.abort = new AbortController(); this.note(redact(text) + (images.length ? '\n[Attached: ' + images.map(image => image.name ?? 'Image').join(', ') + ']' : ''), 'user');
    this.active = (async () => {
      try {
        let task = text; const startUsage = this.store.usage(this.session);
        for (let continuation = 0; ; continuation++) {
          const before = this.store.usage(this.session); const goalBefore = this.store.workflow(this.session).goal;
          const originalBudget = this.config.settings.tokenBudget; const originalDollarBudget = this.config.settings.dollarBudget;
          if (goalBefore?.status === 'active') {
            const spent = this.store.usage(this.session).cost - startUsage.cost;
            if (originalDollarBudget > 0 && spent >= originalDollarBudget) { this.note('Goal stopped at dollar budget.'); break; }

            const remaining = tokenBudgetMaximum(goalBefore.tokenBudget) - goalBefore.usedTokens;
            if (remaining < 1000) { goalBefore.status = 'limit'; const w = this.store.workflow(this.session); w.goal = goalBefore; this.store.saveWorkflow(this.session, w); this.note('Goal token limit reached. /goal shows progress.'); break; }
            const combined = Math.min(tokenBudgetMaximum(originalBudget), remaining);
            this.config.settings.tokenBudget = Number.isFinite(combined) ? combined : 0;
            this.config.settings.dollarBudget = originalDollarBudget - spent;
          }
          const signal = this.abort!.signal;
          const budget = createRunBudget();
          const autoVerify = this.config.settings.verificationMode === 'after_changes' && this.config.settings.mode === 'BUILD';
          let verificationBaseline: Map<string, string | null> | undefined;
          let runError: unknown;
          try {
            if (autoVerify) {
              try { verificationBaseline = await this.verificationSnapshot(signal); }
              catch (error: any) {
                if (signal.aborted) throw error;
                this.note(`Automatic verification could not capture the starting file state: ${redact(error?.message ?? String(error))}`, 'error');
              }
            }
            try { await this.runtime.run(this.session, task, signal, continuation ? undefined : images, budget); }
            catch (error) { runError = error; }
            if (verificationBaseline && !signal.aborted) {
              try {
                const changed = await this.changedSince(verificationBaseline, signal);
                if (changed.length) {
                  this.note(`Build changed ${changed.length} file${changed.length === 1 ? '' : 's'}. Running automatic verification.`, 'system');
                  try { await this.verifyWithRepairs(undefined, this.config.settings.verificationRepairAttempts, signal, budget); }
                  catch (error: any) {
                    if (signal.aborted) throw error;
                    this.note(`Automatic verification stopped: ${redact(error?.message ?? String(error))}`, 'error');
                  }
                }
              } catch (error: any) {
                if (signal.aborted) throw error;
                this.note(`Automatic verification could not compare file state: ${redact(error?.message ?? String(error))}`, 'error');
              }
            }
            if (runError) throw runError;
          }
          finally {
            this.config.settings.tokenBudget = originalBudget; this.config.settings.dollarBudget = originalDollarBudget;
            const w = this.store.workflow(this.session); if (w.goal && goalBefore) { const after = this.store.usage(this.session); w.goal.usedTokens += Math.max(0, after.input + after.output - before.input - before.output); if (w.goal.usedTokens >= tokenBudgetMaximum(w.goal.tokenBudget) && w.goal.status === 'active') w.goal.status = 'limit'; this.store.saveWorkflow(this.session, w); }
          }
          const goal = this.store.workflow(this.session).goal;
          if (!goal || goal.status !== 'active') break;
          this.abort!.signal.throwIfAborted();
          task = 'Continue the active goal using existing results. Do not repeat completed work. Use update_goal complete only when all requirements are achieved with evidence.';
        }
        this.state.status = 'Ready';
      }
      catch (error: any) { this.state.status = this.abort?.signal.aborted ? 'Cancelled' : 'Error'; this.note(this.abort?.signal.aborted ? 'Task cancelled. Results from earlier tools were kept.' : redact(error.message), 'error'); }
      finally { this.state.busy = false; this.abort = undefined; this.notify(); }
    })();
    await this.active;
  }
  cancel(): void { const w = this.store.workflow(this.session); if (w.goal?.status === 'active') { w.goal.status = 'paused'; this.store.saveWorkflow(this.session, w); } this.abort?.abort(new Error('Cancelled by user.')); }
  cycleMode(): Promise<void> {
    if (this.state.busy || this.closing) return Promise.resolve();
    const settings = this.config.settings, previous = settings.mode;
    const modes = ['PLAN', 'BUILD', 'REVIEW'] as const;
    settings.mode = modes[(modes.indexOf(previous) + 1) % modes.length]!;
    return this.persistSettings(() => { settings.mode = previous; }).then(() => this.sync()).catch(error => { this.sync(); this.note(error.message, 'error'); });
  }
  private sync(): void {
    const settings = this.config.settings; const provider = settings.providers[settings.provider]; this.state.provider = settings.provider; this.state.model = provider?.model ?? ''; this.state.mode = settings.mode; this.state.cortex = settings.cortex; this.state.theme = settings.theme; this.state.vision = provider?.vision; this.state.contextLimit = contextLimit(settings.maxInputTokens, settings.maxOutputTokens, provider); this.state.contextLimitSource = contextLimitSource(settings.maxInputTokens, settings.maxOutputTokens, provider); this.state.tokenLimit = settings.tokenBudget; this.state.dollarLimit = settings.dollarBudget; this.notify();
  }
  private async verify(explicitCommand?: string, repairAttempts = 0): Promise<void> {
    if (this.state.busy || this.closing) throw new Error('Wait for the current task before starting verification.');
    if (this.config.settings.mode !== 'BUILD') throw new Error('Verification commands run project code. Switch to BUILD mode first.');
    const abort = new AbortController();
    this.abort = abort; this.state.busy = true; this.state.status = 'Preparing verification'; this.state.taskUsage = { input: 0, output: 0, cached: 0, cost: 0, costKnown: true }; this.notify();
    const operation = (async () => { await this.verifyWithRepairs(explicitCommand, repairAttempts, abort.signal, createRunBudget()); })();
    this.active = operation;
    try { await operation; }
    catch (error: any) { this.note(redact(abort.signal.aborted ? 'Verification cancelled before the report was complete.' : error.message ?? String(error)), 'error'); }
    finally {
      if (this.active === operation) this.active = undefined;
      if (this.abort === abort) this.abort = undefined;
      this.state.busy = false; this.state.status = 'Ready'; this.notify();
    }
  }
  private async verifyWithRepairs(explicitCommand: string | undefined, repairAttempts: number, signal: AbortSignal, budget: ReturnType<typeof createRunBudget>): Promise<import('./verification.js').VerificationReport> {
    let report = await this.performVerification(explicitCommand, signal);
    for (let attempt = 1; attempt <= repairAttempts && report.status === 'failed'; attempt++) {
      signal.throwIfAborted();
      this.state.status = `Repairing verification failure ${attempt}/${repairAttempts}`; this.notify();
      this.note(`Verification failed. Asking the selected model to repair the reported failures (${attempt}/${repairAttempts}).`, 'system');
      await this.runtime.run(this.session, this.verificationRepairTask(report), signal, undefined, budget);
      signal.throwIfAborted();
      report = await this.performVerification(explicitCommand, signal);
    }
    return report;
  }
  private async verificationSnapshot(signal: AbortSignal): Promise<Map<string, string | null>> {
    const paths = new Set(this.workspace.changedPaths());
    try {
      const raw = await this.registry.execute('git_status', { untrackedFiles: true }, { signal, mode: this.config.settings.mode, outputLimit: 0 });
      const status = JSON.parse(raw) as { exitCode?: unknown; stdout?: unknown };
      if (status.exitCode === 0 && typeof status.stdout === 'string') parseGitStatusPaths(status.stdout).forEach(filename => paths.add(filename));
    } catch (error) { if (signal.aborted) throw error; }
    signal.throwIfAborted();
    return hashWorkspaceFiles(this.workspace, [...paths]);
  }
  private async changedSince(before: Map<string, string | null>, signal: AbortSignal): Promise<string[]> {
    const after = await this.verificationSnapshot(signal);
    return [...new Set([...before.keys(), ...after.keys()])].filter(filename => before.get(filename) !== after.get(filename));
  }
  private verificationRepairTask(report: import('./verification.js').VerificationReport): string {
    const failures = report.commands.filter(check => check.status === 'failed').slice(0, 8).map(check => ({
      label: check.label, command: redact(check.command), exitCode: check.exitCode,
      output: redact(check.output).slice(-1200),
    }));
    const diagnostics = report.diagnostics.filter(item => item.error || item.diagnostics.length).slice(0, 20).map(item => ({
      path: item.path,
      error: item.error ? redact(item.error).slice(0, 500) : undefined,
      diagnostics: item.diagnostics.slice(0, 8).map(diagnostic => ({
        code: diagnostic.code, line: diagnostic.line, column: diagnostic.column,
        message: redact(diagnostic.message).slice(0, 500),
      })),
    }));
    const evidence = JSON.stringify({ failures, diagnostics, changedDuringCheck: report.files.filter(file => file.changedDuringCheck).map(file => file.path).slice(0, 30) });
    return [
      'Repair the concrete project failures in this verification report.',
      'Inspect relevant files first and make the smallest safe fixes. Do not claim the issue is fixed until the controller reruns verification.',
      'Do not run the verification commands yourself; the controller will rerun them after this repair attempt. Do not make unrelated edits.',
      'Use the normal tool permissions and approval flow. If a required action is disabled or denied, explain the blocker and stop. Do not bypass it.',
      `Verification report ${report.id.slice(0, 8)} from ${report.workspace}:`,
      evidence.slice(0, 9000),
    ].join('\n\n');
  }
  private async recordReproduction(command: string): Promise<void> {
    if (this.state.busy || this.closing) throw new Error('Wait for the current task before recording a reproduction.');
    if (this.config.settings.mode !== 'BUILD') throw new Error('Reproduction commands run project code. Switch to BUILD mode first.');
    const abort = new AbortController();
    this.abort = abort; this.state.busy = true; this.state.status = 'Recording reproduction'; this.notify();
    const operation = (async () => {
      const raw = await this.registry.execute('run_tests', { command }, { signal: abort.signal, mode: this.config.settings.mode, outputLimit: 0 });
      const result = JSON.parse(raw) as { exitCode?: unknown; stdout?: unknown; stderr?: unknown };
      if (typeof result.exitCode !== 'number' || !Number.isInteger(result.exitCode)) throw new Error('The reproduction command did not return an integer exit code.');
      const output = [result.stdout, result.stderr].filter(value => typeof value === 'string' && value.length).join('\n');
      const workflow = this.store.workflow(this.session);
      workflow.verificationRepro = { command, baselineExitCode: result.exitCode, baselineOutput: redact(output).slice(-2000), createdAt: Date.now() };
      this.store.saveWorkflow(this.session, workflow);
      this.note(result.exitCode === 0
        ? 'Reproduction recorded, but it already exited 0 before a fix. It is kept as a baseline and will not prove that a regression was fixed.'
        : `Reproduction recorded (exit ${result.exitCode}). /verify will rerun it as the first check.`);
    })();
    this.active = operation;
    try { await operation; }
    catch (error: any) { this.note(redact(abort.signal.aborted ? 'Reproduction recording was cancelled.' : error.message ?? String(error)), 'error'); }
    finally {
      if (this.active === operation) this.active = undefined;
      if (this.abort === abort) this.abort = undefined;
      this.state.busy = false; this.state.status = 'Ready'; this.notify();
    }
  }
  private async performVerification(explicitCommand: string | undefined, signal: AbortSignal): Promise<import('./verification.js').VerificationReport> {
    const settings = this.config.settings;
    const plan = await discoverVerificationPlan(this.workspace, settings.verificationCommands, explicitCommand);
    const paths = new Set(this.workspace.changedPaths());
    const notes = [...plan.notes];
    try {
      const raw = await this.registry.execute('git_status', { untrackedFiles: true }, { signal, mode: settings.mode, outputLimit: 0 });
      const status = JSON.parse(raw) as { exitCode?: unknown; stdout?: unknown; stderr?: unknown };
      if (status.exitCode === 0 && typeof status.stdout === 'string') parseGitStatusPaths(status.stdout).forEach(filename => paths.add(filename));
      else notes.push(`Git status did not return a clean result: ${String(status.stderr ?? status.exitCode ?? 'unknown error')}`);
    } catch (error: any) {
      if (signal.aborted) throw error;
      notes.push(`Could not collect Git changed paths: ${redact(error.message ?? String(error))}`);
    }
    const changedCodePaths = [...paths].filter(filename => /\.[cm]?[jt]sx?$/i.test(filename));
    if (changedCodePaths.length) {
      try {
        const raw = await this.registry.execute('project_map', { maxFiles: 300 }, { signal, mode: settings.mode, outputLimit: 0 });
        const map = JSON.parse(raw) as { importEdges?: unknown };
        const edges = Array.isArray(map.importEdges) ? map.importEdges.flatMap(edge => {
          if (!edge || typeof edge !== 'object') return [];
          const row = edge as Record<string, unknown>;
          return typeof row.from === 'string' && typeof row.to === 'string' ? [{ from: row.from, to: row.to }] : [];
        }) : [];
        const dependents = affectedDependents(edges, changedCodePaths);
        if (dependents.length) {
          dependents.forEach(filename => paths.add(filename));
          notes.push(`Impact analysis: also checking ${dependents.length} file(s) that import changed code.`);
        }
      } catch (error: any) {
        if (signal.aborted) throw error;
        notes.push(`Impact analysis was unavailable: ${redact(error.message ?? String(error))}`);
      }
    }
    const before = await hashWorkspaceFiles(this.workspace, [...paths]);
    const checks: VerificationCheck[] = [];
    const diagnostics: VerificationDiagnostic[] = [];
    const reproduction = this.store.workflow(this.session).verificationRepro;
    let reproductionBaselinePassed = false;
    if (reproduction && !signal.aborted) {
      this.state.status = 'Verifying reproduction'; this.notify();
      const started = Date.now();
      try {
        const raw = await this.registry.execute('run_tests', { command: reproduction.command }, { signal, mode: settings.mode, outputLimit: 0 });
        const result = JSON.parse(raw) as { exitCode?: unknown; stdout?: unknown; stderr?: unknown };
        if (typeof result.exitCode !== 'number' || !Number.isInteger(result.exitCode)) throw new Error('The reproduction command did not return an integer exit code.');
        const output = [result.stdout, result.stderr].filter(value => typeof value === 'string' && value.length).join('\n');
        const passed = result.exitCode === 0;
        if (reproduction.baselineExitCode === 0) {
          reproductionBaselinePassed = true;
          notes.push('The reproduction command already exited 0 before the change; it does not prove that a reported regression was fixed.');
        } else if (passed) notes.push('Reproduction now passes; the reported failure is no longer observed.');
        checks.push({ label: 'reproduction', command: reproduction.command, status: passed ? 'passed' : 'failed', exitCode: result.exitCode, durationMs: Date.now() - started, output: output.slice(-8000) });
      } catch (error: any) {
        const message = redact(error.message ?? String(error));
        const cancelled = signal.aborted;
        const blocked = !cancelled && /approval denied|unavailable|disabled|not allowed/i.test(message);
        checks.push({ label: 'reproduction', command: reproduction.command, status: cancelled ? 'cancelled' : blocked ? 'blocked' : 'failed', exitCode: null, durationMs: Date.now() - started, output: message });
      }
    }
    for (const item of plan.commands) {
      if (signal.aborted) break;
      this.state.status = `Verifying ${item.label}`; this.notify();
      const started = Date.now();
      try {
        const raw = await this.registry.execute('run_tests', { command: item.command }, { signal, mode: settings.mode, outputLimit: 0 });
        const result = JSON.parse(raw) as { exitCode?: unknown; stdout?: unknown; stderr?: unknown };
        if (typeof result.exitCode !== 'number' || !Number.isInteger(result.exitCode)) throw new Error('The command did not return an integer exit code.');
        const output = [result.stdout, result.stderr].filter(value => typeof value === 'string' && value.length).join('\n');
        checks.push({ label: item.label, command: item.command, status: result.exitCode === 0 ? 'passed' : 'failed', exitCode: result.exitCode, durationMs: Date.now() - started, output: output.slice(-8000) });
      } catch (error: any) {
        const message = redact(error.message ?? String(error));
        const cancelled = signal.aborted;
        const blocked = !cancelled && /approval denied|unavailable|disabled|not allowed/i.test(message);
        checks.push({ label: item.label, command: item.command, status: cancelled ? 'cancelled' : blocked ? 'blocked' : 'failed', exitCode: null, durationMs: Date.now() - started, output: message });
        if (cancelled || blocked) break;
      }
    }
    const codePaths = [...paths].filter(filename => /\.[cm]?[jt]sx?$/i.test(filename));
    if (codePaths.length && !signal.aborted && this.registry.getSpec('code_diagnostics_batch')) {
      this.state.status = 'Checking code diagnostics'; this.notify();
      try {
        const raw = await this.registry.execute('code_diagnostics_batch', { paths: codePaths }, { signal, mode: settings.mode, outputLimit: 0 });
        const result = JSON.parse(raw) as unknown;
        if (!Array.isArray(result)) throw new Error('Diagnostics returned an invalid result.');
        for (const item of result) {
          if (!item || typeof item !== 'object') continue;
          const row = item as Record<string, unknown>;
          const found = Array.isArray(row.diagnostics) ? row.diagnostics.flatMap(entry => {
            if (!entry || typeof entry !== 'object') return [];
            const diagnostic = entry as Record<string, unknown>;
            if (typeof diagnostic.code !== 'number' || typeof diagnostic.message !== 'string') return [];
            return [{ code: diagnostic.code, message: redact(diagnostic.message), ...(typeof diagnostic.line === 'number' ? { line: diagnostic.line } : {}), ...(typeof diagnostic.column === 'number' ? { column: diagnostic.column } : {}) }];
          }) : [];
          diagnostics.push({ path: typeof row.path === 'string' ? row.path : codePaths[0]!, diagnostics: found, ...(typeof row.error === 'string' ? { error: redact(row.error) } : {}) });
        }
      } catch (error: any) {
        if (signal.aborted) notes.push('Code diagnostics were cancelled.');
        else diagnostics.push({ path: codePaths.join(', '), diagnostics: [], error: redact(error.message ?? String(error)) });
      }
    } else if (codePaths.length) notes.push('TypeScript/JavaScript diagnostics are disabled or unavailable.');
    const after = await hashWorkspaceFiles(this.workspace, [...paths]);
    const files = [...new Set([...before.keys(), ...after.keys()])].map(filename => {
      const beforeHash = before.get(filename) ?? null, afterHash = after.get(filename) ?? null;
      return { path: filename, beforeHash, afterHash, changedDuringCheck: beforeHash !== afterHash };
    });
    if (!files.length) notes.push('No changed project files were detected; the checks ran on the current workspace.');
    let status: VerificationStatus;
    if (signal.aborted || checks.some(check => check.status === 'cancelled')) status = 'cancelled';
    else if (checks.some(check => check.status === 'blocked')) status = 'blocked';
    else if (checks.some(check => check.status === 'failed') || diagnostics.some(item => item.diagnostics.length)) status = 'failed';
    else if (reproductionBaselinePassed || diagnostics.some(item => item.error) || files.some(file => file.changedDuringCheck)) status = 'incomplete';
    else if (!checks.length) status = 'no-checks';
    else status = 'passed';
    const report = makeVerificationReport({ session: this.session, workspace: this.workspace.root, status, commands: checks, diagnostics, files, notes });
    this.store.saveVerification(report);
    this.note(formatVerificationReport(report), status === 'failed' || status === 'blocked' || status === 'incomplete' ? 'error' : 'system');
    return report;
  }
  private async command(line: string): Promise<void> {
    const [command = '', ...args] = line.split(/\s+/); const tail = line.slice(command.length).trim();
    const settings = this.config.settings;
    if (this.state.busy && !(command === '/goal' && (!tail || ['status', 'pause'].includes(tail))) && !['/cancel', '/status', '/cost', '/context', '/agents', '/steer', '/timeline', '/help', '/clear', '/exit'].includes(command)) throw new Error('Wait for the agent or use /cancel before changing the configuration.');
    switch (command) {
      case '/goal': {
        const w = this.store.workflow(this.session);
        if (!tail || tail === 'status') { this.note(w.goal ? JSON.stringify(w.goal, null, 2) : 'No goal. /goal [--tokens N] objective'); break; }
        if (['pause', 'resume', 'clear'].includes(tail)) {
          if (!w.goal) throw new Error('No goal.');
          if (tail === 'pause' && this.state.busy) this.cancel();
          if (tail === 'clear') delete w.goal;
          else { if (tail === 'resume' && w.goal.usedTokens >= tokenBudgetMaximum(w.goal.tokenBudget)) throw new Error('Goal budget exhausted. Create a new goal with --tokens.'); w.goal.status = tail === 'pause' ? 'paused' : 'active'; }
          this.store.saveWorkflow(this.session, w);
          if (tail === 'resume') await this.submit('Continue goal: ' + w.goal!.objective); else this.note('Goal: ' + tail); break;
        }
        const match = /^--tokens (\d+|infinity|∞) ([\s\S]+)$/i.exec(tail);
        if (tail.startsWith('--') && !match) throw new Error('/goal --tokens <N> <objective>');
        const budget = parseTokenBudget(match ? match[1] : settings.tokenBudget);
        if (w.goal?.status === 'active') throw new Error('An active goal exists. /goal pause or /goal clear first.');
        // A persisted plan belongs to the task that created it. Do not carry it
        // into a new goal, where it would mislead the agent's progress summary.
        delete w.plan;
        w.goal = { objective: match ? match[2]! : tail, status: 'active', tokenBudget: budget, usedTokens: 0 }; this.store.saveWorkflow(this.session, w);
        await this.submit(w.goal.objective); break;
      }
      case '/grill-me': {
        const w = this.store.workflow(this.session);
        if (tail === 'off') { if (w.grill) w.grill.active = false; this.store.saveWorkflow(this.session, w); this.note('Interview disabled.'); break; }
        if (!tail) { this.note(w.grill ? JSON.stringify(w.grill, null, 2) : '/grill-me <task> starts an interview. /grill-me off ends it.'); break; }
        w.grill = { task: tail, active: true }; this.store.saveWorkflow(this.session, w); await this.submit('Interview me about: ' + tail); break;
      }
      case '/plan': { if (!tail) throw new Error('/plan <task>'); settings.mode = 'PLAN'; this.sync(); await this.submit(tail); break; }
      case '/review': { if (!tail) throw new Error('/review <task>'); settings.mode = 'REVIEW'; this.sync(); await this.submit(tail); break; }
      case '/build': { if (!tail) throw new Error('/build <task>'); settings.mode = 'BUILD'; this.sync(); await this.submit(tail); break; }
      case '/retry': { const last = this.store.messages(this.session).findLast(m => m.role === 'user'); if (!last) throw new Error('No previous task.'); await this.submit(last.content); break; }
      case '/tools': {
        const tools: ToolSpec[] = [...this.registry.specs(settings.mode),
          { name: 'discover_tools', description: 'Search for extra tools by keyword.', parameters: { type: 'object' } },
          { name: 'load_skill', description: 'Load an enabled skill by name.', parameters: { type: 'object' } }];
        if (settings.mode === 'BUILD') {
          if (settings.cortex > 0 && (settings.maxDepth < 0 || settings.maxDepth > 0) && this.permissions.available('delegate', true, settings.mode)) tools.push({ name: 'delegate', description: 'Run independent subagents in separate project copies.', parameters: { type: 'object' } });
          if (settings.cortex > 0 && (settings.maxDepth < 0 || settings.maxDepth > 0) && this.permissions.available('delegate', true, settings.mode)) tools.push({ name: 'agent_resume', description: 'Resume a subagent from its persisted result.', parameters: { type: 'object' } });
          if (this.permissions.available('agent_changes', false, settings.mode)) tools.push({ name: 'agent_changes', description: 'Show changes proposed by a subagent.', parameters: { type: 'object' } });
          if (this.permissions.available('agent_apply', true, settings.mode)) tools.push({ name: 'agent_apply', description: 'Apply selected subagent changes after checking for conflicts.', parameters: { type: 'object' } });
          if (this.permissions.available('remember', true, settings.mode)) tools.push({ name: 'remember', description: 'Save a short project procedure to memory.', parameters: { type: 'object' } });
          tools.push(...this.mcp.tools());
        }
        const visible = tools.filter(tool => !tail || `${tool.name} ${tool.description}`.toLowerCase().includes(tail.toLowerCase()));
        this.note(`${visible.length} tools available in ${settings.mode}:\n` + visible.map(tool => `${tool.name} — ${tool.description}`).join('\n')); break;
      }
      case '/image': {
        if (!tail) { this.note(`Attached images: ${this.pendingImages.length}/${MAX_IMAGES_PER_TASK}. /image "C:\\folder\\image.png" adds a file. Ctrl+V pastes a screenshot or text from the clipboard. /image clear removes attachments. Model: ${settings.providers[settings.provider]?.vision === true ? 'supports images' : settings.providers[settings.provider]?.vision === false ? 'does not support images' : 'image support unknown'}.`); break; }
        if (tail === 'clear') { this.clearImages(); this.note('Removed pending images.'); break; }
        if (this.pendingImages.length >= MAX_IMAGES_PER_TASK) throw new Error(`Up to ${MAX_IMAGES_PER_TASK} images per message.`);
        const filename = tail.replace(/^"([\s\S]*)"$/, '$1').replace(/^'([\s\S]*)'$/, '$1');
        await this.addImagePath(filename);
        this.note(`Attached image ${this.pendingImages.length}/${MAX_IMAGES_PER_TASK}: ${path.basename(filename)}. Now send a message describing the task.`); break;
      }
      case '/help': this.note(HELP); break;
      case '/sandbox': {
        const action = args[0];
        if (action === 'on' || action === 'required' || action === 'auto' || action === 'off' || action === 'docker') {
          if (args.length !== 1) throw new Error('Use /sandbox on, /sandbox off, /sandbox auto, or /sandbox docker.');
          const mode = action === 'on' ? 'required' : action;
          let backend = 'host';
          if (mode !== 'off') {
            const status = await this.sandbox.status(this.workspace.root, mode);
            if (mode !== 'auto' && !status.available) {
              throw new Error(mode === 'docker'
                ? `Cannot enable the Docker sandbox: ${status.reason ?? status.backend}. Install Docker Desktop, then run /sandbox setup docker.`
                : `Cannot enable required isolation: ${status.reason ?? status.backend}. Run /sandbox status, then /sandbox setup on Windows.`);
            }
            backend = status.backend;
          }
          await this.updateSetting('sandboxMode', mode);
          this.note(mode === 'off'
            ? 'OS sandbox disabled. Shell and code commands run on the host under the normal permission policy.'
            : mode === 'auto'
              ? 'OS sandbox automatic. Commands use the backend when it is ready; otherwise they follow the normal host permission policy.'
              : mode === 'docker'
                ? `Docker sandbox enabled (${this.config.settings.sandboxDockerImage}). Linux-container commands have no network and only the project mount.`
                : `OS sandbox required (${backend}). Commands are blocked when the backend is unavailable.`);
          break;
        }
        if (action === 'setup' && args[1] === 'docker') {
          if (args.length !== 2) throw new Error('Use /sandbox setup docker.');
          this.note(`Pulling Docker image ${this.config.settings.sandboxDockerImage}. This can take a few minutes and only runs on your explicit command.`);
          await this.sandbox.installDocker();
          await this.updateSetting('sandboxMode', 'docker');
          this.note('Docker sandbox image is ready. Docker mode is enabled; commands use a read-only Linux container with no network and only the project mount.');
          break;
        }
        if (args[0] === 'setup') {
          if (args.length === 1) {
            this.note([
              'Windows sandbox setup',
              'This optional one-time setup creates a local sandbox account and a machine-wide network filter, then asks Windows for administrator approval.',
              'It skips user-profile read grants. Project access is granted only when a sandboxed command runs, and those project ACL grants can persist.',
              'PolonRLM refuses to elevate the bundled installer if it lives inside the writable project.',
              'After setup, shell and code tools use required isolation and stop if it is unavailable.',
              'Review the change, then type /sandbox setup confirm to continue. This command does not install anything.',
            ].join('\n'));
            break;
          }
          if (args.length !== 2 || args[1] !== 'confirm') throw new Error('Use /sandbox setup, then /sandbox setup confirm after reviewing the system changes.');
          if (process.platform !== 'win32') throw new Error('The Windows sandbox setup command is available only on Windows.');

          const current = await this.sandbox.status(this.workspace.root, 'required');
          if (current.available) {
            const previous = settings.sandboxMode;
            settings.sandboxMode = 'required';
            try { await this.persistSettings(() => { settings.sandboxMode = previous; }); }
            catch (error) { this.sync(); throw error; }
            this.sync();
            this.note('Windows sandbox is already installed. Required isolation is now enabled.');
            break;
          }

          this.note('Starting the Windows sandbox installer. Windows will show an administrator approval prompt. User-profile access is skipped.');
          const installed = await this.sandbox.installWindows();
          if (installed.cancelled) { this.note('Windows sandbox setup was cancelled. No sandbox setting was changed.'); break; }
          const ready = await this.sandbox.status(this.workspace.root, 'required');
          if (!ready.available) {
            this.note(`Setup finished, but required isolation is not ready yet. Current mode was left unchanged. Details: ${ready.reason ?? ready.backend}`);
            break;
          }
          const previous = settings.sandboxMode;
          settings.sandboxMode = 'required';
          try { await this.persistSettings(() => { settings.sandboxMode = previous; }); }
          catch (error) { this.sync(); throw new Error(`Windows sandbox setup completed, but the setting could not be saved. Run /settings sandboxMode required after fixing the configuration error. ${String((error as Error)?.message ?? error)}`); }
          this.sync();
          this.note('Windows sandbox setup completed. Required isolation is enabled. Use /sandbox status to review it.');
          break;
        }
        if (args.length > 1 || (args[0] && !['status', 'on', 'off', 'auto', 'docker'].includes(args[0]))) throw new Error('Use /sandbox, /sandbox status, /sandbox on, /sandbox off, /sandbox auto, /sandbox docker, or /sandbox setup.');
        const status = await this.sandbox.status(this.workspace.root);
        const execution = status.mode === 'off'
          ? 'Execution: host only, under the normal tool permission policy.'
          : status.available
            ? `Execution: ${status.backend} isolation is ready.`
            : status.mode === 'required'
              ? 'Execution: blocked because required isolation is unavailable.'
              : 'Execution: host fallback under the normal tool permission policy until the backend is ready.';
        const network = status.mode === 'off'
          ? 'Network: not sandboxed; normal host network access.'
          : `Network: sandboxed commands may reach ${settings.sandboxNetworkDomains.length ? settings.sandboxNetworkDomains.join(', ') : 'no hosts (deny by default)'}.`;
        this.note([
          `OS sandbox: ${status.mode}`,
          `Backend: ${status.backend}`,
          `Ready: ${status.available ? 'yes' : 'no'}`,
          execution,
          network,
          status.reason ? `Details: ${status.reason}` : '',
          'Coverage: shell, Python, background processes and LSP are isolated when the backend is ready. File writes, browser actions, desktop control and MCP are not covered; required mode refuses them instead of running them unisolated. Their normal permission and network checks still apply in auto/off mode.',
          'Switch with /sandbox on, /sandbox off, /sandbox auto, or /sandbox docker. On Windows, /sandbox setup provisions the one-time backend.',
        ].filter(Boolean).join('\n'));
        break;
      }
      case '/cancel': this.cancel(); break;
      case '/exit': await this.close(); break;
      case '/clear': this.state.messages = []; this.notify(); break;
      case '/connect': {
        if (!args[0]) { this.note(this.listProviders().map(provider => `${provider.id} · ${provider.url}`).join('\n') + '\n/connect <provider> [BaseURL], then /key and /models.'); break; }
        const id = args[0];
        const existing = Object.hasOwn(settings.providers, id) ? settings.providers[id] : undefined;
        const preset = Object.hasOwn(PROVIDER_PRESETS, id) ? PROVIDER_PRESETS[id] : undefined;
        const provider = existing ?? (preset ? structuredClone(preset) : undefined);
        if (!provider) throw new Error('Unknown preset. Use /connect custom https://host/v1.');
        const previous = { ...provider };
        let baseURL: string | undefined;
        if (args[1]) { const url = new URL(args[1]); if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('BaseURL must not contain secrets, query parameters, or fragments.'); baseURL = url.href.replace(/\/$/, ''); }
        if (!existing) settings.providers[id] = provider;
        if (baseURL) { if (provider.baseURL !== baseURL) updateModel(provider, provider.model); provider.baseURL = baseURL; }
        try { await this.selectProvider(id); }
        catch (error) {
          if (!existing) delete settings.providers[id];
          provider.baseURL = previous.baseURL; provider.model = previous.model;
          for (const key of MODEL_METADATA) { if (previous[key] === undefined) delete provider[key]; else (provider as any)[key] = previous[key]; }
          throw error;
        }
        this.note(`${id}: ${settings.providers[id]!.baseURL}\n/key <key> or ${settings.providers[id]!.apiKeyEnv ?? 'local endpoint without a key'}. /models fetches the list.`); break;
      }
      case '/fallback': {
        if (!args.length) {
          const active = settings.fallback.length ? settings.fallback.map((id, index) => `${index + 1}. ${id} (${settings.providers[id]?.model ?? 'no model'})`).join('\n') : 'None';
          const choices = Object.values(settings.providers).map(provider => `${provider.id}${provider.id === settings.provider ? ' (selected)' : ''} · ${provider.model || 'no model'}`).join('\n');
          this.note([`Fallback order: ${active}`, 'Set with /fallback <provider IDs separated by spaces or commas>. Use /fallback none to clear it.', 'Configured providers:', choices].join('\n')); break;
        }
        const value = args.length === 1 && ['none', 'clear', 'off'].includes(args[0]!.toLowerCase()) ? [] : tail.split(/[\s,]+/).filter(Boolean);
        if (new Set(value).size !== value.length) throw new Error('List each fallback provider once.');
        if (value.includes(settings.provider)) throw new Error('The selected provider cannot also be a fallback provider.');
        const unknown = value.filter(id => !Object.hasOwn(settings.providers, id));
        if (unknown.length) throw new Error(`Unknown provider${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}. Configure it with /connect first.`);
        await this.updateSetting('fallback', JSON.stringify(value));
        this.note(`Fallback order: ${settings.fallback.length ? settings.fallback.join(' → ') : 'none'}.`); break;
      }
      case '/key': if (!tail) throw new Error('Use /key <key>. The key field is masked and the key is omitted from history.'); await this.vault.set(settings.providers[settings.provider]!.id, tail); this.providers.clear(); this.note('Key encrypted with DPAPI for the current Windows account.'); break;
      case '/models': {
        if (args.length > 1) throw new Error('Use /models [provider ID].');
        const providerId = args[0] ?? settings.provider;
        const models = await this.listModels(providerId);
        const modelLines = models.map((model, index) => {
          const details = [
            model.contextWindow ? 'context ' + model.contextWindow : '',
            model.maxOutputTokens ? 'max output ' + model.maxOutputTokens : '',
            model.toolCalling === false ? 'no tools' : '',
            model.reasoning === false ? 'no reasoning' : '',
            model.vision === false ? 'no image support' : '',
          ].filter(Boolean);
          return (index + 1) + '. ' + model.id + (details.length ? ' · ' + details.join(' · ') : '');
        });
        const next = providerId === settings.provider ? '/model <number> or /model <custom ID>' : '/route <role> ' + providerId + ' <model ID> assigns a model to a role.';
        this.note(models.length ? 'Models from ' + providerId + ':\n' + modelLines.join('\n') + '\n' + next : 'The ' + providerId + ' endpoint returned no models.');
        break;
      }
      case '/route': {
        const roles = ['orchestrator', 'planner', 'coder', 'researcher', 'reviewer', 'tester', 'debugger'] as const;
        if (!args.length) {
          const routes = roles.map(role => {
            const route = settings.modelRoutes[role];
            const provider = route ? settings.providers[route.provider] : undefined;
            return role + ': ' + (route ? route.provider + '/' + (route.model ?? provider?.model ?? 'no model') : settings.provider + '/' + (settings.providers[settings.provider]?.model ?? 'no model') + ' (default)');
          });
          this.note([...routes, '', '/route <role> <provider> [model ID] assigns a role-specific model.', '/route <role> default uses the main provider and model again.', '/models <provider> lists that provider\'s models without switching the main provider.'].join('\n'));
          break;
        }
        if (args.length < 2 || args.length > 3 || !roles.includes(args[0] as typeof roles[number])) throw new Error('Use /route <orchestrator|planner|coder|researcher|reviewer|tester|debugger> <provider> [model ID], or /route <role> default.');
        const role = args[0] as typeof roles[number];
        const routes = structuredClone(settings.modelRoutes);
        if (args[1]!.toLowerCase() === 'default' && args.length === 2) delete routes[role];
        else {
          if (!Object.hasOwn(settings.providers, args[1]!)) throw new Error('Unknown provider ' + args[1] + '. Configure it with /connect first.');
          routes[role] = { provider: args[1]!, ...(args[2] ? { model: args[2] } : {}) };
        }
        await this.updateSetting('modelRoutes', JSON.stringify(routes));
        const route = settings.modelRoutes[role];
        this.note(role + ' route: ' + (route ? route.provider + '/' + (route.model ?? settings.providers[route.provider]!.model) : 'main provider and model') + '.');
        break;
      }
      case '/model': {
        if (!tail) { this.note(`Model: ${this.state.model || 'not selected'}. Use /model <id> or /models.`); break; }
        const selected = /^\d+$/.test(tail) ? this.models[Number(tail) - 1] : this.models.find(model => model.id === tail);
        if (/^\d+$/.test(tail) && !selected) throw new Error('That number is outside the /models list.');
        await this.setModel(selected?.id ?? tail, true); this.note(`Selected ${this.state.model}. Unknown capabilities and prices remain unknown.`); break;
      }
      case '/effort': {
        const provider = settings.providers[settings.provider]!;
        if (!tail) {
          const options = effortChoices(provider, this.models.find(model => model.id === provider.model));
          const current = normalizeEffort(provider.reasoning ?? 'auto');
          this.note([`Reasoning effort · ${provider.model || 'no model selected'}`,
            ...options.map(option => `${option.id === current ? '• ' : '  '}${option.label}${option.detail ? ` · ${option.detail}` : ''}`),
            ...(provider.reasoning && !options.some(option => option.id === current) ? [`Current setting ${provider.reasoning} is unsupported by this model.`] : []),
            '', '/effort <value> · /effort auto restores the model default'].join('\n'));
          break;
        }
        await this.setEffort(tail);
        this.note(`Reasoning effort set to ${settings.providers[settings.provider]!.reasoning ?? 'automatic'} for ${provider.model || 'the selected model'}.`);
        break;
      }
      case '/mode': if (!tail) await this.cycleMode(); else {
        if (!['PLAN', 'BUILD', 'REVIEW'].includes(tail.toUpperCase())) throw new Error('Modes: PLAN, BUILD, REVIEW.');
        const previous = settings.mode; settings.mode = tail.toUpperCase() as any;
        await this.persistSettings(() => { settings.mode = previous; }); this.sync();
      } break;
      case '/cortex': if (!tail) this.note(CORTEX.map((level, index) => `${index}: ${level.name} · suggested effort ${level.steps} steps · ${level.agents} subagents`).join('\n') + '\nThese are effort suggestions, not hard limits.'); else {
        const level = Number(tail); if (!Number.isInteger(level) || level < 0 || level > 5) throw new Error('Cortex: 0–5.');
        const previous = settings.cortex; settings.cortex = level;
        await this.persistSettings(() => { settings.cortex = previous; }); this.sync();
      } break;
      case '/setting':
      case '/settings': {
        if (!args[0]) { this.note(['SETTINGS', ...SETTINGS_FIELDS.map(field => `${field.label}: ${field.section === 'limits' ? displayLimit(field.key, settings[field.key as keyof Settings] as number) : ['browserOptions', 'verificationCommands', 'sandboxNetworkDomains', 'fallback', 'agentToolProfiles', 'modelRoutes', 'modelRoleBudgets'].includes(field.key) ? JSON.stringify(settings[field.key as 'browserOptions' | 'verificationCommands' | 'sandboxNetworkDomains' | 'fallback' | 'agentToolProfiles' | 'modelRoutes' | 'modelRoleBudgets']) : String(settings[field.key as keyof Settings])}`), `Subagent tool profiles: ${JSON.stringify(settings.agentToolProfiles)}`, '', '/settings <name> infinity · 0 removes most limits; maxDepth 0 disables delegation and infinity removes the depth cap.', '/settings sandboxMode auto|required|off controls isolation for shell, Python, background commands and LSP.', '/settings sandboxNetworkDomains ["registry.npmjs.org","github.com"] allows network access from sandboxed commands.', '/settings agentToolProfiles {"reviewer":["read_file","search_files"]} sets a strict subagent allowlist; unset roles inherit the normal catalog.', '/settings modelRoleBudgets {"coder":{"maxTokens":50000,"maxCost":1,"maxCalls":30}} sets optional role caps; omitted values and 0 are unlimited.', '/permissions manages tool permissions.'].join('\n')); break; }
        if (args[0].startsWith('provider.')) {
          const field = args[0].slice('provider.'.length);
          if (!['reasoning', 'reasoningSupported', 'reasoningControl', 'reasoningEfforts', 'requestTimeoutMs', 'temperature', 'contextWindow', 'maxOutputTokens', 'inputPrice', 'outputPrice', 'toolCalling', 'vision', 'apiKeyEnv', 'kind'].includes(field)) throw new Error('Provider fields: reasoning, reasoningSupported, reasoningControl, reasoningEfforts, requestTimeoutMs, temperature, pricing, and capabilities. Change the model with /model and the URL with /connect.');
          const provider = settings.providers[settings.provider]!;
          if (args.length === 1) { this.note(`${args[0]}: ${JSON.stringify((provider as any)[field])}`); break; }
          const raw = tail.slice(args[0].length).trim(); let value: unknown; try { value = JSON.parse(raw); } catch { value = raw; }
          const candidate = settingsSchema.parse({ ...settings, providers: { ...settings.providers, [settings.provider]: { ...provider, [field]: value } } });
          const previous = (provider as any)[field];
          Object.assign(provider, candidate.providers[settings.provider]);
          await this.persistSettings(() => { if (previous === undefined) delete (provider as any)[field]; else (provider as any)[field] = previous; });
          this.providers.clear(); this.sync(); this.note(`Saved ${args[0]}.`); break;
        }
        const name = args[0] as keyof typeof settings;
        if (['providers', 'provider', 'mcp', 'plugins', 'allowTools', 'denyTools'].includes(name) || !Object.hasOwn(settings, name)) throw new Error(name === 'plugins' ? 'Use /plugins to review and manage executable plugin code.' : 'Use the command for the relevant module.');
        if (args.length === 1) { this.note(`${name}: ${JSON.stringify(settings[name])}`); break; }
        let value: unknown; const raw = tail.slice(name.length).trim(); try { value = JSON.parse(raw); } catch { value = raw; }
        if (SETTINGS_FIELDS.some(field => field.key === name)) { await this.updateSetting(name, value as string | number); this.note(`Saved ${name === 'tokenBudget' ? `token limit: ${formatTokenBudget(settings.tokenBudget)}` : name}.`); break; }
        const candidate = settingsSchema.parse({ ...settings, [name]: value }); const previous = (settings as any)[name];
        (settings as any)[name] = candidate[name];
        await this.persistSettings(() => { (settings as any)[name] = previous; });
        this.providers.clear(); this.sync(); this.note(`Saved ${name}.`); break;
      }
      case '/verify': {
        if (args[0] === 'report') {
          if (!args[1] || args.length !== 2) throw new Error('Use /verify report <report ID>.');
          const report = this.store.verificationReport(this.session, args[1]);
          if (!report) throw new Error('Verification report was not found in this chat.');
          this.note(formatVerificationReport(report)); break;
        }
        if (args[0] === 'history') {
          if (args.length > 2) throw new Error('Use /verify history [count].');
          const count = args[1] === undefined ? 10 : Number(args[1]);
          if (!Number.isInteger(count) || count < 1) throw new Error('History count must be a positive whole number.');
          this.note(formatVerificationHistory(this.store.verificationReports(this.session, count))); break;
        }
        if (args[0] === 'repair') {
          if (args.length > 2) throw new Error('Use /verify repair [attempts], from 1 to 3.');
          const attempts = args[1] === undefined ? 1 : Number(args[1]);
          if (!Number.isInteger(attempts) || attempts < 1 || attempts > 3) throw new Error('Verification repair attempts must be a whole number from 1 to 3.');
          await this.verify(undefined, attempts); break;
        }
        if (args[0] === 'reproduce') {
          const command = tail.slice('reproduce'.length).trim().replace(/^"([\s\S]*)"$/, '$1').replace(/^'([\s\S]*)'$/, '$1');
          if (!command) throw new Error('Use /verify reproduce <command>.');
          await this.recordReproduction(command); break;
        }
        const explicit = tail ? tail.replace(/^"([\s\S]*)"$/, '$1').replace(/^'([\s\S]*)'$/, '$1') : undefined;
        await this.verify(explicit); break;
      }
      case '/timeline': {
        if (args.length > 1) throw new Error('Use /timeline [count], from 1 to 200.');
        const count = args[0] === undefined ? 30 : Number(args[0]);
        if (!Number.isInteger(count) || count < 1 || count > 200) throw new Error('Timeline count must be a whole number from 1 to 200.');
        this.note(formatEvidenceTimeline(this.store.evidenceTimeline(this.session, count))); break;
      }
      case '/recover': {
        if (args[0] === 'rollback') {
          if (!args[1] || args.length !== 2) throw new Error('Use /recover rollback <change-or-group ID>.');
          const result = await this.workspace.rollbackRecovery(args[1], settings.mode);
          this.note(result.failed ? `Recovery stopped after ${result.restored.length} file(s). ${result.failed}: ${result.error}` : `Recovered ${result.restored.length} file(s) from group ${result.id.slice(0, 8)}.`);
          break;
        }
        if (args.length) throw new Error('Use /recover or /recover rollback <change-or-group ID>.');
        const status = this.workspace.recoveryStatus();
        const lines = ['RECOVERY', ...status.groups.map(group => `Group ${group.id.slice(0, 8)} · ${group.state} · ${group.name}`), ...status.changes.map(change => `Change ${change.id.slice(0, 8)} · ${change.state} · ${change.path}`)];
        this.note(lines.length === 1 ? 'No unfinished or conflicting file changes. Use /history changes to inspect completed changes.' : lines.join('\n'));
        break;
      }
      case '/history': {
        if (args[0] !== 'changes' || args.length > 2) throw new Error('Use /history changes [count].');
        const count = args[1] === undefined ? 50 : Number(args[1]);
        if (!Number.isInteger(count) || count < 1) throw new Error('History count must be a positive whole number.');
        const changes = this.workspace.changeHistory(count);
        this.note(changes.length ? ['FILE CHANGE HISTORY', ...changes.map(change => `${change.id.slice(0, 8)} · ${change.state}${change.groupId ? ` · group ${change.groupId.slice(0, 8)}` : ''} · ${change.tool} · ${change.path}`)].join('\n') : 'No file changes have been recorded for this project.');
        break;
      }
      case '/rollback': {
        if (!args[0] || args.length !== 1) throw new Error('Use /rollback <change-or-group-ID>.');
        const result = await this.workspace.rollbackRecovery(args[0], settings.mode);
        this.note(result.failed ? `Rollback stopped after ${result.restored.length} file(s). ${result.failed}: ${result.error}` : `Rolled back ${result.restored.length} file(s) from ${result.id.slice(0, 8)}.`);
        break;
      }
      case '/steer': {
        const match = /^([a-f0-9]{8})\s+([\s\S]+)$/i.exec(tail);
        if (!match) throw new Error('Use /steer <id> <message>.');
        this.steerAgent(match[1]!, match[2]!); break;
      }
      case '/agents': {
        const active = this.runtime.agents;
        const recent = this.store.agentRuns(this.session, 5).filter(run => !active.some(agent => agent.id === run.id));
        const activeLines = active.map(agent => `${agent.id} · ${agent.role} · ${agent.status}`);
        const recentLines = recent.map(run => `${run.id} · ${run.role} · ${run.status} · ${run.changedFiles.length} file(s)${run.transcript?.length ? ` · ${run.transcript.length} transcript message(s)` : ''} · ${new Date(run.updatedAt).toLocaleString('en-US')}`);
        this.note([
          `Parallel limit: ${displayLimit('maxAgents', settings.maxAgents)}; delegation depth: ${displayLimit('maxDepth', settings.maxDepth)}; Cortex ${settings.cortex} effort: ${CORTEX[settings.cortex]!.name}.`,
          activeLines.length ? `Active:\n${activeLines.join('\n')}` : 'Active: none.',
          recentLines.length ? `Recent persisted runs:\n${recentLines.join('\n')}` : 'Recent persisted runs: none.',
          'Use agent_resume with a saved run id to continue it from the persisted result; /agents lists only the latest five.',
        ].join('\n'));
        break;
      }
      case '/permissions': {
        const [action, tool] = args;
        const registered = new Set([...this.registry.discovery(settings.mode).map(item => item.name), ...this.mcp.tools().map(item => item.name), 'ask_question', 'get_goal', 'update_goal', 'finish_interview', 'discover_tools', 'request_tool', 'search_history', 'delegate', 'agent_resume', 'agent_message', 'agent_changes', 'agent_apply', 'load_skill', 'remember', 'sandbox_fallback']);
        const names = [...new Set([...registered, ...Object.keys(settings.toolPermissions), ...settings.allowTools, ...settings.denyTools])].sort();
        if (!action || action === 'list') {
          const effective = (name: string) => { const rule = settings.toolPermissions[name]; if (rule) return rule; if (settings.permissions === 'all') return 'auto'; if (settings.denyTools.includes(name) || (settings.allowTools.length && !settings.allowTools.includes(name))) return 'off'; return `global:${settings.permissions}`; };
        this.note([`Global mode: ${settings.permissions}`, 'Tool rules: ask = request approval every time; auto = do not ask; off = disable; default = inherit the global mode.', 'Global modes: ask requests approval for risky actions; workspace allows project writes; readonly blocks changes; all approves every action.', 'Auto for an individual tool still respects PLAN/REVIEW and readonly restrictions.', '/permissions all approves every action. /permissions reset restores the default approval prompts.', '/permissions <tool> ask|auto|off|default sets or removes a rule.', 'Tools:', ...names.map(name => `  ${name}: ${effective(name)}`)].join('\n')); break;
        }
        const previousPermissions = settings.permissions;
        const previousToolPermissions = settings.toolPermissions, previousToolValues = { ...settings.toolPermissions };
        const previousAllowTools = settings.allowTools, previousAllowValues = [...settings.allowTools];
        const previousDenyTools = settings.denyTools, previousDenyValues = [...settings.denyTools];
        let confirmation = '';
        if (action === 'all' || (action === 'auto' && tool === 'all')) { settings.permissions = 'all'; settings.toolPermissions = {}; settings.allowTools = []; settings.denyTools = []; confirmation = 'WARNING: all tools will be approved automatically, including shell and computer_use. Per-tool rules and lists were cleared. Use /permissions reset to undo this.'; }
        else if (['ask', 'workspace', 'readonly'].includes(action) && !tool) { settings.permissions = action as 'ask' | 'workspace' | 'readonly'; confirmation = `Permission mode: ${settings.permissions}. Per-tool rules are unchanged.`; }
        else if (action === 'reset' && !tool) { settings.permissions = 'ask'; settings.toolPermissions = {}; settings.allowTools = []; settings.denyTools = []; confirmation = 'Approval prompts restored and per-tool rules cleared.'; }
        else if (['ask', 'auto', 'off', 'default', 'inherit'].includes(String(tool))) { if (!registered.has(action)) throw new Error(`Unknown tool: ${action}. Check /tools.`); if (tool === 'default' || tool === 'inherit') { delete settings.toolPermissions[action]; confirmation = `${action}: inherits the global mode.`; } else { settings.toolPermissions[action] = tool as 'ask' | 'auto' | 'off'; confirmation = `${action}: ${tool === 'ask' ? 'request approval for every call' : tool === 'auto' ? 'approve automatically' : 'disabled'}.`; } }
        else if ((action === 'allow' || action === 'deny') && tool) { const list = action === 'allow' ? settings.allowTools : settings.denyTools; if (!list.includes(tool)) list.push(tool); confirmation = `${tool}: ${action === 'allow' ? 'allowed by the allowlist' : 'blocked by the denylist'}.`; }
        else if (action === 'undeny' && tool) { settings.denyTools = settings.denyTools.filter(name => name !== tool); confirmation = `Removed ${tool} from the denylist.`; }
        else throw new Error('/permissions [list|all|ask|workspace|readonly|reset] | /permissions <tool> ask|auto|off|default');
        await this.persistSettings(() => {
          settings.permissions = previousPermissions;
          for (const key of Object.keys(previousToolPermissions)) delete previousToolPermissions[key]; Object.assign(previousToolPermissions, previousToolValues); settings.toolPermissions = previousToolPermissions;
          previousAllowTools.splice(0, previousAllowTools.length, ...previousAllowValues); settings.allowTools = previousAllowTools;
          previousDenyTools.splice(0, previousDenyTools.length, ...previousDenyValues); settings.denyTools = previousDenyTools;
        });
        this.note(confirmation); break;
      }
      case '/status': this.note(`${this.workspace.root}\nSession: ${this.session}\n${settings.provider} / ${this.state.model || 'select a model'}\n${settings.mode} · Cortex ${settings.cortex} · ${settings.permissions}\nConfiguration: ${this.config.home}\n${this.state.status}`); break;
      case '/cost': this.note(JSON.stringify(this.store.usage(this.session), null, 2) + '\nPrices: USD per 1M tokens. An unknown price does not mean the model is free. The USD limit applies only when prices are known.'); break;
      case '/budget': {
        if (!args.length) { this.note(`Task budget: ${formatTokenBudget(settings.tokenBudget)} tokens · ${displayCostLimit(settings.dollarBudget)}. Change it with /budget <tokens or infinity> <USD or infinity>.`); break; }
        const tokenLimit = parseTokenBudget(args[0]), dollarLimit = args[1] === undefined ? settings.dollarBudget : parseUnlimitedLimit(args[1]);
        if (!Number.isInteger(tokenLimit) || !Number.isFinite(dollarLimit) || dollarLimit < 0) throw new Error('Use /budget <whole number of tokens or infinity> <USD or infinity>.');
        await this.setBudgets(tokenLimit, dollarLimit); this.note(`Task limit set to ${formatTokenBudget(settings.tokenBudget)} tokens · ${displayCostLimit(settings.dollarBudget)}.`); break;
      }
      case '/context': {
        const provider = settings.providers[settings.provider];
        this.note(`Context: ~${estimateTokens(this.store.context(this.session)).toLocaleString('en-US')} tokens (local UTF-8 estimate, not the provider tokenizer). App input cap: ${displayLimit('maxInputTokens', settings.maxInputTokens)}. Model context: ${provider?.contextWindow?.toLocaleString('en-US') ?? 'unknown'}${provider?.contextWindow ? ` · max output ${provider.maxOutputTokens?.toLocaleString('en-US') ?? 'provider default'}` : ''}. Task token budget: ${formatTokenBudget(settings.tokenBudget)}. Automatic compaction runs only when a configured or known model context limit requires it. /compact makes a local extractive summary without an AI call; the full transcript remains archived.`); break;
      }
      case '/compact': {
        const before = this.store.context(this.session);
        const target = settings.maxInputTokens > 0 ? Math.floor(settings.maxInputTokens / 2) : Math.max(500, Math.floor(estimateTokens(before) * 0.6));
        const local = compactMessages(before, target);
        if (args[0] === 'model') {
          this.note('Compacting with one explicit model summary call. The full transcript remains archived.');
          const summary = await this.runtime.summarizeContext(before, target, AbortSignal.timeout(Math.max(30_000, settings.timeoutMs || 120_000)));
          this.store.recordUsage(this.session, summary.usage);
          const marker = 'polonrlm_context';
          const summaryContent = `Model-compacted context (generated by an explicit /compact model call; verify before relying on it):\n${clip(summary.text, Math.max(1_000, target * 3))}`;
          const messages = local.messages.some(message => message.name === marker)
            ? local.messages.map(message => message.name === marker ? { ...message, content: summaryContent } : message)
            : [{ role: 'system' as const, name: marker, content: summaryContent }, ...local.messages];
          this.store.archiveContext(this.session, messages);
          this.note(`Context compacted with the model: ${summary.usage.input.toLocaleString('en-US')} input / ${summary.usage.output.toLocaleString('en-US')} output tokens; ${local.removed} messages summarized locally. Full history remains in SQLite.`);
          break;
        }
        this.store.archiveContext(this.session, local.messages);
        const saved = Math.max(0, local.beforeTokens - local.afterTokens);
        this.note(saved ? `Context compacted locally: ~${local.beforeTokens.toLocaleString('en-US')} → ${local.afterTokens.toLocaleString('en-US')} tokens; ${local.removed} messages summarized and ${local.shortened} long outputs shortened. Full history remains in the SQLite archive. No extra AI call was made.` : `Context is already about ${local.afterTokens.toLocaleString('en-US')} tokens or the current message cannot be safely shortened. SQLite history was left unchanged.`);
        break;
      }
      case '/sessions': this.note(this.store.list(this.workspace.root, tail).map(session => `${session.id} ${session.id === this.session ? '· active ' : '· '}${new Date(session.updated).toLocaleString('en-US')} · ${session.title}`).join('\n') || 'No conversation history.'); break;
      case '/new': this.session = this.store.create(this.workspace.root); this.state.sessionId = this.session; this.state.messages = []; this.state.usage = this.store.usage(this.session); this.note(`New session: ${this.session}`); break;
      case '/resume': this.resumeSession(tail || undefined); break;
      case '/export': {
        if (!tail) throw new Error('Use /export path.md. The export includes every message and tool result from this session.');
        const messages = this.store.messages(this.session);
        const body = [`# PolonRLM conversation`, ``, `Workspace: ${this.workspace.root}`, `Session: ${this.session}`, ``,
          ...messages.flatMap(message => {
            const role = message.role === 'user' ? 'User' : message.role === 'assistant' ? 'PolonRLM' : message.role === 'tool' ? `Tool: ${message.name ?? 'tool'}${message.isError ? ' (error)' : ''}` : message.role;
            const toolCalls = message.toolCalls?.length ? `\n\nTools called: ${message.toolCalls.map(call => call.name).join(', ')}` : '';
            const content = `${message.content}${toolCalls}`;
            return content.trim() ? [`## ${role}`, ``, content, ``] : [];
          })].join('\n');
        if (Buffer.byteLength(body) > 2_000_000) throw new Error('Export exceeds 2 MB. Use /compact or choose a shorter session.');
        await this.workspace.change('export_session', tail, () => body, settings.mode);
        this.note(`Exported ${messages.length} messages to ${tail}.`); break;
      }
      case '/forget': if (tail === this.session) throw new Error('Create a new session with /new before deleting the active one.'); this.store.forget(tail, this.workspace.root); this.note('Deleted session.'); break;
      case '/undo': this.note(await this.workspace.undo(settings.mode)); break;
      case '/memory': if (args[0] === 'forget' && args[1]) this.store.forgetMemory(this.workspace.root, args.slice(1).join(' ')); this.note(JSON.stringify(this.store.memories(this.workspace.root), null, 2)); break;
      case '/skills': await this.skillCommand(args, tail); break;
      case '/mcp': await this.mcpCommand(args, tail); break;
      case '/plugins': await this.pluginCommand(args); break;
      default: throw new Error('Unknown command. Use /help to see the command list.');
    }
  }
  private async skillCommand(args: string[], tail: string): Promise<void> {
    const [action = 'list', name] = args;
    if (action === 'list') { const skills = await this.skills.list(); const entries = skills.map(skill => `${skill.enabled ? 'on' : 'off'} · ${skill.name} · ${skill.description} · ${skill.license ?? 'no license'}`); this.note([...entries, ...this.skills.warnings().map(warning => `problem · ${warning}`)].join('\n') || 'No skills found.'); }
    else if (action === 'repair' && !name) this.note(await this.skills.repairRegistry());
    else if (action === 'install' && name) this.note(await this.skills.install(tail.slice(action.length).trim()));
    else if (action === 'update' && name) this.note(await this.skills.update(name));
    else if (action === 'enable' && name) { await this.skills.enable(name, true); this.note(`Enabled ${name}.`); }
    else if (action === 'disable' && name) { await this.skills.enable(name, false); this.note(`Disabled ${name}.`); }
    else if (action === 'remove' && name) { await this.skills.remove(name); this.note(`Removed ${name}.`); }
    else if (action === 'show' && name) { const skill = (await this.skills.list()).find(skill => skill.name === name); if (!skill) throw new Error('Skill not found.'); const { readFile } = await import('node:fs/promises'); this.note(await readFile(`${skill.path}/SKILL.md`, 'utf8')); }
    else if (action === 'create' && name) this.note(await this.skills.create(name, 'Procedure approved by the user.', args.slice(2).join(' ')));
    else throw new Error('/skills list|install <path or GitHub>|enable|disable|remove|update|show <name>|create <name> <procedure>|repair');
  }
  private async mcpCommand(args: string[], tail: string): Promise<void> {
    const [action = 'list', name] = args; const configs = this.config.settings.mcp;
    if (action === 'list') this.note(JSON.stringify(Object.fromEntries(Object.entries(configs).map(([server, config]) => [server, mcpConfigPreview(config)])), null, 2) + `\nConnected tools: ${this.mcp.tools().map(tool => tool.name).join(', ') || 'none'}`);
    else if (action === 'add' && name) {
      const raw = tail.slice(action.length).trim().slice(name.length).trim(); const server = secureMcpServerSchema.parse(JSON.parse(raw)); const candidate = settingsSchema.parse({ ...this.config.settings, mcp: { ...configs, [name]: server } });
      const previous = configs[name]; configs[name] = candidate.mcp[name]!;
      await this.persistSettings(() => { if (previous) configs[name] = previous; else delete configs[name]; });
      this.note(`Added ${name}. /mcp connect ${name} starts the connection.`);
    }
    else if (action === 'connect' && name) { const config = configs[name]; if (!config) throw new Error('MCP server not found.'); await this.permissions.check('mcp_connect', 'external', 'Starting MCP runs a trusted program or connects to a service.', JSON.stringify(mcpConfigPreview(config))); this.note(`Connected: ${(await this.mcp.connect(name)).map(tool => tool.name).join(', ')}`); }
    else if (action === 'disconnect' && name) { await this.mcp.disconnect(name); this.note(`Disconnected ${name}.`); }
    else if (action === 'remove' && name) {
      const previous = configs[name]; if (!previous) throw new Error('MCP server not found.');
      await this.mcp.disconnect(name); delete configs[name];
      await this.persistSettings(() => { configs[name] = previous; });
      this.note(`Removed ${name}.`);
    }
    else throw new Error('/mcp add <name> {"type":"stdio","command":"...","args":[]} or {"type":"http","url":"https://...","headersEnv":{"Authorization":"MCP_AUTH"}}; /mcp connect|disconnect|remove <name>');
  }
  private async pluginCommand(args: string[]): Promise<void> {
    const [action = 'list', id, confirmation] = args;
    const configured = this.config.settings.plugins;
    if (action === 'list' && args.length <= 1) {
      const statuses = await this.plugins.list(configured);
      const problems = this.plugins.drainProblems();
      this.note([
        ...statuses.map(plugin => `${plugin.loaded ? 'loaded' : plugin.enabled ? 'enabled' : 'off'} Â· ${plugin.id}${plugin.name ? ` Â· ${plugin.name} v${plugin.version}` : ''}${plugin.problem ? ` Â· ${plugin.problem}` : ''}`),
        ...problems.map(problem => `problem Â· ${problem}`),
        statuses.length ? '' : 'No plugins configured.',
        'Plugins are trusted JavaScript with the current user permissions. Use /plugins enable <id> to review one, then /plugins enable <id> confirm to run it.',
      ].filter(Boolean).join('\n'));
      return;
    }
    if (action === 'create' && id && args.length === 2) {
      if (Object.hasOwn(configured, id)) throw new Error(`Plugin ${id} is already configured.`);
      const directory = await this.plugins.create(id);
      const previous = configured[id]; configured[id] = { enabled: false };
      try { await this.persistSettings(() => { if (previous) configured[id] = previous; else delete configured[id]; }); }
      catch (error) { throw new Error(`Plugin files were created but could not be registered: ${String((error as Error)?.message ?? error)}. Files remain disabled at ${directory}.`); }
      this.note(`Created disabled plugin ${id} at ${directory}. Review plugin.json and index.mjs before enabling it.`);
      return;
    }
    if (action === 'show' && id && args.length === 2) {
      const preview = await this.plugins.preview(id);
      this.note([`${preview.manifest.name} v${preview.manifest.version}`, preview.manifest.description, `Entry: ${preview.path}`, `SHA-256 approval: ${preview.sha256}`, 'Enabling runs this local JavaScript with PolonRLM’s current user permissions.'].join('\n'));
      return;
    }
    if (action === 'enable' && id && (args.length === 2 || args.length === 3 && confirmation === 'confirm')) {
      const preview = args.length === 2 ? await this.plugins.review(id) : await this.plugins.preview(id);
      if (args.length === 2) {
        this.note([`Review plugin ${preview.manifest.name} v${preview.manifest.version}`, preview.manifest.description, `Entry: ${preview.path}`, `SHA-256: ${preview.sha256}`, 'This is trusted JavaScript with the same file, network, and process permissions as PolonRLM.', `Read the file, then type /plugins enable ${id} confirm to run this exact version.`].join('\n'));
        return;
      }
      if (!this.plugins.consumeReview(id, preview.sha256)) {
        const current = await this.plugins.review(id);
        this.note([`Plugin ${id} was NOT started because its files were not the version from the last review.`, `Entry: ${current.path}`, `Current SHA-256: ${current.sha256}`, 'Read the current plugin source, then confirm it again with /plugins enable ' + id + ' confirm.'].join('\n'));
        return;
      }
      const previous = configured[id];
      configured[id] = { enabled: true, sha256: preview.sha256 };
      try {
        await this.config.save();
        await this.plugins.activate(id, preview.sha256);
      } catch (error) {
        await this.plugins.deactivate(id).catch(() => {});
        if (previous) configured[id] = previous; else delete configured[id];
        await this.config.save().catch(() => {});
        this.sync();
        throw error;
      }
      this.sync();
      this.note(`Enabled ${id} at SHA-256 ${preview.sha256}. The exact file hash is pinned; edits require another review and confirmation.`);
      return;
    }
    if (action === 'disable' && id && args.length === 2) {
      const previous = configured[id]; if (!previous) throw new Error(`Plugin ${id} is not configured.`);
      configured[id] = { ...previous, enabled: false };
      try { await this.persistSettings(() => { configured[id] = previous; }); }
      catch (error) { this.sync(); throw error; }
      await this.plugins.deactivate(id);
      this.sync();
      this.note(`Disabled ${id}. Its files remain in your PolonRLM plugins folder.`);
      return;
    }
    if (action === 'remove' && id && args.length === 2) {
      const previous = configured[id]; if (!previous) throw new Error(`Plugin ${id} is not configured.`);
      delete configured[id];
      try { await this.persistSettings(() => { configured[id] = previous; }); }
      catch (error) { this.sync(); throw error; }
      await this.plugins.deactivate(id);
      this.sync();
      this.note(`Removed ${id} from PolonRLM. Its plugin files remain in your user directory for review.`);
      return;
    }
    throw new Error('/plugins list | create <id> | show <id> | enable <id> [confirm] | disable <id> | remove <id>');
  }
  close(): Promise<void> {
    if (this.closeOperation) return this.closeOperation;
    this.closing = true; this.cancel();
    this.closeOperation = (async () => {
      await this.active;
      try { await this.plugins.close(); } finally {
        try { await this.mcp.close(); } finally {
          try { await this.registry.close(); } finally { this.recoveryCipher.close(); this.store.close(); this.state.status = 'closed'; this.notify(); }
        }
      }
    })();
    return this.closeOperation;
  }
}
