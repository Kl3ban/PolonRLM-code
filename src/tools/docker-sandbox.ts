import { execa } from 'execa';
import path from 'node:path';

export const DEFAULT_DOCKER_IMAGE = 'node:24-bookworm-slim';
const CHECK_TIMEOUT_MS = 5_000;

export interface DockerStatus { available: boolean; reason?: string }

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

/** Build a Docker argv for one sandboxed command. Kept pure for tests. */
export function dockerRunArgs(options: { image: string; workspace: string; cwd: string; command: string; args: string[] }): string[] {
  const workspace = path.resolve(options.workspace);
  const cwd = path.resolve(options.cwd);
  const relative = path.relative(workspace, cwd);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Docker sandbox can run only inside the project workspace.');
  }
  const containerCwd = relative ? `/workspace/${relative.split(path.sep).join('/')}` : '/workspace';
  const executable = path.basename(options.command).toLowerCase();
  if (process.platform === 'win32' && /^(?:powershell|pwsh)(?:\.exe)?$/.test(executable)) {
    throw new Error('The Docker backend runs Linux containers and cannot execute PowerShell. Use the SRT backend for PowerShell or call node/npm/python directly.');
  }
  let text: string;
  if (executable === 'sh' && options.args[0] === '-c') text = options.args.slice(1).join(' ');
  else text = [options.command, ...options.args].map(quote).join(' ');
  const args = ['run', '--rm', '--init', '--network', 'none', '--memory', '2g', '--pids-limit', '256', '--cpus', '2', '--read-only', '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL', '--tmpfs', '/tmp:rw,noexec,nosuid,size=256m', '-v', `${workspace}:/workspace`, '-w', containerCwd, '-e', 'HOME=/tmp', '-e', 'TMPDIR=/tmp'];
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const gid = typeof process.getgid === 'function' ? process.getgid() : undefined;
  if (uid !== undefined && gid !== undefined) args.push('--user', `${uid}:${gid}`);
  args.push('--', options.image, '/bin/sh', '-lc', text);
  return args;
}

export async function dockerStatus(image: string): Promise<DockerStatus> {
  try {
    const daemon = await execa('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: CHECK_TIMEOUT_MS, reject: false, windowsHide: true });
    if (daemon.exitCode !== 0) return { available: false, reason: 'Docker is installed but its daemon is not running. Start Docker Desktop or the Docker service.' };
    const imageCheck = await execa('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], { timeout: CHECK_TIMEOUT_MS, reject: false, windowsHide: true });
    if (imageCheck.exitCode !== 0) return { available: false, reason: `Docker image ${image} is not present. Run /sandbox setup docker to pull it.` };
    return { available: true };
  } catch {
    return { available: false, reason: 'Docker CLI is not installed or not on PATH.' };
  }
}

export async function pullDockerImage(image: string): Promise<void> {
  const result = await execa('docker', ['pull', image], { timeout: 900_000, reject: false, windowsHide: true });
  if (result.exitCode !== 0) throw new Error(`Could not pull Docker image ${image}: ${(result.stderr || result.stdout || 'unknown error').slice(-1000)}`);
}
