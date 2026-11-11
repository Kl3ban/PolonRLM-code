export function expiryFor(now, ttlMs) {
  return ttlMs === 0 ? Infinity : now() + ttlMs;
}
