export function formatCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('numeric CSV cells must be finite');
    }
    return String(value);
  }
  throw new TypeError('unsupported CSV cell value');
}

export function escapeCell(value) {
  const text = formatCell(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}
