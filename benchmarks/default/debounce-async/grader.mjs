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

function createClock() {
  let nextId = 1;
  const timers = new Map();
  const history = [];
  return {
    setTimeout(callback, ms) {
      const id = nextId;
      nextId += 1;
      history.push(ms);
      timers.set(id, { callback, ms });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle);
    },
    size() {
      return timers.size;
    },
    delays() {
      return [...history];
    },
    runAll() {
      const pending = [...timers.values()];
      timers.clear();
      for (const timer of pending) timer.callback();
    },
  };
}

export async function grade(root) {
  const checks = [];
  try {
    const { debounceAsync } = await import(pathToFileURL(path.join(root, 'src', 'debounce-async.js')).href);
    checks.push(typeof debounceAsync === 'function');
    if (typeof debounceAsync !== 'function') throw new Error('debounce-async.js must export debounceAsync');

    const coalesceClock = createClock();
    const calls = [];
    const debounced = debounceAsync((...args) => {
      calls.push(args);
      return args.at(-1) * 2;
    }, 50, { clock: coalesceClock });
    const first = debounced(1);
    checks.push(coalesceClock.size() === 1);
    const second = debounced(2);
    const third = debounced(3);
    checks.push(coalesceClock.size() === 1);
    checks.push(JSON.stringify(coalesceClock.delays()) === JSON.stringify([50, 50, 50]));
    checks.push(calls.length === 0);
    coalesceClock.runAll();
    checks.push(calls.length === 1 && JSON.stringify(calls[0]) === JSON.stringify([3]));
    const values = await settlesWithin(Promise.all([first, second, third]));
    checks.push(JSON.stringify(values) === JSON.stringify([6, 6, 6]));
    checks.push(coalesceClock.size() === 0);

    const burstClock = createClock();
    const burstCalls = [];
    const bursts = debounceAsync(value => {
      burstCalls.push(value);
      return value;
    }, 5, { clock: burstClock });
    const firstBurst = bursts('a');
    burstClock.runAll();
    checks.push(await settlesWithin(firstBurst) === 'a');
    const secondBurst = bursts('b');
    checks.push(burstClock.size() === 1);
    burstClock.runAll();
    checks.push(await settlesWithin(secondBurst) === 'b');
    checks.push(JSON.stringify(burstCalls) === JSON.stringify(['a', 'b']));

    const cancelClock = createClock();
    let cancelledCalls = 0;
    const cancellable = debounceAsync(() => {
      cancelledCalls += 1;
      return 'value';
    }, 25, { clock: cancelClock });
    const pending = cancellable('x');
    const pendingOutcome = pending.then(() => null, error => error);
    cancellable.cancel();
    checks.push(cancelClock.size() === 0);
    const cancelled = await settlesWithin(pendingOutcome);
    checks.push(cancelled instanceof Error && cancelled.name === 'AbortError');
    cancelClock.runAll();
    checks.push(cancelledCalls === 0);
    cancellable.cancel();
    const revived = cancellable('y');
    cancelClock.runAll();
    checks.push(await settlesWithin(revived) === 'value');
    checks.push(cancelledCalls === 1);

    const rejectionClock = createClock();
    const boom = new Error('debounced failure');
    const failing = debounceAsync(async () => {
      throw boom;
    }, 10, { clock: rejectionClock });
    const failurePromise = failing('ignored');
    const failureOutcome = failurePromise.then(() => null, error => error);
    rejectionClock.runAll();
    checks.push(await settlesWithin(failureOutcome) === boom);

    checks.push(throwsTypeError(() => debounceAsync(null, 10)));
    checks.push(throwsTypeError(() => debounceAsync(() => 1, -1)));
    checks.push(throwsTypeError(() => debounceAsync(() => 1, Number.NaN)));
    checks.push(throwsTypeError(() => debounceAsync(() => 1, Number.POSITIVE_INFINITY)));
    checks.push(throwsTypeError(() => debounceAsync(() => 1, 10, { clock: {} })));

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
