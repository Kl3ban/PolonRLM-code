import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { UIController, UIState } from '../core/types.js';
import { THEMES } from './design.js';
import { sanitizeTerminalText } from './markdown.js';
import { readClipboardImage as readWindowsClipboardImage } from './clipboard.js';
import { parseTokenBudget } from '../core/budget.js';
import { copyToClipboard } from './clipboard.js';

type Props = { controller: UIController; state: UIState; width: number; rows: number; close: () => void; readClipboardImage?: () => Promise<string> };

function Frame({ title, hint, children, state, width }: Props & { title: string; hint: string; children: React.ReactNode }): React.JSX.Element {
  const colors = THEMES[state.theme];
  return <Box width={Math.max(12, Math.min(width, width - 8))} flexDirection="column" paddingX={2} paddingY={1} backgroundColor={colors.panel} borderStyle="round" borderColor={colors.border}>
    <Box justifyContent="space-between"><Text color={colors.accent} bold>{title}</Text><Text color={colors.faint}>Esc to close</Text></Box>
    {children}
    <Text color={colors.muted}>{hint}</Text>
  </Box>;
}

export function SessionPanel(props: Props): React.JSX.Element {
  const { controller, state, close, rows } = props;
  const [query, setQuery] = useState(''), [selected, setSelected] = useState(0), [revision, setRevision] = useState(0);
  const [renaming, setRenaming] = useState(false), [title, setTitle] = useState(''), [error, setError] = useState('');
  const sessions = useMemo(() => controller.listSessions?.(query) ?? [], [controller, query, revision, state.messages.length]);
  const index = Math.min(selected, Math.max(0, sessions.length - 1));
  useInput((input, key) => {
    if (key.eventType === 'release') return;
    if (key.escape) { if (renaming) setRenaming(false); else close(); return; }
    if (renaming) {
      if (key.return) {
        const current = sessions[index];
        if (current) { try { controller.renameSession?.(current.id, title); setError(''); setRenaming(false); setRevision(value => value + 1); } catch (cause) { setError(sanitizeTerminalText(cause instanceof Error ? cause.message : String(cause))); } }
        return;
      }
      if (key.backspace || key.delete) { setTitle(value => Array.from(value).slice(0, -1).join('')); return; }
      if (key.ctrl && input.toLowerCase() === 'u') { setTitle(''); return; }
      if (!key.ctrl && !key.meta && input) setTitle(value => (value + sanitizeTerminalText(input).replace(/[\r\n]/g, '')).slice(0, 100));
      return;
    }
    if (key.upArrow || key.downArrow) { setSelected(value => Math.max(0, Math.min(sessions.length - 1, value + (key.upArrow ? -1 : 1)))); return; }
    if (key.return) {
      const current = sessions[index];
      if (current) {
        if (state.busy) { setError('Wait for the task to finish before resuming the conversation.'); return; }
        try { if (!controller.resumeSession) throw new Error('Session resume is unavailable.'); controller.resumeSession(current.id); close(); }
        catch (cause) { setError(sanitizeTerminalText(cause instanceof Error ? cause.message : String(cause))); }
      }
      return;
    }
    if (key.ctrl && input.toLowerCase() === 'r') { const current = sessions[index]; if (current) { setTitle(current.title); setError(''); setRenaming(true); } return; }
    if (key.backspace || key.delete) { setQuery(value => Array.from(value).slice(0, -1).join('')); setSelected(0); return; }
    if (key.ctrl && input.toLowerCase() === 'u') { setQuery(''); setSelected(0); return; }
    if (!key.ctrl && !key.meta && input) { setQuery(value => value + sanitizeTerminalText(input).replace(/[\r\n]/g, '')); setSelected(0); }
  });
  const count = Math.max(1, Math.min(8, rows - 13));
  const start = Math.max(0, index - count + 1);
  return <Frame {...props} title="CONVERSATION HISTORY" hint={renaming ? 'Enter save name · Esc cancel · Ctrl+U clear' : 'Type to search names and messages · ↑↓ select · Enter resume · Ctrl+R rename'}>
    <Box marginY={1}><Text color={THEMES[state.theme].accent}>/ </Text><Text color={THEMES[state.theme].text}>{renaming ? title : query || <Text color={THEMES[state.theme].muted}>search conversations…</Text>}{(renaming || !query) && <Text inverse> </Text>}</Text></Box>
    {sessions.slice(start, start + count).map((session, offset) => {
      const active = start + offset === index;
      return <Box key={session.id} height={1} backgroundColor={active ? THEMES[state.theme].selected : THEMES[state.theme].panel}>
        <Text color={active ? THEMES[state.theme].accent : THEMES[state.theme].muted}>{active ? '› ' : '  '}</Text>
        <Text color={active ? THEMES[state.theme].text : THEMES[state.theme].muted} wrap="truncate-end">{sanitizeTerminalText(session.title)} · {new Date(session.updated).toLocaleString('en-US')} {session.id === state.sessionId ? '· active' : ''}</Text>
      </Box>;
    })}
    {!sessions.length && <Text color={THEMES[state.theme].muted}>No matching conversations.</Text>}
    {error && <Text color={THEMES[state.theme].error}>{error}</Text>}
  </Frame>;
}

