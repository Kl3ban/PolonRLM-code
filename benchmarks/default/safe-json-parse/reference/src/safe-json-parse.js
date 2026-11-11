export function safeJsonParse(text, fallback = undefined) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}
