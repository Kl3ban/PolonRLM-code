import { realpath, lstat, readFile, writeFile, mkdir, unlink, readdir, rename, chmod } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createTwoFilesPatch } from 'diff';
import type { Mode } from '../core/types.js';
import type { Permissions } from '../core/permissions.js';
import { clip } from '../core/context.js';
import { redact } from '../core/secrets.js';

type TextEncoding = 'utf8' | 'utf8bom' | 'utf16le' | 'utf16be';
type Change = { path: string; before: string | null; after: string | null; encoding: TextEncoding };
type Transaction = { id: string; name: string; start: number };

function decodeWorkspaceText(bytes: Buffer): { text: string; encoding: TextEncoding } {
  let encoding: TextEncoding = 'utf8';
  let body = bytes;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    encoding = 'utf8bom'; body = bytes.subarray(3);
  } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = 'utf16le'; body = bytes.subarray(2);
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = 'utf16be'; body = bytes.subarray(2);
  }
  if ((encoding === 'utf16le' || encoding === 'utf16be') && body.length % 2 !== 0) throw new Error('UTF-16 file has an invalid byte count.');
  let text: string;
  try {
    const label = encoding === 'utf16le' ? 'utf-16le' : encoding === 'utf16be' ? 'utf-16be' : 'utf-8';
    text = new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(body);
  } catch { throw new Error('File has invalid or unsupported text encoding. The file was not changed.'); }
  if (text.includes('\0')) throw new Error('Binary file.');
  return { text, encoding };
}

function encodeWorkspaceText(text: string, encoding: TextEncoding): Buffer {
  let bytes: Buffer;
  if (encoding === 'utf8') bytes = Buffer.from(text, 'utf8');
  else if (encoding === 'utf8bom') bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
  else if (encoding === 'utf16le') bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  else {
    const body = Buffer.from(text, 'utf16le');
    for (let index = 0; index < body.length; index += 2) [body[index], body[index + 1]] = [body[index + 1]!, body[index]!];
    bytes = Buffer.concat([Buffer.from([0xfe, 0xff]), body]);
  }
  if (decodeWorkspaceText(bytes).text !== text) throw new Error('Text contains an invalid Unicode character. The file was not changed.');
  return bytes;
}

