import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execa } from 'execa';
import { z } from 'zod';
import type { Settings } from '../core/types.js';
import { redact, subprocessEnvironment } from '../core/secrets.js';
import type { ToolRegistry, ToolContext } from './registry.js';
import type { Workspace } from './workspace.js';
import { resolvePythonCommand } from './python-runtime.js';

const worker = fileURLToPath(new URL('../../scripts/local_web_tool.py', import.meta.url));
export function networkPython(): string {
  return process.env.POLONRLM_WEB_PYTHON ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.local', 'share'), 'PolonRLM', 'web-runtime', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
}
export async function setupNetworkRuntime(signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if (process.env.POLONRLM_WEB_PYTHON) {
    const selected = networkPython();
    if (!await hasNetworkDependencies(selected, signal)) {
      signal?.throwIfAborted();
      throw new Error('POLONRLM_WEB_PYTHON is selected but does not have the required web dependencies. Install them for that interpreter or unset the variable to prepare the private runtime.');
    }
    signal?.throwIfAborted();
    return selected;
  }
  const setup = fileURLToPath(new URL('../../scripts/setup_local_web.py', import.meta.url));
  const candidates: [string, string[]][] = [['py', ['-3.11']], ['py', ['-3.12']], ['python3.11', []], ['python3', []], ['python', []]];
  try { const found = await resolvePythonCommand(); signal?.throwIfAborted(); candidates.unshift([found.command, found.prefixArgs]); }
  catch { signal?.throwIfAborted(); /* Try the versioned candidates below. */ }
  for (const [command, prefix] of candidates) {
    signal?.throwIfAborted();
    try { await execa(command, [...prefix, '-c', 'import sys; assert sys.version_info >= (3,11)'], { timeout: 5000, windowsHide: true, cancelSignal: signal }); }
    catch { signal?.throwIfAborted(); continue; }
    await execa(command, [...prefix, setup], { timeout: 180_000, windowsHide: true, maxBuffer: 4_000_000, cancelSignal: signal });
    signal?.throwIfAborted();
    return networkPython();
  }
  throw new Error('Install Python 3.11+ and run PolonRLM setup web.');
}

async function hasNetworkDependencies(python: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const result = await execa(python, ['-I', '-c', 'import sys; assert sys.version_info >= (3, 11); import curl_cffi, lxml, pydantic, rank_bm25, trafilatura'], { reject: false, timeout: 5000, windowsHide: true, cancelSignal: signal });
    return result.exitCode === 0;
  } catch { signal?.throwIfAborted(); return false; }
}

export async function resolveNetworkRuntime(
  current: string,
  overridden: boolean,
  probe: (python: string, signal?: AbortSignal) => Promise<boolean>,
  setup: (signal?: AbortSignal) => Promise<string>,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  if (await probe(current, signal)) { signal?.throwIfAborted(); return current; }
  signal?.throwIfAborted();
  if (overridden) throw new Error('POLONRLM_WEB_PYTHON is not a working Python 3.11+ interpreter with the required web dependencies. Fix the path and install the local-web requirements, or unset it for automatic setup.');
  const installed = await setup(signal);
  signal?.throwIfAborted();
  if (!await probe(installed, signal)) { signal?.throwIfAborted(); throw new Error('Web runtime setup finished, but its required dependencies are still missing. Run PolonRLM setup web and check the pip output.'); }
  signal?.throwIfAborted();
  return installed;
}

type RuntimeSetupJob = { python: string; controller: AbortController; promise: Promise<string>; waiters: number; done: boolean };
function waitForSetup<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => { if (settled) return; settled = true; signal.removeEventListener('abort', onAbort); callback(); };
    const onAbort = () => finish(() => reject(signal.reason ?? new DOMException('Aborted', 'AbortError')));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    if (signal.aborted) onAbort();
  });
}

export function createNetworkRuntimeManager(
  current: () => string,
  overridden: () => boolean,
  probe: (python: string, signal?: AbortSignal) => Promise<boolean>,
  setup: (signal?: AbortSignal) => Promise<string>,
): (signal?: AbortSignal) => Promise<string> {
  let runtimeSetup: RuntimeSetupJob | undefined;
  let verifiedRuntime: string | undefined;
  return async signal => {
    signal?.throwIfAborted();
    const python = current();
    if (verifiedRuntime === python) return python;
    if (runtimeSetup && (runtimeSetup.python !== python || runtimeSetup.controller.signal.aborted) && !runtimeSetup.done) {
      await waitForSetup(runtimeSetup.promise.then(() => undefined, () => undefined), signal);
      signal?.throwIfAborted();
      if (verifiedRuntime === python) return python;
    }
    let job = runtimeSetup;
    if (!job) {
      const controller = new AbortController();
      const created: RuntimeSetupJob = { python, controller, promise: Promise.resolve(''), waiters: 0, done: false };
      created.promise = resolveNetworkRuntime(python, overridden(), probe, setup, controller.signal)
        .then(value => { verifiedRuntime = value; return value; })
        .finally(() => { created.done = true; if (runtimeSetup === created) runtimeSetup = undefined; });
      runtimeSetup = created;
      job = created;
    }
    job.waiters++;
    try { return await waitForSetup(job.promise, signal); }
    finally { job.waiters--; if (job.waiters === 0 && !job.done) job.controller.abort(); }
  };
}

