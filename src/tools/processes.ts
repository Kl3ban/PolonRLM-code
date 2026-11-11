import { randomUUID } from 'node:crypto';
import { execa } from 'execa';
import { z } from 'zod';
import { StringDecoder } from 'node:string_decoder';
import { safeText, subprocessEnvironment } from '../core/secrets.js';
import type { ToolRegistry } from './registry.js';
import type { Workspace } from './workspace.js';
import type { SandboxExecutor, PreparedCommand } from './sandbox.js';

export class ProcessOutputBuffer {
  private readonly decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
  private contents = '';
  truncated = false;
  constructor(private readonly maximum: number | (() => number) = 0) {}
  get output(): string { this.trim(); return this.contents; }
  write(stream: 'stdout' | 'stderr', chunk: Buffer | string): void { this.append(this.decoders[stream].write(Buffer.from(chunk))); }
  end(stream: 'stdout' | 'stderr'): void { this.append(this.decoders[stream].end()); }
  private append(text: string): void {
    if (!text) return;
    this.contents += text;
    this.trim();
  }
  private trim(): void {
    const maximum = typeof this.maximum === 'number' ? this.maximum : this.maximum();
    if (maximum > 0 && this.contents.length > maximum) {
      let start = this.contents.length - maximum;
      const first = this.contents.charCodeAt(start);
      if (first >= 0xdc00 && first <= 0xdfff) start++;
      this.contents = this.contents.slice(start);
      this.truncated = true;
    }
  }
}

