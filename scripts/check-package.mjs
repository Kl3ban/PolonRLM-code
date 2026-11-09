import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run this check through npm so npm_execpath is available.');

const output = execFileSync(process.execPath, [npmCli, 'pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' });
const [pack] = JSON.parse(output);
assert.ok(pack?.files?.length, 'npm pack returned no file list.');

const unexpected = pack.files
  .map(file => file.path)
  .filter(file => /(?:^|\/)__pycache__(?:\/|$)|\.py[co]$|^docs\/(?:tool-review-live|web-live-check|audit-progress|STATUS)(?:\.|\/|$)|\.log$|(?:^|\/)\.env(?:\.|\/|$)|(?:^|\/)credentials(?:\/|$)|\.(?:sqlite(?:-[^/]+)?|db(?:-[^/]+)?|pem|p12|key|dpapi)$/i.test(file));

assert.deepEqual(unexpected, [], `Unexpected local or secret-bearing files in npm package:\n${unexpected.join('\n')}`);
const credentialPattern = /AQ\.[A-Za-z0-9_-]{30,}|AIza[0-9A-Za-z_-]{30,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9_-]{30,}/;
const embeddedCredentials = [];
for (const file of pack.files) {
  const contents = await readFile(path.resolve(file.path), 'utf8');
  if (credentialPattern.test(contents)) embeddedCredentials.push(file.path);
}

assert.deepEqual(embeddedCredentials, [], `Credential-shaped strings found in npm package files:\n${embeddedCredentials.join('\n')}`);
console.log(`Package contents OK (${pack.files.length} files; no local reports, credentials, or Python bytecode).`);
