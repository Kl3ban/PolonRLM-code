import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { execa } from 'execa';
import { copyBenchmarkWorkspace, loadBenchmarkTasks, parseGraderResult, syncBenchmarkSubmission } from '../src/benchmarks/pack.js';
import { benchmarkProfile } from '../src/benchmarks/profiles.js';
import { createBenchmarkMatrix, createProviderBenchmarkMatrix, executeBenchmarkMatrix } from '../src/benchmarks/matrix.js';
import { formatBenchmarkComparison, parseBenchmarkReport, summarizeBenchmarkReports } from '../src/benchmarks/reports.js';

const defaultPack = path.resolve(import.meta.dirname, '..', 'benchmarks', 'default');
const yoctoQueuePack = path.resolve(import.meta.dirname, '..', 'benchmarks', 'real', 'yocto-queue');
const pLimitPack = path.resolve(import.meta.dirname, '..', 'benchmarks', 'real', 'p-limit');

test('benchmark profiles compare single-agent, adaptive, and fixed Cortex settings', () => {
  assert.deepEqual(benchmarkProfile(), { name: 'single', settings: { cortex: 0, cortexStrategy: 'fixed', maxAgents: 0, maxDepth: 0 }, subagents: 'disabled' });
  const adaptive = benchmarkProfile('adaptive');
  const fixed = benchmarkProfile('fixed');
  assert.deepEqual(adaptive.settings, { cortex: 5, cortexStrategy: 'adaptive', maxAgents: 3, maxDepth: 1 });
  assert.deepEqual(fixed.settings, { ...adaptive.settings, cortexStrategy: 'fixed' });
  assert.equal(adaptive.subagents, 'enabled');
  assert.equal(fixed.subagents, 'enabled');
});

test('benchmark matrix expands unique model and profile lists in stable order', () => {
  assert.deepEqual(createBenchmarkMatrix('flash-a, flash-b'), [
    { model: 'flash-a', profile: 'single' }, { model: 'flash-b', profile: 'single' },
  ]);
  assert.deepEqual(createBenchmarkMatrix('flash-a', 'adaptive,fixed'), [
    { model: 'flash-a', profile: 'adaptive' }, { model: 'flash-a', profile: 'fixed' },
  ]);
  assert.deepEqual(createBenchmarkMatrix('flash-a,flash-b', 'single,adaptive'), [
    { model: 'flash-a', profile: 'single' }, { model: 'flash-a', profile: 'adaptive' },
    { model: 'flash-b', profile: 'single' }, { model: 'flash-b', profile: 'adaptive' },
  ]);
  assert.deepEqual(createProviderBenchmarkMatrix('qwen=qwen-flash,openrouter=meta/llama-free', 'single,adaptive'), [
    { provider: 'qwen', model: 'qwen-flash', profile: 'single' },
    { provider: 'qwen', model: 'qwen-flash', profile: 'adaptive' },
    { provider: 'openrouter', model: 'meta/llama-free', profile: 'single' },
    { provider: 'openrouter', model: 'meta/llama-free', profile: 'adaptive' },
  ]);
});

test('benchmark matrix rejects ambiguous or invalid selections before making requests', () => {
  assert.throws(() => createBenchmarkMatrix('flash-a'), /at least two runs/);
  assert.throws(() => createBenchmarkMatrix('flash-a,flash-a'), /must not contain duplicates/);
  assert.throws(() => createBenchmarkMatrix('flash-a,flash-b', 'single,single'), /must not contain duplicates/);
  assert.throws(() => createBenchmarkMatrix('flash-a,flash-b', 'unknown'), /accepts single/);
  assert.throws(() => createBenchmarkMatrix('flash-a,,flash-b'), /without empty values/);
  assert.throws(() => createBenchmarkMatrix('x'.repeat(201) + ',flash-b'), /at most 200 characters/);
  assert.throws(() => createProviderBenchmarkMatrix('qwen=qwen-flash,qwen=qwen-flash'), /must not contain duplicates/);
  assert.throws(() => createProviderBenchmarkMatrix('qwen=qwen-flash,openrouter='), /provider=model syntax/);
  assert.throws(() => createProviderBenchmarkMatrix('qwen'), /provider=model syntax/);
  assert.throws(() => createProviderBenchmarkMatrix('=qwen-flash,openrouter=llama'), /provider=model syntax/);
});

