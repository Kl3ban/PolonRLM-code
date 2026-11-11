import type React from 'react';
import type { EventEmitter } from 'node:events';
import type { DOMElement } from 'ink';
import type { ApprovalRequest, UIController } from '../core/types.js';
import type { MarkdownLine } from './markdown.js';
import type { MenuKind } from './menu.js';
import type { TerminalMouseEvent } from './input-router.js';
import type { TextSelection } from './selection.js';
import { transcriptLines, toolExpansionIds, latestToolExpansionId } from './transcript.js';
import { formatTokenBudget } from '../core/budget.js';
import { Scrollbar, scrollbarMetrics } from './scrollbar.js';
import { QuestionPanel } from './question.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, render, useApp, useInput, usePaste, useWindowSize, measureElement } from 'ink';
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import { MarkdownRow, markdownLines, sanitizePastedText, sanitizeTerminalText } from './markdown.js';
import { contentWidth, WORDMARK, MODE_LABELS, THEMES, VERSION } from './design.js';
import { CommandMenu } from './menu.js';
import { TerminalInputRouter } from './input-router.js';
import { copyToClipboard, readClipboardImage, readClipboardText } from './clipboard.js';
import { disableQuickEdit } from './windows-console.js';
import { columnAtCell, plainLine, selectedText, selectionRange } from './selection.js';
interface PendingApproval { request: ApprovalRequest; resolve: (allow: boolean) => void; signal?: AbortSignal }
interface DraftSelection { anchor: number; focus: number }
function orderedDraftRange(selection: DraftSelection): [number, number] {
    return selection.anchor <= selection.focus ? [selection.anchor, selection.focus] : [selection.focus, selection.anchor];
}
const COMMANDS = ['/goal', '/grill-me', '/plan', '/build', '/review', '/retry', '/copy', '/help', '/connect', '/models', '/model', '/effort', '/key', '/image', '/budget', '/settings', '/agents', '/steer', '/skills', '/mcp', '/mode', '/cortex', '/sessions', '/new', '/resume', '/export', '/context', '/compact', '/cost', '/status', '/permissions', '/cancel', '/undo', '/recover', '/history', '/rollback', '/memory', '/forget', '/clear', '/exit'];
const SPINNER = ['·  ', '·· ', '···', ' ··', '  ·', '   '];
function cursorAtCell(text: string, targetRow: number, targetColumn: number, width: number) {
    let row = 0, column = 0, index = 0;
    for (const character of Array.from(text)) {
        if (character === '\n') {
            if (row === targetRow)
                return index;
            row++;
            column = 0;
            index++;
            continue;
        }
        const cells = stringWidth(character);
        if (column > 0 && column + cells > width) {
            row++;
            column = 0;
        }
        if (row > targetRow)
            return index;
        if (row === targetRow && targetColumn < column + Math.ceil(cells / 2))
            return index;
        column += cells;
        index++;
    }
    return index;
}
function SelectableRow({ line, row, selection }: { line: MarkdownLine; row: number; selection?: TextSelection }) {
    const chars = Array.from(plainLine(line.text));
    const [start, end] = selection ? selectionRange(selection, row, chars.length) : [0, 0];
    if (start === end)
        return <MarkdownRow line={line}/>;
    return <Text color={line.color} bold={line.bold} wrap={"truncate-end"}>{chars.slice(0, start).join('')}<Text color={"#101010"} backgroundColor={"#d7d7d7"}>{chars.slice(start, end).join('')}</Text>{chars.slice(end).join('')}</Text>;
}
/** UI exported separately so automated tests can drive a fake controller. */
const readOptionalClipboardImage = () => readClipboardImage(true);
export function TerminalApp({ controller, mouseEvents, readClipboard = readClipboardText, readImageClipboard = readOptionalClipboardImage, writeClipboard = copyToClipboard }: { controller: UIController; mouseEvents?: EventEmitter; readClipboard?: () => Promise<string>; readImageClipboard?: () => Promise<string>; writeClipboard?: (text: string) => Promise<void> }) {
    const { exit } = useApp();
    const { columns: terminalColumns, rows: terminalRows } = useWindowSize();
    const columns = Math.max(12, terminalColumns || 80);
    const rows = Math.max(8, terminalRows || 24);
    const width = contentWidth(columns);
    const [state, setState] = useState(() => controller.snapshot());
    const [draft, setDraft] = useState('');
    const [cursor, setCursor] = useState(0);
    const [draftSelection, setDraftSelectionState] = useState<DraftSelection>();
    const draftSelectionRef = useRef<DraftSelection | undefined>(undefined);
    const composerDragging = useRef(false);
    const [history, setHistory] = useState<string[]>([]);
    const [historyIndex, setHistoryIndex] = useState(-1);
    const savedDraft = useRef('');
    const [scroll, setScroll] = useState(0);
    const [expandedTools, setExpandedTools] = useState(() => new Set<string>());
    const toolRowRefs = useRef(new Map<string, DOMElement>());
    const transcriptRef = useRef<DOMElement | null>(null);
    const scrollbarRef = useRef<DOMElement | null>(null);
    const scrollbarDrag = useRef<number | undefined>(undefined);
    const [selection, setSelection] = useState<TextSelection>();
    const selectionRef = useRef<TextSelection | undefined>(undefined);
    const dragging = useRef(false);
    const selectText = (value: TextSelection | undefined) => { selectionRef.current = value; setSelection(value); };
    const [spinner, setSpinner] = useState(0);
    const [pending, setPending] = useState<PendingApproval>();
    const pendingRef = useRef<PendingApproval | undefined>(undefined);
    const approvalQueue = useRef<PendingApproval[]>([]);
    const [approvalScroll, setApprovalScroll] = useState(0);
    const [error, setError] = useState('');
    const [copyStatus, setCopyStatus] = useState('');
    const [menu, setMenu] = useState<MenuKind>();
    const menuRef = useRef(menu);
    menuRef.current = menu;
    const [composerFocused, setComposerFocused] = useState(true);
    const composerRef = useRef<DOMElement | null>(null);
    const draftRef = useRef(draft);
    draftRef.current = draft;
    const cursorRef = useRef(cursor);
    cursorRef.current = cursor;
    const selectDraft = useCallback((value: DraftSelection | undefined) => { draftSelectionRef.current = value; setDraftSelectionState(value); }, []);
    const menuButtonRefs = useRef(new Map<MenuKind, DOMElement>());
    const composerFocusRef = useRef(true);
    const closing = useRef(false);
    const quit = useCallback(async () => {
        if (closing.current)
            return;
        closing.current = true;
        pendingRef.current?.resolve(false);
        approvalQueue.current.splice(0).forEach(item => item.resolve(false));
        pendingRef.current = undefined;
        try {
            await controller.close();
            exit();
        }
        catch (cause) {
            exit(cause instanceof Error ? cause : new Error(String(cause)));
        }
    }, [controller, exit]);
    const focusComposer = useCallback((focused: boolean) => {
        composerFocusRef.current = focused;
        setComposerFocused(focused);
    }, []);
    useEffect(() => {
        const unsubscribe = controller.subscribe(() => setState(controller.snapshot()));
        controller.setApprover((request, signal) => new Promise<boolean>(resolve => {
            let settled = false;
            const settle = (allow: boolean) => {
                if (settled)
                    return;
                settled = true;
                signal?.removeEventListener('abort', onAbort);
                resolve(allow);
            };
            const next = { request, resolve: settle, signal };
            const onAbort = () => {
                if (pendingRef.current === next) {
                    pendingRef.current = undefined;
                    let following = approvalQueue.current.shift();
                    while (following?.signal?.aborted) {
                        following.resolve(false);
                        following = approvalQueue.current.shift();
                    }
                    pendingRef.current = following;
                    setApprovalScroll(0);
                    setPending(following);
                }
                else {
                    const index = approvalQueue.current.indexOf(next);
                    if (index >= 0)
                        approvalQueue.current.splice(index, 1);
                }
                settle(false);
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            if (signal?.aborted) {
                onAbort();
                return;
            }
            if (pendingRef.current) {
                approvalQueue.current.push(next);
                return;
            }
            pendingRef.current = next;
            setApprovalScroll(0);
            setPending(next);
        }));
        return () => {
            unsubscribe();
            pendingRef.current?.resolve(false);
            approvalQueue.current.splice(0).forEach(item => item.resolve(false));
            pendingRef.current = undefined;
            controller.setApprover(async () => false);
        };
    }, [controller]);
    useEffect(() => {
        if (state.status === 'closed')
            exit();
    }, [state.status, exit]);
    useEffect(() => {
        if (!copyStatus)
            return;
        const timer = setTimeout(() => setCopyStatus(''), 1800);
        return () => clearTimeout(timer);
    }, [copyStatus]);
    useEffect(() => {
        if (!state.busy)
            return;
        const timer = setInterval(() => setSpinner(value => (value + 1) % SPINNER.length), 180);
        return () => clearInterval(timer);
    }, [state.busy]);
    const pasteIntoComposer = useCallback((text: string) => {
        if (menuRef.current || pendingRef.current || !composerFocusRef.current)
            return;
        const safe = sanitizePastedText(text);
        if (!safe)
            return;
        const parts = Array.from(draftRef.current);
        const pasted = Array.from(safe);
        const selection = draftSelectionRef.current;
        const [start, end] = selection ? orderedDraftRange(selection) : [cursorRef.current, cursorRef.current];
        const at = Math.max(0, Math.min(parts.length, start));
        parts.splice(at, Math.max(0, Math.min(parts.length, end) - at), ...pasted);
        const next = parts.join(''), nextCursor = at + pasted.length;
        draftRef.current = next;
        cursorRef.current = nextCursor;
        setDraft(next);
        setCursor(nextCursor);
        selectDraft(undefined);
        setError('');
    }, [selectDraft]);
    usePaste(pasteIntoComposer, { isActive: !menu && !pending && !state.question });
    const clipboardPending = useRef(false);
    const pasteFromClipboard = useCallback(async () => {
        if (clipboardPending.current) return;
        clipboardPending.current = true;
        try {
            const image = await readImageClipboard();
            if (menuRef.current || pendingRef.current || !composerFocusRef.current) return;
            if (image) {
                if (!controller.addImageData) throw new Error('Image attachments are unavailable.');
                controller.addImageData(image, 'Screenshot.png');
                setError('');
                setCopyStatus('Screenshot attached');
            } else {
                pasteIntoComposer(await readClipboard());
            }
        } catch (cause) {
            setError(sanitizeTerminalText(cause instanceof Error ? cause.message : String(cause)));
        } finally { clipboardPending.current = false; }
    }, [controller, readClipboard, readImageClipboard, pasteIntoComposer]);
    const editorWidth = Math.max(1, width - 7);
    const secret = /^\s*\/key(?:\s|$)/i.test(draft);
    const shownDraft = secret ? draft.replace(/^(\s*\/key\s*)([\s\S]*)$/i, (_, prefix, value) => prefix + '•'.repeat(Array.from(value).length)) : draft;
    const beforeCursor = Array.from(shownDraft).slice(0, cursor).join('');
    const atCursor = Array.from(shownDraft)[cursor] || ' ';
    const afterCursor = Array.from(shownDraft).slice(cursor + 1).join('');
    const editorLines = Math.min(5, Math.max(1, wrapAnsi(shownDraft || ' ', editorWidth, { hard: true, trim: false }).split('\n').length));
    const cursorLine = wrapAnsi(beforeCursor + ' ', editorWidth, { hard: true, trim: false }).split('\n').length - 1;
    const suggestions = draft.startsWith('/') && !/\s/.test(draft) ? COMMANDS.filter(command => command.startsWith(draft)).slice(0, 3) : [];
    const available = Math.max(1, rows - editorLines - (rows >= 16 ? 8 : 6) - (state.attachments.length ? 1 : 0) - (state.busy ? 1 : 0) - suggestions.length);
    const allLines = useMemo(() => transcriptLines(state.messages, Math.max(1, width - 2), expandedTools, state.model), [state.messages, width, expandedTools, state.model]);
    const lastStart = Math.max(0, allLines.length - available);
    const scrollStart = Math.max(0, lastStart - scroll);
    const visible = allLines.slice(scrollStart, scrollStart + available);
    const copyDraftSelection = () => {
        const current = draftSelectionRef.current;
        if (!current)
            return false;
        const [start, end] = orderedDraftRange(current);
        if (start === end)
            return false;
        const text = Array.from(shownDraft).slice(start, end).join('');
        void writeClipboard(text).then(() => setCopyStatus('Selection copied')).catch(cause => setError(String(cause)));
        return true;
    };
    const copySelection = () => {
        if (!selectionRef.current)
            return;
        const text = selectedText(allLines, selectionRef.current);
        if (text)
            void writeClipboard(text).then(() => setCopyStatus('Selection copied')).catch(cause => setError(String(cause)));
    };
    useEffect(() => { selectText(undefined); dragging.current = false; scrollbarDrag.current = undefined; }, [state.sessionId, columns]);
    useEffect(() => { setScroll(0); }, [state.sessionId]);
    const previousStart = useRef(lastStart);
    useEffect(() => { const delta = lastStart - previousStart.current; previousStart.current = lastStart; setScroll(value => value ? Math.max(0, Math.min(lastStart, value + delta)) : 0); }, [lastStart]);
    useEffect(() => {
        if (!mouseEvents)
            return;
        const onMouse = (event: TerminalMouseEvent) => {
            if (menu || pendingRef.current || state.question)
                return;
            const composerElement = composerRef.current;
            const composerBounds = composerElement ? measureElement(composerElement) : undefined;
            if (composerDragging.current && composerBounds && (event.action === 'move' || event.action === 'up')) {
                const paddingY = rows >= 16 ? 1 : 0;
                const visibleRow = Math.max(0, Math.min(editorLines - 1, event.y - composerBounds.y - paddingY));
                const firstVisibleRow = Math.max(0, cursorLine - editorLines + 1);
                const focus = Math.max(0, Math.min(Array.from(draft).length, cursorAtCell(draft, firstVisibleRow + visibleRow, Math.max(0, event.x - composerBounds.x - 4), editorWidth)));
                const current = draftSelectionRef.current;
                if (current)
                    selectDraft({ anchor: current.anchor, focus });
                setCursor(focus);
                if (event.action === 'up') {
                    composerDragging.current = false;
                    if (draftSelectionRef.current?.anchor === focus)
                        selectDraft(undefined);
                }
                return;
            }
            if (scrollbarRef.current && lastStart > 0) {
                const bounds = measureElement(scrollbarRef.current);
                const metrics = scrollbarMetrics(allLines.length, available, scrollStart);
                const inside = event.x === bounds.x && event.y >= bounds.y && event.y < bounds.y + bounds.height;
                if (event.action === 'down' && event.button === 0 && inside) {
                    const y = event.y - bounds.y;
                    scrollbarDrag.current = y >= metrics.top && y < metrics.top + metrics.size ? y - metrics.top : Math.floor(metrics.size / 2);
                }
                if (scrollbarDrag.current !== undefined && ['down', 'move', 'up'].includes(event.action)) {
                    const top = Math.max(0, Math.min(metrics.travel, event.y - bounds.y - scrollbarDrag.current));
                    const start = metrics.travel ? Math.round(top / metrics.travel * lastStart) : 0;
                    setScroll(lastStart - start);
                    if (event.action === 'up') scrollbarDrag.current = undefined;
                    return;
                }
            }
            const transcriptElement = transcriptRef.current;
            if (transcriptElement && (event.button === 0 || event.action === 'move')) {
                const bounds = measureElement(transcriptElement);
                const inside = event.x >= bounds.x && event.x < bounds.x + bounds.width && event.y >= bounds.y && event.y < bounds.y + visible.length;
                if ((event.action === 'down' && inside) || (dragging.current && (event.action === 'move' || event.action === 'up'))) {
                    const row = Math.max(0, Math.min(allLines.length - 1, scrollStart + Math.max(0, Math.min(visible.length - 1, event.y - bounds.y))));
                    const point = { row, column: columnAtCell(allLines[row]?.text ?? '', Math.max(0, event.x - bounds.x)) };
                    if (event.action === 'down') {
                        dragging.current = true;
                        composerDragging.current = false;
                        selectDraft(undefined);
                        selectText({ anchor: point, focus: point });
                        focusComposer(false);
                    }
                    else if (selectionRef.current)
                        selectText({ anchor: selectionRef.current.anchor, focus: point });
                    if (event.action === 'up') {
                        dragging.current = false;
                        const current = selectionRef.current;
                        // A click still expands tool results; only a drag selects text.
                        if (current && current.anchor.row === current.focus.row && current.anchor.column === current.focus.column) {
                            for (const [id, element] of toolRowRefs.current) {
                                const toolBounds = measureElement(element);
                                if (event.x >= toolBounds.x && event.x < toolBounds.x + toolBounds.width && event.y >= toolBounds.y && event.y < toolBounds.y + toolBounds.height) {
                                    setExpandedTools(value => {
                                        const next = new Set(value);
                                        if (next.has(id))
                                            next.delete(id);
                                        else
                                            next.add(id);
                                        return next;
                                    });
                                    return;
                                }
                            }
                        }
                        else
                            return;
                    }
                    else
                        return;
                }
            }
            if (event.action === 'down' && event.button === 2 && selectionRef.current && selectedText(allLines, selectionRef.current)) {
                copySelection();
                return;
            }
            if (event.action === 'wheel') {
                setScroll(value => Math.max(0, Math.min(lastStart, value + (event.button === 0 ? 3 : -3))));
                return;
            }
            if (event.action === 'down' && event.button === 2 && composerRef.current) {
                const bounds = measureElement(composerRef.current);
                if (event.x >= bounds.x && event.x < bounds.x + bounds.width && event.y >= bounds.y && event.y < bounds.y + bounds.height) {
                    focusComposer(true);
                    const attachmentRow = bounds.y + (rows >= 16 ? 1 : 0) + editorLines;
                    if (state.attachments.length && event.y === attachmentRow)
                        setMenu('attachments');
                    else
                        void pasteFromClipboard();
                }
                return;
            }
            if (event.action !== 'down' || event.button !== 0)
                return;
            for (const [id, element] of toolRowRefs.current) {
                const bounds = measureElement(element);
                if (event.x >= bounds.x && event.x < bounds.x + bounds.width && event.y >= bounds.y && event.y < bounds.y + bounds.height) {
                    setExpandedTools(current => {
                        const next = new Set(current);
                        if (next.has(id))
                            next.delete(id);
                        else
                            next.add(id);
                        return next;
                    });
                    return;
                }
            }
            for (const [target, element] of menuButtonRefs.current) {
                const bounds = measureElement(element);
                if (event.x >= bounds.x && event.x < bounds.x + bounds.width && event.y >= bounds.y && event.y < bounds.y + bounds.height) {
                    setMenu(target);
                    return;
                }
            }
            const element = composerRef.current;
            if (!element) {
                focusComposer(false);
                return;
            }
            const bounds = measureElement(element);
            if (event.x >= bounds.x && event.x < bounds.x + bounds.width && event.y >= bounds.y && event.y < bounds.y + bounds.height) {
                selectText(undefined);
                focusComposer(true);
                const paddingY = rows >= 16 ? 1 : 0;
                const editorRow = event.y - bounds.y - paddingY;
                if (state.attachments.length && editorRow === editorLines) {
                    composerDragging.current = false;
                    selectDraft(undefined);
                    setMenu('attachments');
                }
                else if (editorRow >= 0 && editorRow < editorLines) {
                    const firstVisibleRow = Math.max(0, cursorLine - editorLines + 1);
                    const index = Math.max(0, Math.min(Array.from(draft).length, cursorAtCell(draft, firstVisibleRow + editorRow, Math.max(0, event.x - bounds.x - 4), editorWidth)));
                    composerDragging.current = true;
                    selectDraft({ anchor: index, focus: index });
                    setCursor(index);
                }
                else {
                    composerDragging.current = false;
                    selectDraft(undefined);
                    setCursor(Array.from(draft).length);
                }
            }
            else
                focusComposer(false);
        };
        mouseEvents.on('mouse', onMouse);
        return () => { mouseEvents.off('mouse', onMouse); };
    }, [mouseEvents, draft, cursorLine, menu, state.question, state.attachments.length, lastStart, rows, editorLines, editorWidth, focusComposer, selectDraft, pasteIntoComposer, pasteFromClipboard, allLines, scrollStart, visible.length]);
    useInput((input, key) => {
        if (state.question)
            return;
        if (key.eventType === 'release')
            return;
        if (menu)
            return;
        if (key.ctrl && input.toLowerCase() === 'c') {
            if (composerFocused && !selectionRef.current && copyDraftSelection())
                return;
            if (selectionRef.current) {
                copySelection();
                return;
            }
        }
        if (!pendingRef.current && composerFocused && !selectionRef.current && (key.leftArrow || key.rightArrow)) {
            const current = draftSelectionRef.current;
            const range = current ? orderedDraftRange(current) : undefined;
            if (key.shift) {
                const anchor = current?.anchor ?? cursor;
                const from = current?.focus ?? cursor;
                const focus = Math.max(0, Math.min(Array.from(draft).length, from + (key.leftArrow ? -1 : 1)));
                selectDraft(anchor === focus ? undefined : { anchor, focus });
                setCursor(focus);
                return;
            }
            if (current && range && range[0] !== range[1]) {
                const focus = key.leftArrow ? range[0] : range[1];
                selectDraft(undefined);
                setCursor(focus);
                return;
            }
        }
        if (!pendingRef.current && (selectionRef.current || !composerFocused || !draft) && (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow) && (key.shift || !composerFocused)) {
            const previous = selectionRef.current ?? { anchor: { row: Math.max(0, scrollStart), column: 0 }, focus: { row: Math.max(0, scrollStart), column: 0 } };
            let { row, column } = previous.focus;
            if (key.upArrow)
                row--;
            if (key.downArrow)
                row++;
            row = Math.max(0, Math.min(allLines.length - 1, row));
            const length = Array.from(plainLine(allLines[row]?.text ?? '')).length;
            if (key.leftArrow) {
                if (column > 0)
                    column--;
                else if (row > 0) {
                    row--;
                    column = Array.from(plainLine(allLines[row]?.text ?? '')).length;
                }
            }
            if (key.rightArrow) {
                if (column < length)
                    column++;
                else if (row < allLines.length - 1) {
                    row++;
                    column = 0;
                }
            }
            column = Math.min(column, Array.from(plainLine(allLines[row]?.text ?? '')).length);
            const point = { row, column };
            selectText({ anchor: key.shift ? previous.anchor : point, focus: point });
            focusComposer(false);
            if (row < scrollStart)
                setScroll(Math.max(0, lastStart - row));
            if (row >= scrollStart + available)
                setScroll(Math.max(0, lastStart - row + available - 1));
            return;
        }
        if (selectionRef.current && key.escape) {
            selectText(undefined);
            focusComposer(true);
            return;
        }
        if (key.meta && ['m', 'd', 'l', 's', 'a', 'b', 'i', 'u'].includes(input.toLowerCase())) {
            const panels: Record<string, MenuKind> = { m: 'commands', d: 'providers', l: 'models', s: 'sessions', a: 'agents', b: 'budget', i: 'attachments', u: 'settings' };
            setMenu(panels[input.toLowerCase()]);
            return;
        }
        if (key.meta && key.shift && input.toLowerCase() === 'e') {
            const ids = toolExpansionIds(state.messages);
            setExpandedTools(current => current.size === ids.length && ids.every(id => current.has(id)) ? new Set() : new Set(ids));
            setScroll(0);
            return;
        }
        if (key.meta && !key.shift && input.toLowerCase() === 'e') {
            const latest = latestToolExpansionId(state.messages);
            if (latest)
                setExpandedTools(current => {
                    const next = new Set(current);
                    if (next.has(latest))
                        next.delete(latest);
                    else
                        next.add(latest);
                    return next;
                });
            setScroll(0);
            return;
        }
        if ((key.ctrl && input.toLowerCase() === 'y')) {
            const answer = [...state.messages].reverse().find(message => message.role === 'assistant')?.text;
            if (answer)
                void copyToClipboard(answer).then(() => setCopyStatus('Response copied')).catch(cause => setError(sanitizeTerminalText(cause instanceof Error ? cause.message : String(cause))));
            return;
        }
        if (key.ctrl && !key.shift && input.toLowerCase() === 'v') {
            if (!composerFocusRef.current) {
                setError('Click the task field to paste.');
                return;
            }
            void pasteFromClipboard();
            return;
        }
        if (key.ctrl && key.shift && input.toLowerCase() === 'v') {
            void readClipboardImage().then(data => controller.addImageData?.(data)).catch(cause => setError(sanitizeTerminalText(cause instanceof Error ? cause.message : String(cause))));
            return;
        }
        if (key.ctrl && !key.shift && input === 'c') {
            if (pendingRef.current) {
                pendingRef.current.resolve(false);
                pendingRef.current = undefined;
                setPending(undefined);
                approvalQueue.current.splice(0).forEach(item => item.resolve(false));
            }
            if (state.busy)
                controller.cancel();
            else
                void quit();
            return;
        }
        if (pendingRef.current) {
            if (key.pageDown) {
                setApprovalScroll(value => Math.min(Math.max(0, promptLines.length - Math.max(1, available - 3)), value + Math.max(1, available - 3)));
                return;
            }
            if (key.pageUp) {
                setApprovalScroll(value => Math.max(0, value - Math.max(1, available - 3)));
                return;
            }
            if (input.toLowerCase() === 'y' || input.toLowerCase() === 't' || input.toLowerCase() === 'n' || key.escape) {
                pendingRef.current.resolve(input.toLowerCase() === 'y' || input.toLowerCase() === 't');
                pendingRef.current = approvalQueue.current.shift();
                while (pendingRef.current?.signal?.aborted) {
                    pendingRef.current.resolve(false);
                    pendingRef.current = approvalQueue.current.shift();
                }
                setPending(pendingRef.current);
                setApprovalScroll(0);
            }
            return;
        }
        if (key.ctrl && input === 'p') {
            setMenu('commands');
            return;
        }
        if (key.ctrl && input === 'k') {
            setMenu('models');
            return;
        }
        if (key.ctrl && input === 'o') {
            setMenu('providers');
            return;
        }
        if (key.pageUp) {
            setScroll(value => Math.min(lastStart, value + available));
            return;
        }
        if (key.ctrl && key.home) { setScroll(lastStart); return; }
        if (key.ctrl && key.end) { setScroll(0); return; }
        if (key.pageDown) {
            setScroll(value => Math.max(0, value - available));
            return;
        }
        if (!composerFocused) {
            if (key.tab || key.return || key.escape) {
                focusComposer(true);
                setError('');
            }
            return;
        }
        if (key.escape) {
            if (state.busy)
                controller.cancel();
            else {
                setDraft('');
                setCursor(0);
                selectDraft(undefined);
            }
            return;
        }
        if ((key.return && (key.meta || key.shift)) || (key.ctrl && input === 'j')) {
            const parts = Array.from(draft);
            const current = draftSelectionRef.current;
            const [start, end] = current ? orderedDraftRange(current) : [cursor, cursor];
            parts.splice(start, end - start, '\n');
            setDraft(parts.join(''));
            setCursor(start + 1);
            selectDraft(undefined);
            return;
        }
        if (key.return) {
            if ((!draft.trim() && !state.attachments.length) || (state.busy && !/^\/(cancel|status|cost|context|agents|steer|sessions|copy|budget|image|help|clear|exit)\b/.test(draft.trim())))
                return;
            const text = draft;
            if (!secret)
                setHistory(value => [...value, text].slice(-100));
            setDraft('');
            setCursor(0);
            selectDraft(undefined);
            setHistoryIndex(-1);
            setScroll(0);
            setError('');
            if (/^\/(models|model)\s*$/.test(text) && controller.listModels) {
                setMenu('models');
                return;
            }
            if (/^\/connect\s*$/.test(text) && controller.listProviders) {
                setMenu('providers');
                return;
            }
            if (/^\/effort\s*$/.test(text) && controller.listEfforts) {
                setMenu('efforts');
                return;
            }
            if (/^\/key\s*$/.test(text)) {
                setMenu('key');
                return;
            }
            if (/^\/sessions\s*$/.test(text)) {
                setMenu('sessions');
                return;
            }
            if (/^\/copy\s*$/i.test(text)) {
                setMenu('messages');
                return;
            }
            const copyMatch = /^\/copy\s+(user|ai|assistant|last)$/i.exec(text.trim());
            if (copyMatch) {
                const role = copyMatch[1]!.toLowerCase();
                const message = [...state.messages].reverse().find(item => role === 'user' ? item.role === 'user' : item.role === 'assistant');
                if (!message?.text) {
                    setError('There is no message of this type to copy.');
                    return;
                }
                void copyToClipboard(message.text).then(() => setCopyStatus('Full message copied')).catch(cause => setError(sanitizeTerminalText(cause instanceof Error ? cause.message : String(cause))));
                return;
            }
            if (/^\/agents\s*$/.test(text)) {
                setMenu('agents');
                return;
            }
            if (/^\/settings?\s*$/i.test(text)) { setMenu('settings'); return; }
        if (/^\/budget\s*$/.test(text)) {
                setMenu('budget');
                return;
            }
            if (/^\/image\s*$/.test(text)) {
                setMenu('attachments');
                return;
            }
            void controller.submit(text).catch(cause => setError(sanitizeTerminalText(cause instanceof Error ? cause.message : String(cause))));
            return;
        }
        if (key.tab) {
            if (draft.startsWith('/') && !draft.includes(' ')) {
                const matches = COMMANDS.filter(command => command.startsWith(draft));
                if (matches[0]) {
                    setDraft(matches[0] + (matches.length === 1 ? ' ' : ''));
                    setCursor(matches[0].length + (matches.length === 1 ? 1 : 0));
                    selectDraft(undefined);
                }
            }
            else if (!draft)
                controller.cycleMode();
            return;
        }
        if (key.upArrow || key.downArrow) {
            if (!history.length || secret || draft.includes('\n'))
                return;
            if (historyIndex === -1 && key.upArrow)
                savedDraft.current = draft;
            const next = key.upArrow ? Math.min(history.length - 1, historyIndex + 1) : Math.max(-1, historyIndex - 1);
            const text = next === -1 ? savedDraft.current : history[history.length - 1 - next] || '';
            setHistoryIndex(next);
            setDraft(text);
            setCursor(Array.from(text).length);
            selectDraft(undefined);
            return;
        }
        if (key.leftArrow) {
            setCursor(value => Math.max(0, value - 1));
            selectDraft(undefined);
            return;
        }
        if (key.rightArrow) {
            setCursor(value => Math.min(Array.from(draft).length, value + 1));
            selectDraft(undefined);
            return;
        }
        if (key.ctrl && input === 'a') {
            const length = Array.from(draft).length;
            selectDraft(length ? { anchor: 0, focus: length } : undefined);
            setCursor(length);
            return;
        }
        if (key.home) {
            setCursor(0);
            selectDraft(undefined);
            return;
        }
        if (key.end || (key.ctrl && input === 'e')) {
            setCursor(Array.from(draft).length);
            selectDraft(undefined);
            return;
        }
        if (key.ctrl && input === 'u') {
            setDraft('');
            setCursor(0);
            selectDraft(undefined);
            return;
        }
        if (key.meta && (key.backspace || key.delete) && state.attachments.length && controller.removeImage) {
            controller.removeImage(state.attachments.length - 1);
            setCopyStatus('Last image removed');
            return;
        }
        if (key.backspace || key.delete) {
            const parts = Array.from(draft);
            const current = draftSelectionRef.current;
            if (current && orderedDraftRange(current)[0] !== orderedDraftRange(current)[1]) {
                const [start, end] = orderedDraftRange(current);
                parts.splice(start, end - start);
                setDraft(parts.join(''));
                setCursor(start);
                selectDraft(undefined);
            }
            else if (!parts.length && state.attachments.length && controller.removeImage) {
                controller.removeImage(state.attachments.length - 1);
                setCopyStatus('Last image removed');
            }
            else {
                const index = key.backspace ? cursor - 1 : cursor;
                if (index >= 0 && index < parts.length) {
                    parts.splice(index, 1);
                    setDraft(parts.join(''));
                    if (key.backspace)
                        setCursor(value => value - 1);
                }
            }
            return;
        }
        if (key.ctrl || key.meta || !input)
            return;
        const safe = sanitizeTerminalText(input).replace(/\r\n?/g, '\n');
        if (safe) {
            const parts = Array.from(draft);
            const current = draftSelectionRef.current;
            const [start, end] = current ? orderedDraftRange(current) : [cursor, cursor];
            const characters = Array.from(safe);
            parts.splice(start, end - start, ...characters);
            setDraft(parts.join(''));
            setCursor(start + characters.length);
            selectDraft(undefined);
        }
    });
    const colors = THEMES[state.theme];
    const home = !state.busy && (state.messages.length === 0 || (state.messages.length === 1 && /^(New session:|PolonRLM ·)/.test(state.messages[0]!.text)));
    const activeAgents = state.agents.filter(agent => !['done', 'complete', 'failed', 'error', 'cancelled'].includes(agent.status));
    const prompt = pending?.request;
    const promptLines = useMemo(() => prompt ? markdownLines(`${prompt.description}\n\n${prompt.preview ? '```diff\n' + prompt.preview + '\n```' : ''}`, Math.max(1, width - 4)) : [], [prompt, width]);
    const folder = sanitizeTerminalText(state.workspace.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? state.workspace);
    const totals = state.usage.input + state.usage.output;
    const selectionRange = draftSelection ? orderedDraftRange(draftSelection) : undefined;
    const selectedDraftText = selectionRange && selectionRange[0] !== selectionRange[1]
        ? <>{Array.from(shownDraft).slice(0, selectionRange[0]).join('')}<Text color={"#101010"} backgroundColor={"#d7d7d7"}>{Array.from(shownDraft).slice(selectionRange[0], selectionRange[1]).join('')}</Text>{Array.from(shownDraft).slice(selectionRange[1]).join('')}</>
        : <>{beforeCursor}{draft && <Text inverse={true}>{atCursor}</Text>}{afterCursor}</>;
    const composer = <Box ref={composerRef} width={width} height={editorLines + (rows >= 16 ? 3 : 1) + (state.attachments.length ? 1 : 0)} flexShrink={0} flexDirection={"column"} backgroundColor={colors.panel} paddingLeft={2} paddingRight={2} paddingY={rows >= 16 ? 1 : 0}><Box height={editorLines} overflow={"hidden"} flexShrink={0}><Text color={pending ? colors.warm : composerFocused ? colors.accent : colors.faint}>{"\u203A "}</Text><Box width={editorWidth} flexDirection={"column"} contentOffsetY={Math.max(0, cursorLine - editorLines + 1)} flexShrink={0}><Text color={colors.text} wrap={"hard"}>{selectedDraftText}{!draft && <Text color={colors.muted}>{state.busy ? 'Next message…' : 'Describe the task or paste an error…'}</Text>}</Text></Box></Box>{!!state.attachments.length && <Box height={1}><Text color={colors.accent} wrap={"truncate-end"}>{"+ "}{state.attachments.length}{state.attachments.length === 1 ? ' image' : ' images'}{" "}<Text color={state.vision === false ? colors.error : colors.muted}>{state.vision === true ? '· image support enabled' : state.vision === false ? '· model has no image support' : '· image support unknown'}</Text><Text color={colors.faint}> · click / Alt+I manage</Text></Text></Box>}<Box justifyContent={"space-between"} height={1}><Text wrap={"truncate-end"}><Text color={colors.accent} bold={true}>{MODE_LABELS[state.mode]}</Text><Text color={colors.faint}>{"  \u00B7  "}</Text><Text color={colors.text}>{sanitizeTerminalText(state.model || 'Select a model')}</Text><Text color={colors.muted}>{"  "}{sanitizeTerminalText(state.provider)}</Text></Text>{width >= 60 && <Text color={colors.faint}>{"Cortex "}{state.cortex}</Text>}</Box></Box>;
    const shortcuts = <Box width={width} marginTop={1} gap={2}>{[['commands', 'Menu', 'Alt+M'], ['providers', 'Provider', 'Alt+D'], ['models', 'Models', 'Alt+L']].map(([target, name, shortcut]) => <Box ref={node => {
        if (node)
            menuButtonRefs.current.set(target as MenuKind, node);
        else
            menuButtonRefs.current.delete(target as MenuKind);
    }} key={target}><Text color={colors.text}>{name}<Text color={colors.faint}>{" "}{shortcut}</Text></Text></Box>)}</Box>;
    const completion = suggestions.length ? <Box width={width} flexDirection={"column"} height={suggestions.length}>{suggestions.map((command, index) => <Text color={index ? colors.muted : colors.accent} key={command}>{"  "}{command}</Text>)}</Box> : null;
    const tip = error || (!composerFocused ? 'Click the task field to type.' : !state.model ? 'Click Provider to add an API key and choose a model.' : '');
    if (state.question)
        return <QuestionPanel question={state.question} width={columns} height={rows} onAnswer={answer => controller.answerQuestion?.(answer)} onCancel={() => controller.cancel()} mouseEvents={mouseEvents} key={JSON.stringify(state.question)}/>;
    return <Box width={columns} height={rows} flexDirection={"column"} backgroundColor={colors.canvas} overflow={"hidden"}>{menu ? <Box flexGrow={1} justifyContent={"center"} alignItems={"center"}><CommandMenu initial={menu} controller={controller} state={state} width={width} rows={rows} mouseEvents={mouseEvents} readClipboard={readClipboard} close={() => setMenu(current => current === menu ? undefined : current)} key={menu}/></Box> : home && !pending ? <Box flexGrow={1} justifyContent={"center"} alignItems={"center"} flexDirection={"column"}><Box width={width} flexDirection={"column"} marginBottom={rows >= 25 ? 2 : 0}><Box marginTop={1} flexDirection={"column"}>{width >= 48 && rows >= 20 ? WORDMARK.map((row, index) => <Text color={colors.text} bold={true} key={index}>{row}</Text>) : <Text color={colors.text} bold={true}>{"PolonRLM"}</Text>}</Box>{rows >= 25 && <Box marginTop={1}><Text color={colors.muted}>{folder}{" \u00B7 "}{MODE_LABELS[state.mode]}</Text></Box>}</Box>{composer}{completion}<Box width={width} backgroundColor={colors.canvas} flexDirection={"column"}>{shortcuts}{tip && <Box marginTop={1}><Text color={error ? colors.error : colors.muted}>{tip}</Text></Box>}</Box></Box> : <><Box height={2} paddingX={2} alignItems={"center"} justifyContent={"space-between"} flexShrink={0}><Text color={colors.text} bold={true}>{"PolonRLM"}<Text color={colors.faint}>{" / "}</Text><Text color={colors.muted}>{folder}</Text></Text><Text color={colors.faint}>{scroll > 0 ? `history ↑ ${scroll}` : 'Alt+M menu / Alt+U settings'}</Text></Box><Box flexGrow={1} width={columns} flexDirection="row"><Box flexGrow={1} flexDirection="column" alignItems="center"><Box ref={transcriptRef} width={width} flexDirection="column" overflow="hidden">{prompt ? <><Text color={colors.warm} bold={true}>{"APPROVAL: "}{sanitizeTerminalText(prompt.tool)}</Text><Text color={colors.muted}>{prompt.oneTimeOverride ? 'One-time exception \u00b7 approval will perform this action only' : 'Agent is waiting for a decision · approval applies only to this action'}</Text>{promptLines.slice(approvalScroll, approvalScroll + Math.max(0, available - 4)).map((line, index) => <MarkdownRow line={line} key={index}/>)}{promptLines.length > available - 4 && <Text dimColor={true}>{"PgUp/PgDn: preview"}</Text>}<Text color={colors.warm}>{"[Y] approve once   [N/Esc] reject"}</Text></> : visible.map((line, index) => line.toolCallId ? <Box ref={node => {
        if (node)
            toolRowRefs.current.set(line.toolCallId!, node);
        else
            toolRowRefs.current.delete(line.toolCallId!);
    }} key={`${scrollStart + index}`}><SelectableRow line={line} row={scrollStart + index} selection={selection}/></Box> : <SelectableRow line={line} row={scrollStart + index} selection={selection} key={`${scrollStart + index}`}/>)}</Box></Box>{!prompt && <Scrollbar total={allLines.length} viewport={available} offset={scrollStart} trackRef={scrollbarRef} color={colors.muted} muted={colors.border}/>}<Box width={1}/></Box><Box alignSelf="center" flexDirection="column" flexShrink={0}>{completion}{composer}{state.busy && <Box height={1} width={width} justifyContent={"space-between"}><Text color={colors.muted}>{"Task: "}{state.taskUsage.input + state.taskUsage.output}{"/"}{formatTokenBudget(state.tokenLimit)}{" tokens \u00B7 context ~"}{state.contextTokens}{"/"}{Number.isFinite(state.contextLimit) ? state.contextLimit.toLocaleString("en-US") : "model limit"}{state.contextLimitSource === "app" ? " app" : state.contextLimitSource === "model" ? " model" : state.contextLimitSource === "both" ? " app/model" : ""}</Text><Text color={colors.faint}>{state.taskUsage.costKnown ? `$${state.taskUsage.cost.toFixed(4)} / ${state.dollarLimit === 0 ? "no app cost cap" : `$${state.dollarLimit}`}` : `cost unknown / ${state.dollarLimit === 0 ? "no app cost cap" : `limit $${state.dollarLimit}`}`}</Text></Box>}<Box height={1} marginTop={1} width={width} justifyContent={"space-between"}><Text color={error ? colors.error : copyStatus ? colors.accent : composerFocused ? colors.muted : colors.warm} wrap={"truncate-end"}>{state.busy ? `${SPINNER[spinner]} ` : ''}{error || copyStatus || (composerFocused ? sanitizeTerminalText(state.status) : 'Click the task field to type')}{activeAgents.length ? ` · ${activeAgents.map(agent => `${sanitizeTerminalText(agent.role)}:${sanitizeTerminalText(agent.status)}`).join(', ')}` : ''}</Text><Text color={colors.faint}>{state.messages.some(message => message.role === 'tool' && message.toolOutput) ? 'alt+e result · alt+shift+e all · ' : ''}{"PgUp/PgDn history"}</Text></Box></Box></>}<Box height={1} width={columns} paddingX={2} justifyContent={"space-between"} flexShrink={0}><Text color={colors.faint} wrap={"truncate-middle"}>{home || menu ? sanitizeTerminalText(state.workspace) : `${totals.toLocaleString('en-US')} tokens · cache ${state.usage.cached} · ${state.usage.costKnown ? `$${state.usage.cost.toFixed(5)}` : 'cost unknown'}`}</Text><Text color={colors.muted}>{home && totals ? `${totals} tokens · ${state.usage.costKnown ? `$${state.usage.cost.toFixed(5)}` : 'cost unknown'}  ` : ''}<Text color={colors.faint}>{"PolonRLM "}{VERSION}</Text></Text></Box></Box>;
}
export async function startTUI(controller: UIController) {
    if (process.stdout.isTTY)
        process.stdout.write('\x1b]0;PolonRLM\x07');
    const routedInput = new TerminalInputRouter(process.stdin);
    const restoreQuickEdit = disableQuickEdit();
    let instance;
    try {
        // Drag reports let the app select transcript text without pausing the console.
        process.stdout.write('\x1b[?1002h\x1b[?1006h');
        instance = render(<TerminalApp controller={controller} mouseEvents={routedInput}/>, {
            stdin: routedInput,
            alternateScreen: true, incrementalRendering: true, exitOnCtrlC: false,
            maxFps: 24, kittyKeyboard: { mode: 'auto' },
        });
        await instance.waitUntilExit();
    }
    finally {
        instance?.unmount();
        process.stdout.write('\x1b[?1002l\x1b[?1006l');
        routedInput.dispose();
        restoreQuickEdit();
        await controller.close();
    }
}
//# sourceMappingURL=tui.js.map
