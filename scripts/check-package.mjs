import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run this check through npm so npm_execpath is available.');

const output = execFileSync(process.execPath, [npmCli, 'pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' });
const [pack] = JSON.parse(output);
assert.ok(pack?.files?.length, 'npm pack returned no file list.');

const unexpected = pack.files
  .map(file => file.path)
  .filter(file => /(?:^|\/)__pycache__(?:\/|$)|\.py[co]$|^docs\/(?:tool-review-live|web-live-check|audit-progress|STATUS)(?:\.|\/|$)|\.log$|(?:^|\/)\.env(?:\.|\/|$)|(?:^|\/)credentials(?:\/|$)|\.(?:sqlite(?:-[^/]+)?|db(?:-[^/]+)?|pem|p12|key|dpapi)$/i.test(file));

assert.deepEqual(unexpected, [], `Unexpected local or secret-bearing files in npm package:\n${unexpected.join('\n')}`);
console.log(`Package contents OK (${pack.files.length} files; no local reports, secrets, or Python bytecode).`);
