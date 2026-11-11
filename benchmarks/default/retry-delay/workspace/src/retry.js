export function retryDelay(attempt, baseMs = 100, maxMs = 2000) {
  if (attempt < 1) return baseMs;
  return Math.min(maxMs, attempt * baseMs);
}
