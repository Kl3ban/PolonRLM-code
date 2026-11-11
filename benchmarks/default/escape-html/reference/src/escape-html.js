const ENTITIES = new Map([
  ['&', '&amp;'],
  ['<', '&lt;'],
  ['>', '&gt;'],
  ['"', '&quot;'],
  ["'", '&#39;'],
]);

export function escapeHtml(value) {
  if (typeof value !== 'string') throw new TypeError('value must be a string');
  return value.replace(/[&<>"']/g, character => ENTITIES.get(character));
}
