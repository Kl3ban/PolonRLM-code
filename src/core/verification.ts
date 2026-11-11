import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Workspace } from '../tools/workspace.js';
import { redact } from './secrets.js';

export type VerificationStatus = 'passed' | 'failed' | 'blocked' | 'cancelled' | 'incomplete' | 'no-checks';
export interface VerificationCommand { label: string; command: string }
export interface VerificationPlan { source: 'custom' | 'configured' | 'manifest' | 'none'; commands: VerificationCommand[]; notes: string[] }
export interface VerificationFile { path: string; beforeHash: string | null; afterHash: string | null; changedDuringCheck: boolean }
export interface VerificationCheck { label: string; command: string; status: 'passed' | 'failed' | 'blocked' | 'cancelled'; exitCode: number | null; durationMs: number; output: string }
export interface VerificationDiagnostic { path: string; diagnostics: Array<{ code: number; message: string; line?: number; column?: number }>; error?: string }
export interface VerificationReport {
  id: string; session: string; workspace: string; createdAt: number; status: VerificationStatus;
  commands: VerificationCheck[]; diagnostics: VerificationDiagnostic[]; files: VerificationFile[]; notes: string[];
}

function scriptsFrom(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const scripts = (value as Record<string, unknown>).scripts;
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return {};
  return Object.fromEntries(Object.entries(scripts).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

export async function discoverVerificationPlan(workspace: Workspace, configured: string[], explicit?: string): Promise<VerificationPlan> {
  if (explicit !== undefined) {
    const command = explicit.trim();
    if (!command) throw new Error('Use /verify <command> or /verify without a command.');
    return { source: 'custom', commands: [{ label: 'custom', command }], notes: [] };
  }
  if (configured.length) return { source: 'configured', commands: configured.map((command, index) => ({ label: `configured ${index + 1}`, command })), notes: [] };

  const entries = new Set(await workspace.list());
  if (entries.has('package.json')) {
    let manifest: unknown;
    try { manifest = JSON.parse(await workspace.readText('package.json')); }
    catch (error: any) { return { source: 'manifest', commands: [], notes: [`Could not read package.json: ${error.message ?? String(error)}`] }; }
    const data = manifest && typeof manifest === 'object' ? manifest as Record<string, unknown> : {};
    const scripts = scriptsFrom(manifest);
    const packageManager = typeof data.packageManager === 'string' ? /^(npm|pnpm|yarn|bun)@/i.exec(data.packageManager)?.[1]?.toLowerCase() : undefined;
    const manager = packageManager ?? (entries.has('pnpm-lock.yaml') ? 'pnpm' : entries.has('yarn.lock') ? 'yarn' : entries.has('bun.lock') || entries.has('bun.lockb') ? 'bun' : 'npm');
    const names = ['test', 'check', 'typecheck', 'lint', 'build'].filter(name => scripts[name] && !(name === 'test' && /no test specified/i.test(scripts[name]!)));
    return { source: 'manifest', commands: names.map(name => ({ label: name, command: `${manager} run ${name}` })), notes: names.length ? [] : ['No standard test, check, typecheck, lint, or build script was found in package.json.'] };
  }
  if (entries.has('Cargo.toml')) return { source: 'manifest', commands: [{ label: 'test', command: 'cargo test' }, { label: 'check', command: 'cargo check' }], notes: [] };
  if (entries.has('go.mod')) return { source: 'manifest', commands: [{ label: 'test', command: 'go test ./...' }, { label: 'vet', command: 'go vet ./...' }], notes: [] };
  if (entries.has('pyproject.toml') && entries.has('tests')) return { source: 'manifest', commands: [{ label: 'test', command: process.platform === 'win32' ? 'py -m pytest' : 'python3 -m pytest' }], notes: [] };
  if ([...entries].some(name => name.endsWith('.sln') || name.endsWith('.slnx'))) return { source: 'manifest', commands: [{ label: 'test', command: 'dotnet test' }], notes: [] };
  if (entries.has('gradlew') || entries.has('gradlew.bat')) return { source: 'manifest', commands: [{ label: 'test', command: process.platform === 'win32' ? '.\\gradlew.bat test' : './gradlew test' }], notes: [] };
  if (entries.has('pom.xml')) return { source: 'manifest', commands: [{ label: 'test', command: 'mvn test' }], notes: [] };
  if (entries.has('pyproject.toml') || entries.has('pytest.ini') || entries.has('tox.ini')) return { source: 'manifest', commands: [{ label: 'test', command: process.platform === 'win32' ? 'py -m pytest' : 'python3 -m pytest' }], notes: [] };
  return { source: 'none', commands: [], notes: ['No known test manifest was found. Configure commands in /settings or pass a command to /verify.'] };
}

function unquoteGitPath(value: string): string | null {
  if (!value.startsWith('"')) return value;
  if (value.length < 2 || !value.endsWith('"')) return null;
  const bytes: number[] = [];
  const escapedBytes: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92, '"': 34 };
  for (let index = 1; index < value.length - 1; index++) {
    const character = value[index]!;
    if (character !== '\\') { bytes.push(...Buffer.from(character, 'utf8')); continue; }
    const escaped = value[++index];
    if (escaped === undefined) return null;
    if (escaped in escapedBytes) { bytes.push(escapedBytes[escaped]!); continue; }
    const octal = value.slice(index, index + 3);
    if (/^[0-7]{3}$/.test(octal)) { bytes.push(parseInt(octal, 8)); index += 2; continue; }
    return null;
  }
  return Buffer.from(bytes).toString('utf8');
}

// Porcelain v1 C-quotes paths with spaces, control characters, quotes, or non-ASCII
// bytes (core.quotePath). Split the old/new rename pair before unquoting so a
// quoted path that itself contains " -> " is not truncated.
function splitGitPathTokens(value: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < value.length) {
    while (value[index] === ' ') index++;
    if (index >= value.length) break;
    if (value[index] === '"') {
      let end = index + 1;
      while (end < value.length) {
        if (value[end] === '\\') { end += 2; continue; }
        if (value[end] === '"') { end++; break; }
        end++;
      }
      tokens.push(value.slice(index, end));
      index = end;
    } else {
      const arrow = value.indexOf(' -> ', index);
      if (arrow < 0) { tokens.push(value.slice(index)); break; }
      tokens.push(value.slice(index, arrow));
      index = arrow + 4;
    }
    while (value[index] === ' ') index++;
    if (value.startsWith('->', index)) index += 2;
  }
  return tokens;
}

