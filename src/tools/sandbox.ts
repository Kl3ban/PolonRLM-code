import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { rgPath } from '@vscode/ripgrep';
import {
  SandboxManager, VENDORED_SRT_WIN_EXE, checkWindowsDependenciesAsync, getWindowsSandboxUserStatusAsync,
  installWindowsSandboxAsync, resolveSrtWin,
  type WindowsInstallOptions,
  type SandboxRuntimeConfig,
} from '@anthropic-ai/sandbox-runtime';
import type { Settings } from '../core/types.js';
import { isSecretEnvironmentName } from '../core/secrets.js';

export interface SandboxStatus { mode: Settings['sandboxMode']; available: boolean; backend: string; reason?: string }
export type WindowsSandboxInstaller = (options?: WindowsInstallOptions) => ReturnType<typeof installWindowsSandboxAsync>;

export async function installWindowsSandboxOnDemand(
  workspaceRoot: string,
  installer: WindowsSandboxInstaller = installWindowsSandboxAsync,
  platform = process.platform,
): Promise<Awaited<ReturnType<typeof installWindowsSandboxAsync>>> {
  if (platform !== 'win32') throw new Error('The OS sandbox setup command is available only on Windows.');
  const [project, executable] = await Promise.all([realpath(workspaceRoot), realpath(VENDORED_SRT_WIN_EXE)]);
  if (pathWithin(project, executable)) throw new Error('The bundled Windows sandbox installer is inside the writable project. Refusing to run it with administrator access. Install PolonRLM outside this project, then run setup again.');
  const srtWin = resolveSrtWin({ path: executable });
  return installer({ srtWin, allowLoopback: false, skipProfileGrant: true });
}

export interface PreparedCommand {
  command: string; args: string[]; env: NodeJS.ProcessEnv; sandboxed: boolean; reason?: string;
  cleanup(): Promise<void>;
  annotate(stderr: string): string;
}