export class Workspace {
  private changes: Change[] = [];
  private transaction?: Transaction;
  private queue: Promise<unknown> = Promise.resolve();
  private constructor(readonly root: string, readonly permissions: Permissions) {}
  static async open(root: string, permissions: Permissions): Promise<Workspace> {
    const resolved = await realpath(root);
    if (!(await lstat(resolved)).isDirectory()) throw new Error('Workspace must be a directory.');
    return new Workspace(resolved, permissions);
  }
  private inside(value: string): boolean { const relative = path.relative(this.root, value); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); }
  private checkParts(value: string): void {
    const parts = path.relative(this.root, value).split(path.sep);
    if (parts.some(part => ['.git', '.polonrlm', '.januszgpt'].includes(process.platform === 'win32' ? part.toLowerCase() : part))) throw new Error('Protected metadata directory.');
    if (process.platform === 'win32' && parts.some(part => part && (part.includes(':') || /[. ]$/.test(part) || /^(con|conin\$|conout\$|clock\$|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)))) throw new Error('Invalid Windows path: stream, device, or ambiguous name.');
  }
  async resolve(input: string): Promise<string> {
    const target = path.resolve(this.root, input);
    if (!this.inside(target)) throw new Error('Path is outside the workspace.');
    this.checkParts(target);
    let existing = target;
    while (true) {
      try { const actual = await realpath(existing); if (!this.inside(actual)) throw new Error('Symlink/junction points outside the workspace.'); this.checkParts(actual); break; }
      catch (error: any) { if (error.code !== 'ENOENT') throw error; const parent = path.dirname(existing); if (parent === existing) throw error; existing = parent; }
    }
    return target;
  }
  async read(input: string, start = 1, lines = 200): Promise<string> {
    const data = await this.readText(input);
    return data.split(/\r?\n/).slice(start - 1, start - 1 + lines).map((line, index) => `${start + index}: ${line}`).join('\n');
  }
  async readText(input: string): Promise<string> {
    const target = await this.resolve(input);
    const stat = await lstat(target);
    if (!stat.isFile() || stat.size > 5_000_000) throw new Error('A text file up to 5 MB is required.');
    return decodeWorkspaceText(await readFile(target)).text;
  }
  async list(input = '.'): Promise<string[]> {
    const entries = await readdir(await this.resolve(input), { withFileTypes: true });
    return entries.filter(entry => !['node_modules', '.git', '.polonrlm', '.januszgpt'].includes(entry.name)).slice(0, 500).map(entry => `${entry.name}${entry.isDirectory() ? '/' : entry.isSymbolicLink() ? '@' : ''}`);
  }
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work); this.queue = next.catch(() => {}); return next;
  }
  async change(tool: string, input: string, transform: (before: string | null, encoding?: TextEncoding) => string | null, mode: Mode, signal?: AbortSignal): Promise<string> {
    return this.exclusive(() => this.applyChange(tool, input, transform, mode, true, signal));
  }
  async beginTransaction(name: string): Promise<{ id: string; name: string }> {
    return this.exclusive(async () => {
      if (this.transaction) throw new Error(`Transaction ${this.transaction.name} is already open.`);
      const transaction = { id: randomUUID(), name, start: this.changes.length };
      this.transaction = transaction; return { id: transaction.id, name };
    });
  }
  transactionStatus(): { id: string; name: string; changedFiles: string[] } | null {
    const transaction = this.transaction; if (!transaction) return null;
    return { id: transaction.id, name: transaction.name, changedFiles: [...new Set(this.changes.slice(transaction.start).map(change => change.path))] };
  }
  async commitTransaction(id: string): Promise<{ id: string; name: string; changedFiles: string[] }> {
    return this.exclusive(async () => {
      const transaction = this.transaction; if (!transaction || transaction.id !== id) throw new Error('No open transaction was found.');
      const result = { id, name: transaction.name, changedFiles: [...new Set(this.changes.slice(transaction.start).map(change => change.path))] };
      this.transaction = undefined; return result;
    });
  }
  async applyChangesAtomically(tool: string, requested: Array<{ path: string; before: string | null; after: string | null }>, mode: Mode, signal?: AbortSignal): Promise<{ applied: string[]; rolledBack: string[]; error?: string; rollbackFailures?: Array<{ path: string; error: string }> }> {
    return this.exclusive(async () => {
      const applied: Array<{ path: string; change: Change }> = [];
      for (const item of requested) {
        try {
          signal?.throwIfAborted();
          await this.applyChange(tool, item.path, current => {
            if (current !== item.before) throw new Error('File changed during merge.');
            return item.after;
          }, mode, true, signal);
          if (item.before !== item.after) {
            const change = this.changes.at(-1);
            if (!change || change.path !== item.path || change.before !== item.before || change.after !== item.after) throw new Error('Could not record the applied file change.');
            applied.push({ path: item.path, change });
          }
        } catch (error: any) {
          const rolledBack: string[] = [];
          const rollbackFailures: Array<{ path: string; error: string }> = [];
          for (const entry of [...applied].reverse()) {
            try {
              await this.permissions.withOneTimeToolApproval(() => this.applyChange('transaction_rollback', entry.path, (current, encoding) => {
                if (current !== entry.change.after || (current !== null && encoding !== entry.change.encoding)) throw new Error('File changed outside the atomic operation.');
                return entry.change.before;
              }, mode, false, undefined, entry.change.encoding));
              const index = this.changes.lastIndexOf(entry.change);
              if (index >= 0) this.changes.splice(index, 1);
              rolledBack.push(entry.path);
            } catch (rollbackError: any) {
              rollbackFailures.push({ path: entry.path, error: rollbackError.message ?? String(rollbackError) });
            }
          }
          const stillApplied = applied.filter(entry => !rolledBack.includes(entry.path)).map(entry => entry.path);
          return { applied: stillApplied, rolledBack, error: error.message ?? String(error), ...(rollbackFailures.length ? { rollbackFailures } : {}) };
        }
      }
      return { applied: applied.map(entry => entry.path), rolledBack: [] };
    });
  }
  async rollbackTransaction(id: string, mode: Mode, signal?: AbortSignal): Promise<{ restored: string[]; failed?: string; error?: string }> {
    return this.exclusive(async () => {
      const transaction = this.transaction; if (!transaction || transaction.id !== id) throw new Error('No open transaction was found.');
      const restored: string[] = [];
      while (this.changes.length > transaction.start) {
        signal?.throwIfAborted();
        const change = this.changes.at(-1)!;
        try {
          await this.applyChange('transaction_rollback', change.path, (current, encoding) => { if (current !== change.after || (current !== null && encoding !== change.encoding)) throw new Error('File changed outside the transaction.'); return change.before; }, mode, false, undefined, change.encoding);
          this.changes.pop(); restored.push(change.path);
        } catch (error: any) { return { restored, failed: change.path, error: error.message }; }
      }
      this.transaction = undefined; return { restored };
    });
  }
  private async applyChange(tool: string, input: string, transform: (before: string | null, encoding?: TextEncoding) => string | null, mode: Mode, record: boolean, signal?: AbortSignal, encodingHint?: TextEncoding): Promise<string> {
      const target = await this.resolve(input);
      let before: string | null;
      let beforeBytes: Buffer | null;
      let beforeEncoding: TextEncoding | undefined;
      let fileMode: number | undefined;
      try {
        const stat = await lstat(target);
        if (!stat.isFile() || stat.size > 5_000_000) throw new Error('Editing requires a file up to 5 MB.');
        fileMode = stat.mode & 0o777; beforeBytes = await readFile(target);
        const decoded = decodeWorkspaceText(beforeBytes); before = decoded.text; beforeEncoding = decoded.encoding;
      } catch (error: any) { if (error.code !== 'ENOENT') throw error; before = null; beforeBytes = null; }
      if (before?.includes('\0')) throw new Error('Cannot edit a binary file.');
      const after = transform(before, beforeEncoding);
      if (after?.includes('\0')) throw new Error('Text writes cannot contain NUL.');
      if (before === after) return 'No changes.';
      const outputEncoding = beforeEncoding ?? encodingHint ?? 'utf8';
      const diff = createTwoFilesPatch(input, input, before ?? '', after ?? '');
      await this.permissions.check(tool, after === null ? 'delete' : 'write', `${after === null ? 'Delete' : 'Write'} ${input}`, clip(redact(diff), 12000), mode, signal);
      signal?.throwIfAborted();
      const currentBytes = await readFile(target).catch((error: any) => { if (error.code === 'ENOENT') return null; throw error; });
      if ((currentBytes === null) !== (beforeBytes === null) || (currentBytes !== null && !beforeBytes!.equals(currentBytes))) throw new Error('File changed while the write was being approved. Read it again.');
      await this.resolve(input);
      signal?.throwIfAborted();
      if (after === null) await unlink(target); else {
        await mkdir(path.dirname(target), { recursive: true }); await this.resolve(input);
        const temporary = path.join(path.dirname(target), `.polonrlm-write-${randomUUID()}.tmp`);
        try {
          signal?.throwIfAborted();
          await writeFile(temporary, encodeWorkspaceText(after, outputEncoding), { flag: 'wx', mode: fileMode ?? 0o666 });
          if (fileMode !== undefined && process.platform !== 'win32') await chmod(temporary, fileMode);
          await this.resolve(input);
          signal?.throwIfAborted();
          await rename(temporary, target);
        } finally { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); }
      }
      if (record) this.changes.push({ path: input, before, after, encoding: outputEncoding });
      return diff;
  }
  async undo(mode: Mode): Promise<string> {
    return this.exclusive(async () => {
      if (this.transaction && this.changes.length > this.transaction.start) throw new Error('A transaction is open. Commit it or use transaction_rollback.');
      const change = this.changes.at(-1); if (!change) return 'No changes to undo in this process.';
      const diff = await this.applyChange('undo', change.path, (current, encoding) => { if (current !== change.after || (current !== null && encoding !== change.encoding)) throw new Error('File was changed outside the change log. Undo was cancelled.'); return change.before; }, mode, false, undefined, change.encoding);
      this.changes.pop();
      return diff;
    });
  }
  fingerprints(): string[] { return this.changes.slice(-20).map(change => `${change.path}: ${createHash('sha256').update(change.after ?? '').digest('hex').slice(0, 12)}`); }
}
