export function retryDelay(attempt, baseMs = 100, maxMs = 2000) {
  if (!Number.isFinite(attempt) || !Number.isFinite(baseMs) || !Number.isFinite(maxMs)) return 0;
  const number = Math.trunc(attempt);
  if (number < 1) return 0;
  const base = Math.max(0, baseMs);
  const cap = Math.max(0, maxMs);
  return Math.min(cap, base * 2 ** (number - 1));
}
