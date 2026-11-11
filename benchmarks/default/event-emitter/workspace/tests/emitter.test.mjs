import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from '../src/index.js';

test('listeners run in order and unsubscribe is idempotent', () => {
  const emitter = new EventEmitter();
  const seen = [];
  const off = emitter.on('ready', value => seen.push(`first:${value}`));
  emitter.on('ready', value => seen.push(`second:${value}`));
  off(); off();
  assert.equal(emitter.emit('ready', 3), 1);
  assert.deepEqual(seen, ['second:3']);
});

test('once removes before callback and subscription mutations affect next emit', () => {
  const emitter = new EventEmitter();
  const seen = [];
  let unsubscribeLater;
  emitter.once('tick', () => { seen.push('once'); emitter.emit('tick'); });
  emitter.on('tick', () => { seen.push('stable'); unsubscribeLater?.(); });
  unsubscribeLater = emitter.on('tick', () => seen.push('removed-next'));
  assert.equal(emitter.emit('tick'), 3);
  assert.deepEqual(seen, ['once', 'stable', 'removed-next', 'stable', 'removed-next']);
  assert.equal(emitter.emit('tick'), 1);
});

test('clear event and clear all remove listeners; invalid inputs fail', () => {
  const emitter = new EventEmitter();
  emitter.on('a', () => {}); emitter.on('b', () => {});
  emitter.clear('a');
  assert.equal(emitter.emit('a'), 0);
  assert.equal(emitter.emit('b'), 1);
  emitter.clear();
  assert.equal(emitter.emit('b'), 0);
  assert.throws(() => emitter.on(1, () => {}), TypeError);
  assert.throws(() => emitter.once('a', null), TypeError);
});
