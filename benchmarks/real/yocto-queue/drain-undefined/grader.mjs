import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function grade(workspacePath) {
  try {
    const moduleUrl = pathToFileURL(path.resolve(workspacePath, 'index.js')).href;
    const { default: Queue } = await import(`${moduleUrl}?grader=${Date.now()}-${Math.random()}`);
    const queue = new Queue();
    queue.enqueue('first');
    queue.enqueue(undefined);
    queue.enqueue('last');
    assert.deepEqual([...queue.drain()], ['first', undefined, 'last']);
    assert.equal(queue.size, 0);
    assert.deepEqual([...queue], []);
    queue.enqueue('reused');
    assert.equal(queue.dequeue(), 'reused');
    return { passed: true, summary: 'drain() yields undefined entries and empties the queue.' };
  } catch (error) {
    return { passed: false, summary: error instanceof Error ? error.message.slice(0, 450) : String(error).slice(0, 450) };
  }
}
