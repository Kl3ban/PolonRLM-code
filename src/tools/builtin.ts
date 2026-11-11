import { execa } from 'execa';
import { rgPath } from '@vscode/ripgrep';
import path from 'node:path';
import { applyPatch } from 'diff';
import { z } from 'zod';
import type { ToolRegistry, ToolContext } from './registry.js';
import type { Workspace } from './workspace.js';
import type { Settings } from '../core/types.js';
import { browserAction } from './web.js';
import { registerNetworkTools } from './network.js';
import { registerComputerTool } from './computer.js';
import { registerAdvancedTools } from './advanced.js';
import { registerBrowserSessionTools } from './browser-session.js';
import { subprocessEnvironment } from '../core/secrets.js';
import { resolvePythonCommand } from './python-runtime.js';
import type { SandboxExecutor, PreparedCommand } from './sandbox.js';
import type { SessionStore } from '../core/store.js';

let shellChain: Promise<unknown> = Promise.resolve();

/** Serialize mutating shell/code commands across the main agent and all subagents in this process. */
export function withShellLock<T>(work: () => Promise<T>): Promise<T> {
  const next = shellChain.then(() => work(), () => work());
  shellChain = next.then(() => undefined, () => undefined);
  return next;
}

export function registerBuiltins(registry: ToolRegistry, workspace: Workspace, settings: Settings, options: { computer?: boolean; sandbox?: SandboxExecutor; store?: SessionStore } = {}): void {
  if (options.computer !== false) registerComputerTool(registry, workspace);
  registerAdvancedTools(registry, workspace, () => settings.maxProcesses, () => settings.timeoutMs, () => settings.toolOutputLimit, options.sandbox, options.store);
  registerBrowserSessionTools(registry, workspace, () => settings.browserEngine);
  const file = z.object({ path: z.string().min(1) });
  registry.add('read_file', 'Read numbered text lines. Request targeted ranges. Accepts start/lines, line_start/line_end, or offset/limit aliases.', file.extend({
    start: z.number().int().positive().default(1), lines: z.number().int().min(1).max(1000).default(200),
    line_start: z.number().int().positive().optional(), line_end: z.number().int().positive().optional(),
    offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(1000).optional(),
  }), true, async args => {
    let start = args.start;
    let lines = args.lines;
    if (args.line_start !== undefined) {
      start = args.line_start;
      if (args.line_end !== undefined) {
        if (args.line_end < start) throw new Error('line_end must be greater than or equal to line_start.');
        lines = Math.min(1000, args.line_end - start + 1);
      }
    } else if (args.offset !== undefined) {
      start = args.offset + 1;
      if (args.limit !== undefined) lines = args.limit;
    } else if (args.line_end !== undefined) {
      if (args.line_end < start) throw new Error('line_end must be greater than or equal to the start line.');
      lines = Math.min(1000, args.line_end - start + 1);
    }
    return workspace.read(args.path, start, lines);
  });
  registry.add('list_directory', 'List directory entries; skips dependency and metadata folders.', z.object({ path: z.string().default('.') }), true, async args => workspace.list(args.path));
  registry.add('write_file', 'Create or replace text file. Shows diff and supports /undo.', file.extend({ content: z.string().max(2_000_000) }), false, async (args, context) => workspace.change('write_file', args.path, () => args.content, context.mode, context.signal));
  registry.add('edit_file', 'Replace exact unique text with replacement (the write_file-style content field is accepted as an alias). Read before editing.', file.extend({ old: z.string().min(1), replacement: z.string().optional(), content: z.string().optional() }), false, async (args, context) => workspace.change('edit_file', args.path, before => {
    if (before === null) throw new Error('File does not exist.');
    const replacement = args.replacement ?? args.content;
    if (replacement === undefined) throw new Error('Provide replacement text (or the content alias).');
    const first = before.indexOf(args.old); if (first < 0 || before.indexOf(args.old, first + 1) !== -1) throw new Error('Text must occur exactly once.'); return before.replace(args.old, () => replacement);
  }, context.mode, context.signal));
  registry.add('delete_file', 'Delete one file after explicit approval.', file, false, async (args, context) => workspace.change('delete_file', args.path, before => { if (before === null) throw new Error('File does not exist.'); return null; }, context.mode, context.signal));
  registry.add('apply_patch', 'Apply unified diff to one file. No multi-file patch.', file.extend({ patch: z.string() }), false, async (args, context) => workspace.change('apply_patch', args.path, before => { const result = applyPatch(before ?? '', args.patch); if (result === false) throw new Error('Patch does not match the current file.'); return result; }, context.mode, context.signal));
  const searchSchema = z.object({ pattern: z.string().max(500), path: z.string().default('.'), limit: z.number().int().min(1).max(200).default(60) });
  async function rg(args: any, files: boolean, context: ToolContext): Promise<string> {
    const target = await workspace.resolve(args.path);
    try {
      const parameters = files ? ['--files', '--glob', args.pattern] : ['--line-number', '--fixed-strings', '--max-count', '5'];
      const result = await execa(rgPath, [...parameters, '--glob', '!node_modules', '--glob', '!.git', '--glob', '!.polonrlm', '--glob', '!.januszgpt', ...(files ? ['--', target] : ['--', args.pattern, target])], { cwd: workspace.root, reject: false, timeout: 15000, cancelSignal: context.signal, maxBuffer: 2_000_000, windowsHide: true });
      context.signal.throwIfAborted();
      if (result.timedOut || result.isMaxBuffer || (result.exitCode !== undefined && result.exitCode > 1)) throw new Error(`Search failed: ${result.stderr || result.shortMessage || result.exitCode}`);
      const { stdout } = result;
      return stdout.split('\n').slice(0, args.limit).join('\n') || 'No results.';
    } catch (error: any) { if (error.code !== 'ENOENT') throw error; throw new Error('The bundled ripgrep executable is missing for this platform. Reinstall PolonRLM.'); }
  }
  registry.add('search_files', 'Find paths using glob with ripgrep.', searchSchema, true, (args, context) => rg(args, true, context));
  registry.add('search_content', 'Find literal text using ripgrep; bounded results.', searchSchema, true, (args, context) => rg(args, false, context));
  async function detect(): Promise<Record<string, unknown>> {
    const entries = await workspace.list();
    const result: Record<string, unknown> = { files: entries, types: entries.filter(name => ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod'].includes(name)) };
    try { const data = JSON.parse(await workspace.readText('package.json')); result.scripts = data.scripts; result.dependencies = data.dependencies; result.devDependencies = data.devDependencies; } catch { /* Missing, invalid or oversized manifests are omitted. */ }
    return result;
  }
  for (const name of ['inspect_project', 'detect_project_type', 'analyze_dependencies']) registry.add(name, 'Inspect project manifest, scripts and dependency declarations without running code.', z.object({}), true, detect);
  async function processRun(tool: string, command: string, args: string[], context: ToolContext, approved = false): Promise<unknown> {
    let prepared: PreparedCommand | undefined;
    let sandboxStatus: Awaited<ReturnType<SandboxExecutor['status']>> | undefined;
    if (!approved && options.sandbox) {
      sandboxStatus = await options.sandbox.status(workspace.root);
      if (settings.sandboxMode === 'required' && !sandboxStatus.available) throw new Error(`OS sandbox is required but unavailable: ${sandboxStatus.reason ?? sandboxStatus.backend}. No command was run.`);
      const detail = sandboxStatus.available
        ? `Run the command inside the ${sandboxStatus.backend} OS sandbox after approval. Sandbox network access follows /settings sandboxNetworkDomains.${sandboxStatus.reason ? ` Setup note: ${sandboxStatus.reason}` : ''}`
        : `The OS sandbox is unavailable (${sandboxStatus.reason ?? sandboxStatus.backend}). Run this command with your normal host permissions only after approval.`;
      await workspace.permissions.check(tool, 'shell', detail, `${command} ${args.join(' ')}`, context.mode, context.signal);
      if (!sandboxStatus.available && settings.toolPermissions[tool] === 'auto' && settings.permissions !== 'all') {
        await workspace.permissions.check('sandbox_fallback', 'shell', 'The selected tool is set to auto, but the OS sandbox is unavailable. Approve this host execution explicitly.', `${command} ${args.join(' ')}`, context.mode, context.signal);
      }
      try { prepared = await options.sandbox.prepare(command, args, workspace.root, context.signal); }
      catch (error: any) {
        if (settings.sandboxMode === 'required') throw error;
        const reason = String(error?.message ?? error);
        await workspace.permissions.check('sandbox_fallback', 'shell', `Sandbox setup failed (${reason}). Approve running this command directly on the host.`, `${command} ${args.join(' ')}`, context.mode, context.signal);
        prepared = { command, args, env: subprocessEnvironment(context.isolated), sandboxed: false, reason, cleanup: async () => {}, annotate: stderr => stderr };
      }
    } else if (!approved) {
      await workspace.permissions.check(tool, 'shell', 'Run the command with your permissions on the host after approval. OS sandbox is not configured for this tool.', `${command} ${args.join(' ')}`, context.mode, context.signal);
    }
    context.signal.throwIfAborted();
    const launch = prepared ?? { command, args, env: subprocessEnvironment(context.isolated), sandboxed: false, cleanup: async () => {}, annotate: (stderr: string) => stderr };
    try {
      const result = await execa(launch.command, launch.args, { cwd: workspace.root, env: launch.sandboxed ? launch.env : subprocessEnvironment(context.isolated), reject: false, timeout: settings.timeoutMs > 0 ? settings.timeoutMs : undefined, cancelSignal: context.signal, killDescendants: true, forceKillAfterDelay: 1000, maxBuffer: Number.POSITIVE_INFINITY, windowsHide: true, cleanup: true });
      context.signal.throwIfAborted();
      if (result.timedOut) throw new Error(`Command timed out after ${settings.timeoutMs} ms.`);
      if (result.exitCode === undefined) throw new Error(`Command was not started: ${result.shortMessage ?? result.stderr}`);
      return { execution: launch.sandboxed ? `sandboxed (${sandboxStatus?.backend ?? 'OS'})` : `host${launch.reason ? ` (sandbox fallback: ${launch.reason})` : settings.sandboxMode === 'off' ? ' (sandbox off)' : ''}`, exitCode: result.exitCode, stdout: result.stdout, stderr: launch.annotate(result.stderr) };
    } finally { await launch.cleanup(); }
  }
  const shellSchema = z.object({ command: z.string().min(1).max(10000) });
  const shell = (tool: string, command: string, context: ToolContext) => withShellLock(() => processRun(tool, process.platform === 'win32' ? 'powershell.exe' : '/bin/sh', process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ' + command] : ['-c', command], context));
  for (const name of ['execute_command', 'execute_powershell', 'run_tests', 'install_dependencies', 'inspect_errors']) registry.add(name, 'Run a shell command under the configured permission policy. Uses OS isolation when available; host fallback follows the permission policy and is reported.', shellSchema, false, async (args, context) => { if (name === 'execute_powershell' && process.platform !== 'win32') throw new Error('PowerShell tool requires Windows.'); return shell(name, args.command, context); });
  registry.add('execute_python', 'Execute Python code after explicit approval. Uses an installed interpreter, skipping Windows Store aliases. Python commands are serialized with shell commands across agents.', z.object({ code: z.string().min(1) }), false, async (args, context) => {
    const python = await resolvePythonCommand();
    return withShellLock(() => processRun('execute_python', python.command, [...python.prefixArgs, '-c', args.code], context));
  });
  registry.add('inspect_process', 'Inspect running processes; no process termination.', z.object({}), true, async (_args, context) => processRun('inspect_process', process.platform === 'win32' ? 'tasklist.exe' : 'ps', process.platform === 'win32' ? ['/FO', 'CSV'] : ['-eo', 'pid,comm'], context, true));
  registry.add('git_status', 'Read git working tree status without running repository-configured fsmonitor hooks.', z.object({ untrackedFiles: z.boolean().default(false) }), true, (args, context) => processRun('git_status', 'git', ['-c', 'core.fsmonitor=false', '--no-optional-locks', 'status', '--short', ...(args.untrackedFiles ? ['--untracked-files=all'] : [])], context, true));
  registry.add('git_diff', 'Read git diff without external diff drivers.', z.object({ staged: z.boolean().default(false) }), true, (args, context) => processRun('git_diff', 'git', ['--no-pager', 'diff', '--no-ext-diff', '--no-textconv', ...(args.staged ? ['--cached'] : [])], context, true));
  registry.add('git_log', 'Read recent commit hashes, dates and subjects, optionally for one workspace path.', z.object({ limit: z.number().int().min(1).max(50).default(15), path: z.string().optional() }), true, async (args, context) => { if (args.path) await workspace.resolve(args.path); return processRun('git_log', 'git', ['--no-pager', 'log', `-n${args.limit}`, '--date=iso-strict', '--format=%h %ad %s', '--', ...(args.path ? [args.path] : [])], context, true); });
  registry.add('git_show', 'Inspect an explicit commit without external diff drivers or text conversion.', z.object({ revision: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._~^/-]{0,100}$/) }), true, (args, context) => processRun('git_show', 'git', ['--no-pager', 'show', '--no-ext-diff', '--no-textconv', '--format=fuller', args.revision, '--'], context, true));
  registry.add('git_blame', 'Read commit attribution for a bounded line range in a workspace file.', z.object({ path: z.string(), start: z.number().int().positive().default(1), lines: z.number().int().min(1).max(200).default(50) }), true, async (args, context) => { await workspace.resolve(args.path); return processRun('git_blame', 'git', ['--no-pager', 'blame', '--no-textconv', '-L', `${args.start},+${args.lines}`, '--', args.path], context, true); });
  registry.add('git_commit', 'Commit currently staged changes; follows the configured permission policy. Does not stage files.', z.object({ message: z.string().min(1).max(1000) }), false, async (args, context) => processRun('git_commit', 'git', ['-c', 'core.hooksPath=', 'commit', '-m', args.message], context));
  registerNetworkTools(registry, workspace, settings);
  registry.add('browser_automation', 'Headless browser navigation, text, screenshot or click. Auto selects an installed Playwright Chromium, Chrome, Edge, Brave or Firefox; users can choose an engine in /settings. Missing Playwright Chromium/Firefox is downloaded to the local cache on first use, after the browser action is approved. Actions follow the configured permission policy.', z.object({ url: z.url(), action: z.enum(['text', 'screenshot', 'click']).default('text'), selector: z.string().optional(), output: z.string().default('browser.png') }), false, async (args, context) => { await workspace.permissions.check('browser_automation', 'external', `Browser: ${args.action} ${args.url}. The page may perform external actions. A missing Playwright engine may be downloaded to the local cache.`, undefined, context.mode, context.signal); return browserAction(args, workspace, context.signal, context.mode, settings.browserEngine); });
}
