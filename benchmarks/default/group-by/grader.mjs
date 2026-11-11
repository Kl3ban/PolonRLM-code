import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function grade(root) {
  const { groupBy } = await import(pathToFileURL(path.join(root, 'src', 'group.js')).href);
  const input = [{ k: 'b', n: 1 }, { k: 'a', n: 2 }, { k: 'b', n: 3 }];
  const before = JSON.stringify(input);
  const groups = groupBy(input, item => item.k);
  const checks = [
    groups instanceof Map,
    JSON.stringify([...groups.keys()]) === JSON.stringify(['b', 'a']),
    groups.get('b')?.map(item => item.n).join(',') === '1,3',
    groups.get('a')?.[0] === input[1],
    JSON.stringify(input) === before,
  ];
  let invalidRejected = false;
  try { groupBy(input, null); } catch (error) { invalidRejected = error instanceof TypeError; }
  checks.push(invalidRejected);
  const passed = checks.every(Boolean);
  return { passed, summary: `${checks.filter(Boolean).length}/${checks.length} checks passed` };
}
