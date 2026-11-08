import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';

export type OverlayChange = { path: string; before: string | null; after: string | null; diff: string; binary: boolean };
const excludedDirectories = new Set(['.git', '.polonrlm', '.januszgpt', '.next', '.nuxt', '.cache', '.venv', 'venv', '.tox', '__pycache__', 'node_modules', 'vendor', 'bower_components', 'coverage', 'dist', 'build', 'target']);
const excludedFiles = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|credentials(?:\.json)?|.*(?:secret|credential|id_rsa|id_ed25519).*)$/i;

function safeProjectFile(relative: string): boolean {
  const parts = relative.split(path.sep);
  return !parts.some((part, index) => (index < parts.length - 1 && excludedDirectories.has(part.toLowerCase())) || excludedFiles.test(part));
}

async function snapshot(root: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>(); let total = 0;
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name); const relative = path.relative(root, full);
      if (entry.isSymbolicLink() || (entry.isDirectory() && excludedDirectories.has(entry.name.toLowerCase())) || !safeProjectFile(relative)) continue;
      if (entry.isDirectory()) { await visit(full); continue; }
      if (!entry.isFile()) continue;
      const stat = await lstat(full); total += stat.size;
      if (files.size >= 5000 || total > 100_000_000) throw new Error('The isolated subagent workspace exceeds the limit of 5,000 files or 100 MB. Narrow the project scope.');
      files.set(relative, await readFile(full));
    }
  }
  await visit(root); return files;
}

function decode(text: Buffer): string | null {
  const value = text.toString('utf8'); return value.includes('\0') || !Buffer.from(value).equals(text) ? null : value;
}

export class AgentWorktree {
  readonly root: string;
  readonly baseline: Map<string, Buffer>;
  private constructor(readonly source: string, root: string, baseline: Map<string, Buffer>) { this.root = root; this.baseline = baseline; }
  static async create(source: string): Promise<AgentWorktree> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'polonrlm-agent-'));
    try {
      const initial = await snapshot(source);
      for (const [relative, content] of initial) {
        const target = path.join(root, relative); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, content);
      }
      for (const name of ['node_modules', 'vendor']) {
        const dependencyTree = path.join(source, name);
        try { if ((await stat(dependencyTree)).isDirectory()) await symlink(dependencyTree, path.join(root, name), process.platform === 'win32' ? 'junction' : 'dir'); } catch { /* Dependencies are optional. */ }
      }
      return new AgentWorktree(source, root, initial);
    } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
  }
  async changes(): Promise<OverlayChange[]> {
    const current = await snapshot(this.root); const paths = [...new Set([...this.baseline.keys(), ...current.keys()])].sort(); const changes: OverlayChange[] = []; let changedBytes = 0;
    for (const filename of paths) {
      const beforeBuffer = this.baseline.get(filename) ?? null, afterBuffer = current.get(filename) ?? null;
      if (beforeBuffer && afterBuffer && beforeBuffer.equals(afterBuffer)) continue;
      const before = beforeBuffer ? decode(beforeBuffer) : null, after = afterBuffer ? decode(afterBuffer) : null;
      const binary = (beforeBuffer !== null && before === null) || (afterBuffer !== null && after === null);
      changedBytes += (beforeBuffer?.byteLength ?? 0) + (afterBuffer?.byteLength ?? 0);
      if (changedBytes > 20_000_000) throw new Error('Subagent changes exceed the 20 MB limit.');
      const diff = binary ? '' : createTwoFilesPatch(filename, filename, before ?? '', after ?? '');
      changes.push({ path: filename, before, after, diff, binary });
      if (changes.length > 200) throw new Error('The subagent changed more than 200 files. A change set cannot be prepared safely.');
    }
    return changes;
  }
  async remove(): Promise<void> { await rm(this.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }); }
}
