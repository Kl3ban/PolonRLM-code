import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

export async function grade(workspace) {
  try {
    const mod = await import(pathToFileURL(`${workspace}/src/index.js`).href + `?grade=${Date.now()}`);
    const { decodeCursor, encodeCursor, paginate } = mod;
    for (const fn of [decodeCursor, encodeCursor, paginate]) {
      assert.equal(typeof fn, 'function');
    }

    assert.equal(encodeCursor(0), 'MA');
    assert.equal(encodeCursor(10), 'MTA');
    assert.equal(encodeCursor(25), 'MjU');
    assert.equal(decodeCursor('MA'), 0);
    assert.equal(decodeCursor('MTA'), 10);
    assert.equal(decodeCursor(encodeCursor(12345)), 12345);
    assert.throws(() => encodeCursor(-1), Error);
    assert.throws(() => encodeCursor(1.5), Error);
    assert.throws(() => decodeCursor(''), Error);
    assert.throws(() => decodeCursor('MTA='), Error);
    assert.throws(() => decodeCursor('MTA '), Error);
    assert.throws(() => decodeCursor('LTE'), Error);
    assert.throws(() => decodeCursor('!!!'), Error);
    assert.throws(() => decodeCursor(10), Error);

    const items = ['a', 'b', 'c', 'd', 'e'];
    const itemsBefore = [...items];
    const first = paginate(items, { limit: 2 });
    assert.deepEqual(first.items, ['a', 'b']);
    assert.equal(first.hasMore, true);
    assert.equal(decodeCursor(first.nextCursor), 2);
    const second = paginate(items, { limit: 2, cursor: first.nextCursor });
    assert.deepEqual(second.items, ['c', 'd']);
    assert.equal(second.hasMore, true);
    assert.equal(decodeCursor(second.nextCursor), 4);
    const third = paginate(items, { limit: 2, cursor: second.nextCursor });
    assert.deepEqual(third, { items: ['e'], nextCursor: null, hasMore: false });
    assert.deepEqual(items, itemsBefore);

    const eleven = Array.from({ length: 11 }, (_, index) => index + 1);
    const defaultPage = paginate(eleven);
    assert.equal(defaultPage.items.length, 10);
    assert.equal(defaultPage.hasMore, true);
    assert.equal(decodeCursor(defaultPage.nextCursor), 10);
    assert.deepEqual(paginate(eleven, { cursor: defaultPage.nextCursor }), {
      items: [11],
      nextCursor: null,
      hasMore: false,
    });
    assert.deepEqual(paginate(['only'], { limit: 1 }), {
      items: ['only'],
      nextCursor: null,
      hasMore: false,
    });
    assert.deepEqual(paginate([]), { items: [], nextCursor: null, hasMore: false });
    assert.deepEqual(paginate(items, { cursor: encodeCursor(5) }), {
      items: [],
      nextCursor: null,
      hasMore: false,
    });
    assert.deepEqual(paginate(items, { cursor: encodeCursor(99) }), {
      items: [],
      nextCursor: null,
      hasMore: false,
    });

    assert.throws(() => paginate(null), Error);
    assert.throws(() => paginate([], { limit: 0 }), Error);
    assert.throws(() => paginate([], { limit: 101 }), Error);
    assert.throws(() => paginate([], { limit: 2.5 }), Error);
    assert.throws(() => paginate([], { limit: '2' }), Error);
    assert.throws(() => paginate([], { cursor: 'abc' }), Error);
    assert.throws(() => paginate([], { cursor: 5 }), Error);
    assert.throws(() => paginate([], null), Error);

    return {
      passed: true,
      summary: 'canonical base64url cursors, page traversal, default and boundary limits, empty/out-of-range pages, validation, and immutability passed',
    };
  } catch (error) {
    return { passed: false, summary: error instanceof Error ? error.message : String(error) };
  }
}
