export function formatCell(value) {
  return String(value ?? '');
}

export function escapeCell(value) {
  return formatCell(value);
}
