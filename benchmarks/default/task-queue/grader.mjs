import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

export async function grade(workspace) {
  try {
    const mod = await import(pathToFileURL(`${workspace}/src/index.js`).href + `?grade=${Date.now()}`);
    const { assertConcurrency, createQueue } = mod;
    assert.equal(typeof assertConcurrency, 'function');
    assert.equal(typeof createQueue, 'function');
    assert.equal(assertConcurrency(3), 3);
    assert.throws(() => assertConcurrency(0), RangeError);
    assert.throws(() => assertConcurrency(-1), RangeError);
    assert.throws(() => assertConcurrency(1.5), RangeError);
    assert.throws(() => assertConcurrency(Number.NaN), RangeError);

    const serial = createQueue(1);
    const order = [];
    const first = serial.push(async () => {
      order.push('a');
      await Promise.resolve();
      order.push('b');
      return 'A';
    });
    const second = serial.push(() => {
      order.push('c');
      return 'C';
    });
    assert.equal(serial.active, 1);
    assert.equal(serial.size, 1);
    assert.equal(await serial.idle(), undefined);
    assert.deepEqual(order, ['a', 'b', 'c']);
    assert.deepEqual(await Promise.all([first, second]), ['A', 'C']);
    assert.equal(serial.active, 0);
    assert.equal(serial.size, 0);

    const parallel = createQueue(2);
    const starts = [];
    let running = 0;
    let maxRunning = 0;
    const jobs = [0, 1, 2, 3].map(index =>
      parallel.push(async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        starts.push(index);
        await Promise.resolve();
        await Promise.resolve();
        running -= 1;
        return index;
      }),
    );
    assert.equal(parallel.active, 2);
    assert.equal(parallel.size, 2);
    assert.deepEqual(await Promise.all(jobs), [0, 1, 2, 3]);
    assert.equal(maxRunning, 2);
    assert.deepEqual(starts, [0, 1, 2, 3]);
    await parallel.idle();

    const rejecting = createQueue(1);
    const failure = rejecting.push(() => {
      throw new Error('boom');
    });
    const success = rejecting.push(() => 42);
    const settled = await Promise.allSettled([failure, success]);
    assert.equal(settled[0].status, 'rejected');
    assert.equal(settled[0].reason.message, 'boom');
    assert.deepEqual(settled[1], { status: 'fulfilled', value: 42 });
    await rejecting.idle();

    const empty = createQueue();
    await empty.idle();
    assert.equal(empty.active, 0);
    assert.equal(empty.size, 0);
    await assert.rejects(empty.push(null), TypeError);
    assert.equal(empty.size, 0);
    assert.equal(empty.active, 0);
    assert.equal(await empty.push(() => 7), 7);

    const nested = createQueue(2);
    let nestedDone = false;
    const outer = nested.push(async () => {
      await nested.push(() => {
        nestedDone = true;
      });
      return 'outer';
    });
    await nested.idle();
    assert.equal(await outer, 'outer');
    assert.equal(nestedDone, true);

    assert.throws(() => createQueue(0), RangeError);
    assert.throws(() => createQueue(1.5), RangeError);

    return {
      passed: true,
      summary: 'bounded FIFO concurrency, result forwarding, rejection isolation, invalid tasks, idle draining, nested work, and validation passed',
    };
  } catch (error) {
    return { passed: false, summary: error instanceof Error ? error.message : String(error) };
  }
}
