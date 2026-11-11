import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function grade(root) {
  const { formatBytes } = await import(pathToFileURL(path.join(root, 'src', 'format.js')).href);
  const checks = [
    formatBytes(0) === '0 B',
    formatBytes(1) === '1 B',
    formatBytes(1024) === '1 KiB',
    formatBytes(1536) === '1.5 KiB',
    formatBytes(1048576) === '1 MiB',
    formatBytes(1572864) === '1.5 MiB',
    formatBytes(1024 ** 3) === '1 GiB',
    formatBytes(1024 ** 4) === '1 TiB',
    formatBytes(-1) === '0 B',
    formatBytes(Number.NaN) === '0 B',
    formatBytes(Number.POSITIVE_INFINITY) === '0 B',
  ];
  const passed = checks.every(Boolean);
  return { passed, summary: `${checks.filter(Boolean).length}/${checks.length} checks passed` };
}
