import test from 'ava';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Queue from './index.js';

test('.enqueue()', t => {
	const queue = new Queue();
	queue.enqueue('🦄');
	t.is(queue.dequeue(), '🦄');
	queue.enqueue('🌈');
	queue.enqueue('❤️');
	t.is(queue.dequeue(), '🌈');
	t.is(queue.dequeue(), '❤️');
});

test('.dequeue()', t => {
	const queue = new Queue();
	t.is(queue.dequeue(), undefined);
	t.is(queue.dequeue(), undefined);
	queue.enqueue('🦄');
	t.is(queue.dequeue(), '🦄');
	t.is(queue.dequeue(), undefined);
});

test('.peek()', t => {
	const queue = new Queue();
	t.is(queue.peek(), undefined);
	queue.enqueue('🦄');
	t.is(queue.peek(), '🦄');
	queue.enqueue('🌈');
	t.is(queue.peek(), '🦄');
	queue.dequeue();
	t.is(queue.peek(), '🌈');
	queue.dequeue();
	t.is(queue.peek(), undefined);
});

test('.clear()', t => {
	const queue = new Queue();
	queue.clear();
	queue.enqueue(1);
	queue.clear();
	t.is(queue.size, 0);
	queue.enqueue(1);
	queue.enqueue(2);
	queue.enqueue(3);
	queue.clear();
	t.is(queue.size, 0);
});

test('.size', t => {
	const queue = new Queue();
	t.is(queue.size, 0);
	queue.clear();
	t.is(queue.size, 0);
	queue.enqueue('🦄');
	t.is(queue.size, 1);
	queue.enqueue('🦄');
	t.is(queue.size, 2);
	queue.dequeue();
	t.is(queue.size, 1);
	queue.dequeue();
	t.is(queue.size, 0);
	queue.dequeue();
	t.is(queue.size, 0);
});

test('iterable', t => {
	const queue = new Queue();
	queue.enqueue('🦄');
	queue.enqueue('🌈');
	t.deepEqual([...queue], ['🦄', '🌈']);
});

test('.drain()', t => {
	const queue = new Queue();
	queue.enqueue('🦄');
	queue.enqueue(undefined);
	queue.enqueue('🌈');
	t.deepEqual([...queue.drain()], ['🦄', undefined, '🌈']);
	t.deepEqual([...queue], []);
	t.is(queue.size, 0);
})

test('last dequeued item can be collected', t => {
	const probe = `
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
	const result = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', probe], {
		cwd: path.dirname(fileURLToPath(import.meta.url)),
		encoding: 'utf8',
		windowsHide: true,
		timeout: 15_000,
	});
	t.is(result.status, 0, result.stderr);
	t.is(result.stdout.trim(), 'released');
});
