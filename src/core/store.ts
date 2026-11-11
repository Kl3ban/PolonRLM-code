import { DatabaseSync } from 'node:sqlite';
import { closeSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Message, Usage } from './types.js';
import { redact, safeText } from './secrets.js';
import { clip } from './context.js';
import type { WorkflowState } from './workflows.js';
import type { VerificationReport } from './verification.js';
import type { EvidenceTimelineEntry } from './evidence.js';
import { describeToolCall } from './tool-display.js';
import type { RecoveryChange, RecoveryChangeState, RecoveryCheckpoint, RecoveryGroup, RecoveryGroupState } from './recovery.js';

function execWithBusyRetry(db: DatabaseSync, sql: string): void {
  const waitCell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      db.exec(sql);
      return;
    } catch (error) {
      const code = (error as { errcode?: number }).errcode;
      const primaryCode = typeof code === 'number' ? code & 0xff : 0;
      if ((primaryCode !== 5 && primaryCode !== 6) || Date.now() >= deadline) throw error;
      Atomics.wait(waitCell, 0, 0, Math.min(25, deadline - Date.now()));
    }
  }
}

class CorruptSessionDatabaseError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); }
}

function isDatabaseCorruption(error: unknown): boolean {
  if (error instanceof CorruptSessionDatabaseError) return true;
  const code = (error as { errcode?: number } | null)?.errcode;
  const primaryCode = typeof code === 'number' ? code & 0xff : 0;
  return primaryCode === 11 || primaryCode === 26; // SQLITE_CORRUPT or SQLITE_NOTADB
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

function waitForWorkspaceLock(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('Task cancelled.'));
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason instanceof Error ? signal.reason : new Error('Task cancelled.')); };
    const timer = setTimeout(finish, 50);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function acquireRecoveryLock(filename: string): () => void {
  const lockPath = `${filename}.recover-lock`;
  const waitCell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const deadline = Date.now() + 15_000;
  for (;;) {
    let descriptor: number;
    try {
      descriptor = openSync(lockPath, 'wx');
      try { writeSync(descriptor, `${process.pid}\n`); }
      catch (error) { closeSync(descriptor); unlinkSync(lockPath); throw error; }
      return () => {
        closeSync(descriptor);
        try { unlinkSync(lockPath); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let owner: number | undefined;
      try { owner = Number.parseInt(readFileSync(lockPath, 'utf8'), 10); } catch { /* The owner may be creating or removing the lock. */ }
      let ownerAlive = Number.isInteger(owner) && owner! > 0;
      if (ownerAlive) {
        try { process.kill(owner!, 0); }
        catch (probeError) { ownerAlive = (probeError as NodeJS.ErrnoException).code === 'EPERM'; }
      }
      if (!ownerAlive) {
        try {
          const age = Date.now() - statSync(lockPath).mtimeMs;
          if (owner !== undefined || age > 5_000) { unlinkSync(lockPath); continue; }
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw statError;
        }
      }
      if (Date.now() >= deadline) throw new Error('Another PolonRLM process is repairing the chat database. Close it and try again.');
      Atomics.wait(waitCell, 0, 0, 25);
    }
  }
}

function quarantineCorruptDatabase(filename: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${filename}.corrupt-${stamp}-${randomUUID().slice(0, 8)}`;
  const moved: [source: string, destination: string][] = [];
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const source = `${filename}${suffix}`;
    const destination = `${backup}${suffix}`;
    try {
      renameSync(source, destination);
      moved.push([source, destination]);
    } catch (error) {
      if (suffix && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      for (const [original, preserved] of moved.reverse()) {
        try { renameSync(preserved, original); } catch { /* Keep the original failure; never delete either file. */ }
      }
      throw new Error(`Could not safely preserve the corrupted chat database: ${(error as Error).message}`, { cause: error });
    }
  }
  return backup;
}

export class SessionStore {
  private db: DatabaseSync;
  recoveryBackupPath?: string;
  constructor(home: string) {
    const filename = path.join(home, 'sessions.sqlite');
    this.db = new DatabaseSync(filename);
    try {
      this.initializeDatabase();
    } catch (error) {
      this.db.close();
      if (!isDatabaseCorruption(error)) throw error;
      const releaseRecoveryLock = acquireRecoveryLock(filename);
      try {
        // Another process may have repaired the database while this instance
        // waited for the lock. Reopen and check the path before moving anything.
        this.db = new DatabaseSync(filename);
        try { this.initializeDatabase(); return; }
        catch (recheckError) {
          this.db.close();
          if (!isDatabaseCorruption(recheckError)) throw recheckError;
        }
        this.recoveryBackupPath = quarantineCorruptDatabase(filename);
        this.db = new DatabaseSync(filename);
        try { this.initializeDatabase(); }
        catch (recoveryError) {
          this.db.close();
          throw new Error(`The damaged chat database was preserved as ${path.basename(this.recoveryBackupPath)}, but a clean database could not be created.`, { cause: recoveryError });
        }
      } finally {
        releaseRecoveryLock();
      }
    }
  }
  private initializeDatabase(): void {
    this.db.exec('PRAGMA busy_timeout=5000');
    const check = this.db.prepare('PRAGMA quick_check').all() as { quick_check: string }[];
    if (check.length !== 1 || check[0]?.quick_check !== 'ok') {
      const problems = check.filter(row => row.quick_check !== 'ok').slice(0, 5).map(row => row.quick_check);
      throw new CorruptSessionDatabaseError(`SQLite quick_check: ${problems.join('; ') || 'database integrity check failed'}`);
    }
    // Configure the busy handler before WAL/schema setup. WAL changes and DDL
    // may still report SQLITE_BUSY immediately on simultaneous cold starts, so
    // retry the idempotent setup batch while another process initializes it.
    execWithBusyRetry(this.db, `PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, workspace TEXT NOT NULL, title TEXT NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, session TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_session ON messages(session);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, session TEXT, time INTEGER, tool TEXT, data TEXT);
      CREATE INDEX IF NOT EXISTS audit_session_time ON audit(session,time DESC,id DESC);
      CREATE TABLE IF NOT EXISTS workflows(session TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage(id INTEGER PRIMARY KEY, session TEXT, data TEXT);
      CREATE TABLE IF NOT EXISTS context(session TEXT PRIMARY KEY, data TEXT, watermark INTEGER);
      CREATE TABLE IF NOT EXISTS memory(workspace TEXT, name TEXT, body TEXT, PRIMARY KEY(workspace,name));
      CREATE TABLE IF NOT EXISTS verification_reports(id TEXT PRIMARY KEY, session TEXT NOT NULL, created INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS verification_session_created ON verification_reports(session,created DESC);
      CREATE TABLE IF NOT EXISTS change_groups(id TEXT PRIMARY KEY, workspace TEXT NOT NULL, name TEXT NOT NULL, created INTEGER NOT NULL, process_id INTEGER NOT NULL, state TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS change_groups_workspace_created ON change_groups(workspace,created DESC);
      CREATE TABLE IF NOT EXISTS file_changes(id TEXT PRIMARY KEY, workspace TEXT NOT NULL, group_id TEXT, path TEXT NOT NULL, tool TEXT NOT NULL, created INTEGER NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS file_changes_workspace_created ON file_changes(workspace,created DESC);
      CREATE INDEX IF NOT EXISTS file_changes_group ON file_changes(workspace,group_id,created);
      CREATE TABLE IF NOT EXISTS file_checkpoints(id TEXT PRIMARY KEY, workspace TEXT NOT NULL, name TEXT NOT NULL, created INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS file_checkpoints_workspace_created ON file_checkpoints(workspace,created DESC);
      CREATE TABLE IF NOT EXISTS workspace_mutation_locks(workspace TEXT PRIMARY KEY, owner TEXT NOT NULL, process_id INTEGER NOT NULL, acquired INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS project_indexes(workspace TEXT NOT NULL, target TEXT NOT NULL, updated INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(workspace,target));`);
  }
  create(workspace: string, title = 'New session'): string {
    const id = randomUUID(); this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(id, workspace, safeText(title).replace(/\s+/g, ' ').trim().slice(0, 100) || 'New session', Date.now()); return id;
  }
  list(workspace: string, query = ''): { id: string; title: string; updated: number }[] {
    const needle = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
    return this.db.prepare(`SELECT s.id,s.title,s.updated FROM sessions s WHERE s.workspace=?
      AND (?='' OR s.title LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM messages m WHERE m.session=s.id AND json_extract(m.data,'$.content') LIKE ? ESCAPE '\\'))
      ORDER BY s.updated DESC LIMIT 100`).all(workspace, query, needle, needle) as any;
  }
  rename(id: string, workspace: string, title: string): void {
    const value = title.trim();
    if (!value || value.length > 100 || /[\r\n\x00-\x1f]/.test(value)) throw new Error('Session name must contain 1 to 100 characters on one line.');
    const result = this.db.prepare('UPDATE sessions SET title=?,updated=? WHERE id=? AND workspace=?').run(safeText(value), Date.now(), id, workspace);
    if (!result.changes) throw new Error('No session was found in this project.');
  }
  exists(id: string, workspace: string): boolean { return !!this.db.prepare('SELECT id FROM sessions WHERE id=? AND workspace=?').get(id, workspace); }
  append(session: string, message: Message): void {
    const { images: _transient, ...stored } = message;
    if (message.images?.length) stored.content += '\n[The image was available only during this run. After resuming, take a new screenshot or attach the image again.]';
    this.db.prepare('INSERT INTO messages(session,data) VALUES(?,?)').run(session, redact(JSON.stringify(stored)));
    this.db.prepare('UPDATE sessions SET updated=? WHERE id=?').run(Date.now(), session);
    if (message.role === 'user') this.db.prepare("UPDATE sessions SET title=? WHERE id=? AND title='New session'").run(safeText(message.content).replace(/\s+/g, ' ').trim().slice(0, 100) || 'New session', session);
  }
  messages(session: string): Message[] { return this.db.prepare('SELECT data FROM messages WHERE session=? ORDER BY id').all(session).map(row => JSON.parse(row.data as string)); }
  context(session: string): Message[] {
    const saved = this.db.prepare('SELECT data,watermark FROM context WHERE session=?').get(session);
    if (!saved) return this.messages(session);
    return [...JSON.parse(saved.data as string), ...this.db.prepare('SELECT data FROM messages WHERE session=? AND id>? ORDER BY id').all(session, saved.watermark as number).map(row => JSON.parse(row.data as string))];
  }
  searchHistory(session: string, query: string, limit = 5): { id: number; role: Message['role']; source?: string; excerpt: string }[] {
    const terms = [...new Set(query.toLocaleLowerCase('pl').match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])].filter(term => !['and', 'for', 'the', 'with', 'from', 'oraz', 'dla', 'tego', 'też', 'czy', 'jak', 'jest', 'było', 'był'].includes(term)).slice(0, 10);
    if (!terms.length) return [];
    const hits: { id: number; role: Message['role']; source?: string; excerpt: string; score: number }[] = [];
    const rows = this.db.prepare('SELECT id,data FROM messages WHERE session=? ORDER BY id DESC').iterate(session) as Iterable<{ id: number; data: string }>;
    for (const row of rows) {
      const message = JSON.parse(row.data) as Message;
      const searchable = safeText(`${message.content}\n${(message.toolCalls ?? []).map(call => `${call.name} ${JSON.stringify(call.arguments)}`).join('\n')}`);
      const folded = searchable.toLocaleLowerCase('pl');
      const matched = terms.filter(term => folded.includes(term));
      if (!matched.length) continue;
      const first = Math.min(...matched.map(term => folded.indexOf(term)).filter(position => position >= 0));
      const start = Math.max(0, first - 250), end = Math.min(searchable.length, first + 1100);
      const excerpt = clip(searchable.slice(start, end), 1400);
      const score = matched.length * 12 + (message.isError ? 18 : 0) + (message.role === 'user' ? 4 : 0) + Math.min(10, Math.floor(row.id / 100000));
      hits.push({ id: row.id, role: message.role, ...(message.name ? { source: message.name } : {}), excerpt, score });
    }
    return hits.sort((a, b) => b.score - a.score || b.id - a.id).slice(0, Math.max(1, Math.min(8, limit))).map(({ score: _score, ...hit }) => hit);
  }
  archiveContext(session: string, messages: Message[]): void {
    const last = this.db.prepare('SELECT MAX(id) AS watermark FROM messages WHERE session=?').get(session);
    this.db.prepare('INSERT OR REPLACE INTO context VALUES(?,?,?)').run(session, redact(JSON.stringify(messages.map(({ images: _transient, ...stored }) => stored))), (last?.watermark as number | null) ?? 0);
  }
  replace(session: string, messages: Message[]): void {
    this.db.exec('BEGIN IMMEDIATE');
    try { this.db.prepare('DELETE FROM context WHERE session=?').run(session); this.db.prepare('DELETE FROM messages WHERE session=?').run(session); for (const message of messages) this.append(session, message); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  audit(session: string, tool: string, data: unknown): void { this.db.prepare('INSERT INTO audit(session,time,tool,data) VALUES(?,?,?,?)').run(session, Date.now(), tool, redact(JSON.stringify(data))); }
  evidenceTimeline(session: string, limit = 30): EvidenceTimelineEntry[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('Timeline count must be between 1 and 200.');
    const toolRows = this.db.prepare('SELECT id,time,tool,data FROM audit WHERE session=? ORDER BY time DESC,id DESC LIMIT ?').all(session, limit) as { id: number; time: number; tool: string; data: string }[];
    const toolEvents = toolRows.map(row => {
      let data: Record<string, unknown> = {};
      try { const parsed: unknown = JSON.parse(row.data); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, unknown>; } catch { /* Keep a minimal event when an older audit entry is malformed. */ }
      const args = data.arguments && typeof data.arguments === 'object' && !Array.isArray(data.arguments) ? data.arguments as Record<string, unknown> : {};
      if (row.tool === 'model_request') {
        const usage = data.usage && typeof data.usage === 'object' ? data.usage as Record<string, unknown> : {};
        const tokenText = typeof usage.input === 'number' && typeof usage.output === 'number' ? ` · ~${usage.input + usage.output} tokens` : '';
        const provider = safeText(String(data.provider ?? 'provider'));
        const model = safeText(String(data.model ?? 'model'));
        const cost = typeof usage.cost === 'number' && usage.costKnown === true ? ` · $${usage.cost.toFixed(6)}` : '';
        return { id: `model-${row.id}`, createdAt: row.time, kind: 'model' as const, actor: safeText(String(data.agent ?? 'agent')),
          status: safeText(String(data.status ?? 'unknown')), summary: clip(`${provider}/${model}${tokenText}${cost}`, 150),
          ...(typeof data.durationMs === 'number' && Number.isFinite(data.durationMs) && data.durationMs >= 0 ? { durationMs: data.durationMs } : {}) };
      }
      return { id: `tool-${row.id}`, createdAt: row.time, kind: 'tool' as const, actor: safeText(String(data.agent ?? 'agent')),
        status: data.isError === true ? 'error' : 'done', summary: describeToolCall(row.tool, args),
        ...(typeof data.durationMs === 'number' && Number.isFinite(data.durationMs) ? { durationMs: data.durationMs } : {}) };
    });
    const verificationEvents = this.verificationReports(session, limit).map(report => {
      const passed = report.commands.filter(command => command.status === 'passed').length;
      return { id: `verification-${report.id}`, createdAt: report.createdAt, kind: 'verification' as const, actor: 'user', status: report.status,
        summary: `${passed}/${report.commands.length} checks · ${report.files.length} files hashed · report ${report.id.slice(0, 8)}` };
    });
    const timeline = [
      ...toolEvents.map((entry, index) => ({ entry, sequence: toolRows[index]!.id })),
      ...verificationEvents.map(entry => ({ entry, sequence: Number.MAX_SAFE_INTEGER })),
    ];
    return timeline.sort((left, right) => right.entry.createdAt - left.entry.createdAt || right.sequence - left.sequence || right.entry.id.localeCompare(left.entry.id))
      .slice(0, limit).map(value => value.entry);
  }
  saveVerification(report: VerificationReport): void {
    if (!this.db.prepare('SELECT id FROM sessions WHERE id=?').get(report.session)) throw new Error('Cannot save verification for an unknown session.');
    this.db.prepare('INSERT OR REPLACE INTO verification_reports(id,session,created,data) VALUES(?,?,?,?)').run(report.id, report.session, report.createdAt, redact(JSON.stringify(report)));
  }
  verificationReports(session: string, limit = 10): VerificationReport[] {
    if (!Number.isFinite(limit) || limit < 1) throw new Error('Verification history limit must be positive.');
    return this.db.prepare('SELECT data FROM verification_reports WHERE session=? ORDER BY created DESC LIMIT ?').all(session, Math.floor(limit)).map(row => JSON.parse((row as { data: string }).data) as VerificationReport);
  }
  verificationReport(session: string, prefix: string): VerificationReport | undefined {
    if (prefix.length < 4) throw new Error('Use at least four characters from the report ID.');
    const matches = (this.db.prepare('SELECT data FROM verification_reports WHERE session=? ORDER BY created DESC').all(session) as { data: string }[])
      .map(row => JSON.parse(row.data) as VerificationReport).filter(report => report.id.startsWith(prefix));
    if (matches.length > 1) throw new Error('That report prefix is ambiguous. Use a longer ID.');
    return matches[0];
  }
  projectIndex(workspace: string, target: string): unknown | undefined {
    const row = this.db.prepare('SELECT data FROM project_indexes WHERE workspace=? AND target=?').get(workspace, target) as { data: string } | undefined;
    if (!row) return undefined;
    try { return JSON.parse(row.data) as unknown; }
    catch {
      this.db.prepare('DELETE FROM project_indexes WHERE workspace=? AND target=?').run(workspace, target);
      return undefined;
    }
  }
  saveProjectIndex(workspace: string, target: string, value: unknown): void {
    const data = redact(JSON.stringify(value));
    if (Buffer.byteLength(data) > 5_000_000) throw new Error('Project index cache is too large.');
    this.db.prepare('INSERT INTO project_indexes(workspace,target,updated,data) VALUES(?,?,?,?) ON CONFLICT(workspace,target) DO UPDATE SET updated=excluded.updated,data=excluded.data')
      .run(workspace, target, Date.now(), data);
  }
  prepareRecoveryChange(change: RecoveryChange): void {
    this.db.prepare('INSERT INTO file_changes(id,workspace,group_id,path,tool,created,state,payload) VALUES(?,?,?,?,?,?,?,?)')
      .run(change.id, change.workspace, change.groupId, safeText(change.path), safeText(change.tool), change.createdAt, 'prepared', change.payload);
  }
  setRecoveryChangeState(workspace: string, id: string, state: RecoveryChangeState): void {
    const result = this.db.prepare('UPDATE file_changes SET state=? WHERE workspace=? AND id=?').run(state, workspace, id);
    if (!result.changes) throw new Error('Recovery change was not found in this project.');
  }
  recoveryChange(workspace: string, id: string): RecoveryChange | undefined {
    const row = this.db.prepare('SELECT id,workspace,group_id AS groupId,path,tool,created AS createdAt,state,payload FROM file_changes WHERE workspace=? AND id=?').get(workspace, id) as RecoveryChange | undefined;
    return row;
  }
  recoveryChanges(workspace: string, groupId?: string, states?: RecoveryChangeState[], limit?: number): RecoveryChange[] {
    const clauses = ['workspace=?']; const values: (string | number)[] = [workspace];
    if (groupId !== undefined) { clauses.push('group_id=?'); values.push(groupId); }
    if (states?.length) { clauses.push(`state IN (${states.map(() => '?').join(',')})`); values.push(...states); }
    const descending = limit !== undefined;
    const limitClause = descending ? ' LIMIT ?' : '';
    if (descending) values.push(Math.max(1, Math.floor(limit!)));
    return this.db.prepare(`SELECT id,workspace,group_id AS groupId,path,tool,created AS createdAt,state,payload FROM file_changes WHERE ${clauses.join(' AND ')} ORDER BY created ${descending ? 'DESC' : 'ASC'},id ${descending ? 'DESC' : 'ASC'}${limitClause}`).all(...values) as unknown as RecoveryChange[];
  }
  latestRecoveryChange(workspace: string, states: RecoveryChangeState[] = ['applied']): RecoveryChange | undefined {
    if (!states.length) return undefined;
    return this.db.prepare(`SELECT id,workspace,group_id AS groupId,path,tool,created AS createdAt,state,payload FROM file_changes WHERE workspace=? AND state IN (${states.map(() => '?').join(',')}) ORDER BY created DESC,id DESC LIMIT 1`).get(workspace, ...states) as RecoveryChange | undefined;
  }
  startRecoveryGroup(group: RecoveryGroup): void {
    this.db.prepare('INSERT INTO change_groups(id,workspace,name,created,process_id,state) VALUES(?,?,?,?,?,?)')
      .run(group.id, group.workspace, safeText(group.name), group.createdAt, group.processId, 'running');
  }
  setRecoveryGroupState(workspace: string, id: string, state: RecoveryGroupState): void {
    const result = this.db.prepare('UPDATE change_groups SET state=? WHERE workspace=? AND id=?').run(state, workspace, id);
    if (!result.changes) throw new Error('Recovery group was not found in this project.');
  }
  recoveryGroup(workspace: string, id: string): RecoveryGroup | undefined {
    return this.db.prepare('SELECT id,workspace,name,created AS createdAt,process_id AS processId,state FROM change_groups WHERE workspace=? AND id=?').get(workspace, id) as RecoveryGroup | undefined;
  }
  recoveryGroups(workspace: string): RecoveryGroup[] {
    return this.db.prepare('SELECT id,workspace,name,created AS createdAt,process_id AS processId,state FROM change_groups WHERE workspace=? ORDER BY created DESC').all(workspace) as unknown as RecoveryGroup[];
  }
  saveCheckpoint(checkpoint: RecoveryCheckpoint): void {
    this.db.prepare('INSERT INTO file_checkpoints(id,workspace,name,created,payload) VALUES(?,?,?,?,?)')
      .run(checkpoint.id, checkpoint.workspace, safeText(checkpoint.name), checkpoint.createdAt, checkpoint.payload);
  }
  checkpoint(workspace: string, id: string): RecoveryCheckpoint | undefined {
    return this.db.prepare('SELECT id,workspace,name,created AS createdAt,payload FROM file_checkpoints WHERE workspace=? AND id=?').get(workspace, id) as RecoveryCheckpoint | undefined;
  }
  checkpoints(workspace: string): Omit<RecoveryCheckpoint, 'payload'>[] {
    return this.db.prepare('SELECT id,workspace,name,created AS createdAt FROM file_checkpoints WHERE workspace=? ORDER BY created DESC').all(workspace) as unknown as Omit<RecoveryCheckpoint, 'payload'>[];
  }
  deleteCheckpoint(workspace: string, id: string): void {
    const result = this.db.prepare('DELETE FROM file_checkpoints WHERE workspace=? AND id=?').run(workspace, id);
    if (!result.changes) throw new Error('Checkpoint was not found in this project.');
  }
  recordUsage(session: string, usage: Usage): void { this.db.prepare('INSERT INTO usage(session,data) VALUES(?,?)').run(session, JSON.stringify(usage)); }
  usage(session: string): Usage {
    const total: Usage = { input: 0, output: 0, cached: 0, cost: 0, costKnown: true };
    for (const row of this.db.prepare('SELECT data FROM usage WHERE session=?').all(session)) {
      const value = JSON.parse(row.data as string) as Usage;
      total.input += value.input; total.output += value.output; total.cached += value.cached; total.cost += value.cost; total.costKnown &&= value.costKnown;
    }
    return total;
  }
  integrityCheck(): string {
    const result = this.db.prepare('PRAGMA quick_check').all() as { quick_check: string }[];
    const problems = result.filter(row => row.quick_check !== 'ok').map(row => row.quick_check);
    if (result.length !== 1 || problems.length) throw new Error(`SQLite quick_check: ${problems.join('; ') || `oczekiwano jednego wiersza, otrzymano ${result.length}`}`);
    return 'ok';
  }
  forget(id: string, workspace: string): void {
    if (!this.exists(id, workspace)) throw new Error('Session does not belong to this project.');
    this.db.exec('BEGIN IMMEDIATE');
    try { for (const table of ['messages', 'audit', 'usage', 'context', 'workflows', 'verification_reports']) this.db.prepare(`DELETE FROM ${table} WHERE session=?`).run(id); this.db.prepare('DELETE FROM sessions WHERE id=?').run(id); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  memories(workspace: string): { name: string; body: string }[] { return this.db.prepare('SELECT name,body FROM memory WHERE workspace=?').all(workspace) as any; }
  remember(workspace: string, name: string, body: string): void { this.db.prepare('INSERT OR REPLACE INTO memory VALUES(?,?,?)').run(workspace, name, redact(body)); }
  forgetMemory(workspace: string, name: string): void { this.db.prepare('DELETE FROM memory WHERE workspace=? AND name=?').run(workspace, name); }
  workflow(session: string): WorkflowState { const row = this.db.prepare('SELECT data FROM workflows WHERE session=?').get(session) as { data: string } | undefined; return row ? JSON.parse(row.data) : {}; }
  saveWorkflow(session: string, state: WorkflowState): void { this.db.prepare('INSERT OR REPLACE INTO workflows VALUES(?,?)').run(session, redact(JSON.stringify(state))); }
  savePlan(session: string, plan: NonNullable<WorkflowState['plan']>): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT data FROM workflows WHERE session=?').get(session) as { data: string } | undefined;
      const state: WorkflowState = row ? JSON.parse(row.data) : {};
      state.plan = plan;
      this.db.prepare('INSERT OR REPLACE INTO workflows VALUES(?,?)').run(session, redact(JSON.stringify(state)));
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* The transaction may already have ended. */ }
      throw error;
    }
  }
  async withWorkspaceLock<T>(workspace: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const owner = randomUUID(), deadline = Date.now() + 30_000;
    const acquire = (): boolean => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const current = this.db.prepare('SELECT process_id FROM workspace_mutation_locks WHERE workspace=?').get(workspace) as { process_id: number } | undefined;
        if (current && processIsAlive(current.process_id)) { this.db.exec('COMMIT'); return false; }
        this.db.prepare(`INSERT INTO workspace_mutation_locks(workspace,owner,process_id,acquired) VALUES(?,?,?,?)
          ON CONFLICT(workspace) DO UPDATE SET owner=excluded.owner,process_id=excluded.process_id,acquired=excluded.acquired`)
          .run(workspace, owner, process.pid, Date.now());
        this.db.exec('COMMIT');
        return true;
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch { /* The transaction may already have ended. */ }
        throw error;
      }
    };

    while (true) {
      signal?.throwIfAborted();
      if (acquire()) break;
      if (Date.now() >= deadline) throw new Error('Another PolonRLM process is changing this project. Wait for it to finish or close it, then try again.');
      await waitForWorkspaceLock(signal);
    }
    try { return await work(); }
    finally { this.db.prepare('DELETE FROM workspace_mutation_locks WHERE workspace=? AND owner=?').run(workspace, owner); }
  }
  close(): void { this.db.close(); }
}
