import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

export async function grade(workspace) {
  try {
    const mod = await import(pathToFileURL(`${workspace}/src/index.js`).href + `?grade=${Date.now()}`);
    const { calculateTotal, percentageOf } = mod;
    assert.equal(typeof percentageOf, 'function');
    assert.equal(typeof calculateTotal, 'function');

    assert.equal(percentageOf(199, 10), 20);
    assert.equal(percentageOf(250, 1), 3);
    assert.equal(percentageOf(0, 37), 0);

    const items = [
      { priceCents: 199, quantity: 1, sku: 'notebook' },
      { priceCents: 100, quantity: 2, sku: 'pen' },
    ];
    const options = { discountPercent: 10, taxPercent: 8, shippingCents: 599 };
    const itemsBefore = structuredClone(items);
    const optionsBefore = structuredClone(options);
    assert.deepEqual(calculateTotal(items, options), {
      subtotalCents: 399,
      discountCents: 40,
      taxCents: 29,
      shippingCents: 599,
      totalCents: 987,
    });
    assert.deepEqual(items, itemsBefore);
    assert.deepEqual(options, optionsBefore);

    assert.deepEqual(calculateTotal([]), {
      subtotalCents: 0,
      discountCents: 0,
      taxCents: 0,
      shippingCents: 0,
      totalCents: 0,
    });
    assert.deepEqual(calculateTotal([], { shippingCents: 250 }), {
      subtotalCents: 0,
      discountCents: 0,
      taxCents: 0,
      shippingCents: 250,
      totalCents: 250,
    });
    assert.deepEqual(
      calculateTotal([{ priceCents: 125, quantity: 1 }], { discountPercent: 10, taxPercent: 5 }),
      { subtotalCents: 125, discountCents: 13, taxCents: 6, shippingCents: 0, totalCents: 118 },
    );
    assert.equal(
      calculateTotal([{ priceCents: 1000, quantity: 1 }], { discountPercent: 100, taxPercent: 50 }).totalCents,
      0,
    );
    assert.equal(calculateTotal([{ priceCents: 0, quantity: 3 }], { shippingCents: 0 }).totalCents, 0);

    assert.throws(() => calculateTotal(null), Error);
    assert.throws(() => calculateTotal([{ priceCents: 100, quantity: 0 }]), Error);
    assert.throws(() => calculateTotal([{ priceCents: -1, quantity: 1 }]), Error);
    assert.throws(() => calculateTotal([{ priceCents: 1.5, quantity: 1 }]), Error);
    assert.throws(() => calculateTotal([], { discountPercent: 101 }), Error);
    assert.throws(() => calculateTotal([], { taxPercent: 1.5 }), Error);
    assert.throws(() => calculateTotal([], { shippingCents: -1 }), Error);
    assert.throws(() => calculateTotal([], []), Error);
    assert.throws(() => percentageOf(-1, 10), Error);
    assert.throws(() => percentageOf(100, 101), Error);

    return {
      passed: true,
      summary: 'order subtotals, rounded discount/tax, shipping, empty orders, validation, and input immutability passed',
    };
  } catch (error) {
    return { passed: false, summary: error instanceof Error ? error.message : String(error) };
  }
}
