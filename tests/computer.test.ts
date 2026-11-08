import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ComputerSession, desktopKeyCodes, registerComputerTool, type DesktopBackend } from '../src/tools/computer.js';
import { defaultSettings } from '../src/core/config.js';
import { Permissions } from '../src/core/permissions.js';
import { Workspace } from '../src/tools/workspace.js';
import { ToolRegistry } from '../src/tools/registry.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=';
const window = { id: '123', pid: 98765, title: 'Fixture', process: 'fixture', bounds: [100, 200, 800, 600] };
function fixture(now = () => 0) {
  const calls: Record<string, unknown>[] = [];
  let fail = false;
  const backend: DesktopBackend = async request => {
    calls.push(request); if (fail) throw new Error('native capture failed');
    if (request.action === 'list') return { windows: [window, { ...window, id: '999', process: 'LockApp' }] };
    return { windowId: '123', pid: 98765, title: 'Fixture', bounds: window.bounds, imageWidth: 400, imageHeight: 300, png, elements: [{ name: 'Save', type: 'Button', enabled: true, password: false, x: 100, y: 80, width: 100, height: 40 }] };
  };
  return { session: new ComputerSession(backend, now), backend, calls, fail: () => { fail = true; } };
}
const context = () => ({ mode: 'BUILD' as const, signal: new AbortController().signal });

test('computer targets only enumerated windows, attaches images, scales coordinates and consumes snapshots', async () => {
  const f = fixture(); const images: unknown[] = []; const ctx = { ...context(), onImage: (image: unknown) => images.push(image) };
  await assert.rejects(f.session.execute({ action: 'observe', windowId: '123' }, ctx), /Najpierw list/);
  const list = await f.session.execute({ action: 'list' }, ctx) as any;
  assert.equal(list.windows.length, 1);
  const observation = await f.session.execute({ action: 'observe', windowId: '123' }, ctx) as any;
  assert.equal(images.length, 1); assert.equal(JSON.stringify(observation).includes(png), false);
  await f.session.execute({ action: 'click', snapshotId: observation.snapshotId, element: 0 }, ctx);
  assert.deepEqual(f.calls.at(-1)?.bounds, window.bounds);
  assert.equal(f.calls.at(-1)?.x, 150); assert.equal(f.calls.at(-1)?.y, 100);
  await assert.rejects(f.session.execute({ action: 'click', snapshotId: observation.snapshotId, x: 10, y: 10 }, ctx), /Snapshot expired/);
});

test('computer rejects expired snapshots, unsupported keys and replays after native failure', async () => {
  let now = 0; const f = fixture(() => now); const ctx = context();
  await f.session.execute({ action: 'list' }, ctx);
  const first = await f.session.execute({ action: 'observe', windowId: '123' }, ctx) as any;
  now = 61000;
  await assert.rejects(f.session.execute({ action: 'type', snapshotId: first.snapshotId, text: 'hello' }, ctx), /Snapshot expired/);
  const second = await f.session.execute({ action: 'observe', windowId: '123' }, ctx) as any;
  f.fail();
  await assert.rejects(f.session.execute({ action: 'key', snapshotId: second.snapshotId, keys: ['ENTER'] }, ctx), /native capture/);
  await assert.rejects(f.session.execute({ action: 'key', snapshotId: second.snapshotId, keys: ['ENTER'] }, ctx), /Snapshot expired/);
  assert.deepEqual(desktopKeyCodes(['CTRL', 'A']), [17, 65]);
  assert.throws(() => desktopKeyCodes(['WIN', 'R']), /Nieobsługiwany/);
});

test('invisible 10x10 grid maps cell centers to window pixels without an overlay request', async () => {
  const f = fixture(); const ctx = context();
  await f.session.execute({ action: 'list' }, ctx);
  const observed = await f.session.execute({ action: 'observe', windowId: '123' }, ctx) as any;
  assert.equal(observed.grid.columns, 10);
  await f.session.execute({ action: 'click', snapshotId: observed.snapshotId, cell: 100 }, ctx);
  assert.equal(f.calls.at(-1)?.x, 760); assert.equal(f.calls.at(-1)?.y, 570);
  assert.ok(!f.calls.some(call => 'overlay' in call));
});

test('taskbar grid adapts to its wide, short screenshot', async () => {
  const calls: Record<string, unknown>[] = [];
  const target = { id: '456', pid: 12345, title: 'Windows taskbar', process: 'explorer', bounds: [0, 1032, 1920, 48] };
  const backend: DesktopBackend = async request => {
    calls.push(request);
    if (request.action === 'list') return { windows: [target] };
    return { windowId: target.id, pid: target.pid, title: target.title, bounds: target.bounds, imageWidth: 1280, imageHeight: 32, png, elements: [] };
  };
  const session = new ComputerSession(backend);
  const ctx = context();
  await session.execute({ action: 'list' }, ctx);
  const observed = await session.execute({ action: 'observe', windowId: target.id }, ctx) as any;
  assert.deepEqual(observed.grid, { columns: 64, rows: 1, cells: '1..columns, left-to-right. One-row grid adapts to the narrow taskbar; no overlay is displayed.' });
  await session.execute({ action: 'click', snapshotId: observed.snapshotId, cell: 64 }, ctx);
  assert.equal(calls.at(-1)?.x, 1905);
  assert.equal(calls.at(-1)?.y, 24);
  const fresh = await session.execute({ action: 'observe', windowId: target.id }, ctx) as any;
  await assert.rejects(session.execute({ action: 'click', snapshotId: fresh.snapshotId, cell: 65 }, ctx), /out of range/);
});

