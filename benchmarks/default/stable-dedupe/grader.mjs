import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function grade(root) {
  const { dedupe } = await import(pathToFileURL(path.join(root, 'src', 'dedupe.js')).href);
  const first = { id: 'a', n: 1 };
  const duplicate = { id: 'a', n: 2 };
  const second = { id: 'b', n: 3 };
  const input = [first, duplicate, second];
  const before = JSON.stringify(input);
  const output = dedupe(input);
  const checks = [
    Array.isArray(output),
    output.length === 2,
    output[0] === first,
    output[1] === second,
    JSON.stringify(input) === before,
  ];
  let invalidRejected = false;
  try { dedupe('not-an-array'); } catch (error) { invalidRejected = error instanceof TypeError; }
  checks.push(invalidRejected);
  const passed = checks.every(Boolean);
  return { passed, summary: `${checks.filter(Boolean).length}/${checks.length} checks passed` };
}
