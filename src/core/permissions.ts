import { AsyncLocalStorage } from 'node:async_hooks';
import type { Approve, Mode, Settings } from './types.js';

export class Permissions {
  approve: Approve = async () => false;
  private approvedToolCall = new AsyncLocalStorage<boolean>();
  private toolInvocation = new AsyncLocalStorage<string>();
  constructor(private settings: Settings) {}
  settingsDeny(tool: string): boolean { return this.settings.denyTools.includes(tool); }
  settingsAllowlistExcludes(tool: string): boolean { return !!this.settings.allowTools.length && !this.settings.allowTools.includes(tool); }
  explicitlyDisabled(tool: string): boolean { return this.settings.toolPermissions[tool] === 'off'; }
  requiresApproval(tool: string): boolean { return !this.approvedToolCall.getStore() && this.settings.toolPermissions[tool] === 'ask'; }
  get readonly(): boolean { return this.settings.permissions === 'readonly'; }
  unavailableReason(tool: string, mutating = false, mode: Mode = this.settings.mode): string | undefined {
    if (this.approvedToolCall.getStore()) return undefined;
    const policy = this.settings.toolPermissions[tool];
    if (policy === 'off') return `disabled for this tool; use /permissions ${tool} ask or auto to enable it.`;
    if (this.settings.permissions !== 'all' && mutating && mode !== 'BUILD' && tool !== 'computer_use') return `mode ${mode} blocks this action; it requires BUILD, which can be enabled with /mode BUILD.`;
    if (this.settings.permissions !== 'all' && mutating && this.settings.permissions === 'readonly') return `blocked by readonly; permissions can be changed with /permissions ask.`;
    // An explicit per-tool rule supersedes the legacy allow/deny lists. The
    // global `all` mode does too; `/permissions all` is an intentional opt-in.
    if (policy === 'ask' || policy === 'auto' || this.settings.permissions === 'all') return undefined;
    if (this.settings.denyTools.includes(tool)) return `blocked by the denylist. Do not bypass it. This can be removed with /permissions undeny ${tool}.`;
    if (this.settings.allowTools.length && !this.settings.allowTools.includes(tool)) return `not on the allowlist. This can be added with /permissions allow ${tool}.`;
    return undefined;
  }
  available(tool: string, mutating = false, mode: Mode = this.settings.mode): boolean {
    return this.unavailableReason(tool, mutating, mode) === undefined;
  }
  withOneTimeToolApproval<T>(action: () => Promise<T>): Promise<T> { return this.approvedToolCall.run(true, action); }
  async requestOneTimeToolApproval(tool: string, description: string, preview: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const allowed = await this.waitForApproval({ tool, description, preview, oneTimeOverride: true }, signal);
    if (!allowed) throw new Error(`Approval denied: the user rejected this one-time call to ${tool}. Do not retry. Tell the user and wait for a new message.`);
  }
  private async waitForApproval(request: Parameters<Approve>[0], signal?: AbortSignal): Promise<boolean> {
    const approval = this.approve(request, signal);
    if (!signal) return approval;
    let abort: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('Task cancelled.'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    try { const allowed = await Promise.race([approval, cancelled]); signal.throwIfAborted(); return allowed; }
    finally { if (abort) signal.removeEventListener('abort', abort); }
  }
  async runToolInvocation<T>(tool: string, description: string, preview: string | undefined, mode: Mode, signal: AbortSignal | undefined, action: () => Promise<T>): Promise<T> {
    await this.check(tool, 'read', description, preview, mode, signal);
    const policy = this.settings.toolPermissions[tool];
    // Only explicit invocation policies have already settled the whole call.
    // Default policies still need the handler's risk-specific approval.
    if (policy === 'ask' || policy === 'auto' || this.settings.permissions === 'all') return this.toolInvocation.run(tool, action);
    return action();
  }
  async check(tool: string, risk: 'read' | 'write' | 'delete' | 'shell' | 'external', description: string, preview?: string, mode: Mode = this.settings.mode, signal?: AbortSignal, modeMutates?: boolean): Promise<void> {
    signal?.throwIfAborted();
    if (this.approvedToolCall.getStore()) return;
    const reason = this.unavailableReason(tool, modeMutates ?? (risk !== 'read'), mode);
    if (reason) throw new Error('Tool ' + tool + ' is unavailable: ' + reason + ' Do not retry without approval. If the user explicitly requests this action, use request_tool to ask approval for this exact call. Do not retry after a rejection.');
    if (this.toolInvocation.getStore() === tool) return;
    const policy = this.settings.toolPermissions[tool];
    if (policy === 'ask') { if (!await this.waitForApproval({ tool, description, preview }, signal)) throw new Error('Approval denied: the user rejected action ' + tool + '. Do not retry. Tell the user and wait for a new message.'); return; }
    if (policy === 'auto' || this.settings.permissions === 'all') return;
    if (risk === 'read') return;
    if (risk === 'write' && this.settings.permissions === 'workspace') return;
    if (!await this.waitForApproval({ tool, description, preview }, signal)) throw new Error('Approval denied: the user rejected action ' + tool + '. Do not retry. Tell the user and wait for a new message.');
  }
}
