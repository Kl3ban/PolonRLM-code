import path from 'node:path';
import { pathToFileURL } from 'node:url';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

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

function createFakeTimer() {
  let fire;
  const calls = [];
  let cancellations = 0;
  const timer = ms => {
    calls.push(ms);
    const promise = new Promise(resolve => {
      fire = resolve;
    });
    return { promise, cancel: () => { cancellations += 1; } };
  };
  return {
    timer,
    calls,
    cancellations: () => cancellations,
    fire: () => fire(),
  };
}

export async function grade(root) {
  const checks = [];
  try {
    const { withTimeout, TimeoutError } = await import(pathToFileURL(path.join(root, 'src', 'race-timeout.js')).href);
    checks.push(typeof withTimeout === 'function');
    checks.push(typeof TimeoutError === 'function');
    if (typeof withTimeout !== 'function' || typeof TimeoutError !== 'function') {
      throw new Error('race-timeout.js must export withTimeout and TimeoutError as functions');
    }

    let calls = 0;
    const first = createFakeTimer();
    const value = await settlesWithin(withTimeout(async () => {
      calls += 1;
      return 'done';
    }, 25, { timer: first.timer }));
    checks.push(value === 'done' && calls === 1);
    checks.push(JSON.stringify(first.calls) === JSON.stringify([25]));
    checks.push(first.cancellations() === 1);

    const boom = new Error('boom');
    const second = createFakeTimer();
    const failure = await settlesWithin(withTimeout(async () => {
      throw boom;
    }, 10, { timer: second.timer }).then(() => null, error => error));
    checks.push(failure === boom);
    checks.push(second.cancellations() === 1);

    const third = createFakeTimer();
    let lateReject;
    const operation = new Promise((resolve, reject) => {
      lateReject = reject;
    });
    let operationCalls = 0;
    const pending = withTimeout(() => {
      operationCalls += 1;
      return operation;
    }, 50, { timer: third.timer });
    third.fire();
    const timeoutError = await settlesWithin(pending.then(() => null, error => error)).catch(error => error);
    checks.push(timeoutError instanceof TimeoutError);
    checks.push(timeoutError?.name === 'TimeoutError' && timeoutError?.timeoutMs === 50);
    checks.push(operationCalls === 1);
    lateReject(new Error('late failure'));
    await tick();
    let stillRejected = timeoutError;
    if (timeoutError instanceof TimeoutError) {
      stillRejected = await settlesWithin(pending.then(() => null, error => error)).catch(error => error);
    }
    checks.push(stillRejected === timeoutError);

    const fourth = createFakeTimer();
    let lateResolve;
    const slow = new Promise(resolve => {
      lateResolve = resolve;
    });
    const timedOut = withTimeout(() => slow, 75, { timer: fourth.timer });
    fourth.fire();
    const firstOutcome = await settlesWithin(timedOut.then(() => null, error => error)).catch(error => error);
    lateResolve('too late');
    let secondOutcome = firstOutcome;
    if (firstOutcome instanceof TimeoutError) {
      secondOutcome = await settlesWithin(timedOut.then(() => 'resolved late', error => error)).catch(error => error);
    }
    checks.push(firstOutcome instanceof TimeoutError && secondOutcome === firstOutcome);

    checks.push(await rejectsTypeError(() => withTimeout('nope', 10)));
    checks.push(await rejectsTypeError(() => withTimeout(() => 1, 0)));
    checks.push(await rejectsTypeError(() => withTimeout(() => 1, -5)));
    checks.push(await rejectsTypeError(() => withTimeout(() => 1, Number.NaN)));
    checks.push(await rejectsTypeError(() => withTimeout(() => 1, Number.POSITIVE_INFINITY)));
    checks.push(await rejectsTypeError(() => withTimeout(() => 1, 10, { timer: 'later' })));

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