test('benchmark matrix runs sequentially and stops after the first incomplete run', async () => {
  const runs = createBenchmarkMatrix('flash-a,flash-b', 'single,adaptive');
  const called: string[] = [];
  let active = false;
  const result = await executeBenchmarkMatrix(runs, async (run, index) => {
    assert.equal(active, false, 'matrix must not overlap provider runs');
    active = true;
    called.push(`${run.model}/${run.profile}`);
    await new Promise(resolve => setTimeout(resolve, 2));
    active = false;
    return { reportPath: `${run.model}-${run.profile}.json`, status: index === 1 ? 'stopped' : 'complete' };
  });
  assert.deepEqual(called, ['flash-a/single', 'flash-a/adaptive']);
  assert.deepEqual(result.completed.map(item => item.result.status), ['complete', 'stopped']);
  assert.equal('failure' in result, false);
});

test('benchmark matrix preserves completed report paths when a run throws', async () => {
  const runs = createBenchmarkMatrix('flash-a,flash-b');
  const failure = new Error('sandbox unavailable');
  const result = await executeBenchmarkMatrix(runs, async run => {
    if (run.model === 'flash-b') throw failure;
    return { reportPath: 'flash-a.json', status: 'complete' };
  });
  assert.deepEqual(result.completed.map(item => item.result.reportPath), ['flash-a.json']);
  assert.equal(result.failure, failure);
});

test('benchmark reports validate, compare runs without requests, and read legacy reports', () => {
  const base = { status: 'complete', startedAt: '2026-11-11T12:00:00.000Z', provider: 'local', model: 'flash-a', taskPack: 'default',
    cases: [{ status: 'passed', durationMs: 1000, toolCalls: 3, toolErrors: 0, usage: { input: 100, output: 20, cached: 0, cost: 0, costKnown: false } }] };
  const first = parseBenchmarkReport({ ...base, version: 2, profile: 'adaptive' });
  const second = parseBenchmarkReport({ ...base, version: 1, model: 'flash-b', cases: [{ ...base.cases[0], status: 'failed', durationMs: 2000, toolErrors: 1, usage: { input: 80, output: 25, cached: 0, cost: 0.01, costKnown: true } }] });
  assert.deepEqual(summarizeBenchmarkReports([first, second]).map(row => ({ profile: row.profile, passed: row.passed, failed: row.failed, input: row.inputTokens })), [
    { profile: 'adaptive', passed: 1, failed: 0, input: 100 }, { profile: 'single', passed: 0, failed: 1, input: 80 },
  ]);
  const output = formatBenchmarkComparison([first, second]);
  assert.match(output, /flash-a/); assert.match(output, /flash-b/); assert.match(output, /unknown/); assert.match(output, /\$0\.01000/);
  assert.throws(() => parseBenchmarkReport({ ...base, version: 3 }), /not a supported/);
  assert.throws(() => parseBenchmarkReport({ ...base, version: 2, profile: 'other' }), /unknown benchmark profile/);
});

test('default task pack has valid unique tasks and private graders', async () => {
  const tasks = await loadBenchmarkTasks(defaultPack);
  assert.ok(tasks.length >= 9);
  assert.ok(tasks.filter(task => task.id === 'config-precedence' || task.id === 'event-emitter' || task.id === 'dependency-plan' || task.id === 'ttl-cache').length === 4);
  assert.equal(new Set(tasks.map(task => task.id)).size, tasks.length);
  assert.ok(tasks.every(task => !task.prompt.includes(task.grader)));
  await assert.rejects(loadBenchmarkTasks(defaultPack, '../grader'));
  await assert.rejects(loadBenchmarkTasks(defaultPack, 'does-not-exist'));
});

