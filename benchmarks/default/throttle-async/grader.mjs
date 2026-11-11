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
    const { throttleAsync } = await import(pathToFileURL(path.join(root, 'src', 'throttle-async.js')).href);
    checks.push(typeof throttleAsync === 'function');
    if (typeof throttleAsync !== 'function') throw new Error('throttle-async.js must export throttleAsync');

    const clock = createClock();
    const calls = [];
    const throttled = throttleAsync((...args) => {
      calls.push(args);
      return args.at(-1);
    }, 100, { clock });
    const first = throttled('a');
    checks.push(calls.length === 1 && JSON.stringify(calls[0]) === JSON.stringify(['a']));
    checks.push(clock.size() === 1 && JSON.stringify(clock.delays()) === JSON.stringify([100]));
    const second = throttled('b');
    const third = throttled('c');
    checks.push(calls.length === 1);
    checks.push(clock.size() === 1);
    clock.runAll();
    checks.push(calls.length === 2 && JSON.stringify(calls[1]) === JSON.stringify(['c']));
    const values = await settlesWithin(Promise.all([first, second, third]));
    checks.push(JSON.stringify(values) === JSON.stringify(['a', 'c', 'c']));
    checks.push(clock.size() === 0);

    const nextWindow = throttled('d');
    checks.push(calls.length === 3 && JSON.stringify(calls[2]) === JSON.stringify(['d']));
    checks.push(clock.size() === 1);
    clock.runAll();
    checks.push(await settlesWithin(nextWindow) === 'd');

    const rejectionClock = createClock();
    const leadBoom = new Error('leading failure');
    const rejectingLead = throttleAsync(async () => {
      throw leadBoom;
    }, 10, { clock: rejectionClock });
    const leadOutcome = await settlesWithin(rejectingLead('x').then(() => null, error => error));
    checks.push(leadOutcome === leadBoom);
    rejectingLead.cancel();

    const trailingBoom = new Error('trailing failure');
    let trailingCalls = 0;
    const rejectingTrailing = throttleAsync(async () => {
      trailingCalls += 1;
      if (trailingCalls === 2) throw trailingBoom;
      return 'lead';
    }, 10, { clock: rejectionClock });
    const lead = rejectingTrailing('lead');
    const waiting = rejectingTrailing('trail');
    const waitingOutcome = waiting.then(() => null, error => error);
    rejectionClock.runAll();
    const leadResult = await settlesWithin(lead);
    const trailingResult = await settlesWithin(waitingOutcome);
    checks.push(leadResult === 'lead');
    checks.push(trailingResult === trailingBoom);

    const cancelClock = createClock();
    const cancelCalls = [];
    const cancellable = throttleAsync(value => {
      cancelCalls.push(value);
      return value;
    }, 30, { clock: cancelClock });
    const cancelLead = cancellable('a');
    const cancelWaiting = cancellable('b');
    const cancelOutcome = cancelWaiting.then(() => null, error => error);
    cancellable.cancel();
    checks.push(cancelClock.size() === 0);
    const cancelled = await settlesWithin(cancelOutcome);
    checks.push(cancelled instanceof Error && cancelled.name === 'AbortError');
    checks.push(cancelCalls.length === 1);
    cancelClock.runAll();
    checks.push(cancelCalls.length === 1);
    checks.push(await settlesWithin(cancelLead) === 'a');
    cancellable.cancel();
    const afterCancel = cancellable('c');
    checks.push(cancelCalls.length === 2 && JSON.stringify(cancelCalls) === JSON.stringify(['a', 'c']));
    cancelClock.runAll();
    checks.push(await settlesWithin(afterCancel) === 'c');

    checks.push(throwsTypeError(() => throttleAsync(null, 10)));
    checks.push(throwsTypeError(() => throttleAsync(() => 1, 0)));
    checks.push(throwsTypeError(() => throttleAsync(() => 1, -5)));
    checks.push(throwsTypeError(() => throttleAsync(() => 1, Number.NaN)));
    checks.push(throwsTypeError(() => throttleAsync(() => 1, Number.POSITIVE_INFINITY)));
    checks.push(throwsTypeError(() => throttleAsync(() => 1, 10, { clock: {} })));

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
