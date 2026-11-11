export function tokenize(text) {
  if (typeof text !== 'string') {
    throw new TypeError('text must be a string');
  }
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}
