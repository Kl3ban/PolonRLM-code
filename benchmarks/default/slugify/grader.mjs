import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function grade(root) {
  const { slugify } = await import(pathToFileURL(path.join(root, 'src', 'slug.js')).href);
  const checks = [
    slugify('Hello, World!') === 'hello-world',
    slugify('  A  B  ') === 'a-b',
    slugify('C++ / C#') === 'c-c',
    slugify('already-slug') === 'already-slug',
    slugify('') === '',
    slugify('---') === '',
  ];
  let invalidRejected = false;
  try { slugify(42); } catch (error) { invalidRejected = error instanceof TypeError; }
  checks.push(invalidRejected);
  const passed = checks.every(Boolean);
  return { passed, summary: `${checks.filter(Boolean).length}/${checks.length} checks passed` };
}
