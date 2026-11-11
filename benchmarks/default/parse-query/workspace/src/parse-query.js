export function parseQuery(search) {
  return Object.fromEntries(new URLSearchParams(search));
}
