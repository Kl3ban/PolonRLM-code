import { realpath, lstat, readFile, writeFile, mkdir, unlink, readdir, rename, chmod } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createTwoFilesPatch } from 'diff';
import type { Mode } from '../core/types.js';
import type { Permissions } from '../core/permissions.js';
import { clip } from '../core/context.js';
import { redact } from '../core/secrets.js';
import { RecoveryCipher, type CheckpointData, type CheckpointFile, type RecoveryChange, type RecoveryChangeData, type RecoveryGroup, type RecoveryJournal } from '../core/recovery.js';

type TextEncoding = RecoveryChangeData['encoding'];
type Change = RecoveryChangeData & { id: string; groupId?: string };
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
  private recovery?: { journal: RecoveryJournal; cipher: RecoveryCipher };
  private ephemeralCheckpoints = new Map<string, { name: string; data: CheckpointData; createdAt: number }>();
  private queue: Promise<unknown> = Promise.resolve();
  private constructor(readonly root: string, readonly permissions: Permissions) {}
  static async open(root: string, permissions: Permissions): Promise<Workspace> {
    const resolved = await realpath(root);
    if (!(await lstat(resolved)).isDirectory()) throw new Error('Workspace must be a directory.');
    return new Workspace(resolved, permissions);
  }
  attachRecovery(journal: RecoveryJournal, cipher: RecoveryCipher): void { this.recovery = { journal, cipher }; }
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
    return this.exclusive(() => this.applyChange(tool, input, transform, mode, true, signal, undefined, this.transaction?.id));
  }
  async beginTransaction(name: string): Promise<{ id: string; name: string }> {
    return this.exclusive(async () => {
      if (this.transaction) throw new Error(`Transaction ${this.transaction.name} is already open.`);
      const transaction = { id: randomUUID(), name, start: this.changes.length };
      this.recovery?.journal.startRecoveryGroup({ id: transaction.id, workspace: this.root, name: `Transaction: ${name}`, createdAt: Date.now(), processId: process.pid, state: 'running' });
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
      this.recovery?.journal.setRecoveryGroupState(this.root, id, 'committed');
      this.transaction = undefined; return result;
    });
  }
  async applyChangesAtomically(tool: string, requested: Array<{ path: string; before: string | null; after: string | null; encoding?: TextEncoding; expectedHash?: string; forceEncoding?: boolean }>, mode: Mode, signal?: AbortSignal): Promise<{ applied: string[]; rolledBack: string[]; error?: string; rollbackFailures?: Array<{ path: string; error: string }> }> {
    return this.exclusive(async () => {
      if (!requested.length) return { applied: [], rolledBack: [] };
      const groupId = randomUUID();
      this.recovery?.journal.startRecoveryGroup({ id: groupId, workspace: this.root, name: `Atomic ${tool}`, createdAt: Date.now(), processId: process.pid, state: 'running' });
      const applied: Array<{ path: string; change: Change }> = [];
      for (const item of requested) {
        try {
          signal?.throwIfAborted();
          await this.applyChange(tool, item.path, (current, currentEncoding) => {
            if (current !== item.before) throw new Error('File changed during merge.');
            if (item.expectedHash) {
              const currentHash = current === null ? 'missing' : createHash('sha256').update(encodeWorkspaceText(current, currentEncoding ?? item.encoding ?? 'utf8')).digest('hex');
              if (currentHash !== item.expectedHash) throw new Error('File hash changed during the atomic operation.');
            }
            return item.after;
          }, mode, true, signal, item.encoding, groupId, item.forceEncoding);
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
              }, mode, false, undefined, entry.change.beforeEncoding ?? entry.change.encoding, undefined, true));
              const index = this.changes.lastIndexOf(entry.change);
              if (index >= 0) this.changes.splice(index, 1);
              if (entry.change.id) this.recovery?.journal.setRecoveryChangeState(this.root, entry.change.id, 'rolled_back');
              rolledBack.push(entry.path);
            } catch (rollbackError: any) {
              rollbackFailures.push({ path: entry.path, error: rollbackError.message ?? String(rollbackError) });
            }
          }
          this.recovery?.journal.setRecoveryGroupState(this.root, groupId, rollbackFailures.length ? 'partial' : 'rolled_back');
          const stillApplied = applied.filter(entry => !rolledBack.includes(entry.path)).map(entry => entry.path);
          return { applied: stillApplied, rolledBack, error: error.message ?? String(error), ...(rollbackFailures.length ? { rollbackFailures } : {}) };
        }
      }
      this.recovery?.journal.setRecoveryGroupState(this.root, groupId, 'committed');
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
          await this.applyChange('transaction_rollback', change.path, (current, encoding) => { if (current !== change.after || (current !== null && encoding !== change.encoding)) throw new Error('File changed outside the transaction.'); return change.before; }, mode, false, undefined, change.beforeEncoding ?? change.encoding, undefined, true);
          if (change.id) this.recovery?.journal.setRecoveryChangeState(this.root, change.id, 'rolled_back');
          this.changes.pop(); restored.push(change.path);
        } catch (error: any) { this.recovery?.journal.setRecoveryGroupState(this.root, id, 'partial'); return { restored, failed: change.path, error: error.message }; }
      }
      this.recovery?.journal.setRecoveryGroupState(this.root, id, 'rolled_back');
      this.transaction = undefined; return { restored };
    });
  }
  private async applyChange(tool: string, input: string, transform: (before: string | null, encoding?: TextEncoding) => string | null, mode: Mode, record: boolean, signal?: AbortSignal, encodingHint?: TextEncoding, groupId?: string, forceEncoding = false): Promise<string> {
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
      const outputEncoding = forceEncoding ? encodingHint ?? beforeEncoding ?? 'utf8' : beforeEncoding ?? encodingHint ?? 'utf8';
      if (before === after && (!forceEncoding || before === null || beforeEncoding === outputEncoding)) return 'No changes.';
      const afterBytes = after === null ? null : encodeWorkspaceText(after, outputEncoding);
      const diff = createTwoFilesPatch(input, input, before ?? '', after ?? '') + (forceEncoding && before !== null && after !== null && beforeEncoding !== outputEncoding ? '\n[File encoding changes from ' + beforeEncoding + ' to ' + outputEncoding + '.]' : '');
      await this.permissions.check(tool, after === null ? 'delete' : 'write', `${after === null ? 'Delete' : 'Write'} ${input}`, clip(redact(diff), 12000), mode, signal);
      signal?.throwIfAborted();
      const currentBytes = await readFile(target).catch((error: any) => { if (error.code === 'ENOENT') return null; throw error; });
      if ((currentBytes === null) !== (beforeBytes === null) || (currentBytes !== null && !beforeBytes!.equals(currentBytes))) throw new Error('File changed while the write was being approved. Read it again.');
      await this.resolve(input);
      signal?.throwIfAborted();
      const id = record ? randomUUID() : undefined;
      const changeData: RecoveryChangeData = {
        path: input, tool, before, after, beforeEncoding: beforeEncoding ?? null, encoding: outputEncoding,
        beforeHash: beforeBytes ? createHash('sha256').update(beforeBytes).digest('hex') : 'missing',
        afterHash: afterBytes ? createHash('sha256').update(afterBytes).digest('hex') : 'missing'
      };
      if (record && id && this.recovery) this.recovery.journal.prepareRecoveryChange({
        id, workspace: this.root, groupId: groupId ?? null, path: input, tool, createdAt: Date.now(), state: 'prepared', payload: this.recovery.cipher.seal(changeData)
      });
      try {
        if (after === null) await unlink(target); else {
          await mkdir(path.dirname(target), { recursive: true }); await this.resolve(input);
          const temporary = path.join(path.dirname(target), `.polonrlm-write-${randomUUID()}.tmp`);
          try {
            signal?.throwIfAborted();
            await writeFile(temporary, afterBytes!, { flag: 'wx', mode: fileMode ?? 0o666 });
            if (fileMode !== undefined && process.platform !== 'win32') await chmod(temporary, fileMode);
            await this.resolve(input);
            signal?.throwIfAborted();
            await rename(temporary, target);
          } finally { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); }
        }
      } catch (error) {
        if (record && id && this.recovery) this.recovery.journal.setRecoveryChangeState(this.root, id, 'aborted');
        throw error;
      }
      if (record && id) {
        this.changes.push({ ...changeData, id, ...(groupId ? { groupId } : {}) });
        if (this.recovery) this.recovery.journal.setRecoveryChangeState(this.root, id, 'applied');
      }
      return diff;
  }
  private async restoreRecoveryChange(entry: RecoveryChange, mode: Mode, signal?: AbortSignal): Promise<string> {
    if (!this.recovery) throw new Error('Persistent recovery is not initialized.');
    if (entry.state !== 'applied' && entry.state !== 'prepared') throw new Error(`Change ${entry.id.slice(0, 8)} is ${entry.state} and cannot be restored.`);
    const data = this.recovery.cipher.open(entry.payload);
    const target = await this.resolve(data.path);
    const currentBytes = await readFile(target).catch((error: any) => { if (error.code === 'ENOENT') return null; throw error; });
    const currentHash = currentBytes ? createHash('sha256').update(currentBytes).digest('hex') : 'missing';
    if (currentHash === data.beforeHash) {
      this.recovery.journal.setRecoveryChangeState(this.root, entry.id, 'rolled_back');
      this.changes = this.changes.filter(change => change.id !== entry.id);
      return `Already restored: ${data.path}`;
    }
    if (currentHash !== data.afterHash) {
      this.recovery.journal.setRecoveryChangeState(this.root, entry.id, 'conflict');
      throw new Error(`${data.path} has changed since the saved operation. Its current contents were kept.`);
    }
    const diff = await this.applyChange('rollback', data.path, (current, encoding) => {
      const observedHash = current === null ? 'missing' : createHash('sha256').update(encodeWorkspaceText(current, encoding ?? data.encoding)).digest('hex');
      if (observedHash !== data.afterHash || current !== data.after || (current !== null && encoding !== data.encoding)) throw new Error('File changed during rollback. Its current contents were kept.');
      return data.before;
    }, mode, false, signal, data.beforeEncoding ?? data.encoding, undefined, true);
    this.recovery.journal.setRecoveryChangeState(this.root, entry.id, 'rolled_back');
    this.changes = this.changes.filter(change => change.id !== entry.id);
    return diff;
  }
  private async rollbackRecoveryInternal(id: string, mode: Mode, signal?: AbortSignal): Promise<{ restored: string[]; failed?: string; error?: string }> {
    if (!this.recovery) throw new Error('Persistent recovery is not initialized.');
    const group = this.recovery.journal.recoveryGroup(this.root, id);
    const change = group ? undefined : this.recovery.journal.recoveryChange(this.root, id);
    if (!group && !change) throw new Error('No recovery group or change was found. Use /history changes to see IDs.');
    if (change?.groupId) return this.rollbackRecoveryGroupInternal(change.groupId, mode, signal);
    if (change) {
      try { await this.restoreRecoveryChange(change, mode, signal); return { restored: [change.path] }; }
      catch (error: any) { return { restored: [], failed: change.path, error: error.message ?? String(error) }; }
    }
    return this.rollbackRecoveryGroupInternal(id, mode, signal);
  }
  private async rollbackRecoveryGroupInternal(id: string, mode: Mode, signal?: AbortSignal): Promise<{ restored: string[]; failed?: string; error?: string }> {
    if (!this.recovery) throw new Error('Persistent recovery is not initialized.');
    const group = this.recovery.journal.recoveryGroup(this.root, id);
    if (!group) throw new Error('Recovery group was not found in this project.');
    const entries = this.recovery.journal.recoveryChanges(this.root, id, ['applied', 'prepared']).reverse();
    const restored: string[] = [];
    for (const entry of entries) {
      signal?.throwIfAborted();
      try { await this.restoreRecoveryChange(entry, mode, signal); restored.push(entry.path); }
      catch (error: any) {
        this.recovery.journal.setRecoveryGroupState(this.root, id, 'partial');
        if (this.transaction?.id === id) this.transaction = undefined;
        return { restored, failed: entry.path, error: error.message ?? String(error) };
      }
    }
    const conflicts = this.recovery.journal.recoveryChanges(this.root, id, ['conflict']);
    if (conflicts.length) {
      this.recovery.journal.setRecoveryGroupState(this.root, id, 'partial');
      if (this.transaction?.id === id) this.transaction = undefined;
      return { restored, failed: conflicts[0]!.path, error: 'A changed file was preserved. Resolve it manually before completing this rollback.' };
    }
    this.recovery.journal.setRecoveryGroupState(this.root, id, 'rolled_back');
    if (this.transaction?.id === id) this.transaction = undefined;
    return { restored };
  }
  async rollbackRecovery(idPrefix: string, mode: Mode, signal?: AbortSignal): Promise<{ id: string; restored: string[]; failed?: string; error?: string }> {
    return this.exclusive(async () => {
      if (!this.recovery) throw new Error('Persistent recovery is not initialized.');
      if (idPrefix.length < 4) throw new Error('Use at least four characters from a change or group ID.');
      const matches = [
        ...this.recovery.journal.recoveryGroups(this.root).filter(group => group.id.startsWith(idPrefix)).map(group => ({ id: group.id, type: 'group' as const })),
        ...this.recovery.journal.recoveryChanges(this.root).filter(change => change.id.startsWith(idPrefix)).map(change => ({ id: change.id, type: 'change' as const }))
      ];
      if (matches.length > 1) throw new Error('That ID prefix is ambiguous. Use more characters.');
      const match = matches[0]; if (!match) throw new Error('No recovery group or change was found. Use /history changes to see IDs.');
      const target = match.type === 'change' ? this.recovery.journal.recoveryChange(this.root, match.id)?.groupId ?? match.id : match.id;
      const result = await this.rollbackRecoveryInternal(target, mode, signal);
      return { id: target, ...result };
    });
  }
  recoveryStatus(): { groups: RecoveryGroup[]; changes: RecoveryChange[] } {
    if (!this.recovery) return { groups: [], changes: [] };
    const groups = this.recovery.journal.recoveryGroups(this.root).filter(group => group.state === 'running' || group.state === 'partial');
    const pendingGroups = new Set(groups.map(group => group.id));
    const changes = this.recovery.journal.recoveryChanges(this.root, undefined, ['prepared', 'applied', 'conflict'], 100)
      .filter(change => change.state !== 'applied' || (change.groupId !== null && pendingGroups.has(change.groupId))).slice(0, 50);
    return { groups, changes };
  }
  private async captureCheckpointFile(input: string): Promise<CheckpointFile> {
    const target = await this.resolve(input);
    try {
      const stat = await lstat(target);
      if (!stat.isFile() || stat.size > 5_000_000) throw new Error('Checkpoint files must be text files up to 5 MB.');
      const bytes = await readFile(target), decoded = decodeWorkspaceText(bytes);
      return { path: input, content: decoded.text, encoding: decoded.encoding, hash: createHash('sha256').update(bytes).digest('hex') };
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      return { path: input, content: null, encoding: 'utf8', hash: 'missing' };
    }
  }
  private checkpointData(idPrefix: string): { id: string; name: string; data: CheckpointData } {
    if (idPrefix.length < 4) throw new Error('Use at least four characters from the checkpoint ID.');
    if (!this.recovery) {
      const matches = [...this.ephemeralCheckpoints].filter(([id]) => id.startsWith(idPrefix));
      if (!matches.length) throw new Error('Checkpoint not found. Use checkpoint_list to see saved checkpoints.');
      if (matches.length > 1) throw new Error('Checkpoint ID prefix is ambiguous. Use more characters.');
      const [id, checkpoint] = matches[0]!;
      return { id, name: checkpoint.name, data: checkpoint.data };
    }
    const matches = this.recovery.journal.checkpoints(this.root).filter(checkpoint => checkpoint.id.startsWith(idPrefix));
    if (!matches.length) throw new Error('Checkpoint not found. Use checkpoint_list to see saved checkpoints.');
    if (matches.length > 1) throw new Error('Checkpoint ID prefix is ambiguous. Use more characters.');
    const checkpoint = this.recovery.journal.checkpoint(this.root, matches[0]!.id);
    if (!checkpoint) throw new Error('Checkpoint was removed while it was being read. List checkpoints and retry.');
    const data = this.recovery.cipher.openJson(checkpoint.payload) as CheckpointData;
    if (!data || !Array.isArray(data.files) || data.files.some(file => !file || typeof file.path !== 'string' || typeof file.content !== 'string' && file.content !== null || !['utf8', 'utf8bom', 'utf16le', 'utf16be'].includes(file.encoding) || typeof file.hash !== 'string')) throw new Error('Saved checkpoint contents are invalid.');
    return { id: checkpoint.id, name: checkpoint.name, data };
  }
  async createCheckpoint(name: string, paths: string[]): Promise<{ id: string; name: string; paths: string[] }> {
    return this.exclusive(async () => {
      const unique = [...new Set(paths)];
      if (!unique.length) throw new Error('Choose at least one file for the checkpoint.');
      const files: CheckpointFile[] = [];
      for (const filename of unique) files.push(await this.captureCheckpointFile(filename));
      const id = randomUUID(), createdAt = Date.now();
      if (this.recovery) this.recovery.journal.saveCheckpoint({ id, workspace: this.root, name, createdAt, payload: this.recovery.cipher.sealJson({ files } satisfies CheckpointData) });
      else this.ephemeralCheckpoints.set(id, { name, createdAt, data: { files } });
      return { id, name, paths: files.map(file => file.path) };
    });
  }
  listCheckpoints(): Omit<import('../core/recovery.js').RecoveryCheckpoint, 'payload'>[] {
    if (this.recovery) return this.recovery.journal.checkpoints(this.root);
    return [...this.ephemeralCheckpoints].map(([id, checkpoint]) => ({ id, workspace: this.root, name: checkpoint.name, createdAt: checkpoint.createdAt }));
  }
  async diffCheckpoint(idPrefix: string): Promise<{ id: string; name: string; files: Array<{ path: string; currentHash: string; savedHash: string; changed: boolean; diff: string }> }> {
    return this.exclusive(async () => {
      const checkpoint = this.checkpointData(idPrefix);
      const files = [];
      for (const saved of checkpoint.data.files) {
        const current = await this.captureCheckpointFile(saved.path);
        files.push({ path: saved.path, currentHash: current.hash, savedHash: saved.hash, changed: current.hash !== saved.hash, diff: createTwoFilesPatch(saved.path, saved.path, current.content ?? '', saved.content ?? '') });
      }
      return { id: checkpoint.id, name: checkpoint.name, files };
    });
  }
  async restoreCheckpoint(idPrefix: string, expected: Record<string, string>, mode: Mode, signal?: AbortSignal): Promise<{ applied: string[]; rolledBack: string[]; error?: string; rollbackFailures?: Array<{ path: string; error: string }> }> {
    const checkpoint = this.checkpointData(idPrefix);
    const selected = Object.keys(expected);
    if (!selected.length || selected.some(filename => !checkpoint.data.files.some(file => file.path === filename))) throw new Error('Provide checkpoint paths from checkpoint_diff and their current hashes.');
    const requested = [];
    for (const filename of selected) {
      const saved = checkpoint.data.files.find(file => file.path === filename)!;
      const current = await this.captureCheckpointFile(filename);
      if (current.hash !== expected[filename]) throw new Error('File ' + filename + ' changed since checkpoint_diff. Run checkpoint_diff again.');
      if (current.hash !== saved.hash) requested.push({ path: filename, before: current.content, after: saved.content, encoding: saved.encoding, expectedHash: current.hash, forceEncoding: true });
    }
    return this.applyChangesAtomically('checkpoint_restore', requested, mode, signal);
  }
  dropCheckpoint(idPrefix: string): void {
    const checkpoint = this.checkpointData(idPrefix);
    if (this.recovery) this.recovery.journal.deleteCheckpoint(this.root, checkpoint.id);
    else this.ephemeralCheckpoints.delete(checkpoint.id);
  }
  changeHistory(limit = 50): RecoveryChange[] { return this.recovery?.journal.recoveryChanges(this.root, undefined, undefined, limit) ?? []; }
  async undo(mode: Mode): Promise<string> {
    return this.exclusive(async () => {
      if (this.transaction && this.changes.length > this.transaction.start) throw new Error('A transaction is open. Commit it or use transaction_rollback.');
      const latest = this.changes.at(-1);
      if (!this.recovery) {
        if (!latest) return 'No changes are available to undo.';
        const diff = await this.applyChange('undo', latest.path, (current, encoding) => { if (current !== latest.after || (current !== null && encoding !== latest.encoding)) throw new Error('File was changed outside the change log. Undo was cancelled.'); return latest.before; }, mode, false, undefined, latest.beforeEncoding ?? latest.encoding, undefined, true);
        this.changes.pop();
        return diff;
      }
      const entry = latest?.id && this.recovery ? this.recovery.journal.recoveryChange(this.root, latest.id) : this.recovery?.journal.latestRecoveryChange(this.root);
      if (!entry) return 'No changes are available to undo.';
      if (entry.groupId) {
        const result = await this.rollbackRecoveryGroupInternal(entry.groupId, mode);
        if (result.failed) throw new Error(`Undo stopped after ${result.restored.length} file(s): ${result.error}`);
        return `Rolled back ${result.restored.length} file(s) from ${entry.groupId.slice(0, 8)}.`;
      }
      return this.restoreRecoveryChange(entry, mode);
    });
  }
  fingerprints(): string[] { return this.changes.slice(-20).map(change => `${change.path}: ${createHash('sha256').update(change.after ?? '').digest('hex').slice(0, 12)}`); }
  changedPaths(): string[] { return [...new Set(this.changes.map(change => change.path))]; }
}
