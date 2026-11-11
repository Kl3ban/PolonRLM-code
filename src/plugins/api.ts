export const POLONRLM_PLUGIN_API_VERSION = 1 as const;

export interface PluginTaskContext {
  readonly sessionId: string;
  readonly workspace: string;
  readonly task: string;
  readonly role: string;
  readonly mode: string;
}

export interface PluginToolContext extends PluginTaskContext {
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface PluginToolResult extends PluginToolContext {
  readonly result: string;
  readonly isError: boolean;
  readonly durationMs: number;
}

export interface PluginTaskResult extends PluginTaskContext {
  readonly status: 'complete' | 'failed' | 'cancelled';
  readonly answer?: string;
}

export type PluginHandler<T, R = void> = (event: Readonly<T>) => R | Promise<R>;

export interface PolonRLMPluginAPI {
  readonly version: typeof POLONRLM_PLUGIN_API_VERSION;
  readonly hooks: {
    beforeTask(handler: PluginHandler<PluginTaskContext, string | void>): void;
    beforeTool(handler: PluginHandler<PluginToolContext, string | void>): void;
    afterTool(handler: PluginHandler<PluginToolResult>): void;
    afterTask(handler: PluginHandler<PluginTaskResult>): void;
  };
}

/** A plugin is trusted local JavaScript and runs with PolonRLM's user permissions. */
export interface PolonRLMPlugin {
  readonly id: string;
  readonly version: string;
  activate(api: PolonRLMPluginAPI): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
