export const CORTEX = [
  { name: 'Fast', steps: 8, agents: 0, guidance: 'Take the shortest correct path. Do not delegate.' },
  { name: 'Standard', steps: 24, agents: 2, guidance: 'Use a short plan only for complex tasks. Check the changed behavior.' },
  { name: 'Advanced', steps: 36, agents: 3, guidance: 'Plan, execute, and verify complex tasks. Delegate only independent work.' },
  { name: 'Deep', steps: 48, agents: 3, guidance: 'For difficult bugs, gather evidence and test a hypothesis. Do not repeat successful checks.' },
  { name: 'Expert', steps: 64, agents: 4, guidance: 'For important changes, use an independent reviewer if the budget allows.' },
  { name: 'Maximum', steps: 80, agents: 6, guidance: 'Compare alternatives only when the outcome is uncertain. Avoid extra calls without a clear benefit.' }
] as const;

export interface CortexDecision { requested: number; level: number; score: number; reason: string }

const complexSignals = /\b(?:architect(?:ure|ural)|migrat(?:e|ion)|refactor|rewrite|benchmark|security|concurren(?:cy|t)|race condition|deadlock|transaction|integration|end[- ]to[- ]end|whole project|across (?:the )?(?:project|files|modules)|multi[- ]file|wieloplikow|wielomoduł|architektur\w*|migracj\w*|refaktor\w*|przepisz|benchmark\w*|bezpiecze\w*|równoleg\w*|wyścig\w*|integracj\w*|cały projekt|wielu plik\w*)\b/i;
const mediumSignals = /\b(?:implement|feature|fix|bug|test|verify|regression|provider|database|api|tool|implementuj|dodaj|napraw|błąd|test\w*|sprawdź|dostawc\w*|baza danych|narzędzi\w*|api)\b/i;
const simpleSignals = /\b(?:typo|spelling|punctuation|one[- ]line|simple rename|format whitespace|literówk\w*|ortograf\w*|interpunkcj\w*|jedna linia|prosta nazw\w*)\b/i;
const continuation = /^(?:continue|keep going|go on|resume|dokończ|kontynuuj|rób dalej|dalej|jedź dalej|pracuj dalej)[.!\s]*$/i;

/** Pick a task-sized strategy without adding calls or changing the user-selected ceiling. */
export function chooseCortex(requested: number, task: string, strategy: 'adaptive' | 'fixed' = 'adaptive'): CortexDecision {
  const level = Math.max(0, Math.min(5, Math.floor(requested)));
  if (strategy === 'fixed' || level === 0) return { requested: level, level, score: 0, reason: strategy === 'fixed' ? 'fixed setting' : 'Cortex disabled by user' };
  const value = task.trim();
  if (simpleSignals.test(value)) return { requested: level, level: 0, score: 0, reason: 'small text-only change' };
  let score = 0;
  if (complexSignals.test(value)) score += 4;
  if (mediumSignals.test(value)) score += 1;
  if (value.length > 500) score += 1;
  if (value.length > 1400) score += 1;
  const paths = new Set([...value.matchAll(/(?:^|[\s"'`])((?:[\w@.-]+[\\/])+[\w@.-]+\.[A-Za-z0-9]{1,8})/g)].map(match => match[1]!.toLowerCase()));
  if (paths.size >= 2) score += 2;
  else if (paths.size === 1) score += 1;
  if (/\b(?:and|then|both|multiple|several|plus|oraz|potem|oba|wiele|kilka|również)\b/i.test(value)) score += 1;
  if (/\b(?:tests?|testy|sprawdź|verify|regression)\b/i.test(value)) score += 1;
  if (score <= 1) return { requested: level, level: 0, score, reason: 'small task; delegation skipped' };
  if (score <= 3) return { requested: level, level: Math.min(level, 1), score, reason: 'focused task' };
  if (score <= 5) return { requested: level, level: Math.min(level, 2), score, reason: 'moderate task' };
  if (score <= 7) return { requested: level, level: Math.min(level, 3), score, reason: 'complex task' };
  return { requested: level, level, score, reason: 'large or cross-cutting task' };
}

export function cortexTaskText(task: string, previousUserTasks: string[]): string {
  if (!continuation.test(task.trim())) return task;
  return previousUserTasks.at(-1)?.trim() || task;
}

/** Raise effort by one level without exceeding the user's selected ceiling. */
export function escalateCortex(decision: CortexDecision, reason: string): CortexDecision {
  if (decision.level >= decision.requested) return decision;
  return { ...decision, level: Math.min(decision.requested, decision.level + 1), reason: `stagnation: ${reason}` };
}

export interface CortexProjectSignals {
  sourceFiles: number;
  importEdges: number;
  truncated: boolean;
}

/** Raise the initial text heuristic when the actual project is large or partial. */
export function assessCortexProject(decision: CortexDecision, signals: CortexProjectSignals): CortexDecision {
  let level = decision.level;
  if (signals.truncated || signals.sourceFiles >= 250 || signals.importEdges >= 150) level = Math.max(level, 2);
  else if (signals.sourceFiles >= 80 || signals.importEdges >= 60) level = Math.max(level, 1);
  level = Math.min(decision.requested, level);
  return level === decision.level ? decision : { ...decision, level, reason: `project analysis: ${signals.sourceFiles} source files, ${signals.importEdges} import edges${signals.truncated ? ', index truncated' : ''}` };
}
