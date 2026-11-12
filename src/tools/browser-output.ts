import { safeText } from '../core/secrets.js';

export function safeBrowserUrl(value: string): string {
  try { const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return safeText(url.href); }
  catch { return ''; }
}

export function safeDiagnosticText(value: string): string {
  return safeText(value)
    .replace(/\b(Bearer\s+)[^\s"'<>]+/gi, '$1[REDACTED]')
    .replace(/\b([\w.-]*(?:api[_-]?key|access[_-]?token|token|secret|password|cookie|credential)[\w.-]*\s*[=:]\s*)["']?[^\s"'&,;<>]+/gi, '$1[REDACTED]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, safeBrowserUrl);
}

/** Keep JSON valid under the output budget. Mark every omitted branch instead of slicing JSON. */
export function browserReport(value: unknown, maxChars: number): string {
  const clean = (item: unknown): any => {
    if (typeof item === 'string') return safeDiagnosticText(item);
    if (Array.isArray(item)) return item.map(clean);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, clean(child)]));
    return item;
  };
  const report = clean(value);
  let output = JSON.stringify(report);
  if (output.length <= maxChars) return output;
  report.truncated = true;
  // Reduce the largest branch, preserving top-level IDs, counts and field names.
  for (let pass = 0; pass < 100 && output.length > maxChars; pass++) {
    let largest: { parent: any; key: string; size: number; value: any } | undefined;
    const visit = (parent: any) => {
      for (const [key, child] of Object.entries(parent)) {
        if (['sessionId', 'tabId', 'frameId', 'snapshotId', 'ref'].includes(key)) continue;
        const size = JSON.stringify(child)?.length ?? 0;
        if ((Array.isArray(child) && child.length > 0) || (typeof child === 'string' && child.length > 100)) {
          if (!largest || size > largest.size) largest = { parent, key, size, value: child };
        } else if (child && typeof child === 'object') visit(child);
      }
    };
    visit(report);
    const branch = largest as { parent: any; key: string; size: number; value: any } | undefined;
    if (!branch) break;
    if (Array.isArray(branch.value)) {
      branch.parent[branch.key] = branch.value.slice(0, Math.max(0, branch.value.length - Math.max(1, Math.ceil(branch.value.length / 4))));
      branch.parent[`${branch.key}Truncated`] = true;
    } else branch.parent[branch.key] = branch.value.slice(0, Math.max(80, Math.floor(branch.value.length / 2))) + '…';
    output = JSON.stringify(report);
  }
  return output.length <= maxChars ? output : JSON.stringify({ truncated: true, message: 'Report exceeds maxChars. Narrow the target or increase maxChars.' });
}
