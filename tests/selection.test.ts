import assert from 'node:assert/strict';
import { test } from 'node:test';
import { columnAtCell, selectedText } from '../src/ui/selection.js';

test('selection copies a partial multiline range in either drag direction without ANSI', () => {
  const lines = [{ text: '\x1b[1mCześć!\x1b[22m' }, { text: 'Druga linia' }];
  const start = { row: 0, column: 2 }, end = { row: 1, column: 5 };
  assert.equal(selectedText(lines, { anchor: start, focus: end }), 'eść!\nDruga');
  assert.equal(selectedText(lines, { anchor: end, focus: start }), 'eść!\nDruga');
  assert.equal(selectedText(lines, { anchor: start, focus: start }), '');
});

test('mouse cell positions respect ANSI styling and wide characters', () => {
  assert.equal(columnAtCell('\x1b[36mA😀B\x1b[0m', 3), 2);
  assert.equal(columnAtCell('A😀B', 2), 1);
  assert.equal(columnAtCell('A😀B', 30), 3);
});
