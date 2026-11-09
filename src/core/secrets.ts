import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execa } from 'execa';
import { sanitizeTerminalText } from './terminal-text.js';

const secrets = new Set<string>();
export function isSecretEnvironmentName(name: string): boolean {
  return /(?:api[_-]?key|(?:^|[_-])key(?:$|[_-])|auth(?:entication|orization)?|token|secret|password|credential|cookie|bearer|private[_-]?key|signature|jwt)/i.test(name);
}
export function registerSecret(value: string | undefined): void { if (value && value.length > 3) secrets.add(value); }
export function redact(text: string): string {
  let result = text;
  for (const secret of secrets) result = result.split(secret).join('[REDACTED]');
  return result
    .replace(/\b(?:sk-[\w-]{12,}|sk_(?:live|test)_[\w-]{16,}|rk_(?:live|test)_[\w-]{16,}|AIza[\w-]{20,}|gh[pousr]_[\w]{20,}|gsk_[\w-]{20,}|nvapi-[\w-]{20,}|xai-[\w-]{20,}|ya29\.[\w-]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[\w-]{20,})\b/g, '[REDACTED]')
    .replace(/((?:api[_-]?key|authorization|password|secret|access[_-]?token)\s*[=:]\s*["']?)(?:Bearer\s+)?[^\s"',;}]+/gi, '$1[REDACTED]');
}
export function safeText(text: string): string {
  return sanitizeTerminalText(redact(text));
}
export function subprocessEnvironment(isolated = false): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  if (isolated) for (const name of Object.keys(environment)) if (/(?:API[_-]?KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL|AUTHORIZATION|ACCESS[_-]?KEY|PRIVATE[_-]?KEY)/i.test(name)) delete environment[name];
  return environment;
}
/** Holds suffixes that could be the beginning of a known secret across stream chunks. */
export class StreamRedactor {
  private pending = '';
  push(chunk: string): string {
    this.pending += chunk;
    for (const secret of secrets) this.pending = this.pending.split(secret).join('[REDACTED]');
    let keep = 0;
    for (const secret of secrets) {
      for (let size = Math.min(secret.length - 1, this.pending.length); size > keep; size--) {
        if (this.pending.endsWith(secret.slice(0, size))) { keep = size; break; }
      }
    }
    const output = this.pending.slice(0, this.pending.length - keep);
    this.pending = keep ? this.pending.slice(-keep) : '';
    return redact(output);
  }
  flush(): string { const output = redact(this.pending); this.pending = ''; return output; }
}
// PowerShell's SecureString cmdlets autoload inconsistently in CI. Direct DPAPI
// retains the same hex blob format, so credentials already saved by older builds still decrypt.
const dpapiUnprotect = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $hex=[Console]::In.ReadToEnd().Trim(); if ($hex.Length -eq 0 -or ($hex.Length % 2) -ne 0 -or $hex -notmatch '^[0-9A-Fa-f]+$') { throw 'Invalid DPAPI ciphertext.' }; $cipher=New-Object byte[] ($hex.Length / 2); for ($i=0; $i -lt $hex.Length; $i+=2) { $cipher[$i/2]=[Convert]::ToByte($hex.Substring($i,2),16) }; $plain=$null; try { $plain=[Security.Cryptography.ProtectedData]::Unprotect($cipher,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write([Text.Encoding]::Unicode.GetString($plain)) } finally { [Array]::Clear($cipher,0,$cipher.Length); if ($plain) { [Array]::Clear($plain,0,$plain.Length) } }";
const dpapiProtect = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $plain=[Text.Encoding]::Unicode.GetBytes([Console]::In.ReadToEnd()); $cipher=$null; try { $cipher=[Security.Cryptography.ProtectedData]::Protect($plain,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write([BitConverter]::ToString($cipher).Replace('-','')) } finally { [Array]::Clear($plain,0,$plain.Length); if ($cipher) { [Array]::Clear($cipher,0,$cipher.Length) } }";
export class SecretVault {
  private cached = new Map<string, Promise<string | undefined>>();
  constructor(private home: string) {}
  private file(id: string): string { return path.join(this.home, 'credentials', `${Buffer.from(id).toString('hex')}.dpapi`); }
  async get(id: string, env?: string): Promise<string | undefined> {
    const value = env ? process.env[env] : undefined;
    if (value) { registerSecret(value); return value; }
    if (process.platform !== 'win32') return undefined;
    let pending = this.cached.get(id);
    if (!pending) {
      pending = this.unprotect(id);
      this.cached.set(id, pending);
      void pending.catch(() => this.cached.delete(id));
    }
    return pending;
  }
  private async unprotect(id: string): Promise<string | undefined> {
    let encrypted: string;
    try { encrypted = await readFile(this.file(id), 'utf8'); } catch (error: any) { if (error.code === 'ENOENT') return undefined; throw error; }
    const { stdout } = await execa('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', dpapiUnprotect], { input: encrypted, timeout: 15000, windowsHide: true });
    registerSecret(stdout); return stdout;
  }
  async set(id: string, value: string): Promise<void> {
    registerSecret(value);
    if (process.platform !== 'win32') throw new Error('On this system, use an API environment variable. The DPAPI vault requires Windows.');
    const { stdout } = await execa('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', dpapiProtect], { input: value, timeout: 15000, windowsHide: true });
    const target = this.file(id), temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(path.dirname(target), { recursive: true });
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(stdout, 'utf8'); await file.sync(); } finally { await file.close(); }
      await rename(temporary, target);
    } finally { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); }
    this.cached.set(id, Promise.resolve(value));
  }
}
