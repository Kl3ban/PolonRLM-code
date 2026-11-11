import { escapeCell } from './cell.js';

export function serializeCsv(headers, rows) {
  return [headers, ...rows].map(row => row.map(escapeCell).join(',')).join('\n');
}
