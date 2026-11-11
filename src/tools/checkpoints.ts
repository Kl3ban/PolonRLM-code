import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ToolRegistry } from './registry.js';
import type { Workspace } from './workspace.js';

export const contentHash = (text: string | null) => text === null ? 'missing' : createHash('sha256').update(text).digest('hex');

export function registerCheckpointTools(registry: ToolRegistry, workspace: Workspace): void {
  registry.add('checkpoint_create', 'Create a persistent, encrypted checkpoint of selected text files. Includes files that do not exist yet so a restore can remove later additions.', z.object({ name: z.string().min(1).max(100), paths: z.array(z.string().min(1)).min(1) }), true, async args => workspace.createCheckpoint(args.name, args.paths));
  registry.add('checkpoint_list', 'List persistent checkpoints saved for this project.', z.object({}), true, async () => workspace.listCheckpoints());
  registry.add('checkpoint_diff', 'Compare a saved checkpoint with current files. Returns exact current hashes required for a safe restore.', z.object({ id: z.string().min(4) }), true, async args => workspace.diffCheckpoint(args.id));
  registry.add('checkpoint_restore', 'Restore selected checkpoint files after permission checks and exact current hash validation. Writes share one journaled group; earlier files are restored if a later write fails.', z.object({ id: z.string().min(4), expected: z.record(z.string(), z.string()) }), false, async (args, context) => {
    const result = await workspace.restoreCheckpoint(args.id, args.expected, context.mode, context.signal);
    return { ...result, restored: result.applied };
  });
  registry.add('checkpoint_drop', 'Remove a saved checkpoint from this project. Does not change project files.', z.object({ id: z.string().min(4) }), false, async args => { workspace.dropCheckpoint(args.id); return 'Checkpoint removed.'; });
}
