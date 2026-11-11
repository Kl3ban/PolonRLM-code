const OPENING = new Set(['(', '[', '{']);
const CLOSING = new Map([[')', '('], [']', '['], ['}', '{']]);

export function isBalanced(text) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  const stack = [];
  for (const character of text) {
    if (OPENING.has(character)) {
      stack.push(character);
    } else if (CLOSING.has(character)) {
      if (stack.pop() !== CLOSING.get(character)) return false;
    }
  }
  return stack.length === 0;
}
