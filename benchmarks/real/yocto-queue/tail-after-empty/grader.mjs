import { spawnSync } from 'node:child_process';

const collectionProbe = `
import Queue from './index.js';
function removeLastItem(queue, drain) {
  const value = new ArrayBuffer(1024 * 1024);
  queue.enqueue(value);
  if (drain) {
    queue.drain().next();
  } else {
    queue.dequeue();
  }
  return new WeakRef(value);
}
for (const drain of [false, true]) {
  const queue = new Queue();
  const reference = removeLastItem(queue, drain);
  for (let attempt = 0; attempt < 20; attempt++) {
    global.gc();
    await new Promise(resolve => setImmediate(resolve));
  }
  if (reference.deref()) {
    console.error('The final value remains reachable after ' + (drain ? 'drain' : 'dequeue') + '.');
    process.exitCode = 1;
  }
}
if (process.exitCode !== 1) console.log('released');
`;

export async function grade(workspacePath) {
  const probe = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', collectionProbe], {
    cwd: workspacePath,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 32 * 1024,
  });
  if (probe.error) return { passed: false, summary: `Could not run the isolated garbage-collection check: ${probe.error.message}` };
  if (probe.status !== 0 || probe.stdout.trim() !== 'released') {
    const details = (probe.stderr || probe.stdout).trim().slice(0, 400);
    return { passed: false, summary: details || `Garbage-collection check exited with status ${probe.status ?? 'unknown'}.` };
  }
  return { passed: true, summary: 'The queue releases the final node after it becomes empty.' };
}
