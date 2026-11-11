import { tokenize } from './tokenize.js';

export function analyzeText(text, options = {}) {
  return {
    characters: 0,
    charactersNoWhitespace: 0,
    words: 0,
    uniqueWords: 0,
    sentences: 0,
    topWords: [],
  };
}