export function MessageCopyPanel(props: Props & { onCopy?: (text: string) => void }): React.JSX.Element {
  const { state, close, rows, onCopy } = props;
  const messages = useMemo(() => state.messages.filter(message => message.role === 'user' || message.role === 'assistant').slice(-60).reverse(), [state.messages]);
  const [selected, setSelected] = useState(0), [status, setStatus] = useState(''), [error, setError] = useState('');
  const index = Math.min(selected, Math.max(0, messages.length - 1));
  const count = Math.max(1, Math.min(10, rows - 13));
  const start = Math.min(Math.max(0, index - count + 1), Math.max(0, messages.length - count));
  useInput((input, key) => {
    if (key.eventType === 'release') return;
    if (key.escape) { close(); return; }
    if (key.upArrow || key.downArrow) { setSelected(n => Math.max(0, Math.min(messages.length - 1, n + (key.upArrow ? -1 : 1)))); return; }
    if (key.return && messages[index]) {
      const message = messages[index]!;
      void (onCopy ? Promise.resolve(onCopy(message.text)) : copyToClipboard(message.text))
        .then(() => { setError(''); setStatus('Full message copied to clipboard.'); })
        .catch(cause => setError(sanitizeTerminalText(cause instanceof Error ? cause.message : String(cause))));
    }
  });
  return <Frame {...props} title="COPY MESSAGE" hint="↑↓ select · Enter copies the full message · Esc close">
    <Box marginY={1} flexDirection="column">
      {messages.slice(start, start + count).map((message, offset) => {
        const active = start + offset === index;
        return <Box key={`${start + offset}`} height={1} backgroundColor={active ? THEMES[state.theme].selected : THEMES[state.theme].panel}>
          <Text color={active ? THEMES[state.theme].accent : THEMES[state.theme].muted}>{active ? '› ' : '  '}</Text>
          <Text color={message.role === 'user' ? THEMES[state.theme].warm : THEMES[state.theme].text} wrap="truncate-end">{message.role === 'user' ? 'You' : `AI · ${message.speaker ?? 'model'}`}: {sanitizeTerminalText(message.text).replace(/\s+/g, ' ')}</Text>
        </Box>;
      })}
      {!messages.length && <Text color={THEMES[state.theme].muted}>No messages to copy.</Text>}
      {status && <Text color={THEMES[state.theme].accent}>{status}</Text>}
      {error && <Text color={THEMES[state.theme].error}>{error}</Text>}
    </Box>
  </Frame>;
}

