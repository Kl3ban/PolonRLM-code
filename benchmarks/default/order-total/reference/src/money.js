function assertNonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

export function percentageOf(cents, percent) {
  assertNonNegativeInteger(cents, 'cents');
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    throw new RangeError('percent must be an integer from 0 to 100');
  }
  return Math.round((cents * percent) / 100);
}
