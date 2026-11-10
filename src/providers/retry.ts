export const PROVIDER_RETRY_DELAY_MS = 10_000;

type ErrorFields = Record<string, unknown>;

function record(value: unknown): ErrorFields {
  return value !== null && typeof value === 'object' ? value as ErrorFields : {};
}

export function isRetryableProviderError(error: unknown): boolean {
  const visited = new Set<object>();
  let current: unknown = error;
  const transient = /high demand|temporarily busy|rate.?limit|too many requests|overload|service unavailable|bad gateway|gateway timeout|fetch failed|network error|socket hang up|connection (?:reset|refused|closed)|ECONN(?:RESET|REFUSED|ABORTED)|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EPIPE|UND_ERR_CONNECT_TIMEOUT|timed?\s*out|\btimeout\b/i;
  const billingRequired = /\b(?:wallet|account )?balance is insufficient\b|\binsufficient (?:wallet |account )?(?:balance|credits?|funds)\b|\bpayment required\b/i;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth++) {
    if (typeof current !== 'object' && typeof current !== 'function') {
      if (transient.test(String(current))) return true;
      break;
    }
    const item = current as ErrorFields;
    if (visited.has(item)) break;
    visited.add(item);
    const response = record(item.response);
    const metadata = record(item.$metadata);
    const statusCode = Number(item.statusCode ?? item.status ?? response.status ?? metadata.httpStatusCode);
    // HTTP 402 indicates a billing/payment requirement for providers such as TeamoRouter.
    // Do not let a vague upstream "busy" message turn it into a ten-second retry loop.
    if (statusCode === 402) return false;
    if ([408, 425, 429, 500, 502, 503, 504, 529].includes(statusCode)) return true;
    const text = [item.name, item.message, item.code].filter(value => typeof value === 'string').join(' ');
    if (billingRequired.test(text)) return false;
    if (transient.test(text)) return true;
    current = item.cause;
  }
  return false;
}
