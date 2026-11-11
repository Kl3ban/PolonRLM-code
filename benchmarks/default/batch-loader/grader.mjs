import path from 'node:path';
import { pathToFileURL } from 'node:url';

function settlesWithin(promise, ms = 200) {
  let handle;
  const timer = new Promise((resolve, reject) => {
    handle = setTimeout(() => reject(new Error(`operation did not settle within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timer]).finally(() => clearTimeout(handle));
}

function throwsTypeError(start) {
  try {
    start();
    return false;
  } catch (error) {
    return error instanceof TypeError;
  }
}

export async function grade(root) {
  const checks = [];
  try {
    const { createBatcher } = await import(pathToFileURL(path.join(root, 'src', 'batch-loader.js')).href);
    checks.push(typeof createBatcher === 'function');
    if (typeof createBatcher !== 'function') throw new Error('batch-loader.js must export createBatcher');

    const batchCalls = [];
    const batcher = createBatcher(keys => {
      batchCalls.push([...keys]);
      return keys.map(key => `v:${key}`);
    });
    const a = batcher.load('a');
    const b = batcher.load('b');
    const c = batcher.load('c');
    checks.push(batchCalls.length === 0);
    const values = await settlesWithin(Promise.all([a, b, c]));
    checks.push(JSON.stringify(batchCalls) === JSON.stringify([['a', 'b', 'c']]));
    checks.push(JSON.stringify(values) === JSON.stringify(['v:a', 'v:b', 'v:c']));

    const dedupeCalls = [];
    const deduped = createBatcher(keys => {
      dedupeCalls.push([...keys]);
      return keys.map(key => key.toUpperCase());
    });
    const d1 = deduped.load('x');
    const d2 = deduped.load('y');
    const d3 = deduped.load('x');
    const dedupeValues = await settlesWithin(Promise.all([d1, d2, d3]));
    checks.push(JSON.stringify(dedupeCalls) === JSON.stringify([['x', 'y']]));
    checks.push(dedupeValues[0] === 'X' && dedupeValues[1] === 'Y' && dedupeValues[2] === 'X');

    const tickCalls = [];
    const ticking = createBatcher(async keys => {
      tickCalls.push([...keys]);
      await Promise.resolve();
      return keys;
    });
    const firstTickValue = await settlesWithin(ticking.load('one'));
    const secondTickValue = await settlesWithin(ticking.load('two'));
    checks.push(firstTickValue === 'one' && secondTickValue === 'two');
    checks.push(JSON.stringify(tickCalls) === JSON.stringify([['one'], ['two']]));

    const boom = new Error('batch failed');
    const failing = createBatcher(async () => {
      throw boom;
    });
    const failedValues = await settlesWithin(Promise.allSettled([failing.load(1), failing.load(2)]));
    checks.push(failedValues.every(item => item.status === 'rejected' && item.reason === boom));

    const perKey = createBatcher(async keys => keys.map(key => (key === 2 ? new Error('bad key') : key * 10)));
    const perKeyValues = await settlesWithin(Promise.allSettled([perKey.load(1), perKey.load(2), perKey.load(3)]));
    checks.push(perKeyValues[0].status === 'fulfilled' && perKeyValues[0].value === 10);
    checks.push(perKeyValues[1].status === 'rejected' && perKeyValues[1].reason?.message === 'bad key');
    checks.push(perKeyValues[2].status === 'fulfilled' && perKeyValues[2].value === 30);

    const wrongShape = createBatcher(async () => 'not an array');
    const wrongValues = await settlesWithin(Promise.allSettled([wrongShape.load('k')]));
    checks.push(wrongValues[0].status === 'rejected' && wrongValues[0].reason instanceof TypeError);

    const syncBoom = new Error('sync batch failure');
    const throwing = createBatcher(() => {
      throw syncBoom;
    });
    const thrownValues = await settlesWithin(Promise.allSettled([throwing.load('k')]));
    checks.push(thrownValues[0].status === 'rejected' && thrownValues[0].reason === syncBoom);

    checks.push(throwsTypeError(() => createBatcher(null)));
    checks.push(throwsTypeError(() => createBatcher(42)));

    const passed = checks.every(Boolean);
    const failed = checks.map((ok, index) => (ok ? null : index + 1)).filter(Boolean);
    return {
      passed,
      summary: `${checks.length - failed.length}/${checks.length} checks passed${failed.length ? ` (failed: ${failed.join(', ')})` : ''}`,
    };
  } catch (error) {
    return { passed: false, summary: error instanceof Error ? error.message : String(error) };
  }
}
