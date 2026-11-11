export function wordWrap(text, width) {
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    if (current === '') {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current += ' ' + word;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== '') lines.push(current);
  return lines;
}
