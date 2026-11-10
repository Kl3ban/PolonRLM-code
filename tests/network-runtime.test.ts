import test from 'node:test';
import assert from 'node:assert/strict';
import { createNetworkRuntimeManager, resolveNetworkRuntime, setupNetworkRuntime } from '../src/tools/network.js';

test('network runtime reuses an interpreter only when all required dependencies are available', async () => {
  let setups = 0;
  const result = await resolveNetworkRuntime('private-python', false, async () => true, async () => { setups++; return 'unexpected-python'; });
  assert.equal(result, 'private-python');
  assert.equal(setups, 0);
});

test('network runtime repairs an interrupted private environment on the next use', async () => {
  let probes = 0, setups = 0;
  const result = await resolveNetworkRuntime('partial-python', false, async python => {
    probes++;
    return python === 'repaired-python';
  }, async () => { setups++; return 'repaired-python'; });
  assert.equal(result, 'repaired-python');
  assert.equal(probes, 2);
  assert.equal(setups, 1);
});

test('network runtime does not modify an explicitly selected interpreter', async () => {
  let setups = 0;
  await assert.rejects(
    resolveNetworkRuntime('custom-python', true, async () => false, async () => { setups++; return 'unexpected-python'; }),
    /POLONRLM_WEB_PYTHON.*required web dependencies/,
  );
  assert.equal(setups, 0);
});

test('setup web validates an explicitly selected interpreter instead of installing elsewhere', async () => {
  const previous = process.env.POLONRLM_WEB_PYTHON;
  process.env.POLONRLM_WEB_PYTHON = process.execPath;
  try {
    await assert.rejects(setupNetworkRuntime(), /POLONRLM_WEB_PYTHON is selected.*unset the variable/);
  } finally {
    if (previous === undefined) delete process.env.POLONRLM_WEB_PYTHON;
    else process.env.POLONRLM_WEB_PYTHON = previous;
  }
});

test('network runtime reports an unsuccessful repair clearly', async () => {
  await assert.rejects(
    resolveNetworkRuntime('partial-python', false, async () => false, async () => 'still-broken-python'),
    /setup finished, but its required dependencies are still missing/,
  );
});

test('cancelled searches stop shared runtime setup only after the last waiter leaves', async () => {
  let setupSignal!: AbortSignal, finishSetup!: (python: string) => void, startSetup!: () => void;
  const setupStarted = new Promise<void>(resolve => { startSetup = resolve; });
  let setupCalls = 0;
  const ensure = createNetworkRuntimeManager(
    () => 'partial-python',
    () => false,
    async python => python === 'installed-python',
    signal => {
      setupCalls++;
      setupSignal = signal!;
      return new Promise<string>((resolve, reject) => {
        finishSetup = resolve;
        signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
        startSetup();
      });
    },
  );
  const firstController = new AbortController();
  const first = ensure(firstController.signal);
  await setupStarted;
  const secondController = new AbortController();
  const second = ensure(secondController.signal);

  firstController.abort(new Error('First search cancelled.'));
  await assert.rejects(first, /First search cancelled/);
  assert.equal(setupSignal.aborted, false, 'the second search still needs the shared installation');
  finishSetup('installed-python');
  assert.equal(await second, 'installed-python');
  assert.equal(setupCalls, 1);
});

test('cancelling the final runtime waiter aborts setup and a later search can retry', async () => {
  let attempts = 0, firstSignal!: AbortSignal, startFirst!: () => void;
  const firstStarted = new Promise<void>(resolve => { startFirst = resolve; });
  const ensure = createNetworkRuntimeManager(
    () => 'partial-python',
    () => false,
    async python => python === 'installed-python',
    signal => {
      attempts++;
      if (attempts > 1) return Promise.resolve('installed-python');
      firstSignal = signal!;
      return new Promise<string>((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
        startFirst();
      });
    },
  );
  const controller = new AbortController();
  const pending = ensure(controller.signal);
  await firstStarted;
  controller.abort(new Error('Last search cancelled.'));
  await assert.rejects(pending, /Last search cancelled/);
  assert.equal(firstSignal.aborted, true);
  assert.equal(await ensure(), 'installed-python');
  assert.equal(attempts, 2);
});
