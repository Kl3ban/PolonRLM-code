import { deepMerge } from './merge.js';

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parsePath(path) {
  if (typeof path !== 'string' || path.length === 0) {
    throw new TypeError('override path must be a non-empty string');
  }
  const segments = path.split('.');
  if (segments.some(segment => segment.length === 0)) {
    throw new TypeError(`invalid override path: ${path}`);
  }
  return segments;
}

export function coerceEnvValue(value) {
  if (typeof value !== 'string') {
    throw new TypeError('environment values must be strings');
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    const number = Number(value);
    if (Number.isFinite(number)) return Object.is(number, -0) ? 0 : number;
  }
  return value;
}

export function applyEnv(config, overrides) {
  if (!isPlainObject(config)) {
    throw new TypeError('config must be a plain object');
  }
  if (!isPlainObject(overrides)) {
    throw new TypeError('overrides must be a plain object');
  }

  const result = deepMerge(config, {});
  for (const path of Object.keys(overrides).sort()) {
    const segments = parsePath(path);
    const value = coerceEnvValue(overrides[path]);
    let target = result;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index];
      if (!(segment in target)) {
        target[segment] = {};
      } else if (!isPlainObject(target[segment])) {
        throw new TypeError(`cannot traverse non-object at path: ${path}`);
      }
      target = target[segment];
    }
    target[segments[segments.length - 1]] = value;
  }
  return result;
}
