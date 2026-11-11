import { applyEnv } from './env.js';
import { deepMerge } from './merge.js';

export function resolveConfig(defaults, user = {}, env = {}) {
  return applyEnv(deepMerge(defaults, user), env);
}
