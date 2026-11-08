import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, measureElement, type DOMElement } from 'ink';
import type { EventEmitter } from 'node:events';
import type { AgentQuestion } from '../core/workflows.js';
import type { TerminalMouseEvent } from './input-router.js';
import { sanitizeTerminalText } from './markdown.js';

export function QuestionPanel({ question, width, height, onAnswer, onCancel, mouseEvents }: { question: AgentQuestion; width: number; height: number; onAnswer: (answer: string | null) => void; onCancel?: () => void; mouseEvents?: EventEmitter }): React.JSX.Element {
  const [selected, setSelected] = useState(question.recommended);
  const [custom, setCustom] = useState('');
  const [seconds, setSeconds] = useState(300);
  const refs = useRef(new Map<number, DOMElement>());
  const latest = useRef({ custom, onAnswer }); latest.current = { custom, onAnswer };
  useEffect(() => { const timer = setInterval(() => setSeconds(n => Math.max(0, n - 1)), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    if (!mouseEvents) return;
    const click = (event: TerminalMouseEvent) => {
      if (event.action !== 'down' || event.button !== 0) return;
      for (const [index, node] of refs.current) {
        const box = measureElement(node);
        if (event.x >= box.x && event.x < box.x + box.width && event.y >= box.y && event.y < box.y + box.height) {
          setSelected(index);
          if (index < question.options.length) latest.current.onAnswer(question.options[index]!.label);
        }
      }
    };
    mouseEvents.on('mouse', click); return () => { mouseEvents.off('mouse', click); };
  }, [mouseEvents, question]);
  useInput((input, key) => {
    if (key.ctrl && input === 'c') { if (onCancel) onCancel(); else onAnswer(null); return; }
    if (key.escape) { onAnswer(null); return; }
    if (key.upArrow) { setSelected(n => Math.max(0, n - 1)); return; }
    if (key.downArrow || key.tab) { setSelected(n => (n + 1) % (question.options.length + 1)); return; }
    if (key.return) { const answer = selected < question.options.length ? question.options[selected]!.label : custom.trim(); if (answer) onAnswer(answer); return; }
    if (selected === question.options.length) {
      if (key.backspace || key.delete) setCustom(s => Array.from(s).slice(0, -1).join(''));
      else if (!key.ctrl && !key.meta) setCustom(s => (s + sanitizeTerminalText(input)).slice(0, 4000));
    } else if (/^[1-6]$/.test(input)) setSelected(Math.min(question.options.length, Number(input) - 1));
  });
  return <Box width={width} height={height} paddingX={2} paddingY={1} flexDirection="column" overflow="hidden">
    <Text bold>QUESTION FOR YOU</Text>
    <Text>{sanitizeTerminalText(question.question)}</Text>
    <Text dimColor>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')} until it closes. No response does not count as approval.</Text>
    {question.options.map((option, index) => <Box key={index} ref={node => { if (node) refs.current.set(index, node); else refs.current.delete(index); }} borderStyle="single" flexDirection="column">
      <Text bold={selected === index} inverse={selected === index}>{index + 1}. {sanitizeTerminalText(option.label)}{index === question.recommended ? ' (Recommended)' : ''}</Text>
      <Text dimColor>{sanitizeTerminalText(option.description)}</Text>
    </Box>)}
    <Box ref={node => { if (node) refs.current.set(question.options.length, node); }}><Text inverse={selected === question.options.length}>Custom answer: {custom || 'select an option and enter text'}</Text></Box>
    <Text dimColor>Arrows / 1-6: select · Enter: answer · click an option · Esc: cancel</Text>
  </Box>;
}
