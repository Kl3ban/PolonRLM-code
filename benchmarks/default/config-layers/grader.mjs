import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

export async function grade(workspace) {
  try {
    const mod = await import(pathToFileURL(`${workspace}/src/index.js`).href + `?grade=${Date.now()}`);
    const { applyEnv, coerceEnvValue, deepMerge, resolveConfig } = mod;
    for (const fn of [applyEnv, coerceEnvValue, deepMerge, resolveConfig]) {
      assert.equal(typeof fn, 'function');
    }

    const defaults = {
      server: { port: 3000, host: 'localhost' },
      flags: ['alpha'],
      enabled: true,
      mode: 'development',
    };
    const overrides = {
      server: { port: 0 },
      flags: ['beta'],
      enabled: false,
      mode: undefined,
    };
    const defaultsBefore = structuredClone(defaults);
    const overridesBefore = { ...overrides, server: structuredClone(overrides.server), flags: [...overrides.flags] };
    const merged = deepMerge(defaults, overrides);
    assert.deepEqual(merged, {
      server: { port: 0, host: 'localhost' },
      flags: ['beta'],
      enabled: false,
      mode: 'development',
    });
    assert.deepEqual(defaults, defaultsBefore);
    assert.deepEqual(overrides, overridesBefore);
    merged.server.host = 'changed.example';
    merged.flags.push('gamma');
    assert.equal(defaults.server.host, 'localhost');
    assert.deepEqual(defaults.flags, ['alpha']);
    assert.deepEqual(deepMerge({ nested: { value: 1 } }, { nested: { extra: 2 } }), {
      nested: { value: 1, extra: 2 },
    });
    assert.deepEqual(deepMerge({ value: 1 }, { value: null }), { value: null });
    assert.deepEqual(deepMerge({ value: 1 }, { value: undefined }), { value: 1 });
    assert.throws(() => deepMerge(null, {}), Error);

    assert.equal(coerceEnvValue('true'), true);
    assert.equal(coerceEnvValue('false'), false);
    assert.equal(coerceEnvValue('null'), null);
    assert.equal(coerceEnvValue('0'), 0);
    assert.equal(coerceEnvValue('-12.5'), -12.5);
    assert.equal(coerceEnvValue('42.0'), 42);
    assert.equal(coerceEnvValue('007'), '007');
    assert.equal(coerceEnvValue('01'), '01');
    assert.equal(coerceEnvValue('1e3'), '1e3');
    assert.equal(coerceEnvValue('+4'), '+4');
    assert.equal(coerceEnvValue('1.'), '1.');
    assert.equal(coerceEnvValue('TRUE'), 'TRUE');
    assert.equal(coerceEnvValue(''), '');
    assert.throws(() => coerceEnvValue(4), Error);

    const baseConfig = {
      server: { port: 3000, flags: { debug: false, trace: true } },
      mode: 'dev',
      name: 'service',
    };
    const baseBefore = structuredClone(baseConfig);
    const env = {
      'server.port': '8080',
      'server.flags.debug': 'true',
      mode: 'production',
      empty: '',
    };
    const envBefore = structuredClone(env);
    assert.deepEqual(applyEnv(baseConfig, env), {
      server: { port: 8080, flags: { debug: true, trace: true } },
      mode: 'production',
      name: 'service',
      empty: '',
    });
    assert.deepEqual(baseConfig, baseBefore);
    assert.deepEqual(env, envBefore);
    const applied = applyEnv(baseConfig, env);
    applied.server.flags.trace = false;
    assert.equal(baseConfig.server.flags.trace, true);

    assert.throws(() => applyEnv(null, {}), Error);
    assert.throws(() => applyEnv({}, null), Error);
    assert.throws(() => applyEnv({}, { '': 'x' }), Error);
    assert.throws(() => applyEnv({}, { 'a..b': 'x' }), Error);
    assert.throws(() => applyEnv({}, { 'a.': 'x' }), Error);
    assert.throws(() => applyEnv({}, { port: 80 }), Error);
    assert.throws(() => applyEnv({ server: 'off' }, { 'server.port': '1' }), Error);

    const layers = resolveConfig(
      { server: { port: 3000, host: 'localhost' }, features: { beta: false }, tags: ['a'] },
      { server: { port: 4000 }, features: { beta: true }, tags: ['b'] },
      { 'server.host': 'example.test', 'server.port': '9000' },
    );
    assert.deepEqual(layers, {
      server: { port: 9000, host: 'example.test' },
      features: { beta: true },
      tags: ['b'],
    });
    assert.equal(typeof layers.server.port, 'number');
    assert.throws(() => resolveConfig(null), Error);

    return {
      passed: true,
      summary: 'deep merging, falsy and undefined handling, typed env coercion, nested override paths, layering, validation, and immutability passed',
    };
  } catch (error) {
    return { passed: false, summary: error instanceof Error ? error.message : String(error) };
  }
}
