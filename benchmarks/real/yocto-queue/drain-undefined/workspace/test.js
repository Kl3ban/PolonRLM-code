import test from 'ava';
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
	queue.enqueue('🌈');
	for (const _ of queue.drain()) {}
	t.deepEqual([...queue], []);
	t.is(queue.size, 0);
})

test('drain yields undefined values', t => {
	const queue = new Queue();
	queue.enqueue('first');
	queue.enqueue(undefined);
	queue.enqueue('last');
	t.deepEqual([...queue.drain()], ['first', undefined, 'last']);
	t.deepEqual([...queue], []);
	t.is(queue.size, 0);
});