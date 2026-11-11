export function safeJsonParse(text, fallback = undefined) {
  return JSON.parse(text);
}
