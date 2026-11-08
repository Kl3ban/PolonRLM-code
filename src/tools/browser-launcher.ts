import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { execa } from 'execa';
import { chromium, firefox, type Browser, type LaunchOptions } from 'playwright';

export type BrowserEngine = 'auto' | 'chromium' | 'chrome' | 'edge' | 'brave' | 'firefox';
type Candidate = { engine: Exclude<BrowserEngine, 'auto'>; launch: () => Promise<Browser> };
type ManagedEngine = 'chromium' | 'firefox';
type InstallJob = { controller: AbortController; promise: Promise<void>; waiters: number; done: boolean };
const require = createRequire(import.meta.url);
const installations = new Map<ManagedEngine, InstallJob>();

export function browserEngineOrder(engine: BrowserEngine): Exclude<BrowserEngine, 'auto'>[] {
  return engine === 'auto' ? ['chromium', 'chrome', 'edge', 'brave', 'firefox'] : [engine];
}

export function browserSetupHint(engine: BrowserEngine): string {
  switch (engine) {
    case 'chromium': return 'Install the engine with npx playwright install chromium.';
    case 'firefox': return 'Install the engine with npx playwright install firefox.';
    case 'chrome': return 'Install Google Chrome or choose Auto in /settings.';
    case 'edge': return 'Install Microsoft Edge or choose Auto in /settings.';
    case 'brave': return 'Install Brave or set POLONRLM_BRAVE_PATH. You can also choose Auto in /settings.';
    case 'auto': return 'Install Chromium with npx playwright install chromium or Firefox with npx playwright install firefox. You can also install Chrome, Edge, or Brave.';
  }
}

async function executableExists(executable: string): Promise<boolean> {
  try { await access(executable, constants.F_OK); return true; }
  catch { return false; }
}

function missingBrowserBinary(error: unknown): boolean {
  return error instanceof Error && /Executable doesn't exist at/i.test(error.message);
}

function cleanInstallOutput(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1F\x7F]/g, ' ').trim().slice(-300);
}

