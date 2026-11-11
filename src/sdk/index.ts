import { Controller } from '../core/controller.js';
import { ConfigManager, settingsSchema } from '../core/config.js';
import { SecretVault, redact } from '../core/secrets.js';
import type { Approve, ProviderConfig, RuntimeEvent, Settings, Usage } from '../core/types.js';

export interface AgentSdkProvider {
  id: string;
  config: Omit<ProviderConfig, 'id'>;
  /** Stored in the local secret vault, never in the returned client or logs. */
  apiKey?: string;
}

export interface AgentSdkOptions {
  workspace: string;
  home?: string;
  settings?: Partial<Settings>;
  provider?: AgentSdkProvider;
  approve?: Approve;
}

export interface AgentRunResult {
  text: string;
  sessionId: string;
  usage: Usage;
}

export interface AgentDescription {
  sessionId: string;
  workspace: string;
  provider: string;
  model: string;
  mode: string;
  status: string;
}

export interface AgentToolInfo {
  name: string;
  description: string;
  available: boolean;
  policy: string;
}

/** Small typed wrapper around Controller for embedding and the HTTP server. */
export class AgentClient {
  private constructor(private readonly controller: Controller) {}

  static async create(options: AgentSdkOptions): Promise<AgentClient> {
    if (!options.workspace || typeof options.workspace !== 'string') throw new Error('AgentClient requires a workspace path.');
    const config = new ConfigManager(options.home);
    await config.load();
    const overrides: Partial<Settings> = { ...(options.settings ?? {}) };
    if (options.provider) {
      if (!options.provider.id || !options.provider.config?.baseURL) throw new Error('AgentClient provider requires an id, config.baseURL and config.model.');
      if (options.provider.apiKey) await new SecretVault(config.home).set(options.provider.id, options.provider.apiKey);
      overrides.provider = options.provider.id;
      overrides.providers = { ...config.settings.providers, [options.provider.id]: { ...options.provider.config, id: options.provider.id } };
    }
    // Validate before creating any store or process.
    settingsSchema.parse({ ...config.settings, ...overrides });
    const controller = await Controller.open(options.workspace, config.home, overrides);
    if (options.approve) controller.setApprover(options.approve);
    return new AgentClient(controller);
  }

  /** Embed an already-created Controller, useful for tests and custom hosts. */
  static fromController(controller: Controller): AgentClient {
    return new AgentClient(controller);
  }

  get sessionId(): string { return this.controller.snapshot().sessionId; }
  get controllerRef(): Controller { return this.controller; }

  describe(): AgentDescription {
    const snapshot = this.controller.snapshot();
    return {
      sessionId: snapshot.sessionId, workspace: snapshot.workspace, provider: snapshot.provider, model: snapshot.model,
      mode: snapshot.mode, status: snapshot.status,
    };
  }

  tools(): AgentToolInfo[] {
    return this.controller.readSettings().tools;
  }

  setEventSink(sink?: (event: RuntimeEvent) => void): void {
    this.controller.onEvent = sink;
  }

  async run(prompt: string, onEvent?: (event: RuntimeEvent) => void): Promise<AgentRunResult> {
    if (!prompt || typeof prompt !== 'string') throw new Error('AgentClient.run requires a non-empty prompt.');
    const previous = this.controller.onEvent;
    if (onEvent) this.controller.onEvent = event => {
      try { onEvent(event); } catch { /* A listener must not break the task. */ }
      previous?.(event);
    };
    try { await this.controller.submit(prompt); }
    finally { this.controller.onEvent = previous; }
    const snapshot = this.controller.snapshot();
    const text = snapshot.messages.filter(message => message.role === 'assistant').at(-1)?.text ?? '';
    return { text: redact(text), sessionId: snapshot.sessionId, usage: snapshot.taskUsage };
  }

  cancel(): void { this.controller.cancel(); }
  async close(): Promise<void> { await this.controller.close(); }
}
