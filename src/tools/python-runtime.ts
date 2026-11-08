import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';

export interface PythonCommand { command: string; prefixArgs: string[] }
type PythonProbe = (candidate: PythonCommand) => Promise<boolean>;

export async function firstUsablePython(candidates: PythonCommand[], probe: PythonProbe): Promise<PythonCommand> {
  for (const candidate of candidates) if (await probe(candidate)) return candidate;
  throw new Error('No working Python 3.8+ interpreter was found. Install Python or set POLONRLM_PYTHON to the full path to python.exe.');
}

let cached: Promise<PythonCommand> | undefined;

export function resolvePythonCommand(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<PythonCommand> {
  return cached ??= findPythonCommand(env, platform).catch(error => { cached = undefined; throw error; });
}

async function findPythonCommand(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<PythonCommand> {
  const candidates: PythonCommand[] = [];
  const add = (command: string | undefined, prefixArgs: string[] = []) => {
    if (command && !candidates.some(candidate => candidate.command.toLowerCase() === command.toLowerCase() && candidate.prefixArgs.join('\0') === prefixArgs.join('\0'))) candidates.push({ command, prefixArgs });
  };
  add(env.POLONRLM_PYTHON);

  if (platform === 'win32') {
    add('py.exe', ['-3']);
    const appData = env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    const localAppData = env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    try {
      const runtimes = await readdir(path.join(appData, 'uv', 'python'), { withFileTypes: true });
      const managed = runtimes.filter(entry => entry.isDirectory() && /^cpython-\d+\.\d+/.test(entry.name))
        .sort((a, b) => version(b.name) - version(a.name));
      for (const runtime of managed) add(path.join(appData, 'uv', 'python', runtime.name, 'python.exe'));
    } catch { /* uv is optional */ }
    try {
      const installs = await readdir(path.join(localAppData, 'Programs', 'Python'), { withFileTypes: true });
      for (const install of installs.filter(entry => entry.isDirectory() && /^Python\d+/i.test(entry.name))) add(path.join(localAppData, 'Programs', 'Python', install.name, 'python.exe'));
    } catch { /* Per-user Python is optional */ }
    for (const executable of ['python.exe', 'python3.exe', 'python']) {
      try {
        const result = await execa('where.exe', [executable], { reject: false, timeout: 3000, windowsHide: true });
        for (const command of result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)) {
          if (!/\\WindowsApps\\/i.test(command)) add(command);
        }
      } catch { /* PATH lookup is optional */ }
    }
  } else {
    add('python3');
    add('python');
  }

  return firstUsablePython(candidates, async candidate => {
    try {
      const result = await execa(candidate.command, [...candidate.prefixArgs, '-c', 'import sys; raise SystemExit(0 if sys.version_info >= (3, 8) else 1)'], { reject: false, timeout: 4000, windowsHide: true });
      return result.exitCode === 0;
    } catch { return false; }
  });
}

function version(name: string): number {
  const match = /cpython-(\d+)\.(\d+)/.exec(name);
  return match ? Number(match[1]) * 100 + Number(match[2]) : 0;
}
