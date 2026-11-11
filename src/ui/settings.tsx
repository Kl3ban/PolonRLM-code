import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, measureElement, useInput, usePaste, type DOMElement } from 'ink';
import type { EventEmitter } from 'node:events';
import type { UIController, UIState } from '../core/types.js';
import { SETTINGS_FIELDS, type SettingField } from '../core/settings-fields.js';
import { formatTokenBudget, parseTokenBudget, parseUnlimitedLimit } from '../core/budget.js';
import { THEMES } from './design.js';
import { sanitizeTerminalText } from './markdown.js';
import { readClipboardText } from './clipboard.js';
import type { TerminalMouseEvent } from './input-router.js';

const sections = ['General', 'Limits', 'Tools'];
const policies = [{ value: 'default', label: 'Inherit' }, { value: 'ask', label: 'Ask' }, { value: 'auto', label: 'Auto' }, { value: 'off', label: 'Off' }];
const JSON_SETTINGS = new Set(['verificationCommands', 'sandboxNetworkDomains', 'fallback', 'agentToolProfiles', 'modelRoutes', 'modelRoleBudgets']);
type Row = SettingField & { value: string | number };

export function SettingsPanel({ controller, state, width, rows, close, mouseEvents }: { controller: UIController; state: UIState; width: number; rows: number; close: () => void; mouseEvents?: EventEmitter }): React.JSX.Element {
  const colors = THEMES[state.theme];
  const [section, setSection] = useState(0), [selected, setSelected] = useState(0), [query, setQuery] = useState('');
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(''), [notice, setNotice] = useState(''), [error, setError] = useState(''), [revision, refresh] = useState(0);
  const saving = useRef(false), editingRef = useRef(false);
  const rowRefs = useRef(new Map<number, DOMElement>());
  const snapshot = useMemo(() => controller.readSettings?.() ?? { values: { mode: state.mode, cortex: state.cortex, theme: state.theme, tokenBudget: state.tokenLimit, dollarBudget: state.dollarLimit }, tools: [] }, [controller, state, revision]);
  const entries: Row[] = section === 2 ? snapshot.tools.filter(tool => `${tool.name} ${tool.description}`.toLowerCase().includes(query.toLowerCase())).map(tool => ({ key: `tool.${tool.name}`, label: tool.name, section: 'general', value: tool.policy, options: policies, help: `${tool.available ? 'Available' : 'Blocked in the current mode'}. ${tool.description}` }))
    : SETTINGS_FIELDS.filter(field => field.section === (section === 0 ? 'general' : 'limits')).map(field => ({ ...field, value: snapshot.values[field.key] ?? '' }));
  const index = Math.min(selected, Math.max(0, entries.length - 1));
  const active = entries[index];
  const count = Math.max(1, Math.min(10, rows - 12)), start = Math.max(0, index - count + 1);
  const isUnlimited = (row: Row) => row.section === 'limits' && Number(row.value) === (row.key === 'maxDepth' ? -1 : 0);
  const valueLabel = (row: Row) => isUnlimited(row) ? 'Unlimited ∞' : row.options?.find(option => option.value === row.value)?.label ?? `${typeof row.value === 'number' ? row.value.toLocaleString('en-US') : row.value}${row.unit ? ` ${row.unit}` : ''}`;
  const save = async (row: Row, value: string | number) => {
    if (saving.current) return;
    if (state.busy) { setError('Stop the task before changing settings.'); return; }
    saving.current = true; setError(''); setNotice('Saving…');
    try {
      if (!controller.updateSetting) throw new Error('Settings editing is unavailable.');
      const parsed = row.options ? value : JSON_SETTINGS.has(row.key) ? value : row.key === 'tokenBudget' ? parseTokenBudget(value) : row.section === 'limits' ? parseUnlimitedLimit(value, row.key === 'maxDepth' ? -1 : 0) : Number(value);
      if (typeof parsed === 'number' && !Number.isFinite(parsed)) throw new Error('Enter a valid number.');
      await controller.updateSetting(row.key, parsed); saving.current = false; editingRef.current = false; refresh(value => value + 1); setEditing(false); setNotice('Saved');
    } catch (cause) { saving.current = false; setNotice(''); setError(sanitizeTerminalText(cause instanceof Error ? cause.message : String(cause))); }
    finally { saving.current = false; }
  };
  const cycle = (row: Row, direction: number) => {
    if (!row.options) return;
    const current = row.options.findIndex(option => option.value === row.value);
    const next = row.options[(Math.max(0, current) + direction + row.options.length) % row.options.length]!;
    void save(row, next.value);
  };
  const activate = (row: Row) => { if (row.options) cycle(row, 1); else { editingRef.current = true; setDraft(isUnlimited(row) ? 'infinity' : String(row.value)); setEditing(true); setError(''); setNotice(''); } };
  usePaste(text => { if (editing) setDraft(value => value + sanitizeTerminalText(text).replace(/[\r\n]/g, '')); });
  useInput((input, key) => {
    if (key.eventType === 'release' || saving.current) return;
    if (key.escape) { if (editingRef.current) { editingRef.current = false; setEditing(false); } else close(); return; }
    if (editingRef.current && active) {
      if (key.return) { void save(active, draft); return; }
      if (key.ctrl && input.toLowerCase() === 'u') { setDraft(''); return; }
      if (key.ctrl && input.toLowerCase() === 'v') { void readClipboardText().then(text => setDraft(value => value + sanitizeTerminalText(text).trim())).catch(cause => setError(String(cause))); return; }
      if (key.backspace || key.delete) { setDraft(value => Array.from(value).slice(0, -1).join('')); return; }
      if (!key.ctrl && !key.meta && input) setDraft(value => value + sanitizeTerminalText(input).replace(/[\r\n]/g, ''));
      return;
    }
    if (key.tab) { setSection(value => (value + (key.shift ? 2 : 1)) % 3); setSelected(0); setError(''); setNotice(''); return; }
    if (key.upArrow || key.downArrow) { setSelected(value => Math.max(0, Math.min(entries.length - 1, value + (key.upArrow ? -1 : 1)))); setNotice(''); return; }
    if (key.pageDown || key.pageUp) { setSelected(value => Math.max(0, Math.min(entries.length - 1, value + (key.pageUp ? -count : count)))); return; }
    if (active && (key.leftArrow || key.rightArrow)) { cycle(active, key.leftArrow ? -1 : 1); return; }
    if (active && key.return) { activate(active); return; }
    if (section === 2) {
      if (key.backspace || key.delete) { setQuery(value => Array.from(value).slice(0, -1).join('')); setSelected(0); return; }
      if (key.ctrl && input.toLowerCase() === 'u') { setQuery(''); setSelected(0); return; }
      if (!key.ctrl && !key.meta && input) { setQuery(value => value + sanitizeTerminalText(input)); setSelected(0); }
    }
  });
  useEffect(() => {
    if (!mouseEvents) return;
    const onMouse = (event: TerminalMouseEvent) => {
      if (editing || saving.current) return;
      if (event.action === 'wheel') { setSelected(value => Math.max(0, Math.min(entries.length - 1, value + (event.button === 0 ? -2 : 2)))); return; }
      if (event.action !== 'down' || event.button !== 0) return;
      for (const [rowIndex, element] of rowRefs.current) {
        const b = measureElement(element);
        if (event.x >= b.x && event.x < b.x + b.width && event.y === b.y) { if (rowIndex === index && entries[rowIndex]) activate(entries[rowIndex]!); else setSelected(rowIndex); return; }
      }
    };
    mouseEvents.on('mouse', onMouse); return () => { mouseEvents.off('mouse', onMouse); };
  }, [mouseEvents, entries, index, editing]);
  return <Box width={Math.max(12, Math.min(76, width))} paddingX={2} paddingY={1} flexDirection="column" backgroundColor={colors.canvas}>
    <Box justifyContent="space-between"><Text color={colors.text} bold>SETTINGS</Text><Text color={colors.faint}>Esc to close</Text></Box>
    <Box gap={2} marginY={1}>{sections.map((name, i) => <Text key={name} color={i === section ? colors.text : colors.faint} bold={i === section}>{i === section ? '● ' : ''}{name}</Text>)}</Box>
    {section === 2 && <Text color={colors.muted}>Search: {query || 'enter a tool name…'} · {entries.length}</Text>}
    {entries.slice(start, start + count).map((row, offset) => <Box key={row.key} ref={node => { const n = start + offset; if (node) rowRefs.current.set(n, node); else rowRefs.current.delete(n); }} height={1} backgroundColor={start + offset === index ? colors.selected : colors.canvas} justifyContent="space-between">
      <Text color={start + offset === index ? colors.text : colors.muted} wrap="truncate-end">{start + offset === index ? '› ' : '  '}{row.label}</Text>
      <Text color={colors.text} wrap="truncate-end">{editing && start + offset === index ? <>{draft}<Text inverse> </Text></> : valueLabel(row)}</Text>
    </Box>)}
    {!entries.length && <Text color={colors.muted}>No matching tools.</Text>}
    <Box marginTop={1} minHeight={2}><Text color={colors.muted}>{active?.help ?? ''}</Text></Box>
    <Text color={error ? colors.error : colors.accent}>{error || notice || (state.busy ? 'Stop the task to edit settings.' : 'Changes are saved immediately.')}</Text>
    <Text color={colors.faint}>{editing ? 'Enter save · Ctrl+U clear · Esc cancel' : 'Tab section · ↑↓ select · ←→ change · Enter edit'}</Text>
  </Box>;
}
