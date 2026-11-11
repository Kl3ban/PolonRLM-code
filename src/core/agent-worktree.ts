import { lstat, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { execa } from 'execa';
import { rgPath } from '@vscode/ripgrep';

export type OverlayChange = { path: string; before: string | null; after: string | null; diff: string; binary: boolean };
const excludedDirectories = new Set(['.git', '.polonrlm', '.januszgpt', '.next', '.nuxt', '.cache', '.venv', 'venv', '.tox', '__pycache__', 'node_modules', 'vendor', 'bower_components', 'coverage', 'dist', 'build', 'target']);
const excludedFiles = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|credentials(?:\.json)?|.*(?:secret|credential|id_rsa|id_ed25519).*)$/i;

function safeProjectFile(relative: string): boolean {
  const parts = relative.split(path.sep);
  return !parts.some((part, index) => (index < parts.length - 1 && excludedDirectories.has(part.toLowerCase())) || excludedFiles.test(part));
}

async function readRegularProjectFile(root: string, relative: string): Promise<{ content: Buffer; size: number } | undefined> {
  const full = path.resolve(root, relative);
  const relativeToRoot = path.relative(root, full);
  if (relativeToRoot === '..' || relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot)) return undefined;
  let current = root;
  let fileInfo;
  const parts = relative.split(path.sep);
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]!);
    const info = await lstat(current).catch((error: any) => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (!info || info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())) return undefined;
    fileInfo = info;
  }
  return fileInfo ? { content: await readFile(full), size: fileInfo.size } : undefined;
}

async function snapshot(root: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>(); let total = 0;
  let listing;
  try {
    // Ripgrep applies nested .gitignore/.ignore rules even when the workspace has no Git repo.
    const args = ['--files', '--hidden', '--null', '--no-require-git', ...[...excludedDirectories].flatMap(name => ['--glob', `!**/${name}/**`])];
    listing = await execa(rgPath, args, { cwd: root, reject: false, timeout: 15_000, maxBuffer: 5_000_000, windowsHide: true });
  } catch (error: any) {
    if (error.code === 'ENOENT') throw new Error('The bundled ripgrep executable is missing; subagent files cannot be filtered safely. Reinstall PolonRLM.');
    throw error;
  }
  if (listing.timedOut || listing.isMaxBuffer || (listing.exitCode !== 0 && listing.exitCode !== 1)) {
    throw new Error(`Could not safely enumerate subagent files: ${listing.stderr || listing.shortMessage || listing.exitCode}`);
  }
  for (const entry of listing.stdout.split('\0')) {
    if (!entry) continue;
    const relative = path.normalize(entry);
    if (!safeProjectFile(relative)) continue;
    const file = await readRegularProjectFile(root, relative);
    if (!file) continue;
    total += file.size;
    if (files.size >= 5000 || total > 100_000_000) throw new Error('The isolated subagent workspace exceeds the limit of 5,000 files or 100 MB. Narrow the project scope.');
    files.set(relative, file.content);
  }
  return files;
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
    const current = await snapshot(this.root);
    // Keep baseline files visible even if the agent edits ignore rules mid-task.
    // Otherwise a modified .gitignore could hide its own or another file's changes.
    for (const filename of this.baseline.keys()) {
      if (current.has(filename)) continue;
      const file = await readRegularProjectFile(this.root, filename);
      if (file) current.set(filename, file.content);
    }
    const paths = [...new Set([...this.baseline.keys(), ...current.keys()])].sort(); const changes: OverlayChange[] = []; let changedBytes = 0;
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
  /** Merge one dependency-wave result into this private graph workspace after checking its base. */
  async mergeChanges(changes: readonly OverlayChange[]): Promise<void> {
    const paths = new Set<string>();
    const prepared: { path: string; target: string; before: Buffer | null; after: string | null }[] = [];
    for (const change of changes) {
      const relative = path.normalize(change.path);
      const target = path.resolve(this.root, relative);
      const fromRoot = path.relative(this.root, target);
      if (!relative || path.isAbsolute(relative) || fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot) || !safeProjectFile(relative)) {
        throw new Error(`Graph conflict: unsafe staged path ${change.path}.`);
      }
      if (paths.has(relative)) throw new Error(`Graph conflict: duplicate staged path ${relative}.`);
      paths.add(relative);
      if (change.binary) throw new Error(`Graph conflict: binary changes cannot be composed (${relative}).`);
      const current = await readRegularProjectFile(this.root, relative);
      const currentText = current ? decode(current.content) : null;
      if ((current && currentText === null) || currentText !== change.before) throw new Error(`Graph conflict: ${relative} changed after this task started.`);
      prepared.push({ path: relative, target, before: current?.content ?? null, after: change.after });
    }

    const applied: typeof prepared = [];
    try {
      for (const entry of prepared) {
        await ensureSafeParents(this.root, entry.path);
        if (entry.after === null) await rm(entry.target, { force: true });
        else {
          const stage = `${entry.target}.polonrlm-${randomUUID()}.tmp`;
          try { await writeFile(stage, entry.after, { encoding: 'utf8', flag: 'wx' }); await rename(stage, entry.target); }
          finally { await rm(stage, { force: true }).catch(() => {}); }
        }
        applied.push(entry);
      }
    } catch (error) {
      const rollbackFailures: string[] = [];
      for (const entry of applied.reverse()) {
        try {
          await ensureSafeParents(this.root, entry.path);
          if (entry.before === null) await rm(entry.target, { force: true });
          else {
            const stage = `${entry.target}.polonrlm-rollback-${randomUUID()}.tmp`;
            try { await writeFile(stage, entry.before, { flag: 'wx' }); await rename(stage, entry.target); }
            finally { await rm(stage, { force: true }).catch(() => {}); }
          }
        } catch (rollbackError) { rollbackFailures.push(`${entry.path}: ${String(rollbackError)}`); }
      }
      throw new Error(`Could not stage dependency task changes: ${String(error)}${rollbackFailures.length ? ` Rollback failures: ${rollbackFailures.join('; ')}` : ''}`);
    }
  }
  async remove(): Promise<void> { await rm(this.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }); }
}

async function ensureSafeParents(root: string, relative: string): Promise<void> {
  const parts = relative.split(path.sep);
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    const info = await lstat(current).catch((error: any) => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (!info) await mkdir(current);
    else if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Refusing to follow a symlink or non-directory in ${relative}.`);
  }
  const target = path.join(root, relative);
  const info = await lstat(target).catch((error: any) => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error(`Refusing to replace a symlink or non-file in ${relative}.`);
}