export function registerProcessTools(registry: ToolRegistry, workspace: Workspace, maxProcesses: () => number = () => 0, globalTimeoutMs: () => number = () => 0, outputLimit: () => number = () => 0, sandbox?: SandboxExecutor): void {
  type Job = { id: string; command: string; execution: string; interactive: boolean; stdin?: NodeJS.WritableStream; buffer: ProcessOutputBuffer; output: string; truncated: boolean; running: boolean; exitCode?: number; error?: string; abort: AbortController; done: Promise<void>; waiters: Set<() => void>; cleanup: () => void };
  const jobs = new Map<string, Job>();
  const find = (id: string) => { const job = jobs.get(id); if (!job) throw new Error('Unknown process for this run.'); return job; };
  const snapshot = (job: Job) => { job.output = job.buffer.output; job.truncated = job.buffer.truncated; return { id: job.id, command: job.command, execution: job.execution, interactive: job.interactive, running: job.running, exitCode: job.exitCode, error: job.error, output: job.output, truncated: job.truncated }; };
  registry.onClose(async () => { jobs.forEach(job => job.abort.abort()); await Promise.all([...jobs.values()].map(job => job.done)); });
  registry.add('process_start', 'Start a shell command in the background under the configured permission policy. Uses OS isolation when available; host fallback follows the permission policy and is reported. Timeout and output are unlimited by default; configured global limits apply. Only owned jobs can be stopped.', z.object({ command: z.string().min(1).max(10000), timeoutMs: z.number().int().nonnegative().max(2_147_483_647).default(0), interactive: z.boolean().default(false) }), false, async (args, context) => {
    let status: Awaited<ReturnType<SandboxExecutor['status']>> | undefined;
    let prepared: PreparedCommand | undefined;
    if (sandbox) {
      status = await sandbox.status(workspace.root);
      if (sandbox.mode === 'required' && !status.available) throw new Error(`OS sandbox is required but unavailable: ${status.reason ?? status.backend}. No command was run.`);
      await workspace.permissions.check('process_start', 'shell', status.available ? `Run this background command inside the ${status.backend} OS sandbox.${status.reason ? ` Setup note: ${status.reason}` : ''}` : `The OS sandbox is unavailable (${status.reason ?? status.backend}). Run this command with host permissions only after approval.`, args.command, context.mode, context.signal);
      if (!status.available && sandbox.needsFallbackApproval('process_start')) await workspace.permissions.check('sandbox_fallback', 'shell', 'The selected process tool is set to auto, but OS isolation is unavailable. Approve running directly on the host.', args.command, context.mode, context.signal);
    } else await workspace.permissions.check('process_start', 'shell', 'Run a background command on the host after approval. No OS sandbox is configured for this tool.', args.command, context.mode, context.signal);
    context.signal.throwIfAborted();
    const processLimit = maxProcesses();
    const active = [...jobs.values()].filter(job => job.running).length;
    if (processLimit > 0 && active >= processLimit) throw new Error(`Configured limit of ${processLimit} active processes reached. Increase maxProcesses or stop a running job.`);
    if (jobs.size >= 50) { const old = [...jobs.values()].find(job => !job.running); if (old) jobs.delete(old.id); }
    const abort = new AbortController(); const cancel = () => abort.abort();
    context.signal.addEventListener('abort', cancel, { once: true });
    const id = randomUUID();
    const configuredTimeout = globalTimeoutMs();
    const timeoutMs = configuredTimeout > 0 ? (args.timeoutMs > 0 ? Math.min(configuredTimeout, args.timeoutMs) : configuredTimeout) : args.timeoutMs;
    const command = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh';
    const commandArgs = process.platform === 'win32' ? ['-NoLogo', '-NoProfile', ...(args.interactive ? [] : ['-NonInteractive']), '-Command', '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);' + args.command] : ['-c', args.command];
    try {
      if (sandbox) {
        try { prepared = await sandbox.prepare(command, commandArgs, workspace.root, context.signal); }
        catch (error: any) {
          if (sandbox.mode === 'required') throw error;
          await workspace.permissions.check('sandbox_fallback', 'shell', `Sandbox setup failed (${String(error?.message ?? error)}). Approve running this background command directly on the host.`, args.command, context.mode, context.signal);
        }
      }
    } catch (error) { context.signal.removeEventListener('abort', cancel); throw error; }
    const launch: PreparedCommand = prepared ?? { command, args: commandArgs, env: subprocessEnvironment(context.isolated), sandboxed: false, cleanup: async () => {}, annotate: (stderr: string) => stderr };
    let child: ReturnType<typeof execa>;
    try { child = execa(launch.command, launch.args, { cwd: workspace.root, env: launch.sandboxed ? launch.env : subprocessEnvironment(context.isolated), windowsHide: true, cancelSignal: abort.signal, killDescendants: true, timeout: timeoutMs, maxBuffer: 1, buffer: false, reject: false, stdin: args.interactive ? 'pipe' : 'ignore' }); }
    catch (error) { await launch.cleanup(); context.signal.removeEventListener('abort', cancel); throw error; }
    const buffer = new ProcessOutputBuffer(outputLimit);
    const execution = launch.sandboxed ? `sandboxed (${status?.backend ?? 'OS'})` : `host${launch.reason ? ` (sandbox fallback: ${launch.reason})` : sandbox?.mode === 'off' ? ' (sandbox off)' : ''}`;
    const job: Job = { id, command: safeText(args.command), execution, interactive: args.interactive, ...(args.interactive && child.stdin ? { stdin: child.stdin } : {}), buffer, output: '', truncated: false, running: true, abort, done: Promise.resolve(), waiters: new Set(), cleanup: () => context.signal.removeEventListener('abort', cancel) };
    const publishOutput = () => { job.output = buffer.output; job.truncated = buffer.truncated; job.waiters.forEach(wake => wake()); };
    child.stdout?.on('data', (chunk: Buffer) => { buffer.write('stdout', chunk); publishOutput(); });
    child.stderr?.on('data', (chunk: Buffer) => { buffer.write('stderr', chunk); publishOutput(); });
    child.stdout?.on('end', () => { buffer.end('stdout'); publishOutput(); });
    child.stderr?.on('end', () => { buffer.end('stderr'); publishOutput(); });
    job.done = child.then(result => { job.exitCode = result.exitCode; if (result.timedOut) job.error = 'Timeout'; if (result.isCanceled) job.error = 'Cancelled'; }, error => { job.error = safeText(error.message); }).finally(async () => { job.running = false; job.output = safeText(buffer.output); job.truncated = buffer.truncated; job.waiters.forEach(wake => wake()); try { await launch.cleanup(); } finally { job.cleanup(); } });
    jobs.set(id, job); return { id, running: true, interactive: job.interactive };
  });
  registry.add('process_list', 'List background jobs started by this agent.', z.object({}), true, async () => [...jobs.values()].map(job => ({ ...snapshot(job), output: undefined })));
  registry.add('process_output', 'Read retained output and actual status of a background job. Output is trimmed only when Tool output is configured.', z.object({ id: z.string(), waitMs: z.number().int().min(0).max(30000).default(0) }), true, async (args, context) => {
    const job = find(args.id);
    if (args.waitMs && job.running) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cancel = () => {};
      try { await Promise.race([job.done, new Promise<void>(resolve => { cancel = resolve; timer = setTimeout(resolve, args.waitMs); context.signal.addEventListener('abort', cancel, { once: true }); })]); }
      finally { if (timer) clearTimeout(timer); context.signal.removeEventListener('abort', cancel); }
    }
    context.signal.throwIfAborted(); return { ...snapshot(job), output: safeText(job.output) };
  });
  registry.add('process_wait', 'Wait until a background process writes a literal marker, exits, is cancelled or reaches a timeout.', z.object({ id: z.string(), text: z.string().min(1).max(1000), timeoutMs: z.number().int().min(1).max(60000).default(15000) }), true, async (args, context) => {
    const job = find(args.id);
    job.output = job.buffer.output; job.truncated = job.buffer.truncated;
    if (!job.output.includes(args.text) && job.running) await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = () => { if (settled) return; settled = true; clearTimeout(timer); job.waiters.delete(check); context.signal.removeEventListener('abort', onAbort); resolve(); };
      const check = () => { if (job.output.includes(args.text) || !job.running) finish(); };
      const onAbort = () => { if (settled) return; settled = true; clearTimeout(timer); job.waiters.delete(check); reject(context.signal.reason ?? new Error('Cancelled.')); };
      const timer = setTimeout(finish, args.timeoutMs); job.waiters.add(check); context.signal.addEventListener('abort', onAbort, { once: true }); check();
    });
    context.signal.throwIfAborted();
    return { id: job.id, matched: job.output.includes(args.text), running: job.running, exitCode: job.exitCode, output: safeText(job.output) };
  });
  registry.add('process_input', 'Send text or a newline to stdin of an interactive process_start job. Pipe-based interaction; this is not a terminal emulator/PTY.', z.object({ id: z.string(), input: z.string().max(10000), closeStdin: z.boolean().default(false) }), false, async (args, context) => {
    const job = find(args.id); await workspace.permissions.check('process_input', 'external', `Input to process ${job.id}; exact content is hidden.`, '[input content hidden]', context.mode, context.signal);
    if (!job.running) throw new Error('Process has already exited.');
    if (!job.interactive || !job.stdin) throw new Error('Process was not started with interactive=true.');
    await new Promise<void>((resolve, reject) => job.stdin!.write(args.input, error => error ? reject(error) : resolve()));
    if (args.closeStdin) job.stdin.end();
    return { id: job.id, sent: args.input.length, closed: args.closeStdin };
  });
  registry.add('process_stop', 'Stop only a background job created by process_start, including its child processes.', z.object({ id: z.string() }), false, async (args, context) => { const job = find(args.id); await workspace.permissions.check('process_stop', 'external', `Stop your process ${job.id}`, job.command, context.mode, context.signal); job.abort.abort(); await job.done; return snapshot(job); });
}
