import { createHash } from 'node:crypto';

const MAX_CYCLE_LENGTH = 64;
const HISTORY_CAPACITY = MAX_CYCLE_LENGTH * 2;

export interface ToolCycleResult { notice?: string; stop: boolean }

type Frame = { action: string; fingerprint: string };

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }

function cycleHash(frames: Frame[]): string {
  const parts = frames.map(frame => `${frame.action}:${frame.fingerprint}`);
  let best = 0;
  for (let candidate = 1; candidate < parts.length; candidate++) {
    for (let offset = 0; offset < parts.length; offset++) {
      const left = parts[(candidate + offset) % parts.length]!;
      const right = parts[(best + offset) % parts.length]!;
      if (left === right) continue;
      if (left < right) best = candidate;
      break;
    }
  }
  return hash([...parts.slice(best), ...parts.slice(0, best)].join('|'));
}

function normalizeOutput(value: string): string {
  return value.slice(0, 16_000)
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '<id>')
    .replace(/\b[0-9a-f]{32,}\b/gi, '<hash>')
    .replace(/\b\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:z|[+-]\d{2}:?\d{2})?\b/gi, '<time>')
    .replace(/\b(?:in|after)\s+\d+(?:\.\d+)?\s*(?:ms|msec|milliseconds?|seconds?|secs?|minutes?|mins?)\b/gi, '<duration>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4_000);
}

/** Detects repeated bounded tool sequences when no verified project progress occurs. */
export class ToolCycleGuard {
  private history: Frame[] = [];
  private readonly warnedCycles = new Set<string>();

  observe(tool: string, args: Record<string, unknown>, result: string, isError: boolean): ToolCycleResult {
    const action = hash(tool + '\0' + stableJson(args));
    const fingerprint = hash(`${isError ? 'error' : 'ok'}\0${normalizeOutput(result)}`);
    this.history.push({ action, fingerprint });
    if (this.history.length > HISTORY_CAPACITY) this.history.shift();

    // Keep two copies of cycles up to the cap without growing with task duration.
    for (let length = 2; length <= MAX_CYCLE_LENGTH; length++) {
      if (this.history.length < length * 2) continue;
      const previous = this.history.slice(-length * 2, -length);
      const current = this.history.slice(-length);
      if (previous.some((frame, index) => frame.action !== current[index]!.action || frame.fingerprint !== current[index]!.fingerprint)) continue;
      if (new Set(current.map(frame => frame.action)).size < 2) continue;
      // A repeated cycle may be observed from a different starting step once
      // the third pass begins. Treat rotations as the same cycle to avoid
      // warning on every phase and evicting the original stop signal.
      const cycleId = cycleHash(current);
      if (this.warnedCycles.has(cycleId)) return {
        stop: true,
        notice: `Adaptive tool-cycle guard: the same ${length}-step tool sequence repeated again after a warning, with no verified workspace change. The task was stopped; use the collected results to explain the blocker or choose a genuinely different approach.`,
      };
      this.warnedCycles.add(cycleId);
      while (this.warnedCycles.size > 32) this.warnedCycles.delete(this.warnedCycles.values().next().value!);
      return {
        stop: false,
        notice: `Adaptive tool-cycle guard: the same ${length}-step tool sequence repeated twice without verified workspace progress. Do not repeat it; use the results already collected or change the diagnostic approach. A workspace edit or passing test resets this guard.`,
      };
    }
    return { stop: false };
  }

  reset(): void { this.history = []; this.warnedCycles.clear(); }
}
