import { createHash, randomUUID } from 'node:crypto';
import { createTwoFilesPatch } from 'diff';
import { z } from 'zod';
import type { ToolRegistry } from './registry.js';
import type { Workspace } from './workspace.js';

export const contentHash = (text: string | null) => text === null ? 'missing' : createHash('sha256').update(text).digest('hex');
export function registerCheckpointTools(registry: ToolRegistry, workspace: Workspace): void {
  const checkpoints = new Map<string, { name: string; files: Map<string, string | null> }>();
  const read = async (filename: string): Promise<string | null> => { try { return await workspace.readText(filename); } catch (error: any) { if (error.code === 'ENOENT') return null; throw error; } };
  const find = (id: string) => { const checkpoint = checkpoints.get(id); if (!checkpoint) throw new Error('Unknown checkpoint. Checkpoints exist only for this process.'); return checkpoint; };
  registry.add('checkpoint_create', 'Save a named in-memory checkpoint of explicit text paths, including missing paths. At most five checkpoints, 100 paths, 20 MB total per checkpoint. No Git reset.', z.object({ name: z.string().min(1).max(100), paths: z.array(z.string().min(1)).min(1).max(100) }), true, async args => {
    if (checkpoints.size >= 5) throw new Error('Remove a checkpoint before creating another (limit: 5).');
    const files = new Map<string, string | null>(); let size = 0;
    for (const filename of new Set<string>(args.paths)) { const text = await read(filename); size += Buffer.byteLength(text ?? ''); if (size > 20000000) throw new Error('Checkpoint exceeds 20 MB.'); files.set(filename, text); }
    const id = randomUUID(); checkpoints.set(id, { name: args.name, files }); return { id, name: args.name, paths: [...files.keys()] };
  });
  registry.add('checkpoint_list', 'List this process checkpoints.', z.object({}), true, async () => [...checkpoints].map(([id, cp]) => ({ id, name: cp.name, paths: [...cp.files.keys()] })));
  registry.add('checkpoint_diff', 'Compare checkpoint with current files. Returns current hashes required for safe restore.', z.object({ id: z.string() }), true, async args => {
    const cp = find(args.id); const files = [];
    for (const [filename, saved] of cp.files) { const current = await read(filename); files.push({ path: filename, currentHash: contentHash(current), changed: current !== saved, diff: createTwoFilesPatch(filename, filename, current ?? '', saved ?? '') }); }
    return { id: args.id, files };
  });
  registry.add('checkpoint_restore', 'Restore selected checkpoint paths after permission checks and exact current-hash validation. Get hashes from checkpoint_diff. Each file is atomic; multi-file restore is not atomic and reports partial progress.', z.object({ id: z.string(), expected: z.record(z.string(), z.string()) }), false, async (args, context) => {
    const cp = find(args.id); const paths = Object.keys(args.expected);
    if (!paths.length || paths.some(filename => !cp.files.has(filename))) throw new Error('Provide existing checkpoint paths in expected.');
    for (const filename of paths) if (contentHash(await read(filename)) !== args.expected[filename]) throw new Error(`File ${filename} changed. Run checkpoint_diff again.`);
    const restored: string[] = [];
    for (const filename of paths) {
      context.signal.throwIfAborted();
      try { await workspace.change('checkpoint_restore', filename, current => { if (contentHash(current) !== args.expected[filename]) throw new Error('File changed during restore.'); return cp.files.get(filename)!; }, context.mode, context.signal); restored.push(filename); }
      catch (error: any) { return { restored, failed: filename, error: error.message, remaining: paths.slice(restored.length + 1) }; }
    }
    return { restored };
  });
  registry.add('checkpoint_drop', 'Discard an in-memory checkpoint; no project files are deleted.', z.object({ id: z.string() }), false, async args => { find(args.id); checkpoints.delete(args.id); return 'Checkpoint removed from memory.'; });
}
