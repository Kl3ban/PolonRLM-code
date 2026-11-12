import { performance } from 'node:perf_hooks';
import { chooseCortex } from '../src/core/cortex.js';
import { HistoryIndex } from '../src/core/history-retrieval.js';

// Local routing/retrieval cases. This does not measure an LLM's ability to solve code tasks.
const started = performance.now();
const cases: { task: string; min: number; max: number; ceiling?: number; fixed?: boolean }[] = [
  { task: 'What is 2 + 2?', min: 0, max: 0 },
  { task: 'Fix a spelling typo in README.', min: 0, max: 0 },
  { task: 'Popraw literówkę w komentarzu.', min: 0, max: 0 },
  { task: 'Explain this function.', min: 0, max: 1 },
  { task: 'Fix the provider picker and add a regression test.', min: 1, max: 2 },
  { task: 'Implement a provider feature in src/providers/client.ts.', min: 1, max: 2 },
  { task: 'Fix a typo, then refactor security across modules and add regression tests.', min: 2, max: 5 },
  { task: 'Refactor concurrent transactions in src/store.ts and src/locks.ts; verify regression tests.', min: 2, max: 5 },
  { task: 'Migrate the database across src/store.ts and src/config.ts and run integration tests.', min: 2, max: 5 },
  { task: 'Refactor authentication and add integration tests.', min: 0, max: 1, ceiling: 1 },
  { task: 'Investigate a deadlock across src/worker.ts and src/queue.ts.', min: 0, max: 0, ceiling: 0 },
  { task: 'What is 2 + 2?', min: 5, max: 5, fixed: true },
];
const failures: unknown[] = [];
for (const item of cases) {
  const actual = chooseCortex(item.ceiling ?? 5, item.task, item.fixed ? 'fixed' : 'adaptive');
  if (actual.level < item.min || actual.level > item.max) failures.push({ task: item.task, expected: [item.min, item.max], actual });
}
let ceilingCases = 0;
for (const item of cases) for (let ceiling = 0; ceiling <= 5; ceiling++) {
  ceilingCases++; const result = chooseCortex(ceiling, item.task);
  if (result.level > ceiling || result.level < 0) failures.push({ ceiling, task: item.task, actual: result.level });
}
let top1 = 0, reciprocalRank = 0, excerptChars = 0;
for (let probe = 0; probe < 16; probe++) {
  const index = new HistoryIndex(), key = `reconnect-contract-${probe}-819`;
  for (let id = 1; id <= 40; id++) index.add(id, { role: 'tool', name: 'read_file', content: `Network reconnect notes ${id}. ` + 'Routine unrelated queue retry details. '.repeat(40) });
  index.add(41, { role: 'user', content: 'Background notes. '.repeat(1000) + `The ${key} port must remain ${48100 + probe}. Preserve it in src/network.ts.` });
  const hits = index.search(`network reconnect ${key}`, 5), rank = hits.findIndex(hit => hit.id === 41);
  if (rank === 0) top1++; if (rank >= 0) { reciprocalRank += 1 / (rank + 1); excerptChars += hits[rank]!.excerpt.length; }
  if (rank < 0 || !hits[rank]!.excerpt.includes(String(48100 + probe))) failures.push({ retrievalCase: probe, problem: 'Exact archived contract value was not retrieved.' });
}
console.log(JSON.stringify({ modelCalls: 0, routing: { cases: cases.length, ceilingCases, failures: failures.length }, retrieval: { cases: 16, top1Accuracy: top1 / 16, meanReciprocalRank: reciprocalRank / 16, averageExcerptChars: Math.round(excerptChars / 16) }, elapsedMs: Math.round(performance.now() - started), failures,
  limitation: 'Deterministic routing and exact-source retrieval cases, not a live model benchmark or a claim of task success. Use /cortex stats for real local run evidence.' }, null, 2));
if (failures.length) process.exitCode = 1;
