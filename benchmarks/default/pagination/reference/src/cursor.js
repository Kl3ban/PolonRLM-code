export function encodeCursor(offset) {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new RangeError('offset must be a non-negative safe integer');
  }
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

export function decodeCursor(cursor) {
  if (typeof cursor !== 'string' || cursor.length === 0) {
    throw new TypeError('cursor must be a non-empty string');
  }
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!/^(?:0|[1-9]\d*)$/.test(text)) {
    throw new Error('invalid cursor');
  }
  const offset = Number(text);
  if (!Number.isSafeInteger(offset) || encodeCursor(offset) !== cursor) {
    throw new Error('invalid cursor');
  }
  return offset;
}
