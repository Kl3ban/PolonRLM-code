import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

export async function grade(workspace) {
  try {
    const mod = await import(pathToFileURL(`${workspace}/src/index.js`).href + `?grade=${Date.now()}`);
    const { Inventory, assertSku, assertQuantity } = mod;
    assert.equal(typeof Inventory, 'function');
    assert.equal(typeof assertSku, 'function');
    assert.equal(typeof assertQuantity, 'function');

    assert.equal(assertSku('SKU-1'), 'SKU-1');
    assert.equal(assertQuantity(7), 7);
    assert.throws(() => assertSku(''), Error);
    assert.throws(() => assertSku(' padded '), Error);
    assert.throws(() => assertSku(42), Error);
    assert.throws(() => assertQuantity(0), Error);
    assert.throws(() => assertQuantity(-2), Error);
    assert.throws(() => assertQuantity(1.5), Error);
    assert.throws(() => assertQuantity(Number.NaN), Error);

    const initial = [
      { sku: 'pen', quantity: 2 },
      { sku: 'notebook', quantity: 1 },
      { sku: 'pen', quantity: 3 },
    ];
    const initialBefore = structuredClone(initial);
    const inventory = new Inventory(initial);
    assert.deepEqual(initial, initialBefore);
    assert.deepEqual(inventory.list(), [
      { sku: 'notebook', quantity: 1 },
      { sku: 'pen', quantity: 5 },
    ]);

    assert.equal(inventory.get('pen'), 5);
    assert.equal(inventory.get('missing'), 0);
    assert.equal(inventory.add('pen', 2), 7);
    assert.equal(inventory.add('eraser', 4), 4);
    assert.equal(inventory.remove('pen', 7), 0);
    assert.equal(inventory.get('pen'), 0);
    assert.equal(inventory.remove('eraser', 1), 3);
    assert.equal(inventory.add('Pen', 1), 1);
    assert.equal(inventory.get('Pen'), 1);
    assert.equal(inventory.get('pen'), 0);
    assert.deepEqual(inventory.list(), [
      { sku: 'Pen', quantity: 1 },
      { sku: 'eraser', quantity: 3 },
      { sku: 'notebook', quantity: 1 },
    ]);

    const snapshot = inventory.list();
    snapshot[0].quantity = 999;
    snapshot.push({ sku: 'fake', quantity: 1 });
    assert.equal(inventory.get('Pen'), 1);
    assert.equal(inventory.get('fake'), 0);
    assert.notEqual(inventory.list(), snapshot);
    assert.deepEqual(inventory.list(), [
      { sku: 'Pen', quantity: 1 },
      { sku: 'eraser', quantity: 3 },
      { sku: 'notebook', quantity: 1 },
    ]);

    assert.throws(() => inventory.remove('missing', 1), Error);
    assert.throws(() => inventory.remove('eraser', 99), Error);
    assert.throws(() => inventory.add('eraser', 0), Error);
    assert.throws(() => inventory.get(' bad '), Error);
    assert.throws(() => inventory.remove('eraser', 1.5), Error);
    assert.throws(() => new Inventory(null), Error);
    assert.throws(() => new Inventory([null]), Error);
    assert.throws(() => new Inventory([{ sku: '', quantity: 1 }]), Error);
    assert.throws(() => new Inventory([{ sku: 'valid', quantity: 0 }]), Error);

    assert.deepEqual(new Inventory().list(), []);
    return {
      passed: true,
      summary: 'SKU and quantity validation, duplicate seeding, add/remove/get semantics, sorting, snapshots, and immutability passed',
    };
  } catch (error) {
    return { passed: false, summary: error instanceof Error ? error.message : String(error) };
  }
}
