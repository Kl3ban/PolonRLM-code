import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

export async function grade(workspace) {
  try {
    const mod = await import(pathToFileURL(`${workspace}/src/index.js`).href + `?grade=${Date.now()}`);
    const { compilePattern, matchPath, createRouter } = mod;
    assert.equal(typeof compilePattern, 'function');
    assert.equal(typeof matchPath, 'function');
    assert.equal(typeof createRouter, 'function');

    assert.deepEqual(compilePattern('/'), []);
    assert.deepEqual(compilePattern('/users/:id/books/:bookId'), [
      'users',
      { name: 'id' },
      'books',
      { name: 'bookId' },
    ]);
    assert.deepEqual(compilePattern('/health/'), ['health']);
    assert.deepEqual(matchPath('/health', '/health/'), {});
    assert.deepEqual(
      matchPath('/users/:id/books/:bookId', '/users/42/books/abc/'),
      { id: '42', bookId: 'abc' },
    );
    assert.deepEqual(matchPath('/users/:id', '/users/a%20b'), { id: 'a%20b' });
    assert.equal(matchPath('/users/:id', '/users'), null);
    assert.equal(matchPath('/users/:id', '/users/42/extra'), null);
    assert.equal(matchPath('/users/me', '/users/42'), null);
    assert.equal(matchPath('/users/:id', '/other/42'), null);

    assert.throws(() => compilePattern('users/:id'), Error);
    assert.throws(() => compilePattern('/users//:id'), Error);
    assert.throws(() => compilePattern('/users/:id/:id'), Error);
    assert.throws(() => compilePattern('/users/:1id'), Error);
    assert.throws(() => compilePattern('/users/*rest'), Error);
    assert.throws(() => matchPath('/users/:id', null), Error);
    assert.throws(() => matchPath('/users/:id', 'users/42'), Error);

    const routes = [
      { method: 'GET', path: '/users/me', handler: 'current-user' },
      { method: 'get', path: '/users/:id', handler: 'user-by-id' },
      { method: 'POST', path: '/users/:id', handler: 'update-user' },
    ];
    const routesBefore = structuredClone(routes);
    const router = createRouter(routes);
    assert.deepEqual(router.match('get', '/users/me'), {
      handler: 'current-user',
      params: {},
      method: 'GET',
      path: '/users/me',
    });
    assert.deepEqual(router.match(' GET ', '/users/42/'), {
      handler: 'user-by-id',
      params: { id: '42' },
      method: 'GET',
      path: '/users/:id',
    });
    assert.deepEqual(router.match('post', '/users/42'), {
      handler: 'update-user',
      params: { id: '42' },
      method: 'POST',
      path: '/users/:id',
    });
    assert.equal(router.match('DELETE', '/users/42'), null);
    assert.equal(router.match('GET', '/users'), null);
    assert.deepEqual(routes, routesBefore);

    assert.throws(() => createRouter(null), Error);
    assert.throws(() => createRouter([{ path: '/x', handler: 1 }]), Error);
    assert.throws(() => createRouter([{ method: 'GET', path: 'x', handler: 1 }]), Error);
    assert.throws(() => createRouter([{ method: '', path: '/x', handler: 1 }]), Error);
    assert.throws(() => router.match('', '/users/42'), Error);
    assert.throws(() => router.match('GET', 42), Error);

    return {
      passed: true,
      summary: 'pattern compilation, parameter matching, ordered method-aware routing, validation, and immutability passed',
    };
  } catch (error) {
    return { passed: false, summary: error instanceof Error ? error.message : String(error) };
  }
}
