import { createHash } from 'node:crypto';
import type { Message } from './types.js';
import { safeText } from './secrets.js';

const stop = new Set('a an and are as at be been but by can code could do does for from had has have how i in into is it its just me my of on or our please project should task that the their then there these this to tool tools was we were what when which will with would you your oraz czy dla jest jak już mnie napraw nie po proszę się tak tego ten to tym w we z za że'.split(' '));
export function historyTerms(text: string): string[] { return [...new Set((text.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []).filter(term => !stop.has(term)))]; }
export function historyFingerprint(message: Message): string { return createHash('sha256').update(JSON.stringify([message.role, message.name, message.content, message.toolCalls, message.isError])).digest('hex').slice(0, 16); }
export interface HistoryHit { id: number; role: Message['role']; source?: string; excerpt: string; lines: [number, number]; digest: string; isError?: boolean; score: number }
type Document = { id: number; message: Message; text: string; folded: string; terms: Map<string, number>; size: number; digest: string };

/** Incremental, session-local BM25. The full transcript remains in SQLite. */
export class HistoryIndex {
  watermark = 0;
  private documents = new Map<number, Document>();
  private postings = new Map<string, Set<number>>();
  private tokenCount = 0;
  add(id: number, message: Message): void {
    this.watermark = Math.max(this.watermark, id);
    if (message.role === 'system' || ['polonrlm_context', 'polonrlm_recall'].includes(message.name ?? '')) return;
    const text = safeText(message.content + (message.toolCalls?.length ? '\n' + JSON.stringify(message.toolCalls.map(call => ({ name: call.name, arguments: call.arguments }))) : ''));
    const folded = text.toLocaleLowerCase(), terms = new Map<string, number>();
    for (const term of folded.match(/[\p{L}\p{N}_-]{2,}/gu) ?? []) if (!stop.has(term)) terms.set(term, (terms.get(term) ?? 0) + 1);
    const size = [...terms.values()].reduce((sum, count) => sum + count, 0);
    this.tokenCount += size;
    this.documents.set(id, { id, message: { role: message.role, name: message.name, isError: message.isError, content: '' }, text, folded, terms, size, digest: historyFingerprint(message) });
    for (const term of terms.keys()) { const list = this.postings.get(term) ?? new Set(); list.add(id); this.postings.set(term, list); }
  }
  search(query: string, limit = 5, options: { beforeId?: number; exclude?: Set<string>; excerptChars?: number } = {}): HistoryHit[] {
    const count = this.documents.size;
    const terms = historyTerms(query).filter(term => this.postings.has(term)).sort((a, b) => this.postings.get(a)!.size - this.postings.get(b)!.size || b.length - a.length).slice(0, 16);
    if (!terms.length) return [];
    const scores = new Map<number, number>(), overlaps = new Map<number, number>();
    const weights = new Map<string, number>();
    for (const term of terms) {
      const list = this.postings.get(term)!, idf = Math.log(1 + (count - list.size + .5) / (list.size + .5)); weights.set(term, idf);
      for (const id of list) {
        const doc = this.documents.get(id)!;
        if (options.beforeId !== undefined && id > options.beforeId || options.exclude?.has(doc.digest)) continue;
        const tf = doc.terms.get(term)!;
        const weight = idf * (tf * 2.2) / (tf + 1.2 * (.25 + .75 * doc.size / Math.max(1, this.tokenCount / count)));
        scores.set(id, (scores.get(id) ?? 0) + weight); overlaps.set(id, (overlaps.get(id) ?? 0) + 1);
      }
    }
    const unique = new Set<string>(), result: HistoryHit[] = [];
    const ranked = [...scores].filter(([id]) => (overlaps.get(id) ?? 0) >= Math.min(2, terms.length)).map(([id, score]) => {
      const doc = this.documents.get(id)!;
      return { doc, score: score * (doc.message.role === 'assistant' ? .8 : 1) + (doc.message.isError ? .2 : 0) };
    }).sort((a, b) => b.score - a.score || b.doc.id - a.doc.id);
    for (const { doc, score } of ranked) {
      if (unique.has(doc.digest)) continue; unique.add(doc.digest);
      const size = Math.max(160, Math.min(1400, options.excerptChars ?? 1000));
      let start = 0, best = -1;
      for (const term of terms) {
        const position = doc.folded.indexOf(term); if (position < 0) continue;
        const offset = Math.max(0, position - Math.floor(size / 4)), window = doc.folded.slice(offset, offset + size);
        const relevance = terms.reduce((sum, value) => sum + (window.includes(value) ? weights.get(value)! : 0), 0);
        if (relevance > best) { best = relevance; start = offset; }
      }
      const excerpt = doc.text.slice(start, start + size);
      const line = doc.text.slice(0, start).split('\n').length;
      result.push({ id: doc.id, role: doc.message.role, ...(doc.message.name ? { source: doc.message.name } : {}), excerpt, lines: [line, line + excerpt.split('\n').length - 1], digest: doc.digest, ...(doc.message.isError ? { isError: true } : {}), score: Math.round(score * 1000) / 1000 });
      if (result.length >= Math.max(1, Math.min(8, limit))) break;
    }
    return result;
  }
}
