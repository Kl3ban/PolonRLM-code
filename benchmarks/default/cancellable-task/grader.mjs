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
    const { createCancellableTask } = await import(pathToFileURL(path.join(root, 'src', 'cancellable-task.js')).href);
    checks.push(typeof createCancellableTask === 'function');
    if (typeof createCancellableTask !== 'function') throw new Error('cancellable-task.js must export createCancellableTask');

    let capturedSignal = null;
    const resolved = createCancellableTask(async signal => {
      capturedSignal = signal;
      return 42;
    });
    checks.push(resolved.status() === 'idle');
    const resolvedPromise = resolved.start();
    checks.push(resolved.status() === 'running');
    checks.push(resolved.start() === resolvedPromise);
    checks.push(await settlesWithin(resolvedPromise) === 42);
    checks.push(resolved.status() === 'fulfilled');
    checks.push(capturedSignal instanceof AbortSignal && capturedSignal.aborted === false);
    checks.push(resolved.cancel() === false);
    checks.push(capturedSignal instanceof AbortSignal && capturedSignal.aborted === false);
    checks.push(await settlesWithin(resolvedPromise) === 42);

    const boom = new Error('executor failed');
    const rejected = createCancellableTask(() => {
      throw boom;
    });
    const rejection = await settlesWithin(rejected.start().then(() => null, error => error));
    checks.push(rejection === boom);
    checks.push(rejected.status() === 'rejected');
    checks.push(rejected.cancel() === false);

    let runningSignal;
    let rejectRunning;
    const running = createCancellableTask(signal => {
      runningSignal = signal;
      return new Promise((resolve, reject) => {
        rejectRunning = reject;
      });
    });
    const runningPromise = running.start();
    checks.push(running.status() === 'running');
    const stop = new Error('stop now');
    const stopOutcome = runningPromise.then(() => null, error => error);
    checks.push(running.cancel(stop) === true);
    checks.push(running.cancel(stop) === false);
    checks.push(runningSignal instanceof AbortSignal && runningSignal.aborted === true && runningSignal.reason === stop);
    const stopped = await settlesWithin(stopOutcome).catch(error => error);
    checks.push(stopped === stop);
    checks.push(running.status() === 'cancelled');
    rejectRunning(new Error('late executor failure'));
    await tick();
    await tick();
    checks.push(running.status() === 'cancelled');

    let preCalls = 0;
    const before = createCancellableTask(() => {
      preCalls += 1;
      return new Promise(() => {});
    });
    const earlyStop = new Error('cancelled before start');
    checks.push(before.cancel(earlyStop) === true);
    checks.push(before.status() === 'cancelled');
    const earlyOutcome = await settlesWithin(before.start().then(() => null, error => error)).catch(error => error);
    checks.push(earlyOutcome === earlyStop);
    checks.push(preCalls === 0);
    checks.push(before.cancel(earlyStop) === false);
    checks.push(before.start() === before.start());

    const defaultCancel = createCancellableTask(() => new Promise(() => {}));
    const defaultPromise = defaultCancel.start();
    const defaultOutcome = defaultPromise.then(() => null, error => error);
    checks.push(defaultCancel.cancel() === true);
    const defaultError = await settlesWithin(defaultOutcome).catch(error => error);
    checks.push(defaultError instanceof Error && defaultError.name === 'AbortError');

    checks.push(throwsTypeError(() => createCancellableTask(null)));
    checks.push(throwsTypeError(() => createCancellableTask(42)));

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
