const PLACEHOLDER = /\{\{\s*([^\s{}.]+(?:\.[^\s{}.]+)*)\s*\}\}/g;

export function render(template, data) {
  if (typeof template !== 'string') throw new TypeError('template must be a string');
  if (data === null || typeof data !== 'object') throw new TypeError('data must be an object');
  return template.replace(PLACEHOLDER, (match, path) => {
    let current = data;
    for (const segment of path.split('.')) {
      if (current === null || typeof current !== 'object' || !Object.hasOwn(current, segment) || current[segment] === undefined) {
        throw new TypeError(`missing path: ${path}`);
      }
      current = current[segment];
    }
    return String(current);
  });
}