test('task packs validate optional sandboxed setup commands and default to no setup', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'polonrlm-benchmark-setup-'));
  const taskDirectory = path.join(root, 'repo-task');
  try {
    await mkdir(path.join(taskDirectory, 'workspace'), { recursive: true });
    await writeFile(path.join(taskDirectory, 'grader.mjs'), 'export async function grade() { return { passed: false, summary: "starter" }; }');
    const taskFile = path.join(taskDirectory, 'task.json');
    const base = { id: 'repo-task', title: 'Repository task', prompt: 'Fix a defect.' };
    await writeFile(taskFile, JSON.stringify(base));
    assert.equal((await loadBenchmarkTasks(root))[0]?.setup, undefined);

    await writeFile(taskFile, JSON.stringify({ ...base, setup: { command: ['npm', 'ci'], networkDomains: ['registry.npmjs.org'] } }));
    assert.deepEqual((await loadBenchmarkTasks(root))[0]?.setup, { command: ['npm', 'ci'], timeoutMs: 300_000, networkDomains: ['registry.npmjs.org'] });

    const invalid = [
      { setup: { command: 'npm ci' } },
      { setup: { command: ['npm', 'ci'], networkDomains: ['https://registry.npmjs.org'] } },
      { setup: { command: ['npm', 'ci'], networkDomains: ['registry.npmjs.org', 'registry.npmjs.org'] } },
      { setup: { command: ['npm', 'ci'], timeoutMs: 9_999 } },
      { setup: { command: ['npm', 'ci'], networkDomain: 'registry.npmjs.org' } },
    ];
    for (const value of invalid) {
      await writeFile(taskFile, JSON.stringify({ ...base, ...value }));
      await assert.rejects(loadBenchmarkTasks(root));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('every default hidden grader loads and rejects its starter workspace', async () => {
  const tasks = await loadBenchmarkTasks(defaultPack);
  for (const task of tasks) {
    const grader = await import(pathToFileURL(task.grader).href + `?test=${task.id}`);
    assert.equal(typeof grader.grade, 'function', `${task.id} grader exports grade()`);
    const result = await grader.grade(task.workspace);
    assert.equal(result?.passed, false, `${task.id} starter must not pass: ${result?.summary}`);
  }
});

test('real yocto-queue case pins upstream source and hidden grader accepts the regression fix', async () => {
  const [task] = await loadBenchmarkTasks(yoctoQueuePack, 'tail-after-empty');
  assert.ok(task);
  assert.deepEqual(task.setup?.command.slice(0, 2), ['npm', 'ci']);
  assert.deepEqual(task.setup?.networkDomains, ['registry.npmjs.org']);
  const grader = await import(pathToFileURL(task.grader).href + '?real-case=yocto-queue');
  const root = await mkdtemp(path.join(os.tmpdir(), 'polonrlm-real-benchmark-'));
  const broken = path.join(root, 'broken');
  const fixed = path.join(root, 'fixed');
  try {
    await copyBenchmarkWorkspace(task.workspace, broken);
    assert.equal((await grader.grade(broken)).passed, false, 'upstream starter must reproduce the regression');

    await copyBenchmarkWorkspace(task.workspace, fixed);
    const sourcePath = path.join(fixed, 'index.js');
    const source = await readFile(sourcePath, 'utf8');
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    const marker = `\t\tthis.#size--;${newline}`;
    assert.equal(source.split(marker).length, 2, 'expected the upstream dequeue block once');
    await writeFile(sourcePath, source.replace(marker, `${marker}\t\tif (!this.#head) {${newline}\t\t\tthis.#tail = undefined;${newline}\t\t}${newline}`));
    const result = await grader.grade(fixed);
    assert.equal(result.passed, true, result.summary);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('real yocto-queue drain case rejects the undefined sentinel and accepts the iterator fix', async () => {
  const [task] = await loadBenchmarkTasks(yoctoQueuePack, 'drain-undefined');
  assert.ok(task);
  const grader = await import(pathToFileURL(task.grader).href + '?real-case=yocto-queue-drain');
  const root = await mkdtemp(path.join(os.tmpdir(), 'polonrlm-real-drain-'));
  const broken = path.join(root, 'broken');
  const fixed = path.join(root, 'fixed');
  try {
    await copyBenchmarkWorkspace(task.workspace, broken);
    assert.equal((await grader.grade(broken)).passed, false, 'upstream starter must stop draining at undefined');

    await copyBenchmarkWorkspace(task.workspace, fixed);
    const sourcePath = path.join(fixed, 'index.js');
    const source = await readFile(sourcePath, 'utf8');
    const fixedDrain = `* drain() {\n\t\twhile (this.#head) {\n\t\t\tyield this.dequeue();\n\t\t}\n\t}`;
    const result = source.replace(/\* drain\(\) \{\s*let current;\s*while \(\(current = this\.dequeue\(\)\) !== undefined\) \{\s*yield current;\s*\}\s*\}/, fixedDrain);
    assert.notEqual(result, source, 'expected the upstream drain implementation');
    await writeFile(sourcePath, result);
    const graded = await grader.grade(fixed);
    assert.equal(graded.passed, true, graded.summary);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('real p-limit docs case rejects the starter and accepts the recursive-deadlock warning', async () => {
  const [task] = await loadBenchmarkTasks(pLimitPack, 'recursive-limiter-docs');
  assert.ok(task);
  const grader = await import(pathToFileURL(task.grader).href + '?real-case=p-limit-docs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'polonrlm-real-p-limit-'));
  const broken = path.join(root, 'broken');
  const fixed = path.join(root, 'fixed');
  try {
    await copyBenchmarkWorkspace(task.workspace, broken);
    assert.equal((await grader.grade(broken)).passed, false, 'upstream starter must not document the recursive deadlock');

    await copyBenchmarkWorkspace(task.workspace, fixed);
    const warning = 'Warning: Do not call the same `limit` function inside work already limited by it. This can cause a deadlock where inner tasks never run. Use a separate limiter for inner work.';
    const readmePath = path.join(fixed, 'readme.md');
    const readme = await readFile(readmePath, 'utf8');
    const readmeMarker = 'Returns the promise returned by calling `fn(...args)`.';
    assert.equal(readme.split(readmeMarker).length, 2, 'expected the limit API description once');
    await writeFile(readmePath, readme.replace(readmeMarker, `${readmeMarker}\n\n${warning}`));

    const declarationPath = path.join(fixed, 'index.d.ts');
    const declaration = (await readFile(declarationPath, 'utf8')).replace(/\r\n/g, '\n');
    const declarationMarker = '\t@returns The promise returned by calling `fn(...arguments)`.\n';
    assert.equal(declaration.split(declarationMarker).length, 2, 'expected callable LimitFunction documentation once');
    assert.equal(declaration.replace(/\n/g, '\r\n').replace(/\r\n/g, '\n').split(declarationMarker).length, 2, 'the marker must remain detectable in a CRLF checkout');
    await writeFile(declarationPath, declaration.replace(declarationMarker, `\t${warning}\n${declarationMarker}`));

    const result = await grader.grade(fixed);
    assert.equal(result.passed, true, result.summary);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('multi-file task graders and public tests accept known-correct implementations', async () => {
  const solutions: Record<string, Record<string, string>> = {
    'config-precedence': {
      'src/merge.js': `function isPlain(value) { if (value === null || typeof value !== 'object') return false; const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null; }
function clone(value) { if (Array.isArray(value)) return value.map(clone); if (isPlain(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])); return value; }
function merge(target, source) { const output = isPlain(target) ? clone(target) : {}; if (!isPlain(source)) return output; for (const [key, value] of Object.entries(source)) { if (value === undefined) continue; output[key] = isPlain(value) && isPlain(output[key]) ? merge(output[key], value) : clone(value); } return output; }
export function deepMerge(...sources) { return sources.reduce((result, source) => merge(result, source), {}); }
`,
    },
    'event-emitter': {
      'src/emitter.js': `export class EventEmitter {
  constructor() { this.listeners = new Map(); }
  assertEvent(event) { if (typeof event !== 'string') throw new TypeError('event must be a string'); }
  add(event, callback, once) { this.assertEvent(event); if (typeof callback !== 'function') throw new TypeError('callback must be a function'); const record = { callback, once }; const rows = this.listeners.get(event) ?? new Set(); rows.add(record); this.listeners.set(event, rows); let active = true; return () => { if (!active) return; active = false; const current = this.listeners.get(event); current?.delete(record); if (current?.size === 0) this.listeners.delete(event); }; }
  on(event, callback) { return this.add(event, callback, false); }
  once(event, callback) { return this.add(event, callback, true); }
  emit(event, ...args) { this.assertEvent(event); const snapshot = [...(this.listeners.get(event) ?? [])]; let called = 0; for (const row of snapshot) { if (row.once) this.listeners.get(event)?.delete(row); row.callback(...args); called++; } if (this.listeners.get(event)?.size === 0) this.listeners.delete(event); return called; }
  clear(event) { if (event === undefined) { const had = this.listeners.size > 0; this.listeners.clear(); return had; } this.assertEvent(event); return this.listeners.delete(event); }
}
`,
      'src/index.js': `export { EventEmitter } from './emitter.js';\n`,
    },
    'dependency-plan': {
      'src/validate.js': `export function validateTasks(tasks) {
  if (!Array.isArray(tasks)) throw new TypeError('tasks must be an array');
  const ids = new Set();
  for (const task of tasks) { if (!task || typeof task !== 'object' || typeof task.id !== 'string' || !task.id.trim()) throw new TypeError('task id must be a non-empty string'); if (ids.has(task.id)) throw new Error('duplicate task id'); ids.add(task.id); if (task.dependsOn !== undefined && !Array.isArray(task.dependsOn)) throw new TypeError('dependsOn must be an array'); }
  for (const task of tasks) { const dependencies = task.dependsOn ?? []; const seen = new Set(); for (const id of dependencies) { if (typeof id !== 'string' || !id.trim()) throw new TypeError('dependency id must be a non-empty string'); if (seen.has(id)) throw new Error('duplicate dependency'); if (id === task.id) throw new Error('self dependency'); if (!ids.has(id)) throw new Error('unknown dependency'); seen.add(id); } }
  return tasks;
}
`,
      'src/graph.js': `import { validateTasks } from './validate.js';
export function buildWaves(tasks) { validateTasks(tasks); const remaining = new Set(tasks.map(task => task.id)); const completed = new Set(); const waves = []; while (remaining.size) { const wave = tasks.filter(task => remaining.has(task.id) && (task.dependsOn ?? []).every(id => completed.has(id))).map(task => task.id); if (!wave.length) throw new Error('dependency cycle'); waves.push(wave); for (const id of wave) { remaining.delete(id); completed.add(id); } } return waves; }
`,
      'src/index.js': `export { buildWaves } from './graph.js';\nexport { validateTasks } from './validate.js';\n`,
    },
    'ttl-cache': {
      'src/cache.js': `import { expiryFor } from './clock.js';
export class LruTtlCache {
  constructor({ maxEntries = 100, ttlMs = 0, now = Date.now } = {}) { if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new TypeError('maxEntries must be a positive integer'); if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs < 0) throw new TypeError('ttlMs must be finite and non-negative'); if (typeof now !== 'function') throw new TypeError('now must be a function'); this.maxEntries = maxEntries; this.ttlMs = ttlMs; this.now = now; this.entries = new Map(); }
  live(key) { const entry = this.entries.get(key); if (!entry) return undefined; if (entry.expiresAt <= this.now()) { this.entries.delete(key); return undefined; } return entry; }
  set(key, value) { this.entries.delete(key); this.entries.set(key, { value, expiresAt: expiryFor(this.now, this.ttlMs) }); while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value); return this; }
  get(key) { const entry = this.live(key); if (!entry) return undefined; this.entries.delete(key); this.entries.set(key, entry); return entry.value; }
  has(key) { return this.live(key) !== undefined; }
  delete(key) { return this.entries.delete(key); }
  clear() { const had = this.entries.size > 0; this.entries.clear(); return had; }
}
`,
    },
    'stable-dedupe': {
      'src/dedupe.js': `export function dedupe(items) {
  if (!Array.isArray(items)) throw new TypeError('items must be an array');
  const seen = new Set(); const output = [];
  for (const item of items) { if (!item || typeof item !== 'object') throw new TypeError('item must be an object'); if (seen.has(item.id)) continue; seen.add(item.id); output.push(item); }
  return output;
}
`,
    },
    'parse-duration': {
      'src/duration.js': `export function parseDuration(value) {
  if (typeof value !== 'string' || !value) throw new TypeError('invalid duration');
  const match = /^(?:(\\d+)d)?(?:(\\d+)h)?(?:(\\d+)m)?(?:(\\d+)s)?(?:(\\d+)ms)?$/.exec(value);
  if (!match || !match.slice(1).some(Boolean)) throw new TypeError('invalid duration');
  const [days, hours, minutes, seconds, millis] = match.slice(1).map(part => part === undefined ? 0 : Number(part));
  return days * 86_400_000 + hours * 3_600_000 + minutes * 60_000 + seconds * 1_000 + millis;
}
`,
    },
    'chunk-array': {
      'src/chunk.js': `export function chunk(items, size) {
  if (!Array.isArray(items)) throw new TypeError('items must be an array');
  if (!Number.isInteger(size) || size < 1) throw new TypeError('size must be a positive integer');
  const output = [];
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size));
  return output;
}
`,
    },
    'merge-intervals': {
      'src/intervals.js': `export function mergeIntervals(intervals) {
  if (!Array.isArray(intervals)) throw new TypeError('intervals must be an array');
  const rows = intervals.map(row => {
    if (!Array.isArray(row) || row.length !== 2) throw new TypeError('interval must have two values');
    const [start, end] = row;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) throw new TypeError('invalid interval');
    return [start, end];
  }).sort((left, right) => left[0] - right[0]);
  const output = [];
  for (const [start, end] of rows) {
    const last = output.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else output.push([start, end]);
  }
  return output;
}
`,
    },
    'slugify': {
      'src/slug.js': `export function slugify(value) {
  if (typeof value !== 'string') throw new TypeError('value must be a string');
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
`,
    },
  };
  const tasks = await loadBenchmarkTasks(defaultPack);
  const root = await mkdtemp(path.join(os.tmpdir(), 'polonrlm-benchmark-solutions-'));
  try {
    assert.equal(Object.keys(solutions).length, 9);
    for (const task of tasks.filter(value => Object.hasOwn(solutions, value.id))) {
      const workspace = path.join(root, task.id);
      await copyBenchmarkWorkspace(task.workspace, workspace);
      for (const [relative, contents] of Object.entries(solutions[task.id]!)) {
        await writeFile(path.join(workspace, relative), contents, 'utf8');
      }
      const grader = await import(pathToFileURL(task.grader).href + `?solution=${task.id}`);
      const result = await grader.grade(workspace);
      assert.equal(result?.passed, true, `${task.id} hidden grader: ${result?.summary}`);
      await execa(process.execPath, ['--test'], { cwd: workspace, timeout: 30_000, windowsHide: true });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('workspace copies omit credentials and package state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'polonrlm-benchmark-test-'));
  const source = path.join(root, 'source');
  const destination = path.join(root, 'copy');
  try {
    await mkdir(path.join(source, '.git'), { recursive: true });
    await mkdir(path.join(source, 'node_modules', 'pkg'), { recursive: true });
    await mkdir(path.join(source, 'src'), { recursive: true });
    await writeFile(path.join(source, '.env'), 'secret=value');
    await writeFile(path.join(source, '.env.example'), 'KEY=');
    await writeFile(path.join(source, '.git', 'config'), 'credential');
    await writeFile(path.join(source, 'node_modules', 'pkg', 'index.js'), 'not needed');
    await writeFile(path.join(source, 'src', 'main.js'), 'export const answer = 42;');
    const copied = await copyBenchmarkWorkspace(source, destination);
    assert.equal(copied.files, 2);
    assert.equal(await readFile(path.join(destination, '.env.example'), 'utf8'), 'KEY=');
    assert.equal(await readFile(path.join(destination, 'src', 'main.js'), 'utf8'), 'export const answer = 42;');
    await assert.rejects(readFile(path.join(destination, '.env'), 'utf8'));
    await assert.rejects(readFile(path.join(destination, '.git', 'config'), 'utf8'));
    await assert.rejects(readFile(path.join(destination, 'node_modules', 'pkg', 'index.js'), 'utf8'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('grader sync copies model output while retaining only preinstalled dependencies', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'polonrlm-benchmark-sync-'));
  const source = path.join(root, 'agent');
  const submission = path.join(root, 'grader', 'submission');
  try {
    await mkdir(path.join(source, 'src'), { recursive: true });
    await mkdir(path.join(source, 'node_modules', 'agent-added-dep'), { recursive: true });
    await mkdir(path.join(submission, 'node_modules', 'trusted-dep'), { recursive: true });
    await writeFile(path.join(source, 'src', 'fixed.js'), 'export const fixed = true;');
    await writeFile(path.join(source, 'node_modules', 'agent-added-dep', 'index.js'), 'must not reach the grader');
    await writeFile(path.join(submission, 'node_modules', 'trusted-dep', 'index.js'), 'export const trusted = true;');
    await writeFile(path.join(submission, 'stale.txt'), 'remove me');
    await writeFile(path.join(submission, 'old-file.txt'), 'deleted by the agent');

    await syncBenchmarkSubmission(source, submission);

    assert.equal(await readFile(path.join(submission, 'src', 'fixed.js'), 'utf8'), 'export const fixed = true;');
    assert.equal(await readFile(path.join(submission, 'node_modules', 'trusted-dep', 'index.js'), 'utf8'), 'export const trusted = true;');
    await assert.rejects(readFile(path.join(submission, 'node_modules', 'agent-added-dep', 'index.js'), 'utf8'));
    await assert.rejects(readFile(path.join(submission, 'stale.txt'), 'utf8'));
    await assert.rejects(readFile(path.join(submission, 'old-file.txt'), 'utf8'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('hidden grader output and exit code must agree', () => {
  assert.deepEqual(parseGraderResult('{"passed":true,"summary":"4/4"}\n', 0), { passed: true, summary: '4/4' });
  assert.deepEqual(parseGraderResult('{"passed":false,"summary":"1/4"}\n', 1), { passed: false, summary: '1/4' });
  assert.throws(() => parseGraderResult('{"passed":true,"summary":"4/4"}\n', 1), /exit status/);
  assert.throws(() => parseGraderResult('', 1), /JSON result/);
  assert.throws(() => parseGraderResult('{"passed":false,"summary":"crashed"}\n', 2), /could not complete/);
});
