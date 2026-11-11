export function parseCsvRow(line) {
  const fields = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (quoted) {
      if (character !== '"') { value += character; continue; }
      if (line[index + 1] === '"') { value += '"'; index++; continue; }
      quoted = false;
      if (index + 1 < line.length && line[index + 1] !== ',') throw new SyntaxError('Invalid character after closing quote');
      continue;
    }
    if (character === ',') { fields.push(value); value = ''; continue; }
    if (character === '"') {
      if (value.length) throw new SyntaxError('Quote in an unquoted field');
      quoted = true;
      continue;
    }
    value += character;
  }
  if (quoted) throw new SyntaxError('Unclosed quote');
  fields.push(value);
  return fields;
}
