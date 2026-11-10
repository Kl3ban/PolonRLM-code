import { randomUUID } from 'node:crypto';
import { execa } from 'execa';
import { z } from 'zod';
import { StringDecoder } from 'node:string_decoder';
import { safeText, subprocessEnvironment } from '../core/secrets.js';
import type { ToolRegistry } from './registry.js';
import type { Workspace } from './workspace.js';

export class ProcessOutputBuffer {
  private readonly decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
  output = '';
  truncated = false;
  constructor(private readonly maximum = 64000) {}
  write(stream: 'stdout' | 'stderr', chunk: Buffer | string): void { this.append(this.decoders[stream].write(Buffer.from(chunk))); }
  end(stream: 'stdout' | 'stderr'): void { this.append(this.decoders[stream].end()); }
  private append(text: string): void {
    if (!text) return;
    this.output += text;
    if (this.output.length > this.maximum) {
      let start = this.output.length - this.maximum;
      const first = this.output.charCodeAt(start);
      if (first >= 0xdc00 && first <= 0xdfff) start++;
      this.output = this.output.slice(start);
      this.truncated = true;
    }
  }
}

export function registerProcessTools(registry: ToolRegistry, workspace: Workspace, maxProcesses: () => number = () => 0, globalTimeoutMs: () => number = () => 0): void {
  type Job = { id: string; command: string; interactive: boolean; stdin?: NodeJS.WritableStream; output: string; truncated: boolean; running: boolean; exitCode?: number; error?: string; abort: AbortController; done: Promise<void>; waiters: Set<() => void>; cleanup: () => void };
  const jobs = new Map<string, Job>();
  const find = (id: string) => { const job = jobs.get(id); if (!job) throw new Error('Unknown process for this run.'); return job; };
  const snapshot = (job: Job) => ({ id: job.id, command: job.command, interactive: job.interactive, running: job.running, exitCode: job.exitCode, error: job.error, output: job.output, truncated: job.truncated });
  registry.onClose(async () => { jobs.forEach(job => job.abort.abort()); await Promise.all([...jobs.values()].map(job => job.done)); });
  registry.add('process_start', 'Start an approved shell command in the background. Timeout defaults to none; a global timeout or the optional timeoutMs argument can limit it. Output is kept to 64 KB. Only owned jobs can be stopped. Jobs stop on task cancellation, timeout or app exit.', z.object({ command: z.string().min(1).max(10000), timeoutMs: z.number().int().nonnegative().max(2_147_483_647).default(0), interactive: z.boolean().default(false) }), false, async (args, context) => {
    await workspace.permissions.check('process_start', 'shell', 'Run a command in the background outside a sandbox.', args.command, context.mode, context.signal);
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
    const child = execa(process.platform === 'win32' ? 'powershell.exe' : '/bin/sh', process.platform === 'win32' ? ['-NoLogo', '-NoProfile', ...(args.interactive ? [] : ['-NonInteractive']), '-Command', '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);' + args.command] : ['-c', args.command], { cwd: workspace.root, env: subprocessEnvironment(context.isolated), windowsHide: true, cancelSignal: abort.signal, killDescendants: true, timeout: timeoutMs, maxBuffer: 1, buffer: false, reject: false, stdin: args.interactive ? 'pipe' : 'ignore' });
    const job: Job = { id, command: safeText(args.command), interactive: args.interactive, ...(args.interactive && child.stdin ? { stdin: child.stdin } : {}), output: '', truncated: false, running: true, abort, done: Promise.resolve(), waiters: new Set(), cleanup: () => context.signal.removeEventListener('abort', cancel) };
     const output = new ProcessOutputBuffer();
     const publishOutput = () => { job.output = output.output; job.truncated = output.truncated; job.waiters.forEach(wake => wake()); };
     child.stdout?.on('data', (chunk: Buffer) => { output.write('stdout', chunk); publishOutput(); });
     child.stderr?.on('data', (chunk: Buffer) => { output.write('stderr', chunk); publishOutput(); });
     child.stdout?.on('end', () => { output.end('stdout'); publishOutput(); });
     child.stderr?.on('end', () => { output.end('stderr'); publishOutput(); });
    job.done = child.then(result => { job.exitCode = result.exitCode; if (result.timedOut) job.error = 'Timeout'; if (result.isCanceled) job.error = 'Cancelled'; }, error => { job.error = safeText(error.message); }).finally(() => { job.running = false; job.output = safeText(job.output); job.waiters.forEach(wake => wake()); job.cleanup(); });
    jobs.set(id, job); return { id, running: true, interactive: job.interactive };
  });
  registry.add('process_list', 'List background jobs started by this agent.', z.object({}), true, async () => [...jobs.values()].map(job => ({ ...snapshot(job), output: undefined })));
  registry.add('process_output', 'Read recent bounded output and actual status of a background job.', z.object({ id: z.string(), waitMs: z.number().int().min(0).max(30000).default(0) }), true, async (args, context) => {
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
