import { copyFile, lstat, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { sandboxDomainSchema } from '../core/config.js';

export interface BenchmarkSetup {
  command: string[];
  timeoutMs: number;
  networkDomains: string[];
}

export interface BenchmarkTask {
  id: string;
  title: string;
  prompt: string;
  timeoutMs: number;
  directory: string;
  workspace: string;
  grader: string;
  setup?: BenchmarkSetup;
}

const TASK_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_TASKS = 100;
const MAX_TASK_JSON_BYTES = 64 * 1024;
const MAX_GRADER_BYTES = 128 * 1024;
const MAX_WORKSPACE_FILES = 10_000;
const MAX_WORKSPACE_BYTES = 200 * 1024 * 1024;
const IGNORED_NAMES = new Set(['.git', '.polonrlm', '.januszgpt', '.codex', '.agents', 'node_modules', 'coverage', '__pycache__']);

function parseSetup(value: unknown, id: string): BenchmarkSetup | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Benchmark case ${id} setup must be an object.`);
  const setup = value as Record<string, unknown>;
  if (Object.keys(setup).some(key => !['command', 'timeoutMs', 'networkDomains'].includes(key))) {
    throw new Error(`Benchmark case ${id} setup only accepts command, timeoutMs, and networkDomains.`);
  }
  if (!Array.isArray(setup.command) || setup.command.length < 1 || setup.command.length > 32 ||
      setup.command.some(argument => typeof argument !== 'string' || !argument.trim() || argument.length > 2048 || argument.includes('\0')) ||
      setup.command.reduce((size, argument) => size + (typeof argument === 'string' ? argument.length : 0), 0) > 8192) {
    throw new Error(`Benchmark case ${id} setup.command must be an argv array with 1 to 32 non-empty arguments and at most 8,192 characters.`);
  }
  const timeoutMs = setup.timeoutMs === undefined ? 300_000 : setup.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 10_000 || (timeoutMs as number) > 900_000) {
    throw new Error(`Benchmark case ${id} setup.timeoutMs must be between 10,000 and 900,000.`);
  }
  const networkDomains = setup.networkDomains === undefined ? [] : setup.networkDomains;
  if (!Array.isArray(networkDomains) || networkDomains.length > 32 ||
      networkDomains.some(domain => typeof domain !== 'string' || !sandboxDomainSchema.safeParse(domain).success) ||
      new Set(networkDomains).size !== networkDomains.length) {
    throw new Error(`Benchmark case ${id} setup.networkDomains must be a list of up to 32 unique hostnames or wildcard hostnames.`);
  }
  return { command: setup.command as string[], timeoutMs: timeoutMs as number, networkDomains: networkDomains as string[] };
}

function isCredentialName(name: string): boolean {
  return /^(?:\.env(?!\.example$)|\.npmrc|\.pypirc|\.netrc|\.git-credentials|id_(?:rsa|dsa|ecdsa|ed25519)|credentials(?:\.json)?|secrets?\.json)$/i.test(name) || /\.(?:pem|p12|pfx|key)$/i.test(name);
}

async function requireRealType(filename: string, type: 'file' | 'directory'): Promise<void> {
  const info = await lstat(filename);
  if (info.isSymbolicLink() || (type === 'file' ? !info.isFile() : !info.isDirectory())) {
    throw new Error(`Benchmark entry must be a regular ${type}: ${filename}`);
  }
}

export async function loadBenchmarkTasks(packDirectory: string, selectedId?: string): Promise<BenchmarkTask[]> {
  const root = path.resolve(packDirectory);
  await requireRealType(root, 'directory');
  const entries = await readdir(root, { withFileTypes: true });
  const directories = entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => entry.name).sort();
  if (directories.length > MAX_TASKS) throw new Error(`A benchmark pack can contain at most ${MAX_TASKS} tasks.`);
  if (selectedId && !TASK_ID.test(selectedId)) throw new Error('Benchmark case IDs may contain lowercase letters, numbers, underscores, and hyphens.');

  const tasks: BenchmarkTask[] = [];
  for (const id of directories) {
    if (selectedId && selectedId !== id) continue;
    if (!TASK_ID.test(id)) continue;
    const directory = path.join(root, id);
    const taskFile = path.join(directory, 'task.json');
    const workspace = path.join(directory, 'workspace');
    const grader = path.join(directory, 'grader.mjs');
    await requireRealType(directory, 'directory');
    await requireRealType(taskFile, 'file');
    await requireRealType(workspace, 'directory');
    await requireRealType(grader, 'file');

    const taskStat = await lstat(taskFile);
    const graderStat = await lstat(grader);
    if (taskStat.size > MAX_TASK_JSON_BYTES) throw new Error(`task.json is too large for benchmark case ${id}.`);
    if (graderStat.size > MAX_GRADER_BYTES) throw new Error(`grader.mjs is too large for benchmark case ${id}.`);
    const raw = JSON.parse(await readFile(taskFile, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Invalid task.json in benchmark case ${id}.`);
    const data = raw as Record<string, unknown>;
    if (data.id !== id || typeof data.title !== 'string' || !data.title.trim() || data.title.length > 120 ||
      typeof data.prompt !== 'string' || !data.prompt.trim() || data.prompt.length > 12_000) {
      throw new Error(`Benchmark case ${id} must have matching id, a title, and a prompt of at most 12,000 characters.`);
    }
    const timeoutMs = data.timeoutMs === undefined ? 600_000 : data.timeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 10_000 || (timeoutMs as number) > 900_000) {
      throw new Error(`Benchmark case ${id} timeoutMs must be between 10,000 and 900,000.`);
    }
    const setup = parseSetup(data.setup, id);
    tasks.push({ id, title: data.title.trim(), prompt: data.prompt.trim(), timeoutMs: timeoutMs as number, directory, workspace, grader, ...(setup ? { setup } : {}) });
  }
  if (!tasks.length) throw new Error(selectedId ? `Benchmark case not found: ${selectedId}.` : `No benchmark cases were found in ${root}.`);
  return tasks;
}

