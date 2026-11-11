export function wordWrap(text, width) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  if (!Number.isSafeInteger(width)) throw new TypeError('width must be a safe integer');
  if (width < 1) throw new RangeError('width must be at least 1');

  const words = text.split(/\s+/).filter(word => word.length > 0);
  if (words.length === 0) return [];

  const lines = [];
  let line = words[0];
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index];
    if (line.length + 1 + word.length <= width) {
      line += ' ' + word;
    } else {
      lines.push(line);
      line = word;
    }
  }
  lines.push(line);
  return lines;
}
