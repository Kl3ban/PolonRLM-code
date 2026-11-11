import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function grade(root) {
  const checks = [];
  const check = (name, fn) => {
    try {
      fn();
      checks.push({ name, ok: true });
    } catch {
      checks.push({ name, ok: false });
    }
  };

  try {
    const { wordWrap } = await import(pathToFileURL(path.join(root, 'src', 'word-wrap.js')).href + `?grade=${Date.now()}`);
    check('exports wordWrap', () => assert.equal(typeof wordWrap, 'function'));
    check('wraps greedily at spaces', () => {
      assert.deepEqual(
        wordWrap('The quick brown fox jumps over the lazy dog', 10),
        ['The quick', 'brown fox', 'jumps over', 'the lazy', 'dog'],
      );
    });
    check('handles width 1 and short single words', () => {
      assert.deepEqual(wordWrap('a b c', 1), ['a', 'b', 'c']);
      assert.deepEqual(wordWrap('abc', 10), ['abc']);
    });
    check('puts an overlong word on its own line', () => {
      assert.deepEqual(wordWrap('a bbbbbbbb c', 3), ['a', 'bbbbbbbb', 'c']);
      assert.deepEqual(wordWrap('supercalifragilistic is long', 5), ['supercalifragilistic', 'is', 'long']);
    });
    check('keeps lines within width when words fit', () => {
      assert.deepEqual(wordWrap('ab cd', 5), ['ab cd']);
      assert.deepEqual(wordWrap('abc def', 6), ['abc', 'def']);
    });
    check('collapses arbitrary whitespace and trims edges', () => {
      assert.deepEqual(wordWrap('  a   b\tc\n', 10), ['a b c']);
      assert.deepEqual(wordWrap('one\ntwo three', 7), ['one two', 'three']);
    });
    check('returns an empty array for empty or whitespace-only input', () => {
      assert.deepEqual(wordWrap('', 5), []);
      assert.deepEqual(wordWrap('   ', 5), []);
      assert.deepEqual(wordWrap('\n\t  \r\n', 5), []);
    });
    check('keeps normal text unchanged when the width is large', () => {
      assert.deepEqual(wordWrap('a b c', 1000), ['a b c']);
    });
    check('measures width in UTF-16 code units', () => {
      assert.deepEqual(wordWrap('😀😀 x', 2), ['😀😀', 'x']);
      assert.deepEqual(wordWrap('😀😀 x', 6), ['😀😀 x']);
    });
    check('rejects invalid text', () => {
      for (const text of [undefined, null, 42, {}, ['a']]) {
        assert.throws(() => wordWrap(text, 10), TypeError);
      }
    });
    check('rejects invalid width', () => {
      for (const width of [0, -1, -100]) {
        assert.throws(() => wordWrap('a b', width), RangeError);
      }
      for (const width of [1.5, NaN, Infinity, -Infinity, '3', null, undefined]) {
        assert.throws(() => wordWrap('a b', width), TypeError);
      }
    });
  } catch {
    checks.push({ name: 'module loads and runs', ok: false });
  }

  const failed = checks.filter(entry => !entry.ok).map(entry => entry.name);
  const passed = checks.length > 0 && failed.length === 0;
  return {
    passed,
    summary: passed
      ? `${checks.length}/${checks.length} checks passed`
      : `${failed.length}/${checks.length} checks failed: ${failed.slice(0, 4).join('; ')}`,
  };
}
