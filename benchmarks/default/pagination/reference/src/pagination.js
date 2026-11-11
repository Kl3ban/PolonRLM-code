import { decodeCursor, encodeCursor } from './cursor.js';

export function paginate(items, options = {}) {
  if (!Array.isArray(items)) {
    throw new TypeError('items must be an array');
  }
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('options must be an object');
  }

  const limit = options.limit === undefined ? 10 : options.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError('limit must be an integer from 1 through 100');
  }

  const cursor = options.cursor === undefined ? null : options.cursor;
  if (cursor !== null && typeof cursor !== 'string') {
    throw new TypeError('cursor must be null or a string');
  }
  const offset = cursor === null ? 0 : decodeCursor(cursor);
  if (offset >= items.length) {
    return { items: [], nextCursor: null, hasMore: false };
  }

  const page = items.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const hasMore = nextOffset < items.length;
  return {
    items: page,
    nextCursor: hasMore ? encodeCursor(nextOffset) : null,
    hasMore,
  };
}
