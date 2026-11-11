import assert from 'node:assert/strict';
import { test } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { defaultSettings, settingsSchema } from '../src/core/config.js';
import { installWindowsSandboxOnDemand, SandboxExecutor, windowsGrantReadDenies } from '../src/tools/sandbox.js';
import { dockerRunArgs } from '../src/tools/docker-sandbox.js';

test('sandbox settings default to automatic isolation with no network hosts', () => {
  const settings = defaultSettings();
  assert.equal(settings.sandboxMode, 'auto');
  assert.equal(settings.sandboxDockerImage, 'node:24-bookworm-slim');
  assert.deepEqual(settings.sandboxNetworkDomains, []);
  assert.deepEqual(settingsSchema.parse({ ...settings, sandboxNetworkDomains: ['registry.npmjs.org', '*.githubusercontent.com:443'] }).sandboxNetworkDomains, ['registry.npmjs.org', '*.githubusercontent.com:443']);
  assert.equal(settingsSchema.parse({ ...settings, sandboxMode: 'docker' }).sandboxMode, 'docker');
  assert.throws(() => settingsSchema.parse({ ...settings, sandboxNetworkDomains: ['example.com:70000'] }));
});

test('Docker sandbox argv keeps only the project mount and no network', () => {
  const args = dockerRunArgs({ image: 'node:24-bookworm-slim', workspace: process.cwd(), cwd: path.join(process.cwd(), 'src'), command: '/bin/sh', args: ['-c', 'echo docker-ok'] });
  assert.ok(args.includes('--network'));
  assert.equal(args[args.indexOf('--network') + 1], 'none');
  assert.ok(args.includes(`${path.resolve(process.cwd())}:/workspace`));
  assert.ok(args.includes('/workspace/src'));
  assert.equal(args.at(-1), 'echo docker-ok');
  assert.ok(args.includes('--read-only'));
  assert.throws(() => dockerRunArgs({ image: 'node:24', workspace: process.cwd(), cwd: path.dirname(process.cwd()), command: '/bin/sh', args: ['-c', 'pwd'] }), /inside the project workspace/);
  if (process.platform === 'win32') {
    assert.throws(() => dockerRunArgs({ image: 'node:24', workspace: process.cwd(), cwd: process.cwd(), command: 'powershell.exe', args: ['-Command', 'pwd'] }), /cannot execute PowerShell/);
  }
});

test('sandbox off mode never wraps or starts a command', async () => {
  const settings = defaultSettings(); settings.sandboxMode = 'off';
  const sandbox = new SandboxExecutor(settings, process.cwd());
  const status = await sandbox.status(process.cwd());
  assert.equal(status.available, false);
  assert.match(status.reason ?? '', /disabled/i);
  const command = await sandbox.prepare('program-that-must-not-run', ['arg'], process.cwd(), new AbortController().signal);
  assert.equal(command.sandboxed, false);
  assert.equal(command.command, 'program-that-must-not-run');
  assert.match(command.reason ?? '', /disabled/i);
  await command.cleanup();
  await Promise.all([sandbox.close(), sandbox.close()]);
  await assert.rejects(sandbox.prepare('program-that-must-not-run', ['arg'], process.cwd(), new AbortController().signal), /already closed/i);
});

test('required mode fails closed before preparing a host command', async () => {
  const settings = defaultSettings(); settings.sandboxMode = 'required';
  const sandbox = new SandboxExecutor(settings, process.cwd());
  sandbox.status = async () => ({ mode: 'required', available: false, backend: 'test', reason: 'not provisioned' });
  await assert.rejects(sandbox.prepare('program-that-must-not-run', ['arg'], process.cwd(), new AbortController().signal), /No command was run/);
  await sandbox.close();
});

test('Windows sandbox denies existing grants outside the selected project', () => {
  assert.deepEqual(windowsGrantReadDenies('C:\\work\\app', [
    'C:\\work\\app',
    'C:\\work\\app\\nested',
    'C:\\work\\other',
    'C:\\work',
  ]), ['C:\\work\\other', 'C:\\work']);
});

test('explicit Windows sandbox setup skips profile access and keeps loopback closed', async () => {
  let options: any;
  const expected = { cancelled: true } as Awaited<ReturnType<typeof import('@anthropic-ai/sandbox-runtime').installWindowsSandboxAsync>>;
  const result = await installWindowsSandboxOnDemand(os.tmpdir(), async value => { options = value; return expected; }, 'win32');
  assert.equal(result, expected);
  assert.equal(options.skipProfileGrant, true);
  assert.equal(options.allowLoopback, false);
  assert.match(options.srtWin.exe, /srt-win\.exe$/i);
});

test('Windows sandbox setup refuses unsupported hosts without invoking the installer', async () => {
  let called = false;
  await assert.rejects(installWindowsSandboxOnDemand(process.cwd(), async () => { called = true; return {} as any; }, 'linux'), /only on Windows/i);
  assert.equal(called, false);
});

test('Windows sandbox setup refuses to elevate an installer inside the writable project', async () => {
  let called = false;
  await assert.rejects(installWindowsSandboxOnDemand(process.cwd(), async () => { called = true; return {} as any; }, 'win32'), /inside the writable project/i);
  assert.equal(called, false);
});
