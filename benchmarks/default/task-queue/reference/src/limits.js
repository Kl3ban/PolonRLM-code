export function assertConcurrency(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError('concurrency must be a positive safe integer');
  }
  return value;
}
