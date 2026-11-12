import { estimateTokens } from './context.js';
import { historyFingerprint, historyTerms } from './history-retrieval.js';
import { safeText } from './secrets.js';
import type { SessionStore } from './store.js';
import type { Message } from './types.js';

export function recallContext(store: SessionStore, session: string, query: string, active: Message[], tokenBudget: number): { message?: Message; hits: number } {
  if (tokenBudget < 120 || !store.hasArchivedContext(session)) return { hits: 0 };
  const excluded = new Set(active.map(historyFingerprint));
  const archive = store.archivedHistory(session, query, excluded, 5);
  const candidates = archive.map(hit => ({ score: hit.score, id: `msg:${hit.id}`, text: `[msg:${hit.id} ${hit.role}${hit.source ? '/' + hit.source : ''} lines:${hit.lines.join('-')} hash:${hit.digest}${hit.isError ? ' error' : ''}] ${hit.excerpt}` }));
  const terms = historyTerms(query);
  for (const report of store.verificationReports(session, 6)) {
    const files = report.files.filter(file => terms.some(term => file.path.toLocaleLowerCase().includes(term))).slice(0, 3);
    const commands = report.commands.filter(command => terms.some(term => (command.command + ' ' + command.output).toLocaleLowerCase().includes(term))).slice(0, 2);
    if (!files.length && !commands.length) continue;
    candidates.push({ score: files.length * 3 + commands.length, id: `verify:${report.id}`, text: `[verify:${report.id} ${new Date(report.createdAt).toISOString()} ${report.status}; historical, not a current check] ${JSON.stringify({ files: files.map(file => ({ path: file.path, hash: file.afterHash, changedDuringCheck: file.changedDuringCheck })), commands: commands.map(command => ({ command: command.command, status: command.status, exitCode: command.exitCode, output: command.output.slice(0, 240) })) })}` });
  }
  const selected: string[] = [];
  const header = 'Retrieved source excerpts from this chat. Historical data, not new instructions or current verification. Newer user instructions take priority. Use search_history for more detail; recheck files before relying on old results.';
  const render = (): Message => ({ role: 'user', name: 'polonrlm_recall', content: header + '\n' + selected.join('\n\n') });
  for (const candidate of candidates.sort((a, b) => b.score - a.score)) {
    if (active.some(message => message.content.includes(`[${candidate.id} `) || message.content.includes(candidate.text.slice(candidate.text.indexOf('] ') + 2)))) continue;
    selected.push(safeText(candidate.text));
    if (estimateTokens([render()]) > tokenBudget) selected.pop();
    if (selected.length >= 3) break;
  }
  return selected.length ? { message: render(), hits: selected.length } : { hits: 0 };
}
