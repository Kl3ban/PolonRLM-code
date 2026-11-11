export function shouldRetryStatus(status) {
  return status >= 500;
}
