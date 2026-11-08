import { compactMessages, estimateTokens } from '../dist/core/context.js';
const messages = [{ role: 'user', content: 'Fix the validation and run the test.' }];
for (let index = 0; index < 40; index++) {
  messages.push({ role: 'assistant', content: '', toolCalls: [{ id: String(index), name: 'read_file', arguments: { path: `src/file${index}.ts` } }] });
  messages.push({ role: 'tool', name: 'read_file', toolCallId: String(index), content: `src/file${index}.ts\n${'code and diagnostic output\n'.repeat(150)}` });
}
const before = estimateTokens(messages);
const result = compactMessages(messages, 6000);
console.log(JSON.stringify({ workload: 'synthetic, not an OpenCode comparison', estimator: 'UTF-8 bytes / 3', beforeEstimatedTokens: before, afterEstimatedTokens: estimateTokens(result.messages), archivedMessages: result.removed, reductionPercent: Number((100 * (1 - estimateTokens(result.messages) / before)).toFixed(1)), extraLLMCalls: 0 }, null, 2));