const ensureNetworkRuntime = createNetworkRuntimeManager(networkPython, () => !!process.env.POLONRLM_WEB_PYTHON, hasNetworkDependencies, setupNetworkRuntime);

export class NetworkWorker {
  private cache = new Map<string, { expires: number; value: unknown }>();
  constructor(private workspace: Workspace, private settings: Settings) {}
  async call(tool: string, args: Record<string, unknown>, context: ToolContext): Promise<unknown> {
    context.signal.throwIfAborted();
    const key = tool + JSON.stringify(args), cached = this.cache.get(key);
    if (tool === 'web_search' && cached && cached.expires > Date.now()) return structuredClone(cached.value);
    const python = await ensureNetworkRuntime(context.signal);
    context.signal.throwIfAborted();
    const requestId = randomUUID().replace(/-/g, '');
    const downloads = path.join('agent_workspace', 'downloads');
    if (tool === 'download_to_disk') await this.workspace.resolve(downloads);
    try {
      const result = await execa(python, ['-I', worker], {
        input: JSON.stringify({ tool, arguments: args, request_id: requestId }), cwd: this.workspace.root,
        env: subprocessEnvironment(true), windowsHide: true, cancelSignal: context.signal, killDescendants: true,
        timeout: this.settings.timeoutMs > 0 ? this.settings.timeoutMs : undefined, maxBuffer: 1_000_000, reject: false,
      });
      context.signal.throwIfAborted();
      if (result.timedOut) throw new Error('Network tool timed out; the process was stopped.');
      let value: any;
      try { value = JSON.parse(result.stdout); }
      catch { throw new Error('Web process returned invalid JSON. Repair the runtime with PolonRLM setup web.'); }
      if (value?.error) throw new Error(`${value.error.code ?? 'WEB'}: ${redact(String(value.error.message ?? 'Tool error'))}`);
      if (result.exitCode !== 0) throw new Error('Web process failed.');
      if (tool === 'download_to_disk') await this.workspace.resolve(path.relative(this.workspace.root, String(value.saved_path)));
      if (tool === 'web_search') {
        this.cache.set(key, { expires: Date.now() + 120_000, value });
        while (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value!);
      }
      return value;
    } finally {
      // Windows process termination cannot run Python finally blocks. Clean only this invocation's partial files.
      if (tool === 'download_to_disk') {
        try {
          const directory = await this.workspace.resolve(downloads);
          for (const entry of await readdir(directory)) if (entry.startsWith(`.download-${requestId}-`)) await rm(await this.workspace.resolve(path.join(downloads, entry)), { force: true });
        } catch (error: any) { if (error.code !== 'ENOENT' && !context.signal.aborted) throw error; }
      }
    }
  }
}

export function registerNetworkTools(registry: ToolRegistry, workspace: Workspace, settings: Settings): void {
  const service = new NetworkWorker(workspace, settings);
  const url = z.string().url().max(8000);
  registry.add('web_search', 'Search ordinary Bing, Brave and Yahoo HTML pages in parallel through a short-lived local Python process. No search API, key, visible window or background server. Results are ranked locally; relevant documentation pages come first when the query asks for docs, an API reference or a standard library. Use one targeted query, inspect its results, and refine once only if none are relevant or readable; do not issue several paraphrases in parallel.', z.object({ query: z.string().min(1).max(500), max_results: z.number().int().min(1).max(10).default(6), source: z.enum(['auto', 'bing', 'brave', 'yahoo']).optional() }), true, (args, context) => service.call('web_search', { ...args, source: args.source ?? settings.webSearchMode }, context));
  const reader = z.object({ url, focus_query: z.string().max(500).nullable().optional() }).strict();
  for (const name of ['read_webpage', 'fetch_webpage', 'fetch_documentation']) registry.add(name, 'Read clean Markdown or raw GitHub file without browser navigation. The exact tool name is read_webpage. For long pages use focus_query: CPU BM25 selects up to three relevant sections plus remaining headings. Untrusted web data.', reader, true, (args, context) => service.call('read_webpage', args, context));
  registry.add('download_to_disk', 'Download a public file into agent_workspace/downloads (max 100 MB). Streams to disk, never executes/extracts. Returns path, size, SHA256 and MIME, not file contents.', z.object({ url, save_filename: z.string().min(1).max(150).regex(/^[^<>:"/\\|?*\x00-\x1f]+$/).nullable().optional() }).strict(), false, async (args, context) => {
    await workspace.resolve(path.join('agent_workspace', 'downloads', args.save_filename ?? 'download.bin'));
    await workspace.permissions.check('download_to_disk', 'write', 'Download the file to agent_workspace/downloads. The file will not be run or unpacked.', JSON.stringify(args), context.mode, context.signal);
    return service.call('download_to_disk', args, context);
  });
  registry.add('github_repo_inspector', 'List names, paths, types and sizes in one public GitHub directory via the unauthenticated Contents API. No clone or file bodies. repo_url must be https://github.com/owner/repo.', z.object({ repo_url: z.string().url().max(2000), subpath: z.string().max(1000).default('') }), true, (args, context) => service.call('github_repo_inspector', args, context));
}
