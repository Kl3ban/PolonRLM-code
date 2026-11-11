export type Mode = 'PLAN' | 'BUILD' | 'REVIEW';
export const AGENT_MODEL_ROLES = ['orchestrator', 'planner', 'coder', 'researcher', 'reviewer', 'tester', 'debugger'] as const;
export type AgentModelRole = typeof AGENT_MODEL_ROLES[number];
export interface ModelRoute { provider: string; model?: string }
export interface ModelRoleBudget { maxCalls?: number; maxTokens?: number; maxCost?: number }
export interface TrustedPluginConfig { enabled: boolean; sha256?: string }
export type ProviderKind = 'openai' | 'compatible' | 'anthropic' | 'google';
export type ReasoningControl = 'effort' | 'toggle' | 'thinking-level' | 'thinking-budget';
export interface ProviderConfig {
  id: string; kind: ProviderKind; baseURL: string; model: string;
  apiKeyEnv?: string; reasoning?: string; reasoningControl?: ReasoningControl; reasoningEfforts?: string[];
  requestTimeoutMs?: number;
  temperature?: number; inputPrice?: number; outputPrice?: number;
  contextWindow?: number; maxOutputTokens?: number; reasoningSupported?: boolean; toolCalling?: boolean; vision?: boolean;
}
export interface ModelInfo {
  id: string; name?: string; contextWindow?: number; maxOutputTokens?: number; toolCalling?: boolean;
  vision?: boolean; reasoning?: boolean; reasoningControl?: ReasoningControl; reasoningEfforts?: string[]; inputPrice?: number; outputPrice?: number;
}
export interface ToolCall { id: string; name: string; arguments: Record<string, unknown>; validationError?: string; providerOptions?: Record<string, Record<string, unknown>> }
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'; content: string;
  toolCalls?: ToolCall[]; toolCallId?: string; name?: string; isError?: boolean;
  toolDurationMs?: number;
  /** Provider model that produced an assistant reply; kept for resumed transcripts. */
  model?: string;
  /** Transient tool screenshots; omitted from SQLite history and audit. */
  images?: ImageAttachment[];
}
export interface ImageAttachment { data: string; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; tokenEstimate?: number; name?: string }
export interface ToolSpec { name: string; description: string; parameters: Record<string, unknown> }
export interface Usage { input: number; output: number; cached: number; cost: number; costKnown: boolean }
export interface ModelReply { text: string; toolCalls: ToolCall[]; usage: Usage; finishReason?: string }
export interface LLMProvider {
  complete(messages: Message[], tools: ToolSpec[], onDelta: (text: string) => void, signal: AbortSignal): Promise<ModelReply>;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
}
export interface Settings {
  configVersion: number;
  provider: string; providers: Record<string, ProviderConfig>; fallback: string[];
  mode: Mode; cortex: number; cortexStrategy: 'adaptive' | 'fixed'; repeatFailureThreshold: number; maxSteps: number; maxInputTokens: number; maxOutputTokens: number;
  tokenBudget: number; dollarBudget: number; maxAgents: number; maxProcesses: number; maxDepth: number;
  permissions: 'ask' | 'workspace' | 'readonly' | 'all'; toolPermissions: Record<string, 'ask' | 'auto' | 'off'>; allowTools: string[]; denyTools: string[];
  theme: 'dark' | 'light'; toolOutputLimit: number; timeoutMs: number; webSearchMode: 'auto' | 'bing' | 'brave' | 'yahoo'; browserEngine: 'auto' | 'chromium' | 'chrome' | 'edge' | 'brave' | 'firefox';
  verificationCommands: string[]; verificationMode: 'manual' | 'after_changes'; verificationRepairAttempts: number; mcp: Record<string, MCPConfig>;
  agentToolProfiles: Record<string, string[]>;
  modelRoutes: Partial<Record<AgentModelRole, ModelRoute>>;
  modelRoleBudgets: Partial<Record<AgentModelRole, ModelRoleBudget>>;
  plugins: Record<string, TrustedPluginConfig>;
  sandboxMode: 'off' | 'auto' | 'required'; sandboxNetworkDomains: string[];
}
export interface MCPConfig {
  type: 'stdio' | 'http'; command?: string; args?: string[]; url?: string;
  env?: Record<string, string>; headersEnv?: Record<string, string>; timeoutMs?: number;
}
export interface ApprovalRequest { tool: string; description: string; preview?: string; oneTimeOverride?: boolean }
export type Approve = (request: ApprovalRequest, signal?: AbortSignal) => Promise<boolean>;
export interface RuntimeEvent {
  type: 'text' | 'tool' | 'status' | 'usage' | 'agent' | 'error' | 'reset';
  text?: string; name?: string; state?: string; usage?: Usage; id?: string; agentRole?: string; truncated?: boolean; model?: string;
  durationMs?: number; contextTokens?: number; contextLimit?: number; tokenLimit?: number; dollarLimit?: number; toolDetail?: string;
}
export interface ViewMessage {
  role: string; text: string; speaker?: string;
  toolCallId?: string; toolName?: string; toolState?: 'running' | 'done' | 'error'; toolOutput?: string; toolOutputTruncated?: boolean; toolDurationMs?: number; agentRole?: string; toolDetail?: string;
}
export interface SessionInfo { id: string; title: string; updated: number }
export interface AgentInfo { id: string; role: string; status: string; task?: string; progress?: number; totalSteps?: number; changedFiles?: string[] }
export interface UIState {
  question?: import('./workflows.js').AgentQuestion;
  workspace: string; sessionId: string; provider: string; model: string; mode: Mode; cortex: number;
  busy: boolean; status: string; messages: ViewMessage[]; usage: Usage; taskUsage: Usage;
  agents: AgentInfo[]; attachments: { name: string; mediaType: string; bytes: number }[];
  contextTokens: number; contextLimit: number; contextLimitSource: 'app' | 'model' | 'both' | 'unknown'; tokenLimit: number; dollarLimit: number; vision?: boolean; theme: 'dark' | 'light';
}
export interface UIController {
  readSettings?(): { values: Record<string, string | number>; tools: { name: string; description: string; policy: string; available: boolean }[] };
  updateSetting?(name: string, value: string | number): Promise<void>;
  answerQuestion?(answer: string | null): void;
  snapshot(): UIState;
  subscribe(listener: () => void): () => void;
  submit(text: string): Promise<void>;
  cancel(): void;
  cycleMode(): void;
  close(): Promise<void>;
  setApprover(approve: Approve): void;
  listModels?(providerId?: string): Promise<ModelInfo[]>;
  listProviders?(): { id: string; url: string; model: string }[];
  setModel?(id: string, persist?: boolean): Promise<void>;
  listEfforts?(): { id: string; label: string; detail?: string }[];
  setEffort?(id: string): Promise<void>;
  selectProvider?(id: string): Promise<void>;
  setApiKey?(key: string): Promise<void>;
  configureProvider?(provider: ProviderConfig, apiKey?: string): Promise<void>;
  listSessions?(query?: string): SessionInfo[];
  renameSession?(id: string, title: string): void;
  resumeSession?(id?: string): void;
  stopAgent?(id: string): void;
  setBudgets?(tokenLimit: number, dollarLimit: number): Promise<void>;
  addImagePath?(filename: string): Promise<void>;
  addImageData?(data: string, name?: string): void;
  removeImage?(index: number): void;
  clearImages?(): void;
}
