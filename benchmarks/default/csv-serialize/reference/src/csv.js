import { escapeCell } from './cell.js';

export function serializeCsv(headers, rows) {
  if (!Array.isArray(headers) || headers.length === 0) {
    throw new TypeError('headers must be a non-empty array');
  }
  const seen = new Set();
  for (const header of headers) {
    if (typeof header !== 'string' || header.length === 0) {
      throw new TypeError('headers must be non-empty strings');
    }
    if (seen.has(header)) {
      throw new TypeError(`duplicate header: ${header}`);
    }
    seen.add(header);
  }
  if (!Array.isArray(rows)) {
    throw new TypeError('rows must be an array');
  }

  const lines = [headers.map(escapeCell).join(',')];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== headers.length) {
      throw new TypeError('each row must match the header width');
    }
    lines.push(row.map(escapeCell).join(','));
  }
  return lines.join('\n');
}
