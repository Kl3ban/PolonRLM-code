import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, measureElement, useInput, usePaste, type DOMElement } from 'ink';
import type { EventEmitter } from 'node:events';
import type { ProviderConfig, UIController, UIState } from '../core/types.js';
import { THEMES } from './design.js';
import { sanitizePastedText, sanitizeTerminalText } from './markdown.js';
import type { TerminalMouseEvent } from './input-router.js';
import { copyToClipboard, readClipboardText } from './clipboard.js';
import { AgentPanel, AttachmentPanel, BudgetPanel, MessageCopyPanel, SessionPanel } from './panels.js';
import { PROVIDER_NAMES as CATALOG_NAMES } from '../providers/provider.js';
import { SettingsPanel } from './settings.js';

export type MenuKind = 'commands' | 'models' | 'providers' | 'configure' | 'key' | 'manual' | 'sessions' | 'messages' | 'agents' | 'budget' | 'attachments' | 'settings';
interface Item { id: string; label: string; detail?: string }
interface EndpointDraft { id: string; baseURL: string; model: string; apiKey: string }

const COMMANDS: Item[] = [
  { id: '/goal', label: 'Goal and progress', detail: '/goal --tokens N <goal>' },
  { id: '/grill-me', label: 'Project interview', detail: '/grill-me <task>' },
  { id: '/plan', label: 'Plan a task', detail: '/plan <description>' },
  { id: '/review', label: 'Review code', detail: '/review <description>' },
  { id: '/retry', label: 'Retry last task', detail: '/retry' },
  { id: 'models', label: 'Select model', detail: 'Alt+L' },
  { id: 'providers', label: 'API providers', detail: '/connect' },
  { id: 'key', label: 'Save API key', detail: '/key' },
  { id: 'manual', label: 'Enter a model manually', detail: 'Exact model ID' },
  { id: 'attachments', label: 'Attachments', detail: 'Alt+I · files and images' },
  { id: '/tools', label: 'AI tools', detail: '/tools filter' },
  { id: 'mode', label: 'Change mode', detail: 'Tab' },
  { id: '/new', label: 'New conversation', detail: '/new' },
  { id: 'sessions', label: 'Conversation history', detail: 'Alt+S · search / resume' },
  { id: 'messages', label: 'Copy message', detail: '/copy · user and assistant' },
  { id: '/export', label: 'Export conversation', detail: '/export file.md' },
  { id: 'agents', label: 'Subagents', detail: 'Alt+A · status and stop' },
  { id: 'budget', label: 'Task budget', detail: 'Alt+B · tokens and cost' },
  { id: '/skills', label: 'Skills', detail: '/skills' },
  { id: '/mcp', label: 'MCP integrations', detail: '/mcp' },
  { id: '/cortex', label: 'Cortex level', detail: '/cortex' },
  { id: '/permissions', label: 'Tool permissions', detail: 'ask · auto · off · default · /permissions all' },
  { id: 'settings', label: 'Settings', detail: '/settings · Alt+U' },
  { id: '/cost', label: 'Tokens and cost', detail: '/cost' },
  { id: '/compact', label: 'Compact context', detail: '/compact' },
  { id: '/help', label: 'Help and commands', detail: '/help' },
  { id: '/exit', label: 'Exit PolonRLM', detail: '/exit' },
];
const PROVIDER_NAMES: Record<string, string> = {
  ...CATALOG_NAMES,
  openrouter: 'OpenRouter', openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google Gemini',
  ollama: 'Ollama', lmstudio: 'LM Studio', vllm: 'vLLM', nvidia: 'NVIDIA NIM',
  groq: 'Groq', deepseek: 'DeepSeek', mistral: 'Mistral', custom: 'Custom endpoint',
};
const FIELDS = [
  { key: 'id', label: 'Name', secret: false },
  { key: 'baseURL', label: 'Base URL', secret: false },
  { key: 'model', label: 'Model (can be selected later)', secret: false },
  { key: 'apiKey', label: 'API key (optional)', secret: true },
] as const;
type FieldName = typeof FIELDS[number]['key'];

