import { decodeCursor, encodeCursor } from './cursor.js';

export function paginate(items, options = {}) {
  return {
    items: [...items],
    nextCursor: null,
    hasMore: false,
  };
}
