/** Terminal output is data, never terminal commands. Keep only text, tabs and LF. */
export function sanitizeTerminalText(value: string): string {
  return value
    .replace(/(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/g, '')
    .replace(/(?:\u001b[PX^_]|[\u0090\u0098\u009e\u009f])[\s\S]*?(?:\u001b\\|\u009c|$)/g, '')
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[ -/]*[@-Z\\-_]/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}
