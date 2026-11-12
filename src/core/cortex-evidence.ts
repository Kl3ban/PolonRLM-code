import { randomUUID } from 'node:crypto';
import type { CortexDecision } from './cortex.js';
import type { Mode, Settings, Usage } from './types.js';

export function cortexModelKey(settings: Settings): string {
  const route = settings.modelRoutes.orchestrator, provider = route?.provider ?? settings.provider;
  return `${provider}/${route?.model ?? settings.providers[provider]?.model ?? ''}`;
}

export type CortexTaskClass = 'bugfix' | 'feature' | 'refactor' | 'research' | 'analysis';
export function cortexTaskClass(task: string): CortexTaskClass {
  if (/refactor|migrat|architect|refaktor|migracj|architektur/i.test(task)) return 'refactor';
  if (/\bfix\b|\bbug\b|regression|napraw|błąd|błęd/i.test(task)) return 'bugfix';
  if (/\badd\b|implement|feature|dodaj|rozbuduj/i.test(task)) return 'feature';
  if (/research|search|browse|wyszuk|internet|źródł/i.test(task)) return 'research';
  return 'analysis';
}
const band = (score: number) => score <= 3 ? 'focused' : score <= 5 ? 'moderate' : 'complex';
export interface CortexRunRecord {
  id: string; session: string; workspace: string; created: number; model: string; mode: Mode; taskClass: CortexTaskClass; band: string;
  requested: number; initialLevel: number; peakLevel: number; reason: string;
  status: 'complete' | 'failed' | 'cancelled'; verificationId?: string;
  outcome: 'checks_passed' | 'checks_failed' | 'unverified' | 'cancelled' | 'stalled';
  calls: number; inputTokens: number; outputTokens: number; tools: number; toolErrors: number; durationMs: number;
  compactions: number; compactedTokenEstimate: number; recallHits: number;
}
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0; };

/** Conservative feedback from comparable, check-backed runs. Never treat prose as proof. */
export function calibrateCortex(decision: CortexDecision, taskClass: CortexTaskClass, model: string, mode: Mode, history: CortexRunRecord[]): CortexDecision {
  if (!decision.level || decision.requested === 0) return decision;
  const comparable = history.filter(run => run.model === model && run.mode === mode && run.taskClass === taskClass && run.band === band(decision.score)).slice(0, 24);
  const lower = comparable.filter(run => run.initialLevel === decision.level - 1 && ['checks_passed', 'checks_failed', 'stalled'].includes(run.outcome)).slice(0, 8);
  const current = comparable.filter(run => run.initialLevel === decision.level && run.outcome === 'checks_passed');
  const tokens = (run: CortexRunRecord) => run.inputTokens + run.outputTokens;
  if (lower.length >= 3 && lower.every(run => run.outcome === 'checks_passed' && run.peakLevel === decision.level - 1) && (current.length < 3 || median(lower.map(tokens)) < median(current.map(tokens)) && median(lower.map(run => run.calls)) <= median(current.map(run => run.calls)))) {
    return { ...decision, level: decision.level - 1, reason: `history: ${lower.length} comparable check-backed runs at a lower level; monitor current evidence` };
  }
  const failed = comparable.filter(run => run.initialLevel === decision.level && run.outcome === 'checks_failed').slice(0, 8);
  if (failed.length >= 2 && current.length === 0 && decision.level < decision.requested) return { ...decision, level: decision.level + 1, reason: `history: ${failed.length} comparable runs ended with failing checks` };
  return decision;
}

export class CortexRunEvidence {
  readonly models = new Set<string>();
  decision?: CortexDecision;
  initialLevel = 0;
  peakLevel = 0;
  tools = 0; toolErrors = 0; compactions = 0; compactedTokenEstimate = 0; recallHits = 0; stalled = false;
  private lastChange = 0;
  private check?: { sequence: number; exitCode: number };
  private taskClass?: CortexTaskClass;
  private readonly started = Date.now();
  choose(decision: CortexDecision, taskClass?: CortexTaskClass): void { this.decision = decision; this.initialLevel = decision.level; this.peakLevel = decision.level; this.taskClass = taskClass; }
  escalate(decision: CortexDecision): void { this.peakLevel = Math.max(this.peakLevel, decision.level); }
  observe(isError: boolean, changed: boolean, checkExitCode?: number): void {
    this.tools++; if (isError) this.toolErrors++;
    if (!isError && changed && checkExitCode === undefined) this.lastChange = this.tools;
    if (!isError && checkExitCode !== undefined) this.check = { sequence: this.tools, exitCode: checkExitCode };
  }
  finish(session: string, workspace: string, model: string, mode: Mode, task: string, status: 'complete' | 'failed' | 'cancelled', calls: number, usage: Pick<Usage, 'input' | 'output'>): CortexRunRecord {
    const decision = this.decision ?? { requested: 0, level: 0, score: 0, reason: 'no decision' };
    const currentCheck = this.check && this.check.sequence >= this.lastChange;
    const outcome = status === 'cancelled' ? 'cancelled' : this.stalled ? 'stalled' : status === 'complete' && currentCheck ? this.check!.exitCode === 0 ? 'checks_passed' : 'checks_failed' : 'unverified';
    return { id: randomUUID(), session, workspace, model, mode, taskClass: this.taskClass ?? cortexTaskClass(task), band: band(decision.score), created: Date.now(),
      requested: decision.requested, initialLevel: this.initialLevel, peakLevel: this.peakLevel, reason: decision.reason, status, outcome,
      calls, inputTokens: usage.input, outputTokens: usage.output, tools: this.tools, toolErrors: this.toolErrors, durationMs: Date.now() - this.started,
      compactions: this.compactions, compactedTokenEstimate: this.compactedTokenEstimate, recallHits: this.recallHits };
  }
}

export function formatCortexStats(runs: CortexRunRecord[]): string {
  if (!runs.length) return 'Cortex has no recorded runs in this project yet. New tasks record local routing and verification evidence without an extra model request.';
  return ['Cortex evidence for this project',
    `${runs.length} recent runs; ${runs.filter(run => run.outcome === 'checks_passed').length} ended with passing checks; ${runs.filter(run => run.outcome === 'checks_failed').length} with failing checks; ${runs.filter(run => run.outcome === 'unverified').length} unverified; ${runs.filter(run => run.outcome === 'stalled').length} stalled; ${runs.filter(run => run.outcome === 'cancelled').length} cancelled.`,
    `Median model calls: ${median(runs.map(run => run.calls))}. Median reported input + output tokens: ${median(runs.map(run => run.inputTokens + run.outputTokens))}.`,
    `Compactions: ${runs.reduce((sum, run) => sum + run.compactions, 0)}. Recalled source excerpts: ${runs.reduce((sum, run) => sum + run.recallHits, 0)}.`,
    'Passing checks are evidence for those commands, not proof the whole task is correct. Local compaction estimates are not provider-billed savings. Feedback is separated by task class, complexity, mode and selected model; it respects the configured Cortex ceiling.',
  ].join('\n');
}
