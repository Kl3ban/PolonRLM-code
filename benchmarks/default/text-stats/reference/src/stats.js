import { tokenize } from './tokenize.js';

export function analyzeText(text, options = {}) {
  if (typeof text !== 'string') {
    throw new TypeError('text must be a string');
  }
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('options must be an object');
  }
  const limit = options.limit === undefined ? 3 : options.limit;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError('limit must be a non-negative safe integer');
  }

  const tokens = tokenize(text);
  const counts = new Map();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  const topWords = [...counts.entries()]
    .map(([word, count]) => ({ word, count }))
    .sort((left, right) => {
      if (left.count !== right.count) return right.count - left.count;
      return left.word < right.word ? -1 : left.word > right.word ? 1 : 0;
    })
    .slice(0, limit);

  const codePoints = Array.from(text);
  const charactersNoWhitespace = codePoints.filter(character => !/\s/u.test(character)).length;
  const sentences = text
    .split(/[.!?]+/u)
    .map(part => part.trim())
    .filter(part => part.length > 0).length;

  return {
    characters: codePoints.length,
    charactersNoWhitespace,
    words: tokens.length,
    uniqueWords: counts.size,
    sentences,
    topWords,
  };
}
