import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RecoveryCipher, type RecoveryChangeData } from '../src/core/recovery.js';

test('recovery snapshots are authenticated and readable after reopening the local key', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'polonrlm-recovery-'));
  t.after(async () => { await rm(home, { recursive: true, force: true }); });
  const value: RecoveryChangeData = { path: 'src/file.ts', tool: 'write_file', before: 'secret source before', after: 'secret source after', beforeEncoding: 'utf8', encoding: 'utf8', beforeHash: 'a'.repeat(64), afterHash: 'b'.repeat(64) };
  const first = await RecoveryCipher.open(home);
  const payload = first.seal(value);
  assert.equal(payload.includes(value.before!), false);
  first.close();
  const second = await RecoveryCipher.open(home);
  assert.deepEqual(second.open(payload), value);
  assert.throws(() => second.open(payload.slice(0, -2) + 'xx'));
  second.close();
  const filename = path.join(home, process.platform === 'win32' ? 'recovery-key.dpapi' : 'recovery-key');
  assert.ok((await readFile(filename)).length > 0);
});
