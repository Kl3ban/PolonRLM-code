import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

export async function grade(workspace) {
  try {
    const { EventEmitter } = await import(pathToFileURL(`${workspace}/src/index.js`).href + `?grade=${Date.now()}`);
    assert.equal(typeof EventEmitter, 'function');
    const bus = new EventEmitter(); const seen = [];
    bus.once('x', () => { seen.push('once'); bus.emit('x'); });
    let offLate;
    bus.on('x', () => { seen.push('regular'); offLate?.(); });
    offLate = bus.on('x', () => seen.push('late'));
    assert.equal(bus.emit('x'), 3);
    assert.deepEqual(seen, ['once', 'regular', 'late', 'regular', 'late']);
    const remove = bus.on('y', () => seen.push('y')); remove(); remove();
    assert.equal(bus.emit('y'), 0);
    bus.on('z', () => {}); bus.clear('z'); assert.equal(bus.emit('z'), 0);
    assert.throws(() => bus.on('z', 1), TypeError);
    assert.throws(() => bus.once(null, () => {}), TypeError);
    return { passed: true, summary: 'reentrant once, ordered snapshot delivery, idempotent unsubscribe, clear, and validation passed' };
  } catch (error) {
    return { passed: false, summary: error instanceof Error ? error.message : String(error) };
  }
}
