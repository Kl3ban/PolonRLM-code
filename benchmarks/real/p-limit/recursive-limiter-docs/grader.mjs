import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

function hasWarning(text) {
  const normalized = text.toLowerCase().replace(/[`*_]/g, '');
  return /same\s+limit\s+function/.test(normalized)
    && /inside|within|nested|recursive/.test(normalized)
    && /deadlock|starv|inner tasks? (?:never|cannot|can't) run/.test(normalized)
    && /separate\s+(?:limit\s+)?limiter/.test(normalized);
}

export async function grade(workspacePath) {
  const entries = (await readdir(workspacePath)).sort();
  const expectedEntries = ['index.d.ts', 'license', 'readme.md'];
  if (entries.length !== expectedEntries.length || entries.some((entry, index) => entry !== expectedEntries[index])) {
    return { passed: false, summary: 'Keep this fix documentation-only; do not add or remove repository files.' };
  }

  const readme = await readFile(path.join(workspacePath, 'readme.md'), 'utf8');
  const readmeStart = readme.indexOf('### limit(fn, ...args)');
  const readmeEnd = readme.indexOf('### limit.map', readmeStart + 1);
  if (readmeStart < 0 || readmeEnd < 0 || !hasWarning(readme.slice(readmeStart, readmeEnd))) {
    return { passed: false, summary: 'The limit API section must explain the recursive deadlock and separate-limiter workaround.' };
  }

  const declarations = await readFile(path.join(workspacePath, 'index.d.ts'), 'utf8');
  const parameter = declarations.indexOf('@param fn');
  const commentStart = parameter < 0 ? -1 : declarations.lastIndexOf('/**', parameter);
  const commentEnd = parameter < 0 ? -1 : declarations.indexOf('*/', parameter);
  const callableDocs = commentStart < 0 || commentEnd < 0 ? '' : declarations.slice(commentStart, commentEnd);
  if (!hasWarning(callableDocs)) {
    return { passed: false, summary: 'The callable LimitFunction JSDoc must carry the same warning and workaround.' };
  }

  return { passed: true, summary: 'Both user documentation and TypeScript API documentation describe the recursive deadlock and separate-limiter workaround.' };
}