export function AgentPanel(props: Props): React.JSX.Element {
  const { state, controller, close, rows } = props;
  const [selected, setSelected] = useState(0);
  const index = Math.min(selected, Math.max(0, state.agents.length - 1));
  const count = Math.max(1, Math.min(5, rows - 15));
  const start = Math.min(Math.max(0, index - count + 1), Math.max(0, state.agents.length - count));
  useInput((input, key) => {
    if (key.eventType === 'release') return;
    if (key.escape) { close(); return; }
    if (key.upArrow || key.downArrow) { setSelected(value => Math.max(0, Math.min(state.agents.length - 1, value + (key.upArrow ? -1 : 1)))); return; }
    if ((!key.ctrl && !key.meta && input.toLowerCase() === 'x') || key.delete) { const agent = state.agents[index]; if (agent) controller.stopAgent?.(agent.id); }
  });
  const visible = state.agents.slice(start, start + count);
  return <Frame {...props} title="SUBAGENTS" hint="↑↓ select · X stop · /steer <id> <message> in the task field">
    <Box marginY={1} flexDirection="column">
      {visible.map(agent => <Box key={agent.id} flexDirection="column" marginBottom={1}>
        <Text color={agent.status === 'error' ? THEMES[state.theme].error : agent.status === 'working' || agent.status === 'running' ? THEMES[state.theme].accent : THEMES[state.theme].text} bold>{agent.id === state.agents[index]?.id ? '› ' : '  '}{agent.role} · {agent.id} · {agent.status}{agent.totalSteps ? ` · ${agent.progress ?? 0}/${agent.totalSteps} steps` : ''}</Text>
        {agent.task && <Text color={THEMES[state.theme].muted} wrap="truncate-end">  {sanitizeTerminalText(agent.task)}</Text>}
        {!!agent.changedFiles?.length && <Text color={THEMES[state.theme].muted} wrap="truncate-end">  Files: {agent.changedFiles.map(sanitizeTerminalText).join(', ')}</Text>}
      </Box>)}
      {!state.agents.length && <Text color={THEMES[state.theme].muted}>No subagents have been started in this session.</Text>}
    </Box>
  </Frame>;
}

export function BudgetPanel(props: Props): React.JSX.Element {
  const { controller, state, close } = props;
  const [values, setValues] = useState([state.tokenLimit === 0 ? 'infinity' : String(state.tokenLimit), String(state.dollarLimit)]), [field, setField] = useState(0), [error, setError] = useState('');
  useInput((input, key) => {
    if (key.eventType === 'release') return;
    if (key.escape) { close(); return; }
    if (key.tab || key.return) {
      if (field === 0) { setField(1); return; }
      void (async () => { try { if (!controller.setBudgets) throw new Error('Budget controls are unavailable.'); await controller.setBudgets(parseTokenBudget(values[0]), Number(values[1])); close(); } catch (cause) { setError(sanitizeTerminalText(cause instanceof Error ? cause.message : String(cause))); } })(); return;
    }
    if (key.ctrl && input.toLowerCase() === 'u') { setValues(current => current.map((value, index) => index === field ? '' : value)); return; }
    if (key.backspace || key.delete) { setValues(current => current.map((value, index) => index === field ? value.slice(0, -1) : value)); return; }
    if (!key.ctrl && !key.meta && (field === 0 ? /^[0-9a-z∞]+$/i : /^[0-9.]+$/).test(input)) setValues(current => current.map((value, index) => index === field ? value + input : value));
  });
  return <Frame {...props} title="NEXT TASK BUDGET" hint="Tab choose a limit · Enter next/save · values apply to one task">
    <Box marginTop={1}><Text color={THEMES[state.theme].muted}>Tokeny maks.    </Text><Text color={field === 0 ? THEMES[state.theme].accent : THEMES[state.theme].text}>{values[0]}</Text></Box>
    <Box><Text color={THEMES[state.theme].muted}>Koszt USD maks.  </Text><Text color={field === 1 ? THEMES[state.theme].accent : THEMES[state.theme].text}>{values[1]}</Text></Box>
    <Text color={THEMES[state.theme].muted}>Last task: {state.taskUsage.input + state.taskUsage.output} tokens · {state.taskUsage.costKnown ? `$${state.taskUsage.cost.toFixed(5)}` : 'cost unknown'}</Text>
    <Text color={THEMES[state.theme].muted}>Context now: ~{state.contextTokens.toLocaleString('en-US')} / {state.contextLimit.toLocaleString('en-US')}</Text>
    {error && <Text color={THEMES[state.theme].error}>{error}</Text>}
  </Frame>;
}

