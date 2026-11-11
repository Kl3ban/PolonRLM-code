import { createHash } from 'node:crypto';

export interface FailureLoopResult { count: number; notice?: string }

function normalizeFailure(failure: string): string {
  return failure
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '<id>')
    .replace(/\b[0-9a-f]{32,}\b/gi, '<hash>')
    .replace(/\b\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:z|[+-]\d{2}:?\d{2})?\b/gi, '<time>')
    .replace(/\b(?:in|after)\s+\d+(?:\.\d+)?\s*(?:ms|msec|milliseconds?|seconds?|secs?|minutes?|mins?)\b/gi, '<duration>')
    .replace(/:\d+:\d+\b/g, ':<line>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 1200);
}

/** Counts the same normalized tool failure until verified progress is observed. */
export class FailureLoopGuard {
  private readonly counts = new Map<string, { tool: string; count: number }>();
  private readonly failuresByTool = new Map<string, number>();

  constructor(private readonly threshold: number) {}

  observe(tool: string, failure: string): FailureLoopResult {
    if (this.threshold <= 0) return { count: 0 };
    const normalized = normalizeFailure(failure);
    if (!normalized) return { count: 0 };
    const key = createHash('sha256').update(tool).update('\0').update(normalized).digest('hex');
    const count = (this.counts.get(key)?.count ?? 0) + 1;
    const toolFailureCount = (this.failuresByTool.get(tool) ?? 0) + 1;
    this.counts.delete(key);
    this.counts.set(key, { tool, count });
    this.failuresByTool.delete(tool);
    this.failuresByTool.set(tool, toolFailureCount);
    while (this.counts.size > 128) this.counts.delete(this.counts.keys().next().value!);
    while (this.failuresByTool.size > 128) this.failuresByTool.delete(this.failuresByTool.keys().next().value!);
    if (count >= this.threshold) return {
      count,
      notice: `Adaptive loop guard: the same ${tool} failure occurred ${count} times. Stop repeating this failing approach. Use new evidence to change the code or command, or report the blocker. A recorded workspace edit or passing test resets this guard.`,
    };
    if (toolFailureCount >= this.threshold) return {
      count: toolFailureCount,
      notice: `Adaptive loop guard: ${tool} has failed ${toolFailureCount} times without verified progress, with changing errors. Stop trying variations without new evidence. Change the workspace, use a different diagnostic approach, or report the blocker. A recorded workspace edit or passing test resets this guard.`,
    };
    return { count };
  }

  reset(): void { this.counts.clear(); this.failuresByTool.clear(); }
}