test('computer is available in review but never calls native backend without permission', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'polon-computer-')); t.after(() => rm(root, { recursive: true, force: true }));
  const settings = defaultSettings(); settings.permissions = 'workspace';
  const permissions = new Permissions(settings); const workspace = await Workspace.open(root, permissions);
  const registry = new ToolRegistry(permissions, 20000); const f = fixture(); registerComputerTool(registry, workspace, f.backend);
  assert.ok(registry.specs('REVIEW').some(tool => tool.name === 'computer_use'));
  await assert.rejects(registry.execute('computer_use', { action: 'list' }, { ...context(), mode: 'REVIEW' }), /Approval denied/);
  assert.equal(f.calls.length, 0);
  permissions.approve = async () => true;
  await registry.execute('computer_use', { action: 'list' }, { ...context(), mode: 'REVIEW' }); assert.equal(f.calls.length, 1);
  await assert.rejects(registry.execute('computer_use', { action: 'observe', windowId: '123' }, { ...context(), vision: false }), /vision/);
  assert.equal(f.calls.length, 1);
});

test('invalid desktop arguments preserve the snapshot until input reaches the backend', async () => {
  const f = fixture(); const ctx = context();
  await f.session.execute({ action: 'list' }, ctx);
  const observed = await f.session.execute({ action: 'observe', windowId: '123' }, ctx) as any;
  const id = observed.snapshotId;
  assert.match(observed.interactionHint, /No accessible editable field/);
  assert.equal(observed.coordinateSpace.y, '0 <= y < 300');
  await assert.rejects(f.session.execute({ action: 'fill', snapshotId: id, x: 250, y: 955, text: 'hello' }, ctx), /fill/);
  await assert.rejects(f.session.execute({ action: 'fill', snapshotId: id, element: 0, text: 'hello' }, ctx), /fill/);
  await assert.rejects(f.session.execute({ action: 'click', snapshotId: 'wrong-id', x: 250, y: 100 }, ctx), /snapshotId/);
  await assert.rejects(f.session.execute({ action: 'click', snapshotId: id, x: 250, y: 955 }, ctx), /400x300/);
  await assert.rejects(f.session.execute({ action: 'click', snapshotId: id, element: 0, x: 250, y: 100 }, ctx), /OR/);
  await assert.rejects(f.session.execute({ action: 'type', snapshotId: id, keys: ['hello'] }, ctx), /text/);
  await assert.rejects(f.session.execute({ action: 'key', snapshotId: id, keys: ['CTRL'] }, ctx), /keys/);
  assert.equal(f.calls.length, 2, 'validation must not call the desktop backend');
  const clicked = await f.session.execute({ action: 'click', snapshotId: id, x: 250, y: 100 }, ctx) as any;
  assert.notEqual(clicked.snapshotId, id);
  assert.equal(f.calls.at(-1)?.x, 500);
  assert.equal(f.calls.at(-1)?.y, 200);
  await assert.rejects(f.session.execute({ action: 'click', snapshotId: id, x: 250, y: 100 }, ctx), /snapshotId/);
  const typed = await f.session.execute({ action: 'type', snapshotId: clicked.snapshotId, text: 'hello' }, ctx) as any;
  assert.match(typed.next, new RegExp(typed.snapshotId));
  assert.equal(f.calls.at(-1)?.text, 'hello');
});

test('fill and targeted keys use native element bounds exactly once on scaled captures', async () => {
  const f = fixture(); const calls: Record<string, unknown>[] = [];
  const backend: DesktopBackend = async (request, signal) => {
    calls.push(request);
    const result = await f.backend(request, signal) as any;
    if (result.elements) result.elements[0].type = 'ControlType.Edit';
    return result;
  };
  const session = new ComputerSession(backend); const ctx = context();
  await session.execute({ action: 'list' }, ctx);
  let screen = await session.execute({ action: 'observe', windowId: '123' }, ctx) as any;
  assert.match(screen.interactionHint, /editable element/);
  screen = await session.execute({ action: 'fill', snapshotId: screen.snapshotId, element: 0, text: 'hello' }, ctx) as any;
  assert.equal(calls.at(-1)?.x, 150); assert.equal(calls.at(-1)?.y, 100);
  await session.execute({ action: 'key', snapshotId: screen.snapshotId, element: 0, keys: ['CTRL', 'A'] }, ctx);
  assert.equal(calls.at(-1)?.x, 150); assert.equal(calls.at(-1)?.y, 100);
});
