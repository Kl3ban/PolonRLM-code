export function escapeHtml(value) {
  return String(value).replace(/</g, '&lt;');
}
