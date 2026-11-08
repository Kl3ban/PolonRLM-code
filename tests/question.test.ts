import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { QuestionPanel } from '../src/ui/question.js';

test('question table shows recommendation and returns selected answer', async () => {
  let answer: string | null | undefined;
  const ui = render(React.createElement(QuestionPanel, { width: 90, height: 30, question: { question: 'Select design', options: [{ label: 'Simple', description: 'Small interface' }, { label: 'Detailed', description: 'More controls' }], recommended: 0 }, onAnswer: value => { answer = value; } }));
  try {
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.match(ui.lastFrame()!, /Recommended/);
    assert.match(ui.lastFrame()!, /5:00/);
    ui.stdin.write('\u001b[B'); await new Promise(resolve => setTimeout(resolve, 30));
    ui.stdin.write('\r'); await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(answer, 'Detailed');
  } finally { ui.unmount(); ui.cleanup(); }
});
