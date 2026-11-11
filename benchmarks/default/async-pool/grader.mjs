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

export async function grade(root) {
  const checks = [];
  try {
    const { asyncPool } = await import(pathToFileURL(path.join(root, 'src', 'async-pool.js')).href);
    checks.push(typeof asyncPool === 'function');
    if (typeof asyncPool !== 'function') throw new Error('async-pool.js must export asyncPool as a function');

    const results = await settlesWithin(asyncPool([3, 1, 2], 2, async item => {
      await tick();
      return item * 10;
    }));
    checks.push(JSON.stringify(results) === JSON.stringify([30, 10, 20]));

    const items = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    let inFlight = 0;
    let peak = 0;
    const mapped = await settlesWithin(asyncPool(items, 3, async item => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight -= 1;
      return item;
    }));
    checks.push(peak === 3);
    checks.push(JSON.stringify(mapped) === JSON.stringify(items));

    let running = 0;
    let serial = true;
    await settlesWithin(asyncPool([1, 2, 3], 1, async value => {
      running += 1;
      if (running !== 1) serial = false;
      await tick();
      running -= 1;
      return value;
    }));
    checks.push(serial);

    const empty = await settlesWithin(asyncPool([], 2, () => {
      throw new Error('worker must not run for an empty input');
    }));
    checks.push(Array.isArray(empty) && empty.length === 0);

    const started = [];
    let releaseGate;
    const gate = new Promise(resolve => {
      releaseGate = resolve;
    });
    let rejectFirst;
    const failing = new Promise((resolve, reject) => {
      rejectFirst = reject;
    });
    const failingRun = asyncPool([0, 1, 2, 3], 2, item => {
      started.push(item);
      return item === 0 ? failing : gate;
    });
    await tick();
    checks.push(JSON.stringify(started) === JSON.stringify([0, 1]));
    rejectFirst(new Error('boom'));
    const failure = await settlesWithin(failingRun.then(() => null, error => error));
    checks.push(failure instanceof Error && failure.message === 'boom');
    releaseGate();
    await tick();
    await tick();
    checks.push(JSON.stringify(started) === JSON.stringify([0, 1]));

    checks.push(await rejectsTypeError(() => asyncPool(null, 2, () => 1)));
    checks.push(await rejectsTypeError(() => asyncPool([1], 0, () => 1)));
    checks.push(await rejectsTypeError(() => asyncPool([1], 1.5, () => 1)));
    checks.push(await rejectsTypeError(() => asyncPool([1], -1, () => 1)));
    checks.push(await rejectsTypeError(() => asyncPool([1], 2, 'worker')));

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
