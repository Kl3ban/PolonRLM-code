import { DEFAULT_CONFIG } from './defaults.js';
import { deepMerge } from './merge.js';

export function resolveConfig(user = {}, workspace = {}) {
  return deepMerge(DEFAULT_CONFIG, user, workspace);
}