function normalizedGitPath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+/g, '/');
}

/** Walk the reverse import graph from changed files and return bounded dependents. */
export function affectedDependents(edges: Array<{ from: string; to: string }>, changed: string[], maxDepth = 3, limit = 40): string[] {
  if (!changed.length || limit <= 0) return [];
  const reverse = new Map<string, string[]>();
  for (const edge of edges) {
    const from = normalizedGitPath(edge.from), to = normalizedGitPath(edge.to);
    if (!from || !to) continue;
    const list = reverse.get(to) ?? [];
    list.push(from);
    reverse.set(to, list);
  }
  const changedSet = new Set(changed.map(normalizedGitPath));
  const seen = new Set(changedSet);
  const found: string[] = [];
  let frontier = [...changedSet];
  for (let depth = 0; depth < maxDepth && frontier.length && found.length < limit; depth++) {
    const next: string[] = [];
    for (const path of frontier) {
      for (const dependent of reverse.get(path) ?? []) {
        if (seen.has(dependent)) continue;
        seen.add(dependent);
        if (found.length >= limit) break;
        found.push(dependent);
        next.push(dependent);
      }
      if (found.length >= limit) break;
    }
    frontier = next;
  }
  return found;
}

export function parseGitStatusPaths(output: string): string[] {
  const paths = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    if (line.length < 4 || line[0] === ' ' && line[1] === ' ') continue;
    const status = line.slice(0, 2);
    if (!/[ MADRCU?!]/.test(status[0]!) && !/[ MADRCU?!]/.test(status[1]!)) continue;
    const tokens = splitGitPathTokens(line.slice(3));
    const filename = tokens.length ? unquoteGitPath(tokens.at(-1)!) : null;
    if (!filename) continue;
    const normalized = filename.replaceAll('\\', '/');
    if (normalized.split('/').some(part => ['.git', '.polonrlm', '.januszgpt'].includes(part.toLowerCase()))) continue;
    paths.add(normalized);
  }
  return [...paths];
}

