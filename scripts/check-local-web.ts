import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { defaultSettings } from '../src/core/config.js';
import { Permissions } from '../src/core/permissions.js';
import { Workspace } from '../src/tools/workspace.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { registerNetworkTools } from '../src/tools/network.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'polon-local-web-'));
const settings = { ...defaultSettings(), permissions: 'workspace' as const };
const workspace = await Workspace.open(root, new Permissions(settings));
const registry = new ToolRegistry(workspace.permissions, 15000);
registerNetworkTools(registry, workspace, settings);
const checks: Record<string, unknown>[] = [];
const context = { mode: 'BUILD' as const, signal: AbortSignal.timeout(90000) };
try {
  for (const [tool, args] of [
    ['web_search', { query: 'JanuszGPT', max_results: 6 }],
    ['web_search', { query: 'JanuszGPT', max_results: 6 }],
    ['read_webpage', { url: 'https://github.com/python/cpython/blob/main/README.rst', focus_query: 'Python programming language' }],
    ['github_repo_inspector', { repo_url: 'https://github.com/python/cpython', subpath: 'Include' }],
    ['download_to_disk', { url: 'https://raw.githubusercontent.com/python/cpython/main/LICENSE', save_filename: 'python-license.txt' }],
  ] as const) {
    const start = Date.now(), output = await registry.execute(tool, args, context), value = JSON.parse(output);
    if (tool === 'web_search') { assert.ok(Array.isArray(value) && value.length > 0); assert.ok(value.every(item => /^https?:\/\//.test(item.url))); }
    if (tool === 'read_webpage') { assert.match(value.url, /raw\.githubusercontent\.com/); assert.ok(value.content.length > 20); }
    if (tool === 'github_repo_inspector') assert.ok(value.entries.length > 0);
    if (tool === 'download_to_disk') {
      assert.ok((await realpath(value.saved_path)).startsWith(path.join(workspace.root, 'agent_workspace', 'downloads') + path.sep));
      assert.equal(createHash('sha256').update(await readFile(value.saved_path)).digest('hex'), value.sha256);
    }
    checks.push({ tool, ms: Date.now() - start, bytesReturned: Buffer.byteLength(output), ...(tool === 'web_search' ? { results: value.length } : {}), ...(tool === 'download_to_disk' ? { size: value.size_bytes, sha256: value.sha256 } : {}) });
  }
  await assert.rejects(registry.execute('read_webpage', { url: 'http://127.0.0.1/private' }, context), /SSRF|lokaln|prywatn/);
  checks.push({ tool: 'read_webpage', case: 'loopback rejected', passed: true });
  const report = { date: new Date().toISOString(), transport: 'ephemeral-python; no search APIs', checks };
  await writeFile('docs/network-integration-check.json', JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2));
} finally { await registry.close(); await rm(root, { recursive: true, force: true }); }
