import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext } from 'playwright';
import type { RecoveryCipher } from '../core/recovery.js';
import { registerSecret } from '../core/secrets.js';

type State = Awaited<ReturnType<BrowserContext['storageState']>>;

/** Opt-in auth snapshots for an isolated project browser, never a user's regular profile. */
export class BrowserAuthStore {
  private readonly directory: string;
  private readonly scope: string;
  constructor(home: string, workspace: string, private readonly cipher: Pick<RecoveryCipher, 'sealJson' | 'openJson'>, private readonly enabled: () => boolean = () => false) {
    const project = path.resolve(workspace); const scope = createHash('sha256').update(process.platform === 'win32' ? project.toLowerCase() : project).digest('hex').slice(0, 20);
    this.scope = scope;
    this.directory = path.join(home, 'browser-auth', scope);
  }
  isEnabled(): boolean { return this.enabled(); }
  private requireEnabled(): void { if (!this.enabled()) throw new Error('Persistent browser login is disabled. Only the user can enable it with /browser-auth on. Do not retry or bypass this setting.'); }
  private filename(name: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(name)) throw new Error('Use an auth name with 1 to 40 letters, digits, underscores or hyphens.');
    return path.join(this.directory, name + '.state.enc');
  }
  async list(): Promise<{ name: string; savedAt: string; encryptedBytes: number }[]> {
    let names: string[]; try { names = await readdir(this.directory); } catch (error: any) { if (error.code === 'ENOENT') return []; throw error; }
    const result = [];
    for (const name of names.filter(name => /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}\.state\.enc$/.test(name)).sort()) {
      const metadata = await lstat(path.join(this.directory, name)); if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
      result.push({ name: name.slice(0, -10), savedAt: metadata.mtime.toISOString(), encryptedBytes: metadata.size });
    }
    return result;
  }
  async save(name: string, state: State, localOrigins: readonly string[] = []): Promise<void> {
    this.requireEnabled();
    const target = this.filename(name);
    if (Buffer.byteLength(JSON.stringify(state)) > 8 * 1024 * 1024) throw new Error('Auth snapshot exceeds 8 MiB. Save without IndexedDB or use a smaller login state.');
    for (const cookie of state.cookies) registerSecret(cookie.value);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if ((await lstat(this.directory)).isSymbolicLink()) throw new Error('Browser auth directory cannot be a symlink.');
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(this.cipher.sealJson({ version: 1, scope: this.scope, state, localOrigins }), 'utf8'); await file.sync(); } finally { await file.close(); }
      await rename(temporary, target);
    } finally { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); }
  }
  async load(name: string, localOrigins: readonly string[] = []): Promise<State> {
    this.requireEnabled();
    const target = this.filename(name), metadata = await lstat(target);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 12 * 1024 * 1024) throw new Error('Invalid browser auth file.');
    const record = this.cipher.openJson(await readFile(target, 'utf8')) as { version?: number; scope?: string; state?: State; localOrigins?: string[] };
    if (record?.version !== 1 || record.scope !== this.scope || !Array.isArray(record.state?.cookies) || !Array.isArray(record.state?.origins)) throw new Error('Invalid saved browser auth state or project scope.');
    if (localOrigins.some(origin => !record.localOrigins?.includes(origin))) throw new Error('This login state was not saved for every requested local origin and port.');
    for (const cookie of record.state.cookies) registerSecret(cookie.value);
    return record.state;
  }
  async remove(name: string): Promise<void> { await unlink(this.filename(name)); }
}