export async function hashWorkspaceFiles(workspace: Workspace, filenames: string[]): Promise<Map<string, string | null>> {
  const hashes = new Map<string, string | null>();
  for (const filename of [...new Set(filenames)]) {
    try {
      const target = await workspace.resolve(filename);
      const bytes = await readFile(target);
      hashes.set(filename, createHash('sha256').update(bytes).digest('hex'));
    } catch (error: any) {
      if (error.code === 'ENOENT') { hashes.set(filename, null); continue; }
      if (error.code === 'EISDIR') continue;
      throw error;
    }
  }
  return hashes;
}

export function makeVerificationReport(input: Omit<VerificationReport, 'id' | 'createdAt'>): VerificationReport {
  return { id: randomUUID(), createdAt: Date.now(), ...input };
}

export function formatVerificationReport(report: VerificationReport): string {
  const lines = [`VERIFICATION ${report.status.toUpperCase()}`, `Report ${report.id.slice(0, 8)} · ${new Date(report.createdAt).toLocaleString('en-US')}`];
  if (report.commands.length) {
    const passed = report.commands.filter(check => check.status === 'passed').length;
    lines.push(`Checks: ${passed}/${report.commands.length} passed`);
    for (const check of report.commands) {
      lines.push(`${check.status === 'passed' ? 'PASS' : check.status.toUpperCase()} · ${redact(check.command)} · exit ${check.exitCode ?? 'unknown'} · ${(check.durationMs / 1000).toFixed(1)}s`);
      if (check.status !== 'passed' && check.output) lines.push(`  ${check.output.replace(/\s+/g, ' ').slice(0, 400)}`);
    }
  } else lines.push('Checks: none ran');
  if (report.diagnostics.length) {
    const count = report.diagnostics.reduce((total, item) => total + item.diagnostics.length, 0);
    lines.push(`Diagnostics: ${count} reported in ${report.diagnostics.length} file(s)`);
    for (const item of report.diagnostics) {
      if (item.error) lines.push(`DIAGNOSTIC ERROR · ${item.path} · ${item.error}`);
      for (const issue of item.diagnostics.slice(0, 8)) lines.push(`DIAGNOSTIC · ${item.path}${issue.line ? `:${issue.line}${issue.column ? `:${issue.column}` : ''}` : ''} · TS${issue.code} · ${issue.message}`);
      if (item.diagnostics.length > 8) lines.push(`... ${item.diagnostics.length - 8} more diagnostics in ${item.path}`);
    }
  } else lines.push('Diagnostics: none reported');
  if (report.files.length) {
    lines.push(`Files hashed before and after checks: ${report.files.length}`);
    for (const file of report.files) lines.push(`${file.changedDuringCheck ? 'CHANGED DURING CHECK' : 'HASHED'} · ${file.path} · ${file.afterHash?.slice(0, 12) ?? 'missing'}`);
  } else lines.push('Files hashed: none');
  lines.push(...report.notes.map(note => `Note: ${note}`));
  return lines.join('\n');
}

export function formatVerificationHistory(reports: VerificationReport[]): string {
  if (!reports.length) return 'No verification reports for this chat.';
  return ['VERIFICATION HISTORY', ...reports.map(report => `${report.status.toUpperCase()} · ${new Date(report.createdAt).toLocaleString('en-US')} · ${report.id.slice(0, 8)} · ${report.commands.length} checks · ${report.files.length} files`)].join('\n');
}
