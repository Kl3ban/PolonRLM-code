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

function settle(promise) {
  return promise.then(value => ({ ok: true, value }), error => ({ ok: false, error }));
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
    const { parallelMap } = await import(pathToFileURL(path.join(root, 'src', 'parallel-map.js')).href);
    checks.push(typeof parallelMap === 'function');
    if (typeof parallelMap !== 'function') throw new Error('parallel-map.js must export parallelMap');

    const gates = new Map();
    const started = [];
    const orderedRun = parallelMap(['a', 'b', 'c'], (item, index) => {
      started.push(index);
      return new Promise((resolve, reject) => {
        gates.set(index, { resolve, reject });
      });
    }, { concurrency: 3 });
    await tick();
    checks.push(JSON.stringify(started) === JSON.stringify([0, 1, 2]));
    gates.get(2).resolve('C');
    gates.get(0).resolve('A');
    gates.get(1).resolve('B');
    const ordered = await settlesWithin(settle(orderedRun));
    checks.push(ordered.ok && JSON.stringify(ordered.value) === JSON.stringify([
      { status: 'fulfilled', value: 'A' },
      { status: 'fulfilled', value: 'B' },
      { status: 'fulfilled', value: 'C' },
    ]));

    let active = 0;
    let peak = 0;
    const limited = await settlesWithin(settle(parallelMap([1, 2, 3, 4, 5, 6], async value => {
      active += 1;
      peak = Math.max(peak, active);
      await tick();
      active -= 1;
      return value * 2;
    }, { concurrency: 2 })));
    checks.push(limited.ok && peak === 2);
    checks.push(limited.ok && limited.value.length === 6 && limited.value.every((entry, index) =>
      entry.status === 'fulfilled' && entry.value === (index + 1) * 2));

    const boom = new Error('mapper failed');
    const isolated = await settlesWithin(settle(parallelMap([0, 1, 2, 3], value => {
      if (value === 1) throw boom;
      return value;
    }, { concurrency: 2 })));
    checks.push(isolated.ok);
    checks.push(isolated.ok && isolated.value[0].status === 'fulfilled' && isolated.value[0].value === 0);
    checks.push(isolated.ok && isolated.value[1].status === 'rejected' && isolated.value[1].reason === boom);
    checks.push(isolated.ok && isolated.value[2].status === 'fulfilled' && isolated.value[2].value === 2);
    checks.push(isolated.ok && isolated.value[3].status === 'fulfilled' && isolated.value[3].value === 3);

    const empty = await settlesWithin(settle(parallelMap([], () => {
      throw new Error('mapper must not run for an empty input');
    }, { concurrency: 1 })));
    checks.push(empty.ok && Array.isArray(empty.value) && empty.value.length === 0);

    const defaulted = await settlesWithin(settle(parallelMap([1, 2], value => value + 1)));
    checks.push(defaulted.ok && JSON.stringify(defaulted.value) === JSON.stringify([
      { status: 'fulfilled', value: 2 },
      { status: 'fulfilled', value: 3 },
    ]));

    const preAbort = new AbortController();
    const preReason = new Error('already stopped');
    preAbort.abort(preReason);
    let preCalls = 0;
    const preRun = await settlesWithin(settle(parallelMap([1, 2], () => {
      preCalls += 1;
      return 1;
    }, { signal: preAbort.signal })));
    checks.push(!preRun.ok && preRun.error === preReason && preCalls === 0);

    const controller = new AbortController();
    const startedIndexes = [];
    let releaseGate;
    const gate = new Promise(resolve => {
      releaseGate = resolve;
    });
    const abortRun = parallelMap([0, 1, 2, 3, 4], (item, index) => {
      startedIndexes.push(index);
      return gate.then(() => item);
    }, { concurrency: 2, signal: controller.signal });
    await tick();
    checks.push(JSON.stringify(startedIndexes) === JSON.stringify([0, 1]));
    const stopReason = new Error('stopped mid-flight');
    controller.abort(stopReason);
    const abortedOutcome = await settlesWithin(settle(abortRun)).catch(error => ({ ok: false, error }));
    checks.push(!abortedOutcome.ok && abortedOutcome.error === stopReason);
    releaseGate();
    await tick();
    await tick();
    checks.push(JSON.stringify(startedIndexes) === JSON.stringify([0, 1]));

    checks.push(await rejectsTypeError(() => parallelMap(null, () => 1)));
    checks.push(await rejectsTypeError(() => parallelMap([1], 'mapper')));
    checks.push(await rejectsTypeError(() => parallelMap([1], () => 1, { concurrency: 0 })));
    checks.push(await rejectsTypeError(() => parallelMap([1], () => 1, { concurrency: -2 })));
    checks.push(await rejectsTypeError(() => parallelMap([1], () => 1, { concurrency: 1.5 })));

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
