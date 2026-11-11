function decodePart(text) {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    throw new TypeError(`malformed percent-encoding in "${text}"`);
  }
}

export function parseQuery(search) {
  if (typeof search !== 'string') throw new TypeError('search must be a string');
  const text = search.startsWith('?') ? search.slice(1) : search;
  const result = {};
  if (text === '') return result;
  for (const pair of text.split('&')) {
    if (pair === '') continue;
    const separator = pair.indexOf('=');
    const rawName = separator === -1 ? pair : pair.slice(0, separator);
    const rawValue = separator === -1 ? '' : pair.slice(separator + 1);
    const name = decodePart(rawName);
    const value = decodePart(rawValue);
    if (name === '') continue;
    result[name] = value;
  }
  return result;
}
