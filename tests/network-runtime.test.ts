import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveNetworkRuntime, setupNetworkRuntime } from '../src/tools/network.js';

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
