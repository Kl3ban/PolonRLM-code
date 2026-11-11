import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

export async function grade(workspace) {
  try {
    const mod = await import(pathToFileURL(`${workspace}/src/index.js`).href + `?grade=${Date.now()}`);
    const { analyzeText, tokenize } = mod;
    assert.equal(typeof tokenize, 'function');
    assert.equal(typeof analyzeText, 'function');

    assert.deepEqual(tokenize("Don't stop, stop!"), ['don', 't', 'stop', 'stop']);
    assert.deepEqual(tokenize('Café déjà-vu. CAFÉ!'), ['café', 'déjà', 'vu', 'café']);
    assert.deepEqual(tokenize(''), []);
    assert.deepEqual(tokenize('... -- !!'), []);
    assert.throws(() => tokenize(null), Error);

    const text = 'The cat and the hat.\nThe cat sat!';
    assert.deepEqual(analyzeText(text), {
      characters: 33,
      charactersNoWhitespace: 26,
      words: 8,
      uniqueWords: 5,
      sentences: 2,
      topWords: [
        { word: 'the', count: 3 },
        { word: 'cat', count: 2 },
        { word: 'and', count: 1 },
      ],
    });
    assert.deepEqual(analyzeText(text, { limit: 4 }).topWords, [
      { word: 'the', count: 3 },
      { word: 'cat', count: 2 },
      { word: 'and', count: 1 },
      { word: 'hat', count: 1 },
    ]);
    assert.deepEqual(analyzeText(text, { limit: 0 }).topWords, []);
    assert.deepEqual(analyzeText(''), {
      characters: 0,
      charactersNoWhitespace: 0,
      words: 0,
      uniqueWords: 0,
      sentences: 0,
      topWords: [],
    });
    assert.deepEqual(analyzeText('...'), {
      characters: 3,
      charactersNoWhitespace: 3,
      words: 0,
      uniqueWords: 0,
      sentences: 0,
      topWords: [],
    });
    assert.deepEqual(analyzeText('Café déjà-vu. CAFÉ!'), {
      characters: 19,
      charactersNoWhitespace: 17,
      words: 4,
      uniqueWords: 3,
      sentences: 2,
      topWords: [
        { word: 'café', count: 2 },
        { word: 'déjà', count: 1 },
        { word: 'vu', count: 1 },
      ],
    });
    assert.equal(analyzeText('😀 a').characters, 3);
    assert.equal(analyzeText('😀 a').charactersNoWhitespace, 2);
    assert.equal(analyzeText('No punctuation').sentences, 1);

    assert.throws(() => analyzeText(42), Error);
    assert.throws(() => analyzeText('ok', null), Error);
    assert.throws(() => analyzeText('ok', []), Error);
    assert.throws(() => analyzeText('ok', { limit: -1 }), Error);
    assert.throws(() => analyzeText('ok', { limit: 1.5 }), Error);
    assert.throws(() => analyzeText('ok', { limit: '2' }), Error);

    return {
      passed: true,
      summary: 'Unicode tokenization, code-point counts, sentence counts, deterministic top words, limits, and validation passed',
    };
  } catch (error) {
    return { passed: false, summary: error instanceof Error ? error.message : String(error) };
  }
}
