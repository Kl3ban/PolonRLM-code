import type { Settings } from '../core/types.js';

export type BenchmarkProfileName = 'single' | 'adaptive' | 'fixed';

export interface BenchmarkProfile {
  name: BenchmarkProfileName;
  settings: Pick<Settings, 'cortex' | 'cortexStrategy' | 'maxAgents' | 'maxDepth'>;
  subagents: 'disabled' | 'enabled';
}

/** Keep the default run one-agent and opt-in the profiles that can make more model calls. */
export function benchmarkProfile(name: BenchmarkProfileName = 'single'): BenchmarkProfile {
  if (name === 'single') return {
    name,
    settings: { cortex: 0, cortexStrategy: 'fixed', maxAgents: 0, maxDepth: 0 },
    subagents: 'disabled',
  };
  return {
    name,
    settings: { cortex: 5, cortexStrategy: name, maxAgents: 3, maxDepth: 1 },
    subagents: 'enabled',
  };
}
