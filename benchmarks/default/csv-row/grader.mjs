import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function grade(root) {
  const { parseCsvRow } = await import(pathToFileURL(path.join(root, 'src', 'csv.js')).href);
  const checks = [
    JSON.stringify(parseCsvRow('a,b,c')) === JSON.stringify(['a', 'b', 'c']),
    JSON.stringify(parseCsvRow('a,"b,c",d')) === JSON.stringify(['a', 'b,c', 'd']),
    JSON.stringify(parseCsvRow('"a""b",z')) === JSON.stringify(['a"b', 'z']),
    JSON.stringify(parseCsvRow(' x ," y ",z')) === JSON.stringify([' x ', ' y ', 'z']),
    JSON.stringify(parseCsvRow('')) === JSON.stringify(['']),
  ];
  let unclosedRejected = false;
  let invalidQuoteRejected = false;
  let suffixRejected = false;
  try { parseCsvRow('"open'); } catch (error) { unclosedRejected = error instanceof SyntaxError; }
  try { parseCsvRow('ab"cd'); } catch (error) { invalidQuoteRejected = error instanceof SyntaxError; }
  try { parseCsvRow('"a"x'); } catch (error) { suffixRejected = error instanceof SyntaxError; }
  checks.push(unclosedRejected, invalidQuoteRejected, suffixRejected);
  const passed = checks.every(Boolean);
  return { passed, summary: `${checks.filter(Boolean).length}/${checks.length} checks passed` };
}
