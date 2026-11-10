import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Message, Usage } from './types.js';
import { redact, safeText } from './secrets.js';
import { clip } from './context.js';
import type { WorkflowState } from './workflows.js';

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

export class SessionStore {
  private db: DatabaseSync;
  constructor(home: string) {
    this.db = new DatabaseSync(path.join(home, 'sessions.sqlite'));
    // Configure the busy handler before WAL/schema setup. WAL changes and DDL
    // may still report SQLITE_BUSY immediately on simultaneous cold starts, so
    // retry the idempotent setup batch while another process initializes it.
    this.db.exec('PRAGMA busy_timeout=5000');
    execWithBusyRetry(this.db, `PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, workspace TEXT NOT NULL, title TEXT NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, session TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_session ON messages(session);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, session TEXT, time INTEGER, tool TEXT, data TEXT);
      CREATE TABLE IF NOT EXISTS workflows(session TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage(id INTEGER PRIMARY KEY, session TEXT, data TEXT);
      CREATE TABLE IF NOT EXISTS context(session TEXT PRIMARY KEY, data TEXT, watermark INTEGER);
      CREATE TABLE IF NOT EXISTS memory(workspace TEXT, name TEXT, body TEXT, PRIMARY KEY(workspace,name));`);
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
    try { for (const table of ['messages', 'audit', 'usage', 'context', 'workflows']) this.db.prepare(`DELETE FROM ${table} WHERE session=?`).run(id); this.db.prepare('DELETE FROM sessions WHERE id=?').run(id); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  memories(workspace: string): { name: string; body: string }[] { return this.db.prepare('SELECT name,body FROM memory WHERE workspace=?').all(workspace) as any; }
  remember(workspace: string, name: string, body: string): void { this.db.prepare('INSERT OR REPLACE INTO memory VALUES(?,?,?)').run(workspace, name, redact(body)); }
  forgetMemory(workspace: string, name: string): void { this.db.prepare('DELETE FROM memory WHERE workspace=? AND name=?').run(workspace, name); }
  workflow(session: string): WorkflowState { const row = this.db.prepare('SELECT data FROM workflows WHERE session=?').get(session) as { data: string } | undefined; return row ? JSON.parse(row.data) : {}; }
  saveWorkflow(session: string, state: WorkflowState): void { this.db.prepare('INSERT OR REPLACE INTO workflows VALUES(?,?)').run(session, redact(JSON.stringify(state))); }
  close(): void { this.db.close(); }
}
