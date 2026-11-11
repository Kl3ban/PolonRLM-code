import { DatabaseSync } from 'node:sqlite';
import { closeSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Message, Usage } from './types.js';
import { redact, safeText } from './secrets.js';
import { clip } from './context.js';
import type { WorkflowState } from './workflows.js';
import type { VerificationReport } from './verification.js';

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
      CREATE TABLE IF NOT EXISTS workflows(session TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage(id INTEGER PRIMARY KEY, session TEXT, data TEXT);
      CREATE TABLE IF NOT EXISTS context(session TEXT PRIMARY KEY, data TEXT, watermark INTEGER);
      CREATE TABLE IF NOT EXISTS memory(workspace TEXT, name TEXT, body TEXT, PRIMARY KEY(workspace,name));
      CREATE TABLE IF NOT EXISTS verification_reports(id TEXT PRIMARY KEY, session TEXT NOT NULL, created INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS verification_session_created ON verification_reports(session,created DESC);`);
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
  close(): void { this.db.close(); }
}
