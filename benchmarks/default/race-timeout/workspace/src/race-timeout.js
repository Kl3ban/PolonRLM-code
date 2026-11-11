export class TimeoutError extends Error {
  constructor(ms) {
    super(`Operation timed out after ${ms} ms`);
    this.name = 'TimeoutError';
    this.timeoutMs = ms;
  }
}

export function withTimeout(operation, ms) {
  return Promise.resolve().then(() => operation());
}
