import { z } from 'zod';
import type { ToolRegistry } from './registry.js';
import type { Workspace } from './workspace.js';
import { registerProcessTools } from './processes.js';
import { registerCheckpointTools } from './checkpoints.js';
import { registerCodeTools } from './code.js';
import { registerLspTool } from './lsp.js';
import { registerDocumentTools } from './documents.js';

export function registerAdvancedTools(registry: ToolRegistry, workspace: Workspace): void {
  let plan: { step: string; status: 'pending' | 'in_progress' | 'done' }[] = [];
  registry.add('plan_update', 'Maintain a compact in-memory task plan (not proof of completion). At most one step in progress. Does not edit project files.', z.object({ steps: z.array(z.object({ step: z.string().min(1).max(300), status: z.enum(['pending', 'in_progress', 'done']) })).max(30) }), true, async args => { if (args.steps.filter((step: any) => step.status === 'in_progress').length > 1) throw new Error('Only one plan step can be active at a time.'); plan = args.steps; return plan; });
  registry.add('plan_status', 'Read the current in-memory task plan.', z.object({}), true, async () => plan);
  registerProcessTools(registry, workspace); registerCheckpointTools(registry, workspace); registerCodeTools(registry, workspace); registerLspTool(registry, workspace);
  registerDocumentTools(registry, workspace);
  registry.add('transaction_begin', 'Start one in-memory file change transaction. Later writes can be committed or rolled back together.', z.object({ name: z.string().min(1).max(100) }), false, async args => workspace.beginTransaction(args.name));
  registry.add('transaction_status', 'Show the active file change transaction and its touched paths.', z.object({}), true, async () => workspace.transactionStatus() ?? { active: false });
  registry.add('transaction_commit', 'Keep all changes in the active transaction and close it. Every file still uses normal write approvals.', z.object({ id: z.string() }), false, async args => workspace.commitTransaction(args.id));
  registry.add('transaction_rollback', 'Reverse active transaction writes in reverse order. Checks each file for outside edits and reports partial progress.', z.object({ id: z.string() }), false, async (args, context) => workspace.rollbackTransaction(args.id, context.mode, context.signal));
  registry.add('read_files', 'Batch targeted line reads for up to 20 files. Each result includes its own success/error; total content bounded to 20000 characters.', z.object({ files: z.array(z.object({ path: z.string(), start: z.number().int().positive().default(1), lines: z.number().int().min(1).max(500).default(100) })).min(1).max(20) }), true, async (args, context) => {
    let remaining = 20000; const results = [];
    for (const file of args.files) { context.signal.throwIfAborted(); try { const text = await workspace.read(file.path, file.start, file.lines); const content = text.slice(0, remaining); remaining -= content.length; results.push({ path: file.path, content, truncated: content.length !== text.length }); } catch (error: any) { results.push({ path: file.path, error: error.message }); } }
    return results;
  });
  registry.add('search_batch', 'Batch up to 10 literal or file-name searches with bounded independent results.', z.object({ queries: z.array(z.object({ pattern: z.string().max(500), path: z.string().default('.'), files: z.boolean().default(false), limit: z.number().int().min(1).max(100).default(20) })).min(1).max(10) }), true, async (args, context) => {
    let remaining = 20000; const results = [];
    for (const query of args.queries) { context.signal.throwIfAborted(); try { const result = await registry.execute(query.files ? 'search_files' : 'search_content', query, context); const content = result.slice(0, remaining); remaining -= content.length; results.push({ query: query.pattern, content, truncated: content.length !== result.length }); } catch (error: any) { results.push({ query: query.pattern, error: error.message }); } }
    return results;
  });
}
