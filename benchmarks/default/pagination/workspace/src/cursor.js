export function encodeCursor(offset) {
  return String(offset);
}

export function decodeCursor(cursor) {
  return Number(cursor);
}