function pathWithin(root: string, value: string): boolean {
  const relative = path.relative(root, value);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function windowsGrantReadDenies(workspaceRoot: string, grantRoots: string[]): string[] {
  const workspace = path.win32.resolve(workspaceRoot);
  return grantRoots.filter(root => {
    const relative = path.win32.relative(workspace, path.win32.resolve(root));
    const grantIsInsideWorkspace = relative === '' || (!relative.startsWith(`..${path.win32.sep}`) && relative !== '..' && !path.win32.isAbsolute(relative));
    return !grantIsInsideWorkspace;
  });
}

function shellQuotePosix(value: string): string { return `'${value.replaceAll("'", "'\"'\"'")}'`; }
function shellQuotePowerShell(value: string): string { return `'${value.replaceAll("'", "''")}'`; }

function commandText(command: string, args: string[]): { text: string; shell: string } {
  if (process.platform === 'win32') {
    const commandIndex = args.findIndex(value => value.toLowerCase() === '-command');
    if (/^(?:powershell|powershell\.exe|pwsh|pwsh\.exe)$/i.test(path.basename(command)) && commandIndex >= 0) {
      return { text: args.slice(commandIndex + 1).join(' '), shell: 'powershell' };
    }
    const invocation = `& ${[command, ...args].map(shellQuotePowerShell).join(' ')}; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }`;
    return { text: invocation, shell: 'powershell' };
  }
  if (path.basename(command) === 'sh' && args[0] === '-c') return { text: args.slice(1).join(' '), shell: '/bin/sh' };
  return { text: [command, ...args].map(shellQuotePosix).join(' '), shell: '/bin/sh' };
}

function hostCommand(command: string, args: string[], reason?: string): PreparedCommand {
  return { command, args, env: process.env, sandboxed: false, ...(reason ? { reason } : {}), cleanup: async () => {}, annotate: stderr => stderr };
}

let sharedConfigKey: string | undefined;
let sharedInitialization: Promise<void> | undefined;
let sharedLeases = 0;

export class SandboxExecutor {
  private acquired = false;
  private closed = false;
  private acquirePromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private activeRuns = 0;
  private activePreparations = 0;
  private closeWaiters: (() => void)[] = [];
  private windowsDeniedGrantRoots: string[] = [];

  constructor(private readonly settings: Settings, private readonly workspaceRoot: string) {}

  get mode(): Settings['sandboxMode'] { return this.settings.sandboxMode; }
  needsFallbackApproval(tool: string): boolean { return this.settings.toolPermissions[tool] === 'auto' && this.settings.permissions !== 'all'; }

  async status(cwd: string, mode = this.settings.sandboxMode): Promise<SandboxStatus> {
    if (mode === 'off') return { mode, available: false, backend: 'host', reason: 'OS sandbox is disabled in settings.' };
    if (!SandboxManager.isSupportedPlatform()) return { mode, available: false, backend: process.platform, reason: `The OS sandbox does not support ${process.platform}.` };
    if (process.platform === 'win32' && !pathWithin(this.workspaceRoot, cwd)) {
      return { mode, available: false, backend: 'srt-win', reason: 'The Windows sandbox session grants access only to the main project; this temporary subagent workspace is outside it.' };
    }
    try {
      if (process.platform === 'win32') {
        const srtWin = resolveSrtWin({ path: VENDORED_SRT_WIN_EXE });
        const dependencies = await checkWindowsDependenciesAsync({ srtWin, allowLoopback: false });
        if (dependencies.errors.length) return { mode, available: false, backend: 'srt-win', reason: dependencies.errors.join('; ') };
        const userStatus = await getWindowsSandboxUserStatusAsync({ srtWin });
        if (!userStatus.provisioned || !userStatus.credPresent) {
          const missing = [!userStatus.provisioned ? 'sandbox account' : '', !userStatus.credPresent ? 'credential' : ''].filter(Boolean).join(' and ');
          return { mode, available: false, backend: 'srt-win', reason: `Windows sandbox is not provisioned (${missing}). Run /sandbox setup to review the one-time installer, then /sandbox setup confirm.` };
        }
        if (userStatus.persistentGrants?.state === 'unknown') {
          return { mode, available: false, backend: 'srt-win', reason: `Existing Windows sandbox ACL grants could not be enumerated: ${userStatus.persistentGrants.reason ?? 'unknown status'}. No command was run.` };
        }
        this.windowsDeniedGrantRoots = windowsGrantReadDenies(this.workspaceRoot, userStatus.persistentGrants?.roots ?? []);
        const notes = [
          'Windows keeps this project ACL grant between sessions. Existing grants outside this workspace are denied for this command. Other sandbox programs that do not apply those denials may read kept grants. Remove this project grant with srt-win acl forget <project path>.',
          ...dependencies.warnings,
        ];
        return { mode, available: true, backend: 'srt-win', reason: notes.join('; ') };
      }
      const dependencies = await SandboxManager.checkDependenciesAsync({ command: rgPath });
      if (dependencies.errors.length) return { mode, available: false, backend: process.platform === 'darwin' ? 'seatbelt' : 'bubblewrap', reason: dependencies.errors.join('; ') };
      return { mode, available: true, backend: process.platform === 'darwin' ? 'seatbelt' : 'bubblewrap', ...(dependencies.warnings.length ? { reason: dependencies.warnings.join('; ') } : {}) };
    } catch (error: any) {
      return { mode, available: false, backend: process.platform === 'win32' ? 'srt-win' : process.platform === 'darwin' ? 'seatbelt' : 'bubblewrap', reason: `Sandbox dependency check failed: ${String(error?.message ?? error)}` };
    }
  }

  async installWindows(): Promise<Awaited<ReturnType<typeof installWindowsSandboxAsync>>> {
    return installWindowsSandboxOnDemand(this.workspaceRoot);
  }

  async prepare(command: string, args: string[], cwd: string, signal: AbortSignal): Promise<PreparedCommand> {
    if (this.closed) throw new Error('Sandbox session has already closed.');
    this.activePreparations++;
    try { return await this.prepareCommand(command, args, cwd, signal); }
    finally {
      this.activePreparations--;
      this.wakeCloseWaiters();
    }
  }

  private async prepareCommand(command: string, args: string[], cwd: string, signal: AbortSignal): Promise<PreparedCommand> {
    signal.throwIfAborted();
    const status = await this.status(cwd);
    if (!status.available) {
      if (this.settings.sandboxMode === 'required') throw new Error(`OS sandbox is required but unavailable: ${status.reason ?? status.backend}. No command was run.`);
      return hostCommand(command, args, status.reason ?? 'OS sandbox is unavailable.');
    }

    let tempRoot: string | undefined;
    try {
      let tempDirectory: string;
      if (process.platform === 'win32') {
        const metadata = path.join(this.workspaceRoot, '.polonrlm');
        try { await lstat(metadata); }
        catch (error: any) { if (error.code !== 'ENOENT') throw error; await mkdir(metadata); }
        const metadataStat = await lstat(metadata);
        if (!metadataStat.isDirectory() || metadataStat.isSymbolicLink() || !pathWithin(this.workspaceRoot, await realpath(metadata))) throw new Error('Sandbox metadata path must be a real directory inside the project.');
        const parent = path.join(metadata, 'sandbox-tmp');
        try {
          const existing = await lstat(parent);
          if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error('Sandbox temp path must be a real directory inside the project.');
        } catch (error: any) { if (error.code !== 'ENOENT') throw error; await mkdir(parent); }
        const parentStat = await lstat(parent);
        if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error('Sandbox temp path must be a real directory inside the project.');
        const realParent = await realpath(parent);
        if (!pathWithin(this.workspaceRoot, realParent)) throw new Error('Sandbox temp path resolves outside the project.');
        tempDirectory = await mkdtemp(path.join(realParent, 'run-'));
        tempRoot = tempDirectory;
      } else {
        tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'polonrlm-sandbox-'));
        tempRoot = tempDirectory;
      }
      const runtimeConfig = await this.configFor(cwd);
      await this.acquire(runtimeConfig);
      signal.throwIfAborted();
      const commandId = randomUUID();
      const text = commandText(command, args);
      const customConfig: Partial<SandboxRuntimeConfig> = process.platform === 'win32' ? {
        filesystem: { denyRead: [os.homedir(), ...this.windowsDeniedGrantRoots], allowWrite: [], denyWrite: [] },
      } : {
        network: { allowedDomains: this.settings.sandboxNetworkDomains, deniedDomains: [], strictAllowlist: true },
        filesystem: { denyRead: [os.homedir()], allowRead: [cwd, tempDirectory], allowWrite: [cwd, tempDirectory], denyWrite: [] },
      };
      const wrapped = await SandboxManager.wrapWithSandboxArgv(text.text, text.shell, customConfig, signal, cwd, { commandId, commandText: text.text });
      const env = { ...wrapped.env };
      // The sandbox proxy's generated environment remains intact, but secrets
      // inherited from the user's shell are not passed into project code.
      for (const key of Object.keys(process.env)) if (isSecretEnvironmentName(key)) delete env[key];
      env.TMP = tempDirectory; env.TEMP = tempDirectory;
      if (process.platform !== 'win32') env.TMPDIR = tempDirectory;
      this.activeRuns++;
      let cleaned = false;
      return {
        command: wrapped.argv[0]!, args: wrapped.argv.slice(1), env, sandboxed: true,
        ...(status.reason ? { reason: status.reason } : {}),
        cleanup: async () => {
          if (cleaned) return;
          cleaned = true;
          try { SandboxManager.cleanupAfterCommand(); } finally {
            try { if (tempRoot) await rm(tempRoot, { recursive: true, force: true }); }
            finally { this.activeRuns--; this.wakeCloseWaiters(); }
          }
        },
        annotate: stderr => SandboxManager.annotateStderrWithSandboxFailures(commandId, stderr),
      };
    } catch (error) {
      if (tempRoot) await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      if (this.activeRuns > 0 || this.activePreparations > 0) await new Promise<void>(resolve => this.closeWaiters.push(resolve));
      if (this.acquirePromise) await this.acquirePromise.catch(() => {});
      if (this.acquired) {
        this.acquired = false;
        sharedLeases--;
        if (sharedLeases === 0) {
          try { await SandboxManager.reset(); }
          finally { sharedConfigKey = undefined; sharedInitialization = undefined; }
        }
      }
    })();
    return this.closePromise;
  }

  private wakeCloseWaiters(): void {
    if (this.activeRuns !== 0 || this.activePreparations !== 0) return;
    for (const wake of this.closeWaiters.splice(0)) wake();
  }

  private async configFor(_cwd: string): Promise<SandboxRuntimeConfig> {
    const filesystem = process.platform === 'win32'
      ? { denyRead: [os.homedir(), ...this.windowsDeniedGrantRoots], allowRead: [this.workspaceRoot], allowWrite: [this.workspaceRoot, path.join(this.workspaceRoot, '.polonrlm', 'sandbox-tmp')], denyWrite: [] }
      : { denyRead: [os.homedir()], allowRead: [], allowWrite: [], denyWrite: [] };
    return {
      network: { allowedDomains: process.platform === 'win32' ? this.settings.sandboxNetworkDomains : [], deniedDomains: [], strictAllowlist: true },
      filesystem,
      ripgrep: { command: rgPath },
      ...(process.platform === 'win32' ? { windows: { backend: 'srt-win' as const, srtWin: { path: VENDORED_SRT_WIN_EXE } } } : {}),
    };
  }

  private async acquire(config: SandboxRuntimeConfig): Promise<void> {
    if (this.acquired) return;
    if (this.acquirePromise) return this.acquirePromise;
    if (this.closed) throw new Error('Sandbox session has already closed.');
    this.acquirePromise = (async () => {
      const key = JSON.stringify(config);
      if (sharedInitialization && sharedConfigKey !== key) throw new Error('Another PolonRLM sandbox session is active with a different project policy. Close it before switching workspaces.');
      if (!sharedInitialization) {
        sharedConfigKey = key;
        sharedInitialization = SandboxManager.initialize(config).catch(error => { sharedInitialization = undefined; sharedConfigKey = undefined; throw error; });
      }
      await sharedInitialization;
      sharedLeases++;
      this.acquired = true;
    })().finally(() => { this.acquirePromise = undefined; });
    return this.acquirePromise;
  }
}