async function installPlaywrightBrowser(engine: ManagedEngine, signal?: AbortSignal): Promise<void> {
  let job = installations.get(engine);
  if (!job) {
    const controller = new AbortController();
    const cli = path.join(path.dirname(require.resolve('playwright')), 'cli.js');
    const args = [cli, 'install', engine, ...(engine === 'chromium' ? ['--only-shell'] : [])];
    const pending: InstallJob = { controller, promise: Promise.resolve(), waiters: 0, done: false };
    pending.promise = (async () => {
      try {
        const result = await execa(process.execPath, args, { timeout: 300_000, windowsHide: true, signal: controller.signal, reject: false });
        if (result.exitCode !== 0) {
          const detail = cleanInstallOutput(result.stderr || result.stdout);
          throw new Error(detail || `Browser installation exited with code ${result.exitCode ?? 'unknown'}.`);
        }
      } catch (error) {
        controller.signal.throwIfAborted();
        throw new Error(`Download of ${engine} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
    job = pending;
    installations.set(engine, job);
    void job.promise.then(() => {
      job!.done = true;
      if (installations.get(engine) === job) installations.delete(engine);
    }, () => {
      job!.done = true;
      if (installations.get(engine) === job) installations.delete(engine);
    });
  }
  job.waiters++;
  try {
    signal?.throwIfAborted();
    if (!signal) await job.promise;
    else await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        callback();
      };
      const onAbort = () => finish(() => reject(signal.reason ?? new DOMException('Aborted', 'AbortError')));
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) { onAbort(); return; }
      job!.promise.then(() => finish(resolve), error => finish(() => reject(error)));
    });
  } finally {
    job.waiters--;
    if (!job.waiters && !job.done) job.controller.abort();
  }
}

async function existingBraveExecutable(): Promise<string | undefined> {
  const windows = process.platform === 'win32';
  const darwin = process.platform === 'darwin';
  const names = windows ? ['brave.exe', 'brave-browser.exe'] : darwin ? ['Brave Browser'] : ['brave-browser', 'brave'];
  const directories = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const candidates = [process.env.POLONRLM_BRAVE_PATH];
  if (windows) {
    const programFiles = process.env.ProgramFiles ?? process.env.PROGRAMFILES ?? 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] ?? process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';
    const localAppData = process.env.LOCALAPPDATA;
    candidates.push(
      path.join(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      path.join(programFilesX86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      ...(localAppData ? [path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')] : []),
    );
  } else if (darwin) {
    candidates.push(
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      ...(process.env.HOME ? [path.join(process.env.HOME, 'Applications/Brave Browser.app/Contents/MacOS/Brave Browser')] : []),
    );
  } else {
    directories.push('/usr/bin', '/usr/local/bin', '/opt/brave.com/brave', '/snap/bin');
  }
  candidates.push(...directories.flatMap(directory => names.map(name => path.join(directory, name))));
  const flag = windows ? constants.F_OK : constants.X_OK;
  for (const executable of [...new Set(candidates.filter((item): item is string => !!item))]) {
    try { await access(executable, flag); return executable; } catch { /* Try the next installed location. */ }
  }
  return undefined;
}

function launchOptions(proxyServer: string): LaunchOptions {
  return { headless: true, proxy: { server: proxyServer } };
}

export async function launchBrowser(engine: BrowserEngine, proxyServer: string, signal?: AbortSignal): Promise<{ browser: Browser; engine: Exclude<BrowserEngine, 'auto'> }> {
  signal?.throwIfAborted();
  const options = launchOptions(proxyServer);
  const candidates: Candidate[] = [
    { engine: 'chromium', launch: () => chromium.launch(options) },
    { engine: 'chrome', launch: () => chromium.launch({ ...options, channel: 'chrome' }) },
    { engine: 'edge', launch: () => chromium.launch({ ...options, channel: 'msedge' }) },
  ];
  const bravePath = engine === 'brave' || engine === 'auto' ? await existingBraveExecutable() : undefined;
  if (engine === 'brave' && !bravePath) throw new Error(`Brave is not installed. ${browserSetupHint('brave')}`);
  if (bravePath) candidates.push({ engine: 'brave', launch: () => chromium.launch({ ...options, executablePath: bravePath }) });
  candidates.push({ engine: 'firefox', launch: () => firefox.launch(options) });

  const order = browserEngineOrder(engine);
  const selected = order.flatMap(name => candidates.filter(candidate => candidate.engine === name));
  if (!selected.length) throw new Error(`Engine ${engine} is not installed. ${browserSetupHint(engine)}`);
  const failures: { engine: Exclude<BrowserEngine, 'auto'>; error: unknown }[] = [];
  for (const candidate of selected) {
    signal?.throwIfAborted();
    try { return { browser: await candidate.launch(), engine: candidate.engine }; }
    catch (error) { failures.push({ engine: candidate.engine, error }); }
  }
  const missingManaged = engine === 'auto'
    ? failures.find(item => item.engine === 'chromium' && missingBrowserBinary(item.error))
    : ['chromium', 'firefox'].includes(engine) ? failures.find(item => item.engine === engine && missingBrowserBinary(item.error)) : undefined;
  if (missingManaged) {
    const managedEngine = missingManaged.engine as ManagedEngine;
    try {
      await installPlaywrightBrowser(managedEngine, signal);
      signal?.throwIfAborted();
      const candidate = candidates.find(item => item.engine === managedEngine)!;
      try { return { browser: await candidate.launch(), engine: managedEngine }; }
      catch (error) { failures.push({ engine: managedEngine, error }); }
    } catch (error) {
      signal?.throwIfAborted();
      throw new Error(`${managedEngine} is missing and could not be installed on first use. ${error instanceof Error ? error.message : String(error)}. ${browserSetupHint(engine)}`);
    }
  }
  const summary = failures.map(({ engine: name, error }) => `${name}: ${error instanceof Error ? error.message.slice(0, 180) : String(error).slice(0, 180)}`).join(' · ');
  throw new Error(`Could not launch ${engine}. ${summary}. ${browserSetupHint(engine)}`);
}
