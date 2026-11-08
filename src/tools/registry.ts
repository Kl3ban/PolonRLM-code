import { z } from 'zod';
import type { Mode, ToolSpec, ImageAttachment } from '../core/types.js';
import type { Permissions } from '../core/permissions.js';
import { clip } from '../core/context.js';
import { redact } from '../core/secrets.js';

export interface ToolContext { signal: AbortSignal; mode: Mode; vision?: boolean; isolated?: boolean; onImage?: (image: ImageAttachment) => void }
type Entry = { spec: ToolSpec; schema: z.ZodType; run: (args: any, context: ToolContext) => Promise<unknown>; readOnly: boolean; modeMutates?: (args: any) => boolean };
export interface ToolAvailability { name: string; description: string; parameters?: Record<string, unknown>; available: boolean; reason?: string }
export class ToolRegistry {
  private entries = new Map<string, Entry>();
  private disposers: (() => Promise<void>)[] = [];
  onClose(dispose: () => Promise<void>): void { this.disposers.push(dispose); }
  async close(): Promise<void> { const results = await Promise.allSettled(this.disposers.splice(0).map(dispose => dispose())); if (results.some(result => result.status === 'rejected')) throw new Error('Could not close all tools.'); }
  constructor(private permissions: Permissions, private limit: number | (() => number)) {}
  getSpec(name: string): ToolSpec | undefined { return this.entries.get(name)?.spec; }
  isReadOnly(name: string, args?: unknown): boolean { const entry = this.entries.get(name); return !!entry && !this.mutatesInMode(entry, args); }
  parseArguments(name: string, args: Record<string, unknown>): Record<string, unknown> {
    const entry = this.entries.get(name); if (!entry) throw new Error(`Unknown tool: ${name}`);
    const parsed = entry.schema.safeParse(args);
    if (!parsed.success) throw new Error(`Invalid arguments ${name}: ${parsed.error.issues.slice(0, 4).map(issue => `${issue.path.join('.') || 'arguments'} — ${issue.message}`).join('; ')}. Correct the call to match the tool schema.`);
    return parsed.data as Record<string, unknown>;
  }
  unavailableReason(name: string, args: Record<string, unknown>, mode: Mode): string | undefined {
    const entry = this.entries.get(name); if (!entry) throw new Error(`Unknown tool: ${name}`);
    const parsed = this.parseArguments(name, args);
    return this.permissions.unavailableReason(name, this.mutatesInMode(entry, parsed), mode);
  }
  add(name: string, description: string, schema: z.ZodType, readOnly: boolean, run: Entry['run'], modeMutates?: Entry['modeMutates']): void {
    this.entries.set(name, { spec: { name, description, parameters: z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown> }, schema, run, readOnly, modeMutates });
  }
  private mutatesInMode(entry: Entry, args?: unknown): boolean { return entry.modeMutates ? entry.modeMutates(args ?? {}) : !entry.readOnly; }
  discovery(mode: Mode): ToolAvailability[] {
    return [...this.entries.values()].map(entry => {
      const name = entry.spec.name;
      const mutating = this.mutatesInMode(entry);
      const available = this.permissions.available(name, mutating, mode);
      const reason = available ? undefined : this.permissions.unavailableReason(name, mutating, mode);
      return { name, description: entry.spec.description, available, ...(reason ? { reason, parameters: entry.spec.parameters } : {}) };
    });
  }
  specs(mode: Mode): ToolSpec[] { return [...this.entries.values()].filter(entry => this.permissions.available(entry.spec.name, this.mutatesInMode(entry), mode)).map(entry => entry.spec); }
  async execute(name: string, args: Record<string, unknown>, context: ToolContext): Promise<string> {
    context.signal.throwIfAborted();
    const entry = this.entries.get(name); if (!entry) throw new Error(`Unknown tool: ${name}`);
    const parsed = this.parseArguments(name, args);
    const reason = this.permissions.unavailableReason(name, this.mutatesInMode(entry, parsed), context.mode);
    if (reason) throw new Error(`Tool ${name} is unavailable: ${reason} Do not retry without approval. If the user explicitly requests this action, use request_tool to ask approval for this exact call. Do not retry after a rejection.`);
    await this.permissions.check(name, 'read', name, undefined, context.mode);
    const result = await entry.run(parsed, context);
    return clip(redact(typeof result === 'string' ? result : JSON.stringify(result)), typeof this.limit === 'number' ? this.limit : this.limit());
  }
  executeWithOneTimeApproval(name: string, args: Record<string, unknown>, context: ToolContext): Promise<string> {
    return this.permissions.withOneTimeToolApproval(() => this.execute(name, args, context));
  }
}
