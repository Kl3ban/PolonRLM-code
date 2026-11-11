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

export function registerBuiltins(registry: ToolRegistry, workspace: Workspace, settings: Settings, options: { computer?: boolean } = {}): void {
  if (options.computer !== false) registerComputerTool(registry, workspace);
  registerAdvancedTools(registry, workspace, () => settings.maxProcesses, () => settings.timeoutMs, () => settings.toolOutputLimit);
  registerBrowserSessionTools(registry, workspace, () => settings.browserEngine);
  const file = z.object({ path: z.string().min(1) });
  registry.add('read_file', 'Read numbered text lines. Request targeted ranges.', file.extend({ start: z.number().int().positive().default(1), lines: z.number().int().min(1).max(1000).default(200) }), true, async args => workspace.read(args.path, args.start, args.lines));
  registry.add('list_directory', 'List directory entries; skips dependency and metadata folders.', z.object({ path: z.string().default('.') }), true, async args => workspace.list(args.path));
  registry.add('write_file', 'Create or replace text file. Shows diff and supports /undo.', file.extend({ content: z.string().max(2_000_000) }), false, async (args, context) => workspace.change('write_file', args.path, () => args.content, context.mode, context.signal));
  registry.add('edit_file', 'Replace exact unique text. Read before editing.', file.extend({ old: z.string().min(1), replacement: z.string() }), false, async (args, context) => workspace.change('edit_file', args.path, before => { if (before === null) throw new Error('File does not exist.'); const first = before.indexOf(args.old); if (first < 0 || before.indexOf(args.old, first + 1) !== -1) throw new Error('Text must occur exactly once.'); return before.replace(args.old, () => args.replacement); }, context.mode, context.signal));
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
    if (!approved) await workspace.permissions.check(tool, 'shell', 'Command runs with your permissions, outside a sandbox. Approve only trusted code.', `${command} ${args.join(' ')}`, context.mode, context.signal);
    context.signal.throwIfAborted();
    const result = await execa(command, args, { cwd: workspace.root, env: subprocessEnvironment(context.isolated), reject: false, timeout: settings.timeoutMs > 0 ? settings.timeoutMs : undefined, cancelSignal: context.signal, killDescendants: true, forceKillAfterDelay: 1000, maxBuffer: Number.POSITIVE_INFINITY, windowsHide: true, cleanup: true });
    context.signal.throwIfAborted();
    if (result.timedOut) throw new Error(`Command timed out after ${settings.timeoutMs} ms.`);
    if (result.exitCode === undefined) throw new Error(`Command was not started: ${result.shortMessage ?? result.stderr}`);
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  }
  const shellSchema = z.object({ command: z.string().min(1).max(10000) });
  const shell = (tool: string, command: string, context: ToolContext) => processRun(tool, process.platform === 'win32' ? 'powershell.exe' : '/bin/sh', process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ' + command] : ['-c', command], context);
  for (const name of ['execute_command', 'execute_powershell', 'run_tests', 'install_dependencies', 'inspect_errors']) registry.add(name, 'Run shell command after approval; returns actual exit code and bounded output. Shell is not sandboxed.', shellSchema, false, async (args, context) => { if (name === 'execute_powershell' && process.platform !== 'win32') throw new Error('PowerShell tool requires Windows.'); return shell(name, args.command, context); });
  registry.add('execute_python', 'Execute Python code after explicit approval. Uses an installed interpreter, skipping Windows Store aliases.', z.object({ code: z.string().min(1) }), false, async (args, context) => {
    await workspace.permissions.check('execute_python', 'shell', 'Run the provided Python code with your permissions.', args.code, context.mode, context.signal);
    const python = await resolvePythonCommand();
    return processRun('execute_python', python.command, [...python.prefixArgs, '-c', args.code], context, true);
  });
  registry.add('inspect_process', 'Inspect running processes; no process termination.', z.object({}), true, async (_args, context) => processRun('inspect_process', process.platform === 'win32' ? 'tasklist.exe' : 'ps', process.platform === 'win32' ? ['/FO', 'CSV'] : ['-eo', 'pid,comm'], context, true));
  registry.add('git_status', 'Read git working tree status.', z.object({ untrackedFiles: z.boolean().default(false) }), true, (args, context) => processRun('git_status', 'git', ['--no-optional-locks', 'status', '--short', ...(args.untrackedFiles ? ['--untracked-files=all'] : [])], context, true));
  registry.add('git_diff', 'Read git diff without external diff drivers.', z.object({ staged: z.boolean().default(false) }), true, (args, context) => processRun('git_diff', 'git', ['--no-pager', 'diff', '--no-ext-diff', '--no-textconv', ...(args.staged ? ['--cached'] : [])], context, true));
  registry.add('git_log', 'Read recent commit hashes, dates and subjects, optionally for one workspace path.', z.object({ limit: z.number().int().min(1).max(50).default(15), path: z.string().optional() }), true, async (args, context) => { if (args.path) await workspace.resolve(args.path); return processRun('git_log', 'git', ['--no-pager', 'log', `-n${args.limit}`, '--date=iso-strict', '--format=%h %ad %s', '--', ...(args.path ? [args.path] : [])], context, true); });
  registry.add('git_show', 'Inspect an explicit commit without external diff drivers or text conversion.', z.object({ revision: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._~^/-]{0,100}$/) }), true, (args, context) => processRun('git_show', 'git', ['--no-pager', 'show', '--no-ext-diff', '--no-textconv', '--format=fuller', args.revision, '--'], context, true));
  registry.add('git_blame', 'Read commit attribution for a bounded line range in a workspace file.', z.object({ path: z.string(), start: z.number().int().positive().default(1), lines: z.number().int().min(1).max(200).default(50) }), true, async (args, context) => { await workspace.resolve(args.path); return processRun('git_blame', 'git', ['--no-pager', 'blame', '--no-textconv', '-L', `${args.start},+${args.lines}`, '--', args.path], context, true); });
  registry.add('git_commit', 'Commit currently staged changes; follows the configured permission policy. Does not stage files.', z.object({ message: z.string().min(1).max(1000) }), false, async (args, context) => processRun('git_commit', 'git', ['-c', 'core.hooksPath=', 'commit', '-m', args.message], context));
  registerNetworkTools(registry, workspace, settings);
  registry.add('browser_automation', 'Headless browser navigation, text, screenshot or click. Auto selects an installed Playwright Chromium, Chrome, Edge, Brave or Firefox; users can choose an engine in /settings. Missing Playwright Chromium/Firefox is downloaded to the local cache on first use, after the browser action is approved. Actions follow the configured permission policy.', z.object({ url: z.url(), action: z.enum(['text', 'screenshot', 'click']).default('text'), selector: z.string().optional(), output: z.string().default('browser.png') }), false, async (args, context) => { await workspace.permissions.check('browser_automation', 'external', `Browser: ${args.action} ${args.url}. The page may perform external actions. A missing Playwright engine may be downloaded to the local cache.`, undefined, context.mode, context.signal); return browserAction(args, workspace, context.signal, context.mode, settings.browserEngine); });
}
