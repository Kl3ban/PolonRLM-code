import path from 'node:path';
import { pathToFileURL } from 'node:url';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function settlesWithin(promise, ms = 5000) {
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
    const { createWriteQueue } = await import(pathToFileURL(path.join(root, 'src', 'serialize-writes.js')).href);
    checks.push(typeof createWriteQueue === 'function');
    if (typeof createWriteQueue !== 'function') throw new Error('serialize-writes.js must export createWriteQueue');

    const queue = createWriteQueue();
    const events = [];
    let releaseFirst;
    const firstGate = new Promise(resolve => {
      releaseFirst = resolve;
    });
    const first = queue.enqueue(async () => {
      events.push('start-1');
      await firstGate;
      events.push('end-1');
      return 'one';
    });
    const second = queue.enqueue(async () => {
      events.push('start-2');
      return 'two';
    });
    const third = queue.enqueue(() => {
      events.push('start-3');
      return 'three';
    });
    checks.push(first instanceof Promise && second instanceof Promise && third instanceof Promise);
    checks.push(queue.pending() === 3);
    await tick();
    checks.push(JSON.stringify(events) === JSON.stringify(['start-1']));
    releaseFirst();
    const values = await settlesWithin(Promise.all([first, second, third]));
    checks.push(JSON.stringify(values) === JSON.stringify(['one', 'two', 'three']));
    checks.push(JSON.stringify(events) === JSON.stringify(['start-1', 'end-1', 'start-2', 'start-3']));
    checks.push(queue.pending() === 0);

    let active = 0;
    let peak = 0;
    const serialQueue = createWriteQueue();
    const serialRuns = [0, 1, 2, 3, 4].map(value => serialQueue.enqueue(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await tick();
      active -= 1;
      return value;
    }));
    const serialValues = await settlesWithin(Promise.all(serialRuns));
    checks.push(peak === 1);
    checks.push(JSON.stringify(serialValues) === JSON.stringify([0, 1, 2, 3, 4]));

    const failingQueue = createWriteQueue();
    const failingEvents = [];
    const boom = new Error('boom');
    const okFirst = failingQueue.enqueue(() => {
      failingEvents.push(1);
      return 'a';
    });
    const rejectedSecond = failingQueue.enqueue(async () => {
      failingEvents.push(2);
      throw boom;
    });
    const okThird = failingQueue.enqueue(() => {
      failingEvents.push(3);
      return 'c';
    });
    const outcomes = await settlesWithin(Promise.allSettled([okFirst, rejectedSecond, okThird]));
    checks.push(outcomes[0].status === 'fulfilled' && outcomes[0].value === 'a');
    checks.push(outcomes[1].status === 'rejected' && outcomes[1].reason === boom);
    checks.push(outcomes[2].status === 'fulfilled' && outcomes[2].value === 'c');
    checks.push(JSON.stringify(failingEvents) === JSON.stringify([1, 2, 3]));

    const throwQueue = createWriteQueue();
    const throwBoom = new Error('sync boom');
    let afterSyncThrowRan = false;
    const thrown = throwQueue.enqueue(() => {
      throw throwBoom;
    });
    const after = throwQueue.enqueue(() => {
      afterSyncThrowRan = true;
      return 'ok';
    });
    const thrownOutcomes = await settlesWithin(Promise.allSettled([thrown, after]));
    checks.push(thrownOutcomes[0].status === 'rejected' && thrownOutcomes[0].reason === throwBoom);
    checks.push(thrownOutcomes[1].status === 'fulfilled' && afterSyncThrowRan === true);

    const idleQueue = createWriteQueue();
    const early = await Promise.race([idleQueue.onIdle().then(() => 'idle'), tick().then(() => 'late')]);
    checks.push(early === 'idle');

    let idleCount = 0;
    let releaseIdle;
    const idleGate = new Promise(resolve => {
      releaseIdle = resolve;
    });
    idleQueue.enqueue(async () => {
      await idleGate;
      return 'done';
    });
    const idleWaiterA = idleQueue.onIdle().then(() => {
      idleCount += 1;
    });
    const idleWaiterB = idleQueue.onIdle().then(() => {
      idleCount += 1;
    });
    await tick();
    checks.push(idleCount === 0);
    releaseIdle();
    await settlesWithin(Promise.all([idleWaiterA, idleWaiterB]));
    checks.push(idleCount === 2);

    checks.push(throwsTypeError(() => createWriteQueue().enqueue('nope')));
    checks.push(throwsTypeError(() => createWriteQueue().enqueue(null)));

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
