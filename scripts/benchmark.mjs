import { compactMessages, estimateTokens } from '../dist/core/context.js';
import { OPTIONAL_TOOLS_GUIDANCE } from '../dist/core/tool-guidance.js';
const previousToolGuidance = 'Additional tools include browser (tabs, sign-in, forms, and screenshots), browser_sessions, read_files/search_batch, code_diagnostics/symbol_definition/symbol_references/symbol_hover/rename_symbol, ast_search/ast_edit/code_outline, lsp_request, process_start/process_input/process_output/process_wait/process_list/process_stop, transaction_begin/transaction_status/transaction_commit/transaction_rollback, checkpoint_create/checkpoint_diff/checkpoint_restore/checkpoint_list/checkpoint_drop, git_log/git_show/git_blame, and plan_update/plan_status. Discover tools by name to avoid loading the full catalog. After code changes, check diagnostics. Restoring a checkpoint requires current hashes. Do not treat a plan status as proof that work was completed.';
const previousPromptEstimate = estimateTokens([{ role: 'system', content: previousToolGuidance }]);
const currentPromptEstimate = estimateTokens([{ role: 'system', content: OPTIONAL_TOOLS_GUIDANCE }]);
if (currentPromptEstimate >= previousPromptEstimate) throw new Error('Optional-tool prompt benchmark did not reduce its estimated token cost.');
const messages = [{ role: 'user', content: 'Fix the validation and run the test.' }];
for (let index = 0; index < 40; index++) {
  messages.push({ role: 'assistant', content: '', toolCalls: [{ id: String(index), name: 'read_file', arguments: { path: `src/file${index}.ts` } }] });
  messages.push({ role: 'tool', name: 'read_file', toolCallId: String(index), content: `src/file${index}.ts\n${'code and diagnostic output\n'.repeat(150)}` });
}
const before = estimateTokens(messages);
const result = compactMessages(messages, 6000);
console.log(JSON.stringify({ workload: 'synthetic, not an OpenCode comparison', estimator: 'UTF-8 bytes / 3; not a provider tokenizer', optionalToolGuidance: { beforeBytes: Buffer.byteLength(previousToolGuidance), afterBytes: Buffer.byteLength(OPTIONAL_TOOLS_GUIDANCE), beforeEstimatedTokens: previousPromptEstimate, afterEstimatedTokens: currentPromptEstimate, savedEstimatedTokensPerModelCall: previousPromptEstimate - currentPromptEstimate }, contextCompaction: { beforeEstimatedTokens: before, afterEstimatedTokens: estimateTokens(result.messages), archivedMessages: result.removed, shortenedMessages: result.shortened, retainedMessages: result.messages.length, reductionPercent: Number((100 * (1 - estimateTokens(result.messages) / before)).toFixed(1)) }, extraLLMCalls: 0 }, null, 2));