export function CommandMenu({ initial, controller, state, width, rows, mouseEvents, close, readClipboard = readClipboardText }: {
  initial: MenuKind; controller: UIController; state: UIState; width: number; rows: number;
  mouseEvents?: EventEmitter; close: () => void; readClipboard?: () => Promise<string>;
}): React.JSX.Element {
  const [kind, setKind] = useState(initial), [query, setQuery] = useState(''), [selected, setSelected] = useState(0);
  const [items, setItems] = useState<Item[]>(() => initial === 'commands' ? COMMANDS : initial === 'providers' ? providerItems(controller) : []);
  const [loading, setLoading] = useState(initial === 'models'), [error, setError] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  const [revision, reload] = useState(0);
  const returnToModels = useRef(initial === 'models');
  const [searchFocused, setSearchFocused] = useState(true), [fieldFocused, setFieldFocused] = useState(true);
  const [endpoint, setEndpoint] = useState<EndpointDraft>({ id: 'custom', baseURL: '', model: '', apiKey: '' });
  const [fieldIndex, setFieldIndex] = useState(0), [fieldCursor, setFieldCursor] = useState(6);
  const endpointRef = useRef(endpoint);
  const fieldIndexRef = useRef(0), fieldCursorRef = useRef(6);
  const searchFocusRef = useRef(true), fieldFocusRef = useRef(true);
  const selecting = useRef(false);
  const searchRef = useRef<DOMElement | null>(null);
  const pasteRef = useRef<DOMElement | null>(null);
  const activeKind = useRef(kind);
  activeKind.current = kind;
  const [pasting, setPasting] = useState(false);
  const rowRefs = useRef(new Map<string, DOMElement>());
  const fieldRefs = useRef(new Map<FieldName, DOMElement>());
  const colors = THEMES[state.theme];
  const focusSearch = (focused: boolean) => { searchFocusRef.current = focused; setSearchFocused(focused); };
  const focusField = (focused: boolean) => { fieldFocusRef.current = focused; setFieldFocused(focused); };

  useEffect(() => {
    let active = true;
    setQuery(''); setSelected(0); setError(''); setLoading(kind === 'models'); focusSearch(true); focusField(true);
    if (kind === 'commands') setItems(COMMANDS);
    else if (kind === 'providers') setItems(providerItems(controller));
    else if (['configure', 'key', 'manual', 'sessions', 'messages', 'agents', 'budget', 'attachments', 'settings'].includes(kind)) { setItems([]); setLoading(false); }
    else {
      setItems([]);
      void (async () => {
        try {
          if (!controller.listModels) { close(); await controller.submit('/models'); return; }
          const models = await controller.listModels();
          if (active) setItems(models.map(model => ({ id: model.id, label: model.id, detail: [
            model.contextWindow ? `${model.contextWindow.toLocaleString('en-US')} context` : '',
            model.maxOutputTokens ? `${model.maxOutputTokens.toLocaleString('en-US')} output` : '',
            model.toolCalling === false ? 'no tools' : '', model.reasoning === false ? 'no reasoning' : '', model.vision === false ? 'no image support' : '',
          ].filter(Boolean).join(' · ') || undefined })));
        } catch (cause) { if (active) setError(sanitizeTerminalText(cause instanceof Error ? cause.message : String(cause))); }
        finally { if (active) setLoading(false); }
      })();
    }
    return () => { active = false; };
  }, [kind, controller, revision, state.provider]);

  const catalog = useMemo(() => kind === 'models' ? [...items, { id: '__manual__', label: 'Enter a model ID', detail: 'Without fetching a model list' }, { id: '__key__', label: 'Add or change API key', detail: state.provider }, { id: '__provider__', label: 'Change provider', detail: 'Google, NVIDIA, or a custom endpoint' }, { id: '__reload__', label: 'Fetch the list again' }] : items, [kind, items, state.provider]);
  const filtered = useMemo(() => catalog.filter(item => (kind === 'models' && item.id.startsWith('__')) || `${item.id} ${item.label} ${item.detail ?? ''}`.toLocaleLowerCase('pl').includes(query.toLocaleLowerCase('pl'))), [catalog, query, kind]);
  const count = Math.max(1, Math.min(9, rows - 12));
  const chosen = Math.min(selected, Math.max(0, filtered.length - 1));
  const start = Math.max(0, chosen - count + 1);
  const visibleItems = filtered.slice(start, start + count);

  const beginEndpoint = (providerId: string, initialURL = '', initialModel = '') => {
    const value = { id: providerId, baseURL: initialURL, model: initialModel, apiKey: '' };
    endpointRef.current = value; setEndpoint(value);
    fieldIndexRef.current = 0; setFieldIndex(0);
    fieldCursorRef.current = Array.from(providerId).length; setFieldCursor(fieldCursorRef.current);
    focusField(true);
    setKind('configure'); setError('');
  };

  const selectField = (nextIndex: number) => {
    const index = (nextIndex + FIELDS.length) % FIELDS.length;
    fieldIndexRef.current = index; setFieldIndex(index);
    focusField(true);
    const position = Array.from(endpointRef.current[FIELDS[index]!.key]).length;
    fieldCursorRef.current = position; setFieldCursor(position);
  };
  const setFieldText = (text: string) => {
    const name = FIELDS[fieldIndexRef.current]!.key;
    const next = { ...endpointRef.current, [name]: text };
    endpointRef.current = next; setEndpoint(next);
    fieldCursorRef.current = Array.from(text).length; setFieldCursor(fieldCursorRef.current);
  };
  const insertFieldText = (text: string) => {
    if (!text) return;
    const name = FIELDS[fieldIndexRef.current]!.key;
    const position = fieldCursorRef.current;
    const current = endpointRef.current;
    const chars = Array.from(current[name]);
    const inserted = Array.from(text);
    chars.splice(position, 0, ...inserted);
    const next = { ...current, [name]: chars.join('') };
    endpointRef.current = next; setEndpoint(next);
    fieldCursorRef.current = position + inserted.length; setFieldCursor(fieldCursorRef.current);
  };

  const saveEndpoint = async () => {
    if (selecting.current) return;
    selecting.current = true;
    try {
      const draft = endpointRef.current;
      const id = draft.id.trim();
      if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id)) throw new Error('Name: 1 to 40 characters, using only letters, numbers, hyphens, and underscores.');
      let url: URL;
      try { url = new URL(draft.baseURL.trim()); } catch { throw new Error('Enter a valid Base URL, for example https://host.example/v1.'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Base URL must use HTTP(S) and cannot contain a username, password, query parameters, or fragment.');
      if (!controller.configureProvider) throw new Error('Custom endpoint setup is not available in this controller.');
      const provider: ProviderConfig = { id, kind: 'compatible', baseURL: url.toString().replace(/\/+$/, ''), model: draft.model.trim() };
      await controller.configureProvider(provider, draft.apiKey || undefined);
      if (returnToModels.current) setKind('models'); else close();
    } catch (cause) { setError(sanitizeTerminalText(cause instanceof Error ? cause.message : String(cause))); }
    finally { selecting.current = false; }
  };

  const changeField = (text: string) => {
    const field = FIELDS[fieldIndex]!.key;
    setEndpoint(value => ({ ...value, [field]: text }));
    setFieldCursor(Array.from(text).length);
  };
  const appendPaste = useCallback((text: string) => {
    if (kind === 'configure' ? !fieldFocusRef.current : !searchFocusRef.current) return;
    const safe = sanitizePastedText(text).replace(/\n/g, ' ');
    if (kind === 'configure') insertFieldText(safe);
    else setQuery(value => value + safe);
    setSelected(0);
  }, [kind, fieldFocused, searchFocused]);
  usePaste(appendPaste, { isActive: !loading });
  const pasteFromClipboard = async () => {
    if (pasting) return;
    const destination = kind;
    setPasting(true); setError('');
    try {
      const text = await readClipboard();
      if (activeKind.current !== destination) return;
      if (!text) { setError('Clipboard does not contain text. Copy the key and try again.'); return; }
      if (kind === 'configure') focusField(true); else focusSearch(true);
      appendPaste(text);
    } catch (cause) { setError(sanitizeTerminalText(cause instanceof Error ? cause.message : String(cause))); }
    finally { setPasting(false); }
  };

  useEffect(() => {
    if (!copyStatus) return;
    const timer = setTimeout(() => setCopyStatus(''), 1400);
    return () => clearTimeout(timer);
  }, [copyStatus]);

  const choose = async (item: Item) => {
    if (selecting.current) return;
    selecting.current = true;
    try {
      if (kind === 'commands' && ['models', 'providers', 'key', 'manual', 'sessions', 'messages', 'agents', 'budget', 'attachments', 'settings'].includes(item.id)) { setKind(item.id as MenuKind); return; }
      if (kind === 'models' && item.id === '__manual__') { setKind('manual'); return; }
      if (kind === 'models' && item.id === '__key__') { setKind('key'); return; }
      if (kind === 'models' && item.id === '__provider__') { returnToModels.current = true; setKind('providers'); return; }
      if (kind === 'models' && item.id === '__reload__') { reload(value => value + 1); return; }
      if (kind === 'models') { if (controller.setModel) await controller.setModel(item.id, true); else await controller.submit(`/model ${item.id}`); }
      else if (kind === 'providers' && item.id === '__new_endpoint__') { beginEndpoint('my-endpoint'); return; }
      else if (kind === 'providers' && item.id === 'custom') {
        const existing = controller.listProviders?.().find(provider => provider.id === 'custom');
        beginEndpoint('custom', existing?.url, existing?.model); return;
      }
      else if (kind === 'providers') { if (controller.selectProvider) await controller.selectProvider(item.id); else await controller.submit(`/connect ${item.id}`); returnToModels.current = true; setKind('key'); return; }
      else if (item.id === 'mode') controller.cycleMode();
      else await controller.submit(item.id);
      close();
    } catch (cause) { setError(sanitizeTerminalText(cause instanceof Error ? cause.message : String(cause))); }
    finally { selecting.current = false; }
  };

  useEffect(() => {
    if (!mouseEvents) return;
    const onMouse = (event: TerminalMouseEvent) => {
      if (event.action === 'down' && event.button === 2 && ['key', 'manual', 'configure'].includes(kind)) {
        if (kind === 'configure') {
          for (const [index, field] of FIELDS.entries()) {
            const element = fieldRefs.current.get(field.key); if (!element) continue;
            const bounds = measureElement(element);
            if (event.x >= bounds.x && event.x < bounds.x + bounds.width && event.y === bounds.y) selectField(index);
          }
        }
        void pasteFromClipboard(); return;
      }
      if (event.action === 'down' && event.button === 0 && pasteRef.current) {
        const bounds = measureElement(pasteRef.current);
        if (event.x >= bounds.x && event.x < bounds.x + bounds.width && event.y >= bounds.y && event.y < bounds.y + bounds.height) { void pasteFromClipboard(); return; }
      }
      if (event.action !== 'down' || event.button !== 0) {
        if (event.action === 'wheel' && kind !== 'configure') setSelected(value => Math.max(0, Math.min(filtered.length - 1, value + (event.button === 0 ? -1 : 1))));
        return;
      }
      if (kind === 'configure') {
        let hitField = false;
        for (const [index, field] of FIELDS.entries()) {
          const element = fieldRefs.current.get(field.key);
          if (!element) continue;
          const bounds = measureElement(element);
          if (event.x >= bounds.x && event.x < bounds.x + bounds.width && event.y >= bounds.y && event.y < bounds.y + bounds.height) {
            hitField = true;
            focusField(true);
            fieldIndexRef.current = index; setFieldIndex(index);
            const text = endpointRef.current[field.key];
            const fieldStart = bounds.x + 33;
            const position = Math.max(0, Math.min(Array.from(text).length, event.x - fieldStart));
            fieldCursorRef.current = position; setFieldCursor(position);
            return;
          }
        }
        if (!hitField) focusField(false);
        return;
      }
      const search = searchRef.current;
      if (search) {
        const bounds = measureElement(search);
        if (event.x >= bounds.x && event.x < bounds.x + bounds.width && event.y >= bounds.y && event.y < bounds.y + bounds.height) {
          focusSearch(true);
          return;
        }
      }
      for (const [index, item] of visibleItems.entries()) {
        const element = rowRefs.current.get(item.id);
        if (!element) continue;
        const bounds = measureElement(element);
        if (event.x >= bounds.x && event.x < bounds.x + bounds.width && event.y >= bounds.y && event.y < bounds.y + bounds.height) {
          focusSearch(false);
          const next = start + index;
          setSelected(next);
          void choose(item);
          return;
        }
      }
      focusSearch(false);
    };
    mouseEvents.on('mouse', onMouse);
    return () => { mouseEvents.off('mouse', onMouse); };
  }, [mouseEvents, kind, visibleItems, start, filtered.length, choose]);

  useInput((input, key) => {
    if (key.eventType === 'release') return;
    if (['sessions', 'messages', 'agents', 'budget', 'attachments', 'settings'].includes(kind)) return;
    if (key.meta && ['m', 'd', 'l'].includes(input.toLowerCase())) { setQuery(''); setKind(input.toLowerCase() === 'm' ? 'commands' : input.toLowerCase() === 'd' ? 'providers' : 'models'); return; }
    if (kind === 'models' && key.ctrl) {
      if (input === 'n') { setKind('manual'); return; }
      if (input === 'l') { setKind('key'); return; }
      if (input === 'a') { returnToModels.current = true; setKind('providers'); return; }
      if (input === 'r') { reload(value => value + 1); return; }
    }
    if (kind === 'key' || kind === 'manual') {
      if (kind === 'key' && key.tab) { setQuery(''); setKind('models'); return; }
      if (key.escape) { setQuery(''); setKind('models'); return; }
      if (key.ctrl && input.toLowerCase() === 'v') { void pasteFromClipboard(); return; }
      if (key.return) {
        if (!query.trim() || selecting.current) return;
        selecting.current = true;
        void (async () => {
          try {
            if (kind === 'key') {
              if (!controller.setApiKey) throw new Error('Controller does not support saving API keys.');
              await controller.setApiKey(query.trim()); setQuery(''); setKind('models');
            } else { if (controller.setModel) await controller.setModel(query.trim(), true); else await controller.submit('/model ' + query.trim()); close(); }
          } catch (cause) { setError(sanitizeTerminalText(cause instanceof Error ? cause.message : String(cause))); }
          finally { selecting.current = false; }
        })(); return;
      }
      if (key.backspace || key.delete) { setQuery(value => Array.from(value).slice(0, -1).join('')); return; }
      if (key.ctrl && input === 'u') { setQuery(''); return; }
      if (!key.ctrl && !key.meta && input) setQuery(value => value + sanitizeTerminalText(input).replace(/[\r\n]/g, ''));
      return;
    }
    if (key.ctrl && input.toLowerCase() === 'y') {
      if (kind === 'configure' && FIELDS[fieldIndexRef.current]!.secret) return;
      const value = kind === 'configure' ? endpointRef.current[FIELDS[fieldIndexRef.current]!.key]
        : filtered[chosen] ? `${filtered[chosen]!.label}${filtered[chosen]!.detail ? ` · ${filtered[chosen]!.detail}` : ''}` : query;
      if (value) void copyToClipboard(value).then(() => setCopyStatus('Copied')).catch(cause => setError(sanitizeTerminalText(cause instanceof Error ? cause.message : String(cause))));
      return;
    }
    if (key.ctrl && input.toLowerCase() === 'v') {
      void pasteFromClipboard();
      return;
    }
  if (kind === 'configure') {
      if (key.escape) { setKind('providers'); return; }
      if (key.tab || key.return) {
        if (!fieldFocusRef.current) { focusField(true); return; }
        const current = fieldIndexRef.current;
        if (current < FIELDS.length - 1) selectField(current + 1);
        else if (key.return) void saveEndpoint();
        else selectField(0);
        return;
      }
      if (!fieldFocusRef.current) return;
      const name = FIELDS[fieldIndexRef.current]!.key;
      if (key.leftArrow) { fieldCursorRef.current = Math.max(0, fieldCursorRef.current - 1); setFieldCursor(fieldCursorRef.current); return; }
      if (key.rightArrow) { fieldCursorRef.current = Math.min(Array.from(endpointRef.current[name]).length, fieldCursorRef.current + 1); setFieldCursor(fieldCursorRef.current); return; }
      if (key.home || (key.ctrl && input === 'a')) { fieldCursorRef.current = 0; setFieldCursor(0); return; }
      if (key.end || (key.ctrl && input === 'e')) { fieldCursorRef.current = Array.from(endpointRef.current[name]).length; setFieldCursor(fieldCursorRef.current); return; }
      if (key.ctrl && input === 'u') { setFieldText(''); return; }
      if (key.backspace || key.delete) {
        const chars = Array.from(endpointRef.current[name]);
        const index = key.backspace ? fieldCursorRef.current - 1 : fieldCursorRef.current;
        if (index >= 0 && index < chars.length) {
          chars.splice(index, 1);
          const next = { ...endpointRef.current, [name]: chars.join('') };
          endpointRef.current = next; setEndpoint(next);
          if (key.backspace) { fieldCursorRef.current = index; setFieldCursor(index); }
        }
        return;
      }
      if (key.ctrl || key.meta || !input) return;
      const safe = sanitizeTerminalText(input).replace(/[\r\n]/g, '');
      insertFieldText(safe);
      return;
    }
    if (key.escape || (key.ctrl && !key.shift && ['c', 'p'].includes(input))) { close(); return; }
    if (key.tab) { focusSearch(true); return; }
    if (key.upArrow || key.downArrow) { setSelected(Math.max(0, Math.min(filtered.length - 1, chosen + (key.upArrow ? -1 : 1)))); return; }
    if (key.return) { if (filtered[chosen]) void choose(filtered[chosen]!); return; }
    if (!searchFocusRef.current) return;
    if (key.backspace || key.delete) { setQuery(value => Array.from(value).slice(0, -1).join('')); setSelected(0); return; }
    if (!key.ctrl && !key.meta && input) { setQuery(value => value + sanitizeTerminalText(input).replace(/[\r\n]/g, '')); setSelected(0); }
  });

  if (kind === 'settings') return <SettingsPanel controller={controller} state={state} width={width} rows={rows} close={close} mouseEvents={mouseEvents} />;
  if (kind === 'sessions') return <SessionPanel controller={controller} state={state} width={width} rows={rows} close={close} />;
  if (kind === 'messages') return <MessageCopyPanel controller={controller} state={state} width={width} rows={rows} close={close} />;
  if (kind === 'agents') return <AgentPanel controller={controller} state={state} width={width} rows={rows} close={close} />;
  if (kind === 'budget') return <BudgetPanel controller={controller} state={state} width={width} rows={rows} close={close} />;
  if (kind === 'attachments') return <AttachmentPanel controller={controller} state={state} width={width} rows={rows} close={close} mouseEvents={mouseEvents} />;
  if (kind === 'key' || kind === 'manual') return <Box width={width} flexDirection="column" padding={2} backgroundColor={colors.panel} borderStyle="round" borderColor={colors.border}>
    <Text color={colors.accent} bold>{kind === 'key' ? 'CONNECT / API KEY' : 'MODEL / CUSTOM ID'}</Text>
    <Text color={colors.muted}>{sanitizeTerminalText(state.provider)} · {kind === 'key' ? 'Paste the key. It will be encrypted locally.' : 'Enter a model ID from the provider documentation.'}</Text>
    <Box ref={searchRef} marginY={1} height={1}><Text color={colors.text} wrap="truncate-end">{query ? kind === 'key' ? '•'.repeat(Array.from(query).length) : query : <Text color={colors.muted}>{kind === 'key' ? 'Paste API key…' : 'Model ID…'}</Text>}<Text inverse> </Text></Text></Box>
    <Box ref={pasteRef} paddingX={1} alignSelf="flex-start" backgroundColor={colors.selected}><Text color={colors.text}>{pasting ? 'Pasting…' : 'Paste from clipboard'}</Text></Box>
    {error && <Text color={colors.error}>{error}</Text>}
    <Text color={colors.muted}>Enter save   {kind === 'key' ? 'Tab skip   ' : ''}Esc back   Ctrl+V paste</Text>
  </Box>;
  if (kind === 'configure') return <Box width={width} flexDirection="column" padding={2} backgroundColor={colors.panel} borderStyle="round" borderColor={colors.border}>
    <Text color={colors.accent} bold>CONNECT / CUSTOM ENDPOINT</Text>
    {FIELDS.map((field, index) => <Box key={field.key} ref={node => { if (node) fieldRefs.current.set(field.key, node); }} height={1} paddingX={1} backgroundColor={index === fieldIndex ? colors.selected : colors.panel}>
      <Text color={colors.muted}>{field.label.padEnd(31).slice(0, 31)} </Text>
      <Text color={colors.text}>{(() => { const chars = Array.from(field.secret ? '•'.repeat(Array.from(endpoint[field.key]).length) : sanitizeTerminalText(endpoint[field.key])); return index === fieldIndex && fieldFocused ? <>{chars.slice(0, fieldCursor).join('')}<Text inverse>{chars[fieldCursor] || ' '}</Text>{chars.slice(fieldCursor + 1).join('')}</> : chars.join(''); })()}</Text>
    </Box>)}
    {error && <Text color={colors.error}>{error}</Text>}
    <Text color={colors.muted}>Tab next field   Enter next/save   Esc back</Text>
    <Box ref={pasteRef} paddingX={1} alignSelf="flex-start" backgroundColor={colors.selected}><Text color={colors.text}>{pasting ? 'Pasting…' : 'Paste from clipboard'}</Text></Box>
  </Box>;
  return <Box width={width} flexDirection="column" paddingX={2} paddingY={1} backgroundColor={colors.panel}>
    <Text color={colors.text} bold>{kind === 'commands' ? 'Commands / PolonRLM' : kind === 'providers' ? 'API providers' : 'Models / ENGINE'}</Text>
    <Text color={colors.muted}>{kind === 'models' ? 'Provider: ' + sanitizeTerminalText(state.provider) + ' · Model: ' + sanitizeTerminalText(state.model || 'none') : kind === 'providers' ? '01 provider  →  02 key  →  03 model' : 'Search commands or choose one from the list.'}</Text>
    <Box ref={searchRef} marginY={1}><Text color={colors.accent}>/ </Text><Text color={colors.text}>{query || <Text color={colors.muted}>Search…</Text>}{searchFocused && <Text inverse> </Text>}</Text></Box>
    {loading && <Text color={colors.muted}>Loading model catalog…</Text>}
    {error && <Text color={colors.warm} wrap="truncate-end">{error}</Text>}
    {visibleItems.map((item, index) => <Box key={item.id} ref={node => { if (node) rowRefs.current.set(item.id, node); else rowRefs.current.delete(item.id); }} height={1} backgroundColor={chosen === start + index ? colors.selected : colors.panel}>
      <Text color={chosen === start + index ? colors.accent : colors.faint}>{chosen === start + index ? ' › ' : '   '}</Text>
      <Text color={chosen === start + index ? colors.text : colors.muted} wrap="truncate-end">{sanitizeTerminalText(item.label)}{item.detail && width >= 65 ? '    ' + sanitizeTerminalText(item.detail) : ''}</Text>
    </Box>)}
    {!filtered.length && !loading && <Text color={colors.muted}>No results. Clear the filter or press Esc to go back.</Text>}
    <Box marginTop={1} flexDirection="column">
      <Text color={colors.muted}>↑ ↓ select   Enter open   Esc close{filtered.length ? '   ' + (chosen + 1) + '/' + filtered.length : ''}</Text>
      {kind === 'models' && <Text color={colors.accent}>Ctrl+N enter a model   Ctrl+L API key   Ctrl+A provider   Ctrl+R refresh</Text>}
      {copyStatus && <Text color={colors.accent}>{copyStatus}</Text>}
    </Box>
  </Box>;
}

function providerItems(controller: UIController): Item[] {
  const providers = controller.listProviders?.() ?? [];
  return [
    ...providers.sort((a, b) => { const primary = ['openai', 'anthropic', 'google', 'nvidia', 'mistral', 'openrouter', 'groq', 'deepseek', 'custom']; const rank = (id: string) => primary.includes(id) ? primary.indexOf(id) : 100; return rank(a.id) - rank(b.id) || (PROVIDER_NAMES[a.id] ?? a.id).localeCompare(PROVIDER_NAMES[b.id] ?? b.id); }).map(provider => ({ id: provider.id, label: PROVIDER_NAMES[provider.id] ?? provider.id, detail: provider.model || '' })),
    { id: '__new_endpoint__', label: 'Add a custom endpoint…', detail: 'OpenAI compatible' },
  ];
}
