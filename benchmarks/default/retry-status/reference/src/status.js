export function shouldRetryStatus(status) {
  if (!Number.isFinite(status)) return false;
  if (status === 408 || status === 425 || status === 429) return true;
  return status >= 500 && status < 600;
}