export function AttachmentPanel(props: Props): React.JSX.Element {
  const { controller, state, close, readClipboardImage = readWindowsClipboardImage } = props;
  const [selected, setSelected] = useState(0), [addingPath, setAddingPath] = useState(false), [filename, setFilename] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useInput((input, key) => {
    if (key.eventType === 'release' || busy) return;
    if (key.escape) { if (addingPath) setAddingPath(false); else close(); return; }
    if (addingPath) {
      if (key.return && filename.trim()) {
        if (!controller.addImagePath) { setError('File attachment is unavailable.'); return; }
        setBusy(true); void controller.addImagePath(filename.trim()).then(() => { setFilename(''); setAddingPath(false); }).catch(cause => setError(sanitizeTerminalText(cause instanceof Error ? cause.message : String(cause)))).finally(() => setBusy(false)); return;
      }
      if (key.backspace || key.delete) { setFilename(value => Array.from(value).slice(0, -1).join('')); return; }
      if (key.ctrl && input.toLowerCase() === 'u') { setFilename(''); return; }
      if (!key.ctrl && !key.meta && input) setFilename(value => value + sanitizeTerminalText(input).replace(/[\r\n]/g, ''));
      return;
    }
    if (key.upArrow || key.downArrow) { setSelected(value => Math.max(0, Math.min(state.attachments.length - 1, value + (key.upArrow ? -1 : 1)))); return; }
    if (key.delete || (!key.ctrl && !key.meta && input.toLowerCase() === 'x')) {
      controller.removeImage?.(selected);
      setSelected(value => Math.max(0, Math.min(value, state.attachments.length - 2)));
    }
    else if (!key.ctrl && !key.meta && input.toLowerCase() === 'a') { setAddingPath(true); setFilename(''); setError(''); }
    else if (!key.ctrl && !key.meta && input.toLowerCase() === 'c') controller.clearImages?.();
    else if ((key.ctrl && input.toLowerCase() === 'v') || (!key.ctrl && !key.meta && input.toLowerCase() === 'p')) {
      setBusy(true); setError(''); void readClipboardImage().then(data => Promise.resolve(controller.addImageData?.(data))).catch(cause => setError(sanitizeTerminalText(cause instanceof Error ? cause.message : String(cause)))).finally(() => setBusy(false));
    }
  });
  return <Frame {...props} title="ATTACHMENTS" hint={addingPath ? 'Paste or type a full path · Enter add · Esc back' : 'A add file · Ctrl+V / P paste clipboard image · X remove · C clear'}>
    {addingPath ? <Box marginY={1}><Text color={THEMES[state.theme].accent}>File: </Text><Text color={THEMES[state.theme].text}>{filename}<Text inverse> </Text></Text></Box> : <Box flexDirection="column" marginY={1}>
      {state.attachments.map((attachment, index) => <Text key={`${attachment.name}-${index}`} color={index === selected ? THEMES[state.theme].accent : THEMES[state.theme].text}>{index === selected ? '› ' : '  '}{attachment.name} · {attachment.mediaType.replace('image/', '').toUpperCase()} · {(attachment.bytes / 1024).toFixed(0)} KB</Text>)}
      {!state.attachments.length && <Text color={THEMES[state.theme].muted}>No images attached. Choose a file or paste an image from the clipboard.</Text>}
    </Box>}
    <Text color={state.vision === false ? THEMES[state.theme].error : state.vision === true ? THEMES[state.theme].accent : THEMES[state.theme].muted}>Model {sanitizeTerminalText(state.model || 'none selected')}: {state.vision === true ? 'supports images' : state.vision === false ? 'does not support images' : 'image support unknown'}</Text>
    {busy && <Text color={THEMES[state.theme].muted}>Loading image…</Text>}
    {error && <Text color={THEMES[state.theme].error} wrap="truncate-end">{error}</Text>}
  </Frame>;
}
