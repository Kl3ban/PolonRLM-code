import React from 'react';
import { Text } from 'ink';
import { marked, type Token, type Tokens } from 'marked';
import { highlight } from 'cli-highlight';
import wrapAnsi from 'wrap-ansi';
import { sanitizeTerminalText } from '../core/terminal-text.js';
export { sanitizeTerminalText } from '../core/terminal-text.js';

export interface MarkdownLine {
  text: string;
  color?: string;
  bold?: boolean;
  dim?: boolean;
  toolCallId?: string;
}

/** Remove terminal controls supplied by models, tools, or files. */

/** Keep pasted line breaks while stripping terminal control sequences. */
export function sanitizePastedText(value: string): string {
  return sanitizeTerminalText(value.replace(/\r\n?/g, '\n').replace(/\t/g, '    '));
}

function inline(text: string): string {
  return marked.Lexer.lexInline(text).map(token => {
    switch (token.type) {
      case 'strong': return `\u001b[1m${inline(token.text)}\u001b[22m`;
      case 'em': return `\u001b[3m${inline(token.text)}\u001b[23m`;
      case 'codespan': return `\u001b[36m${token.text}\u001b[39m`;
      case 'del': return `\u001b[9m${inline(token.text)}\u001b[29m`;
      case 'link': return `${inline(token.text)} (${token.href})`;
      case 'image': return `[image: ${token.text}] (${token.href})`;
      case 'br': return '\n';
      case 'escape': case 'text': return token.text;
      case 'html': return token.raw;
      default: return token.raw;
    }
  }).join('');
}

export function markdownLines(markdown: string, width: number): MarkdownLine[] {
  const columns = Math.max(1, width);
  const output: MarkdownLine[] = [];
  const add = (text: string, style: Omit<MarkdownLine, 'text'> = {}) => {
    for (const line of wrapAnsi(text, columns, { hard: true, trim: false }).split('\n')) {
      output.push({ text: line || ' ', ...style });
    }
  };
  const visit = (tokens: Token[], prefix = '') => {
    for (const token of tokens) {
      switch (token.type) {
        case 'space': add(''); break;
        case 'heading': add(`${prefix}${inline(token.text)}`, { bold: true, color: 'cyan' }); break;
        case 'paragraph': case 'text': add(`${prefix}${inline(token.text)}`); break;
        case 'code': {
          add(`${prefix}╭─ ${token.lang || 'code'}`, { dim: true });
          let code = token.text;
          try { code = highlight(code, { language: token.lang?.split(/\s/)[0], ignoreIllegals: true }); } catch { /* Unknown language stays plain. */ }
          for (const line of code.split('\n')) add(`${prefix}│ ${line}`);
          add(`${prefix}╰─`, { dim: true });
          break;
        }
        case 'list': {
          const list = token as Tokens.List;
          list.items.forEach((item, index) => {
            const marker = list.ordered ? `${Number(list.start) + index}. ` : '• ';
            const checked = item.task ? (item.checked ? '[x] ' : '[ ] ') : '';
            const before = output.length;
            visit(item.tokens, `${prefix}${marker}${checked}`);
            if (before === output.length) add(`${prefix}${marker}${checked}${inline(item.text)}`);
          });
          break;
        }
        case 'blockquote': visit(token.tokens || [], `${prefix}│ `); break;
        case 'hr': add('─'.repeat(Math.min(40, columns)), { dim: true }); break;
        case 'table': {
          const table = token as Tokens.Table;
          add(table.header.map(cell => inline(cell.text)).join(' │ '), { bold: true });
          for (const row of table.rows) add(row.map(cell => inline(cell.text)).join(' │ '));
          break;
        }
        case 'def': break;
        default: add(`${prefix}${'text' in token ? String(token.text) : token.raw}`);
      }
    }
  };
  visit(marked.lexer(sanitizeTerminalText(markdown)));
  return output;
}

export function MarkdownRow({ line }: { line: MarkdownLine }): React.JSX.Element {
  return <Text color={line.color} bold={line.bold} dimColor={line.dim} wrap="truncate-end">{line.text}</Text>;
}

export function Markdown({ text, width }: { text: string; width: number }): React.JSX.Element {
  return <>{markdownLines(text, width).map((line, index) => <MarkdownRow key={index} line={line} />)}</>;
}