export async function syncBenchmarkSubmission(source: string, destination: string): Promise<{ files: number; bytes: number }> {
  await requireRealType(source, 'directory');
  await requireRealType(destination, 'directory');
  const destinationRoot = path.resolve(destination);
  const dependencyPath = path.join(destinationRoot, 'node_modules');
  let keepDependencies = false;
  try {
    const info = await lstat(dependencyPath);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Benchmark grader dependencies must be a real node_modules directory.');
    keepDependencies = true;
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
  for (const entry of await readdir(destinationRoot)) {
    if (entry === 'node_modules' && keepDependencies) continue;
    await rm(path.join(destinationRoot, entry), { recursive: true, force: true });
  }
  return copyBenchmarkWorkspace(source, destinationRoot);
}

export async function copyBenchmarkWorkspace(source: string, destination: string): Promise<{ files: number; bytes: number }> {
  await requireRealType(source, 'directory');
  await mkdir(destination, { recursive: true });
  const destinationRoot = path.resolve(destination);
  let files = 0;
  let bytes = 0;

  async function copyDirectory(from: string, to: string): Promise<void> {
    const entries = await readdir(from, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORED_NAMES.has(entry.name) || isCredentialName(entry.name)) continue;
      const sourcePath = path.join(from, entry.name);
      const targetPath = path.resolve(to, entry.name);
      const relative = path.relative(destinationRoot, targetPath);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Benchmark workspace contains an invalid path.');
      const info = await lstat(sourcePath);
      if (info.isSymbolicLink()) throw new Error(`Benchmark workspaces cannot contain symbolic links: ${entry.name}`);
      if (info.isDirectory()) {
        await mkdir(targetPath, { recursive: true });
        await copyDirectory(sourcePath, targetPath);
      } else if (info.isFile()) {
        files++;
        bytes += info.size;
        if (files > MAX_WORKSPACE_FILES || bytes > MAX_WORKSPACE_BYTES) throw new Error('Benchmark workspace exceeds the file-count or size limit.');
        await mkdir(path.dirname(targetPath), { recursive: true });
        await copyFile(sourcePath, targetPath);
      } else {
        throw new Error(`Benchmark workspace contains an unsupported filesystem entry: ${entry.name}`);
      }
    }
  }

  await copyDirectory(path.resolve(source), destinationRoot);
  return { files, bytes };
}

export function parseGraderResult(stdout: string, exitCode: number | null): { passed: boolean; summary: string } {
  if (exitCode !== 0 && exitCode !== 1) throw new Error('Hidden grader could not complete successfully.');
  const line = stdout.split(/\r?\n/).findLast(value => value.trim().startsWith('{'));
  if (!line) throw new Error('Hidden grader did not return its required JSON result.');
  let value: unknown;
  try { value = JSON.parse(line); } catch { throw new Error('Hidden grader returned invalid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof (value as any).passed !== 'boolean' || typeof (value as any).summary !== 'string') {
    throw new Error('Hidden grader result must contain boolean passed and string summary fields.');
  }
  const result = value as { passed: boolean; summary: string };
  if (result.passed !== (exitCode === 0)) throw new Error('Hidden grader exit status did not match its result.');
  return { passed: result.passed, summary: result.summary.slice(0, 500) };
}
