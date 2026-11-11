import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';

export type RecoveryChangeState = 'prepared' | 'applied' | 'rolled_back' | 'aborted' | 'conflict';
export type RecoveryGroupState = 'running' | 'committed' | 'rolled_back' | 'partial';
export type RecoveryEncoding = 'utf8' | 'utf8bom' | 'utf16le' | 'utf16be';

export interface RecoveryChangeData {
  path: string;
  tool: string;
  before: string | null;
  after: string | null;
  beforeEncoding: RecoveryEncoding | null;
  encoding: RecoveryEncoding;
  beforeHash: string;
  afterHash: string;
}

export interface RecoveryChange {
  id: string;
  workspace: string;
  groupId: string | null;
  path: string;
  tool: string;
  createdAt: number;
  state: RecoveryChangeState;
  payload: string;
}

export interface RecoveryGroup {
  id: string;
  workspace: string;
  name: string;
  createdAt: number;
  processId: number;
  state: RecoveryGroupState;
}

export interface CheckpointFile {
  path: string;
  content: string | null;
  encoding: RecoveryEncoding;
  hash: string;
}

export interface CheckpointData { files: CheckpointFile[] }

export interface RecoveryCheckpoint {
  id: string;
  workspace: string;
  name: string;
  createdAt: number;
  payload: string;
}

export interface RecoveryJournal {
  withWorkspaceLock<T>(workspace: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  prepareRecoveryChange(change: RecoveryChange): void;
  setRecoveryChangeState(workspace: string, id: string, state: RecoveryChangeState): void;
  recoveryChange(workspace: string, id: string): RecoveryChange | undefined;
  recoveryChanges(workspace: string, groupId?: string, states?: RecoveryChangeState[], limit?: number): RecoveryChange[];
  latestRecoveryChange(workspace: string, states?: RecoveryChangeState[]): RecoveryChange | undefined;
  startRecoveryGroup(group: RecoveryGroup): void;
  setRecoveryGroupState(workspace: string, id: string, state: RecoveryGroupState): void;
  recoveryGroup(workspace: string, id: string): RecoveryGroup | undefined;
  recoveryGroups(workspace: string): RecoveryGroup[];
  saveCheckpoint(checkpoint: RecoveryCheckpoint): void;
  checkpoint(workspace: string, id: string): RecoveryCheckpoint | undefined;
  checkpoints(workspace: string): Omit<RecoveryCheckpoint, 'payload'>[];
  deleteCheckpoint(workspace: string, id: string): void;
}

const protectScript = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $raw=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); $cipher=$null; try { $cipher=[Security.Cryptography.ProtectedData]::Protect($raw,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write([Convert]::ToBase64String($cipher)) } finally { [Array]::Clear($raw,0,$raw.Length); if ($cipher) { [Array]::Clear($cipher,0,$cipher.Length) } }";
const unprotectScript = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $cipher=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); $raw=$null; try { $raw=[Security.Cryptography.ProtectedData]::Unprotect($cipher,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write([Convert]::ToBase64String($raw)) } finally { [Array]::Clear($cipher,0,$cipher.Length); if ($raw) { [Array]::Clear($raw,0,$raw.Length) } }";
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', process.arch === 'ia32' ? 'Sysnative' : 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

/** Encrypts recovery snapshots with a per-user key; on Windows the key is DPAPI protected. */
export class RecoveryCipher {
  private constructor(private readonly key: Buffer) {}

  static async open(home: string): Promise<RecoveryCipher> {
    await mkdir(home, { recursive: true });
    const filename = path.join(home, process.platform === 'win32' ? 'recovery-key.dpapi' : 'recovery-key');
    try { return new RecoveryCipher(await this.readKey(filename)); }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    const key = randomBytes(32);
    let stored: string | Buffer = key;
    if (process.platform === 'win32') {
      const { stdout } = await execa(powershell, ['-NoProfile', '-NonInteractive', '-Command', protectScript], { input: key.toString('base64'), timeout: 15000, windowsHide: true });
      stored = stdout;
    }
    try {
      const file = await open(filename, 'wx', 0o600);
      try { await file.writeFile(stored); await file.sync(); } finally { await file.close(); }
      return new RecoveryCipher(key);
    } catch (error: any) {
      key.fill(0);
      if (error.code !== 'EEXIST') throw error;
      return new RecoveryCipher(await this.readKey(filename));
    }
  }

  private static async readKey(filename: string): Promise<Buffer> {
    const stored = await readFile(filename);
    let key: Buffer;
    if (process.platform === 'win32') {
      const { stdout } = await execa(powershell, ['-NoProfile', '-NonInteractive', '-Command', unprotectScript], { input: stored.toString('utf8'), timeout: 15000, windowsHide: true });
      key = Buffer.from(stdout.trim(), 'base64');
    } else key = stored;
    if (key.length !== 32) { key.fill(0); throw new Error('Recovery key is invalid. Existing recovery snapshots were left untouched.'); }
    return key;
  }

  seal(value: RecoveryChangeData): string {
    return this.sealJson(value);
  }

  sealJson(value: unknown): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return ['v1', nonce.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
  }

  open(payload: string): RecoveryChangeData {
    const value = this.openJson(payload) as RecoveryChangeData;
    const encodings = ['utf8', 'utf8bom', 'utf16le', 'utf16be'];
    if (!value || typeof value.path !== 'string' || typeof value.tool !== 'string' || !encodings.includes(value.encoding) ||
      value.beforeEncoding !== null && !encodings.includes(value.beforeEncoding) || typeof value.beforeHash !== 'string' || typeof value.afterHash !== 'string' ||
      typeof value.before !== 'string' && value.before !== null || typeof value.after !== 'string' && value.after !== null) throw new Error('Recovery snapshot contents are invalid.');
    return value;
  }

  openJson(payload: string): unknown {
    const [version, noncePart, tagPart, encryptedPart, ...extra] = payload.split('.');
    if (version !== 'v1' || !noncePart || !tagPart || !encryptedPart || extra.length) throw new Error('Recovery snapshot format is not supported.');
    const nonce = Buffer.from(noncePart, 'base64url'), tag = Buffer.from(tagPart, 'base64url'), encrypted = Buffer.from(encryptedPart, 'base64url');
    if (nonce.length !== 12 || tag.length !== 16) throw new Error('Recovery snapshot authentication data is invalid.');
    const decipher = createDecipheriv('aes-256-gcm', this.key, nonce);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')) as unknown;
  }

  close(): void { this.key.fill(0); }
}
