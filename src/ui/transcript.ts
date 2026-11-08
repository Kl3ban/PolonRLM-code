import wrapAnsi from 'wrap-ansi';
import type { ViewMessage } from '../core/types.js';
import { toolDisplayName } from '../core/tool-display.js';
import { markdownLines, sanitizeTerminalText, type MarkdownLine } from './markdown.js';

const diffs = new Set(['write_file', 'edit_file', 'delete_file', 'apply_patch', 'ast_edit', 'git_diff']);
const cachedMessages = new WeakMap<ViewMessage, { key: string; lines: MarkdownLine[] }>();
function groups(messages: ViewMessage[]): (ViewMessage | ViewMessage[])[] {
  const result: (ViewMessage | ViewMessage[])[] = [];
  for (const message of messages) {
    if (message.role === 'assistant' && !message.text.trim()) continue;
    if (message.role === 'tool' && message.toolName) {
      const previous = result.at(-1);
      if (Array.isArray(previous)) previous.push(message); else result.push([message]);
    } else result.push(message);
  }
  return result;
}
const groupId = (messages: ViewMessage[]) => `group:${messages[0]?.toolCallId ?? ''}`;
const operationCount = (count: number) => `${count} ${count === 1 ? 'operation' : 'operations'}`;
export function toolExpansionIds(messages: ViewMessage[]): string[] {
  return groups(messages).flatMap(item => Array.isArray(item) ? [...(item.length > 1 ? [groupId(item)] : []), ...item.map(message => message.toolCallId).filter((id): id is string => !!id)] : []);
}
export function latestToolExpansionId(messages: ViewMessage[]): string | undefined {
  const last = groups(messages).filter(Array.isArray).at(-1) as ViewMessage[] | undefined;
  return last ? last.length > 1 ? groupId(last) : last[0]?.toolCallId : undefined;
}
function readable(value: string): string {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.stdout === 'string') return parsed.stdout + (parsed.stderr ? `\n[stderr]\n${parsed.stderr}` : '');
      if (typeof parsed.diff === 'string') return parsed.diff;
      return JSON.stringify(parsed, null, 2);
    }
  } catch { /* Plain text output. */ }
  return value;
}
function messageLines(message: ViewMessage, width: number, expanded: ReadonlySet<string>, speaker?: string): MarkdownLine[] {
  const open = !!message.toolCallId && expanded.has(message.toolCallId);
  const key = [message.text, message.role, message.speaker, speaker, width, message.toolCallId, message.toolName, message.toolState, message.toolOutput, message.toolOutputTruncated, message.toolDetail, message.agentRole, open].join('\0');
  const cached = cachedMessages.get(message);
  if (cached?.key === key) return cached.lines;
  const result: MarkdownLine[] = [];
  const add = (text: string, style: Omit<MarkdownLine, 'text'> = {}) => {
    wrapAnsi(sanitizeTerminalText(text), width, { hard: true, trim: false }).split('\n').forEach((line, i) => result.push({ text: line || ' ', ...style, ...(i ? { toolCallId: undefined } : {}) }));
  };
  if (message.role === 'tool' && message.toolName) {
    if (message.toolName === 'discover_tools' && message.toolState === 'done' && !open) return [];
    const running = message.toolState === 'running', failed = message.toolState === 'error';
    const duration = message.toolDurationMs === undefined ? '' : ` · ${(message.toolDurationMs / 1000).toFixed(1)}s`;
    add(`${running ? '●' : open ? '▼' : '›'} ${toolDisplayName(message.toolName)}${failed ? ' · error' : running ? ' · running' : ''}${duration}${message.agentRole ? ` · ${message.agentRole}` : ''}`, { color: failed ? '#bca3a3' : undefined, bold: true, toolCallId: message.toolCallId });
    const detail = message.toolDetail?.replace(toolDisplayName(message.toolName) + ': ', '');
    if (detail && detail !== toolDisplayName(message.toolName)) add(`  ${detail.slice(0, Math.max(1, width - 3))}`, { dim: true });
    if (failed && !open && message.toolOutput) add(`  ${sanitizeTerminalText(message.toolOutput).split('\n')[0]!.slice(0, Math.max(1, width - 3))}`, { color: '#bca3a3' });
    if (open && message.toolOutput) {
      const text = readable(message.toolOutput);
      const lines = wrapAnsi(sanitizeTerminalText(text), Math.max(1, width - 2), { hard: true, trim: false }).split('\n');
      for (const line of lines.slice(0, 120)) {
        const color = diffs.has(message.toolName) && line.startsWith('+') ? 'green' : diffs.has(message.toolName) && line.startsWith('-') ? 'red' : undefined;
        result.push({ text: `  ${line || ' '}`, dim: !color, color });
      }
      if (lines.length > 120 || message.toolOutputTruncated) add('  … output truncated', { dim: true });
    }
  } else {
    const labels: Record<string, string> = { user: 'YOU', assistant: message.speaker ?? speaker ?? 'PolonRLM', error: 'ERROR', system: 'INFO', tool: 'TOOL' };
    add(labels[message.role] ?? message.role, { bold: true, color: message.role === 'user' ? 'yellow' : message.role === 'error' ? 'red' : undefined });
    if (message.role === 'assistant') result.push(...markdownLines(message.text, width)); else add(message.text, { dim: message.role === 'system' });
    result.push({ text: ' ' });
  }
  cachedMessages.set(message, { key, lines: result });
  return result;
}

/** Consecutive operations form one compact activity, with optional per-operation details. */
export function transcriptLines(messages: ViewMessage[], width: number, expanded: ReadonlySet<string> = new Set(), speaker?: string): MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  for (const item of groups(messages)) {
    if (!Array.isArray(item)) { lines.push(...messageLines(item, width, expanded, speaker)); continue; }
    if (item.length === 1) { lines.push(...messageLines(item[0]!, width, expanded, speaker), { text: ' ' }); continue; }
    const id = groupId(item), open = expanded.has(id);
    const running = item.some(message => message.toolState === 'running');
    const errors = item.filter(message => message.toolState === 'error');
    const activity = item.filter(message => message.toolName !== 'discover_tools');
    const web = activity.length > 0 && activity.every(message => /^(web_search|read_webpage|fetch_webpage|fetch_documentation|github_repo_inspector|download_to_disk|browser)/.test(message.toolName ?? ''));
    const title = web ? 'Web search' : 'Tool activity';
    const header = `${running ? '●' : open ? '▼' : '›'} ${title} · ${operationCount(item.length)}${errors.length ? ` · errors: ${errors.length}` : ''}`;
    wrapAnsi(header, width, { hard: true }).split('\n').forEach((text, i) => lines.push({ text, bold: true, ...(i === 0 ? { toolCallId: id } : {}) }));
    if (open) for (const message of item) lines.push(...messageLines(message, width, expanded, speaker));
    else {
      const last = [...item].reverse().find(message => message.toolName !== 'discover_tools') ?? item.at(-1)!;
      const detail = last.toolDetail ?? toolDisplayName(last.toolName ?? '');
      lines.push({ text: `  ${sanitizeTerminalText(detail).slice(0, Math.max(1, width - 2))}`, dim: true });
      const lastError = errors.at(-1)?.toolOutput;
      if (lastError) lines.push({ text: `  ! ${sanitizeTerminalText(lastError).split('\n')[0]!.slice(0, Math.max(1, width - 4))}`, color: '#bca3a3' });
    }
    lines.push({ text: ' ' });
  }
  return lines;
}
