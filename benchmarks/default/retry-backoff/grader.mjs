import path from 'node:path';
import { pathToFileURL } from 'node:url';

function settlesWithin(promise, ms = 200) {
  let handle;
  const timer = new Promise((resolve, reject) => {
    handle = setTimeout(() => reject(new Error(`operation did not settle within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timer]).finally(() => clearTimeout(handle));
}

async function rejectsTypeError(start) {
  try {
    const value = start();
    if (value && typeof value.then === 'function') await settlesWithin(value);
    return false;
  } catch (error) {
    return error instanceof TypeError;
  }
}

export async function grade(root) {
  const checks = [];
  try {
    const { retry } = await import(pathToFileURL(path.join(root, 'src', 'retry-backoff.js')).href);
    checks.push(typeof retry === 'function');
    if (typeof retry !== 'function') throw new Error('retry-backoff.js must export retry as a function');

    const attempts = [];
    const value = await settlesWithin(retry(async attempt => {
      attempts.push(attempt);
      if (attempt < 3) throw new Error(`fail-${attempt}`);
      return 'ok';
    }, { retries: 5, baseMs: 10, maxMs: 100, delay: async () => {} }));
    checks.push(value === 'ok');
    checks.push(JSON.stringify(attempts) === JSON.stringify([1, 2, 3]));

    const exhaustedAttempts = [];
    const seenDelays = [];
    const lastError = new Error('still failing');
    const exhausted = await settlesWithin(retry(async attempt => {
      exhaustedAttempts.push(attempt);
      throw attempt === 1 ? new Error('first failure') : lastError;
    }, {
      retries: 3,
      baseMs: 100,
      maxMs: 150,
      delay: async (ms, attempt) => {
        seenDelays.push([ms, attempt]);
      },
    }).then(() => null, error => error));
    checks.push(exhausted === lastError);
    checks.push(JSON.stringify(exhaustedAttempts) === JSON.stringify([1, 2, 3, 4]));
    checks.push(JSON.stringify(seenDelays) === JSON.stringify([[100, 1], [150, 2], [150, 3]]));

    let zeroCalls = 0;
    let zeroDelays = 0;
    const zero = await settlesWithin(retry(async () => {
      zeroCalls += 1;
      throw new Error('nope');
    }, {
      retries: 0,
      delay: async () => {
        zeroDelays += 1;
      },
    }).then(() => null, error => error));
    checks.push(zero instanceof Error && zero.message === 'nope' && zeroCalls === 1 && zeroDelays === 0);

    const preAborted = new AbortController();
    preAborted.abort(new Error('cancelled early'));
    let preStarted = 0;
    const pre = await settlesWithin(retry(async () => {
      preStarted += 1;
      return 1;
    }, { retries: 2, delay: async () => {}, signal: preAborted.signal }).then(() => null, error => error));
    checks.push(pre instanceof Error && pre.message === 'cancelled early' && preStarted === 0);

    const controller = new AbortController();
    let runningCalls = 0;
    let markDelayStarted;
    const delayStarted = new Promise(resolve => {
      markDelayStarted = resolve;
    });
    const running = retry(async () => {
      runningCalls += 1;
      throw new Error('failing');
    }, {
      retries: 5,
      delay: () => {
        markDelayStarted();
        return new Promise(() => {});
      },
      signal: controller.signal,
    });
    await settlesWithin(delayStarted);
    controller.abort(new Error('stopped during wait'));
    const stopped = await settlesWithin(running.then(() => null, error => error)).catch(error => error);
    checks.push(stopped instanceof Error && stopped.message === 'stopped during wait');
    checks.push(runningCalls === 1);

    checks.push(await rejectsTypeError(() => retry('nope', { delay: async () => {} })));
    checks.push(await rejectsTypeError(() => retry(async () => 1, { retries: -1 })));
    checks.push(await rejectsTypeError(() => retry(async () => 1, { retries: 1.5 })));
    checks.push(await rejectsTypeError(() => retry(async () => 1, { baseMs: -1 })));
    checks.push(await rejectsTypeError(() => retry(async () => 1, { maxMs: Infinity })));
    checks.push(await rejectsTypeError(() => retry(async () => 1, { delay: 'later' })));

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
