import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { AgentRuntime } from '../src/core/runtime.js';
import { PROVIDER_RETRY_DELAY_MS } from '../src/providers/retry.js';
import { OPTIONAL_TOOLS_GUIDANCE } from '../src/core/tool-guidance.js';
import { compactMessages, estimateTokens } from '../src/core/context.js';
import { defaultSettings } from '../src/core/config.js';
import { SessionStore } from '../src/core/store.js';
import { Permissions } from '../src/core/permissions.js';
import { registerSecret } from '../src/core/secrets.js';
import { Workspace } from '../src/tools/workspace.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { registerBuiltins } from '../src/tools/builtin.js';
import { SkillsManager } from '../src/integrations/skills.js';
import { MCPManager } from '../src/integrations/mcp.js';
import type { LLMProvider, Message, ModelReply, RuntimeEvent, Settings, ToolCall, Usage } from '../src/core/types.js';

type Complete = LLMProvider['complete'];

test('interview blocks writes under all permissions and records a real question answer', async t => {
  let calls = 0;
  const h = await harness(t, async (_messages, specs) => {
    if (++calls === 1) {
      assert.ok(specs.some(tool => tool.name === 'ask_question'));
      assert.ok(!specs.some(tool => tool.name === 'write_file'));
      return reply('', [{ id: 'blocked', name: 'write_file', arguments: { path: 'bad.txt', content: 'bad' } }]);
    }
    if (calls === 2) return reply('', [{ id: 'question', name: 'ask_question', arguments: { question: 'Which layout?', options: [{ label: 'Simple', description: 'Small UI' }, { label: 'Detailed', description: 'More controls' }], recommended: 0 } }]);
    return reply('Answer received.');
  }, { permissions: 'all' });
  h.store.saveWorkflow(h.session, { grill: { task: 'Design UI', active: true } });
  h.runtime.askQuestion = async () => 'Detailed';
  await h.runtime.run(h.session, 'Interview me', new AbortController().signal);
  await assert.rejects(readFile(path.join(h.workspace.root, 'bad.txt')), /ENOENT/);
  assert.ok(h.store.messages(h.session).some(m => m.name === 'ask_question' && m.content === 'Detailed'));
});

test('question timeout continues without claiming user approval', async t => {
  const h = await harness(t, async () => reply());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  h.runtime.askQuestion = (_question, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  const pending = (h.runtime as any).timedQuestion({ question: 'Choose', options: [{ label: 'A', description: '' }, { label: 'B', description: '' }], recommended: 0 }, new AbortController().signal);
  t.mock.timers.tick(300000);
  assert.match(await pending, /TIMEOUT.*NOT approval/);
  t.mock.timers.reset();
});

test('provider-specific request timeout overrides the global timeout', async t => {
  const h = await harness(t, async (_messages, _specs, _onDelta, signal) => {
    await setTimeout(1200);
    assert.equal(signal.aborted, false, 'the per-provider timeout should replace the shorter global timeout');
    return reply('Request completed within the provider timeout.');
  }, { timeoutMs: 1000 });
  h.settings.providers.fake!.requestTimeoutMs = 2000;
  assert.equal(await h.runtime.run(h.session, 'Answer briefly.', new AbortController().signal), 'Request completed within the provider timeout.');
});

test('goal state survives database reopen and only explicit update completes it', async t => {
  let calls = 0;
  const h = await harness(t, async () => ++calls === 1 ? reply('', [{ id: 'complete', name: 'update_goal', arguments: { status: 'complete', evidence: 'All requested outputs exist.' } }]) : reply('Done'));
  h.store.saveWorkflow(h.session, { goal: { objective: 'Produce outputs', status: 'active', tokenBudget: 10000, usedTokens: 123 } });
  const reopened = new SessionStore(h.home);
  assert.equal(reopened.workflow(h.session).goal?.usedTokens, 123); reopened.close();
  await h.runtime.run(h.session, 'Finish goal', new AbortController().signal);
  assert.equal(h.store.workflow(h.session).goal?.status, 'complete');
});

test('interview timeout never enables implementation under all permissions', async t => {
  let calls = 0;
  const h = await harness(t, async (_messages, specs) => {
    if (++calls === 1) return reply('', [{ id: 'finish', name: 'finish_interview', arguments: { summary: 'Build the agreed UI' } }]);
    assert.ok(!specs.some(spec => spec.name === 'write_file'));
    return reply('Awaiting confirmation.');
  }, { permissions: 'all' });
  h.store.saveWorkflow(h.session, { grill: { task: 'UI', active: true } });
  h.runtime.askQuestion = async () => '[TIMEOUT: No answer. NOT approval.]';
  await h.runtime.run(h.session, 'Finish interview', new AbortController().signal);
  assert.equal(h.store.workflow(h.session).grill?.active, true);
});
function reply(text = 'Done.', toolCalls: ToolCall[] = [], usage?: Partial<Usage>): ModelReply {
  return { text, toolCalls, usage: { input: 10, output: 5, cached: 0, cost: 0, costKnown: true, ...usage } };
}
function provider(complete: Complete): LLMProvider { return { complete, listModels: async () => [] }; }

async function harness(t: test.TestContext, complete: Complete, overrides: Partial<Settings> = {}, retryDelayMs = PROVIDER_RETRY_DELAY_MS) {
  const root = await mkdtemp(path.join(tmpdir(), 'polonrlm-runtime-'));
  const home = path.join(root, 'home');
  const folder = path.join(root, 'workspace');
  await mkdir(home); await mkdir(folder);
  const settings: Settings = {
    ...defaultSettings(), provider: 'fake', providers: { fake: { id: 'fake', kind: 'compatible', baseURL: 'http://127.0.0.1:1/v1', model: 'fake', inputPrice: 0, outputPrice: 0, contextWindow: 64_000 } },
    cortex: 2, permissions: 'workspace', maxOutputTokens: 128, maxInputTokens: 12_000,
    maxSteps: 12, tokenBudget: 100_000, timeoutMs: 5_000, ...overrides,
  };
  const permissions = new Permissions(settings);
  const workspace = await Workspace.open(folder, permissions);
  const store = new SessionStore(home);
  const tools = new ToolRegistry(permissions, settings.toolOutputLimit);
  registerBuiltins(tools, workspace, settings);
  const skills = new SkillsManager(home, workspace.root);
  const mcp = new MCPManager({});
  const session = store.create(workspace.root);
  const events: RuntimeEvent[] = [];
  const fallback = new Map<string, LLMProvider>();
  const primary = provider(complete);
  const runtime = new AgentRuntime(settings, store, tools, workspace, skills, mcp, async id => fallback.get(id ?? 'fake') ?? primary, event => events.push(event), retryDelayMs);
  t.after(async () => { await mcp.close(); store.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  return { root, home, settings, workspace, store, tools, skills, mcp, session, events, fallback, runtime };
}

test('temporary provider errors retry the selected model and show the retry countdown', async t => {
  const calls: number[] = [];
  const h = await harness(t, async () => {
    calls.push(Date.now());
    if (calls.length === 1) throw new Error('The selected provider is temporarily busy.');
    return reply('Recovered response.');
  });
  assert.equal(await h.runtime.run(h.session, 'Answer briefly.', new AbortController().signal), 'Recovered response.');
  assert.equal(calls.length, 2);
  assert.ok(calls[1]! - calls[0]! >= 9_500, 'the retry should wait approximately ten seconds');
  assert.ok(h.events.some(event => event.type === 'status' && /fake did not respond\. Retrying in 10 seconds \(retry 1\)/.test(event.text ?? '')));
  assert.equal(PROVIDER_RETRY_DELAY_MS, 10_000);
});

test('request timeout retries with a fresh timeout signal', async t => {
  let calls = 0;
  const h = await harness(t, async (_messages, _specs, _onDelta, signal) => {
    if (++calls === 1) await setTimeout(40, undefined, { signal });
    return reply('Recovered after request timeout.');
  }, { timeoutMs: 10 }, 0);
  assert.equal(await h.runtime.run(h.session, 'Answer briefly.', new AbortController().signal), 'Recovered after request timeout.');
  assert.equal(calls, 2);
});

test('partial provider responses are never replayed automatically', async t => {
  let calls = 0;
  const h = await harness(t, async (_messages, _specs, onDelta) => {
    calls++;
    onDelta('partial answer');
    throw new Error('The selected provider is temporarily busy.');
  }, {}, 0);
  await assert.rejects(h.runtime.run(h.session, 'Answer briefly.', new AbortController().signal), /temporarily busy/);
  assert.equal(calls, 1);
  assert.ok(h.store.messages(h.session).some(message => message.role === 'assistant' && message.content.includes('Response interrupted')));
});

test('cancel interrupts the retry wait before another provider request', async t => {
  let calls = 0;
  const h = await harness(t, async () => { calls++; throw new Error('The selected provider is temporarily busy.'); });
  const controller = new AbortController();
  const pending = h.runtime.run(h.session, 'Answer briefly.', controller.signal);
  while (!h.events.some(event => event.type === 'status' && /Retrying in 10 seconds/.test(event.text ?? ''))) await setTimeout(1);
  controller.abort();
  await assert.rejects(pending, /aborted/i);
  assert.equal(calls, 1);
});

test('empty model replies retry and their reported token usage is retained', async t => {
  let calls = 0;
  const h = await harness(t, async () => ++calls === 1 ? reply('') : reply('Recovered from empty response.'), {}, 0);
  assert.equal(await h.runtime.run(h.session, 'Answer briefly.', new AbortController().signal), 'Recovered from empty response.');
  assert.equal(calls, 2);
  assert.equal(h.store.usage(h.session).input, 20);
  assert.equal(h.store.usage(h.session).output, 10);
});

test('retry attempts consume the shared model-call limit', async t => {
  let calls = 0;
  const h = await harness(t, async () => { calls++; throw new Error('The selected provider is temporarily busy.'); }, { maxSteps: 1 }, 0);
  await assert.rejects(h.runtime.run(h.session, 'Answer briefly.', new AbortController().signal), /Shared limit of 1 model calls reached while retrying fake/);
  assert.equal(calls, 1);
});

test('resumed desktop follow-ups keep the tool active and recover invalid calls without executing them', async t => {
  let calls = 0, executions = 0;
  const h = await harness(t, async (messages, specs) => {
    assert.ok(specs.some(spec => spec.name === 'computer_use'));
    if (++calls === 1) return reply('', [{ id: 'invalid', name: 'computer_use', arguments: { action: 'list' }, validationError: 'Invalid JSON. Correct the tool input.' }]);
    if (calls === 2) {
      assert.ok(messages.some(message => message.toolCallId === 'invalid' && message.isError && /Correct/.test(message.content)));
      assert.equal(executions, 0);
      return reply('', [{ id: 'repaired', name: 'computer_use', arguments: { action: 'list' } }]);
    }
    return reply('Desktop available.');
  }, { permissions: 'all' });
  const { z } = await import('zod');
  h.tools.add('computer_use', 'Desktop fixture', z.object({ action: z.literal('list') }), false, async () => { executions++; return { windows: [] }; });
  h.store.append(h.session, { role: 'assistant', content: '', toolCalls: [{ id: 'old', name: 'computer_use', arguments: { action: 'list' } }] });
  h.store.append(h.session, { role: 'tool', name: 'computer_use', toolCallId: 'old', content: 'Old desktop error', isError: true });
  await h.runtime.run(h.session, 'zrób to jeszcze raz teraz', new AbortController().signal);
  assert.equal(executions, 1);
  assert.equal(calls, 3);
});

test('a schema-blind call is validated and executed without an extra model retry', async t => {
  let calls = 0;
  const h = await harness(t, async (messages, specs) => {
    calls++;
    if (calls === 1) return reply('', [{ id: 'blind', name: 'checkpoint_create', arguments: { name: 'start', paths: ['README.md'] }, validationError: 'Unknown tool schema.' }]);
    assert.ok(specs.some(spec => spec.name === 'checkpoint_create'));
    assert.equal(messages.at(-1)?.isError, false);
    assert.match(messages.at(-1)?.content ?? '', /start/);
    return reply('Checkpoint saved.');
  }, { permissions: 'all' });
  assert.equal(await h.runtime.run(h.session, 'Create a checkpoint for README.md.', new AbortController().signal), 'Checkpoint saved.');
  assert.equal(calls, 2);
});

test('repeated identical read-only calls are short-circuited before they waste more steps', async t => {
  let calls = 0;
  const h = await harness(t, async () => reply('', [{ id: `read-${++calls}`, name: 'read_file', arguments: { path: 'sample.txt' } }]), { permissions: 'all' });
  await writeFile(path.join(h.workspace.root, 'sample.txt'), 'stable content');
  const result = await h.runtime.run(h.session, 'Read the file and summarize it.', new AbortController().signal);
  assert.match(result, /repeated the same read/);
  assert.equal(calls, 2);
  const toolMessages = h.store.messages(h.session).filter(message => message.role === 'tool' && message.name === 'read_file');
  assert.equal(toolMessages.filter(message => !message.isError).length, 1);
  assert.equal(toolMessages.filter(message => message.isError).length, 1);
});

test('repeated browser screenshots stop even when timeout parameters change', async t => {
  let calls = 0, screenshots = 0;
  const h = await harness(t, async () => {
    calls++;
    return reply('', [{ id: `shot-${calls}`, name: 'browser', arguments: { action: 'screenshot', sessionId: 'fixture-session', timeoutMs: calls * 1000 } }]);
  }, { permissions: 'all' });
  const { z } = await import('zod');
  h.tools.add('browser', 'Fixture browser screenshot.', z.object({ action: z.literal('screenshot'), sessionId: z.string(), timeoutMs: z.number() }), true, async () => { screenshots++; return 'Captured.'; });
  const result = await h.runtime.run(h.session, 'Take a screenshot and inspect it.', new AbortController().signal);
  assert.match(result, /Stopped the task/);
  assert.equal(calls, 2); assert.equal(screenshots, 1);
});

test('the assistant cannot claim completion when no tool produced evidence', async t => {
  const h = await harness(t, async () => reply('Przetestowałem wszystkie narzędzia. Wszystko działa poprawnie.'));
  const result = await h.runtime.run(h.session, 'Uruchom testy narzędzi.', new AbortController().signal);
  assert.match(result, /I cannot confirm that tests were run/);
  assert.equal(h.store.messages(h.session).filter(message => message.role === 'tool').length, 0);
});

test('a successful unrelated read does not prove that requested tests ran', async t => {
  let calls = 0;
  const h = await harness(t, async () => ++calls === 1
    ? reply('', [{ id: 'read-only', name: 'read_file', arguments: { path: 'notes.txt' } }])
    : reply('Przetestowałem wszystkie narzędzia. Wszystko działa poprawnie.'));
  await writeFile(path.join(h.workspace.root, 'notes.txt'), 'ordinary note');
  const result = await h.runtime.run(h.session, 'Uruchom testy projektu.', new AbortController().signal);
  assert.match(result, /I cannot confirm that tests were run/);
});

test('test claims require a recognized test command and a zero exit code for a pass claim', async t => {
  const { z } = await import('zod');
  for (const exitCode of [0, 1]) {
    let calls = 0;
    const h = await harness(t, async () => ++calls === 1
      ? reply('', [{ id: `tests-${exitCode}`, name: 'run_tests', arguments: { command: exitCode === 0 ? 'node -e "if (false) process.exit(1)"' : 'npm test' } }])
      : reply('Testy przeszły pomyślnie.'));
    h.tools.add('run_tests', 'Test fixture', z.object({ command: z.string() }), false, async () => ({ exitCode, stdout: 'tests output', stderr: '' }));
    const result = await h.runtime.run(h.session, 'Uruchom testy projektu.', new AbortController().signal);
    if (exitCode === 0) assert.equal(result, 'Testy przeszły pomyślnie.');
    else assert.match(result, /I cannot confirm that tests passed/);
  }
});

test('factual web answers never stream or persist a made-up conclusion when no source was readable', async t => {
  let calls = 0;
  const h = await harness(t, async (_messages, specs, delta) => {
    assert.ok(specs.some(spec => spec.name === 'web_search'));
    assert.ok(specs.some(spec => spec.name === 'read_webpage'));
    if (++calls === 1) return reply('', [{ id: 'find', name: 'web_search', arguments: { query: 'unverified project' } }]);
    if (calls === 2) return reply('', [{ id: 'read', name: 'read_webpage', arguments: { url: 'https://example.org/' } }]);
    delta('Made-up verified facts.');
    return reply('Made-up verified facts.');
  });
  const { z } = await import('zod');
  h.tools.add('web_search', 'Fixture search', z.object({ query: z.string() }), true, async () => [{ title: 'Fixture', url: 'https://example.org/', snippet: 'Unverified snippet' }]);
  h.tools.add('read_webpage', 'Fixture reader', z.object({ url: z.string() }), true, async () => ({ readable: false, content: '', notice: 'No readable source.' }));
  const answer = await h.runtime.run(h.session, 'Wyszukaj w internecie czym jest ten projekt i daj prawdziwe informacje.', new AbortController().signal);
  assert.match(answer, /Could not verify the information/);
  assert.equal(JSON.stringify(h.events).includes('Made-up verified facts'), false);
  assert.equal(JSON.stringify(h.store.messages(h.session)).includes('Made-up verified facts'), false);
});

test('runtime exposes local web research tools without unrelated browser controls', async t => {
  const research = await harness(t, async (_messages, specs) => {
    const names = new Set(specs.map(spec => spec.name));
    assert.ok(names.has('web_search'));
    assert.ok(names.has('read_webpage'));
    for (const name of ['browser', 'browser_sessions', 'browser_automation', 'computer_use']) assert.ok(!names.has(name), name + ' should not be sent for a read-only research task');
    return reply('Research submitted.');
  });
  await research.runtime.run(research.session, 'Wyszukaj w internecie aktualne informacje o TypeScript.', new AbortController().signal);
  const coding = await harness(t, async (_messages, specs) => {
    const names = new Set(specs.map(spec => spec.name));
    assert.ok(!names.has('web_search'));
    assert.ok(!names.has('browser'));
    return reply('Code inspected.');
  });
  await coding.runtime.run(coding.session, 'Sprawdź funkcję src/index.ts.', new AbortController().signal);
});

test('compact optional-tool guidance retains discovery cues and loads an exact schema on demand', async t => {
  const requiredGuidance = [
    'browser/browser_sessions', 'read_files/search_batch', 'code_diagnostics', 'symbol_*', 'rename_symbol',
    'ast_search/ast_edit/code_outline', 'lsp_request', 'process_*', 'transaction_*', 'checkpoint_*',
    'git_log/git_show/git_blame', 'plan_update/plan_status', 'Load only needed schemas.',
    'After code changes, check diagnostics.', 'Restore checkpoints only with current hashes;',
    'plan status is not proof of completion.',
  ];
  for (const cue of requiredGuidance) assert.ok(OPTIONAL_TOOLS_GUIDANCE.includes(cue), `missing prompt cue: ${cue}`);
  assert.ok(Buffer.byteLength(OPTIONAL_TOOLS_GUIDANCE, 'utf8') < 450, 'the optional-tool index should stay compact');

  let calls = 0;
  const h = await harness(t, async (messages, specs) => {
    calls++;
    assert.ok(messages.some(message => message.role === 'system' && message.content.includes(OPTIONAL_TOOLS_GUIDANCE)));
    if (calls === 1) {
      assert.ok(specs.some(spec => spec.name === 'discover_tools'));
      return reply('', [{ id: 'discover-checkpoint-restore', name: 'discover_tools', arguments: { query: 'checkpoint_restore' } }]);
    }
    const restore = specs.find(spec => spec.name === 'checkpoint_restore');
    assert.ok(restore, 'discovery should load the exact optional schema');
    assert.deepEqual(Object.keys(restore.parameters.properties as Record<string, unknown>).sort(), ['expected', 'id']);
    assert.match(messages.at(-1)?.content ?? '', /checkpoint_restore/);
    return reply('The checkpoint restore schema is available.');
  });
  assert.equal(await h.runtime.run(h.session, 'Inspect checkpoint_restore without changing files.', new AbortController().signal), 'The checkpoint restore schema is available.');
  assert.equal(calls, 2);
});

test('explicit browser_automation request stays available while reading a URL', async t => {
  let calls = 0, executions = 0;
  const h = await harness(t, async (messages, specs) => {
    calls++;
    if (calls === 1) {
      assert.ok(specs.some(spec => spec.name === 'discover_tools'));
      return reply('', [{ id: 'discover-browser-automation', name: 'discover_tools', arguments: { query: 'browser_automation' } }]);
    }
    if (calls === 2) {
      assert.match(messages.at(-1)?.content ?? '', /browser_automation/);
      return reply('', [{ id: 'browser-automation-read', name: 'browser_automation', arguments: { action: 'text', url: 'https://example.org' } }]);
    }
    assert.match(messages.at(-1)?.content ?? '', /Example Domain/);
    return reply('Read the page.');
  }, { permissions: 'all' });
  const { z } = await import('zod');
  h.tools.add('browser_automation', 'Fixture browser automation.', z.object({ action: z.literal('text'), url: z.url() }), true, async args => {
    assert.equal(args.url, 'https://example.org'); executions++; return 'Example Domain';
  });
  assert.equal(await h.runtime.run(h.session, 'Use browser_automation to read https://example.org.', new AbortController().signal), 'Read the page.');
  assert.equal(executions, 1);
  assert.equal(calls, 3);
});

test('web research executes at most two searches and feeds a clear stop signal for batched extras', async t => {
  let calls = 0, executed = 0;
  const h = await harness(t, async messages => {
    calls++;
    if (calls === 1) return reply('', ['one', 'two', 'three', 'four'].map((query, index) => ({ id: `search-${index}`, name: 'web_search', arguments: { query } })));
    const tools = messages.filter(message => message.role === 'tool' && message.name === 'web_search');
    assert.equal(tools.length, 4);
    assert.equal(tools.filter(message => message.content.includes('two-search limit')).length, 2);
    assert.match(messages.at(-1)?.content ?? '', /two-search limit/);
    return reply('I will read the best result and cite it.');
  });
  const { z } = await import('zod');
  h.tools.add('web_search', 'Fixture local search', z.object({ query: z.string() }), true, async args => { executed++; return [{ title: args.query, url: `https://example.org/${args.query}`, snippet: 'result' }]; });
  await h.runtime.run(h.session, 'Search the web for reliable documentation.', new AbortController().signal);
  assert.equal(executed, 2);
  assert.equal(calls, 2);
});

test('ordinary web research cannot re-enable browser tools through discovery or schema repair', async t => {
  let calls = 0, browserExecutions = 0;
  const h = await harness(t, async messages => {
    calls++;
    if (calls === 1) return reply('', [{ id: 'discover-browser', name: 'discover_tools', arguments: { query: 'browser' } }]);
    assert.match(messages.at(-1)?.content ?? '', /unavailable for ordinary web research/i);
    if (calls === 2) return reply('', [{ id: 'hidden-browser', name: 'browser', arguments: { action: 'launch', url: 'https://example.org' }, validationError: 'Unknown tool schema.' }]);
    return reply('Finished with local research.');
  }, { permissions: 'all' });
  const { z } = await import('zod');
  h.tools.add('browser', 'Fixture browser.', z.object({ action: z.literal('launch'), url: z.url() }), false, async () => { browserExecutions++; return 'Launched.'; });
  const answer = await h.runtime.run(h.session, 'Search the web for official documentation.', new AbortController().signal);
  assert.equal(answer, 'Finished with local research.');
  assert.equal(browserExecutions, 0);
  assert.equal(calls, 3);
});

test('unlimited token budget permits the next step after usage exceeds the old factory limit', async t => {
  let calls = 0;
  const h = await harness(t, async () => ++calls === 1 ? reply('', [{ id: 'large-turn', name: 'read_file', arguments: { path: 'file.txt' } }], { input: 500000 }) : reply('Complete without a token ceiling.'), { tokenBudget: 0 });
  await writeFile(path.join(h.workspace.root, 'file.txt'), 'fixture');
  assert.equal(await h.runtime.run(h.session, 'Read the file and finish.', new AbortController().signal), 'Complete without a token ceiling.');
  assert.equal(calls, 2);
});

test('repeating an identical failed action returns the previous failure without executing it again', async t => {
  let calls = 0, executions = 0;
  const h = await harness(t, async messages => {
    if (++calls <= 2) return reply('', [{ id: `attempt-${calls}`, name: 'read_file', arguments: { path: 'missing.txt' } }]);
    assert.match(messages.at(-1)?.content ?? '', /This exact call already failed/);
    return reply('Reported the obstacle.');
  });
  const { z } = await import('zod');
  h.tools.add('read_file', 'Fixture', z.object({ path: z.string() }), true, async () => { executions++; throw new Error('Missing fixture file'); });
  assert.equal(await h.runtime.run(h.session, 'Read the missing file.', new AbortController().signal), 'Reported the obstacle.');
  assert.equal(executions, 1);
});

test('agent executes actual file write, supplies observation, streams response and persists usage', async t => {
  let calls = 0;
  const h = await harness(t, async (messages, tools, delta) => {
    calls++;
    if (calls === 1) {
      assert.ok(tools.some(tool => tool.name === 'write_file'));
      return reply('', [{ id: 'write-1', name: 'write_file', arguments: { path: 'result.txt', content: 'actual result\n' } }]);
    }
    assert.equal(messages.at(-1)?.role, 'tool');
    assert.equal(messages.at(-1)?.toolCallId, 'write-1');
    assert.match(messages.at(-1)?.content ?? '', /\+actual result/);
    delta('Saved.'); return reply('Saved.');
  });
  assert.equal(await h.runtime.run(h.session, 'Create result file.', new AbortController().signal), 'Saved.');
  assert.equal(await readFile(path.join(h.workspace.root, 'result.txt'), 'utf8'), 'actual result\n');
  assert.deepEqual(h.store.messages(h.session).map(message => message.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(h.store.usage(h.session).input, 20);
  assert.ok(h.events.some(event => event.type === 'text' && event.text === 'Saved.'));
});

test('tool screenshot reaches the next model call but never enters SQLite or audit', async t => {
  const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=';
  let calls = 0;
  const h = await harness(t, async messages => {
    if (++calls === 1) return reply('', [{ id: 'screen', name: 'capture_test', arguments: {} }]);
    assert.equal(messages.at(-1)?.images?.[0]?.data, data);
    return reply('I can see the screenshot.');
  });
  const { z } = await import('zod');
  h.tools.add('capture_test', 'fixture', z.object({}), true, async (_args, context) => { context.onImage?.({ data, mediaType: 'image/png', tokenEstimate: 6000 }); return 'snapshot fixture'; });
  await h.runtime.run(h.session, 'Inspect this window.', new AbortController().signal);
  assert.equal(JSON.stringify(h.store.messages(h.session)).includes(data), false);
  h.store.archiveContext(h.session, [{ role: 'tool', content: 'snapshot', images: [{ data, mediaType: 'image/png' }] }]);
  assert.equal(JSON.stringify(h.store.context(h.session)).includes(data), false);
});

test('sensitive computer fill waits for a user decision and never persists the field value', async t => {
  const secret = 'private-form-value-keep-out-of-history';
  let calls = 0, approvals = 0;
  let resolveApproval!: (allowed: boolean) => void;
  let approvalStarted!: () => void;
  const started = new Promise<void>(resolve => { approvalStarted = resolve; });
  const h = await harness(t, async messages => {
    calls++;
    if (calls === 1) return reply('', [{ id: 'fill-form', name: 'computer_use', arguments: { action: 'fill', text: secret } }]);
    assert.equal(messages.at(-1)?.role, 'tool');
    return reply('Done.');
  }, { permissions: 'ask' });
  h.workspace.permissions.approve = async request => {
    approvals++;
    assert.equal(request.tool, 'computer_use');
    assert.ok(!request.preview?.includes(secret));
    approvalStarted();
    return new Promise(resolve => { resolveApproval = resolve; });
  };
  const { z } = await import('zod');
  h.tools.add('computer_use', 'Fixture desktop tool.', z.object({ action: z.enum(['fill']), text: z.string() }), false, async (args, context) => {
    await h.workspace.permissions.check('computer_use', 'external', 'Fill a field', '[field value hidden]', context.mode, context.signal);
    assert.equal(args.text, secret);
    return 'filled';
  });
  const run = h.runtime.run(h.session, 'Fill a field.', new AbortController().signal);
  await started;
  await setTimeout(30);
  assert.equal(calls, 1, 'model call remains paused while approval is pending');
  resolveApproval(true);
  assert.equal(await run, 'Done.');
  assert.equal(calls, 2);
  assert.equal(approvals, 1);
  assert.equal(JSON.stringify(h.store.messages(h.session)).includes(secret), false);
  const audit = (h.store as any).db.prepare('SELECT data FROM audit').all();
  assert.equal(JSON.stringify(audit).includes(secret), false);
});

test('Polish taskbar requests expose computer_use directly and stop empty tool-search loops', async t => {
  let calls = 0;
  const computerSpecCounts: number[] = [];
  let secondHadDiscovery = true;
  let taskbarInstructions = false;
  const h = await harness(t, async (messages, tools) => {
    calls++;
    computerSpecCounts.push(tools.filter(tool => tool.name === 'computer_use').length);
    if (calls === 1) {
      taskbarInstructions = messages[0]!.content.includes('Windows taskbar');
      return reply('', [{ id: 'empty-search', name: 'discover_tools', arguments: { query: 'no-such-desktop-helper' } }]);
    }
    if (calls === 2) {
      secondHadDiscovery = tools.some(tool => tool.name === 'discover_tools');
      return reply('', [{ id: 'desktop-list', name: 'computer_use', arguments: { action: 'list' } }]);
    }
    assert.match(messages.at(-1)?.content ?? '', /Windows taskbar/);
    return reply('Otwieram aplikację z paska zadań.');
  }, { mode: 'REVIEW' });
  const { z } = await import('zod');
  h.tools.add('computer_use', 'Fixture desktop tool.', z.object({ action: z.string() }), false, async () => ({ windows: [{ title: 'Windows taskbar' }] }));
  const result = await h.runtime.run(h.session, 'elo weź włącz mi discorda za pomocą kursora. discord jest na pasku zadań na dole', new AbortController().signal);
  assert.equal(result, 'Otwieram aplikację z paska zadań.');
  assert.equal(calls, 3);
  assert.deepEqual(computerSpecCounts, [1, 1, 1]);
  assert.equal(secondHadDiscovery, false);
  assert.ok(taskbarInstructions);
});

test('Polish computer-control follow-up exposes computer_use without requiring a cursor keyword', async t => {
  let computerWasAvailable = false;
  const h = await harness(t, async (messages, tools) => {
    computerWasAvailable = tools.some(tool => tool.name === 'computer_use');
    assert.match(messages[0]!.content, /computer_use.*available/);
    return reply('Tak, mogę sterować pulpitem po Twojej zgodzie.');
  }, { mode: 'REVIEW' });
  assert.equal(await h.runtime.run(h.session, 'Nie masz możliwości sterowaniem PC? Masz chyba takie narzędzie.', new AbortController().signal), 'Tak, mogę sterować pulpitem po Twojej zgodzie.');
  assert.ok(computerWasAvailable);
});

test('disabled tools report actionable availability and rejected approval is not retried', async t => {
  let calls = 0;
  let approvals = 0;
  const h = await harness(t, async messages => {
    calls++;
    if (calls === 1) return reply('', [{ id: 'find-tool', name: 'discover_tools', arguments: { query: 'execute_command' } }]);
    if (calls === 2) {
      const availability = JSON.parse(messages.at(-1)?.content ?? '[]') as { available: boolean; reason?: string }[];
      assert.equal(availability[0]?.available, false);
      assert.match(availability[0]?.reason ?? '', /deny|denylist/);
      return reply('', [{ id: 'denied-command', name: 'execute_command', arguments: { command: 'Write-Output must-not-run' } }]);
    }
    if (calls === 3) {
      assert.match(messages.at(-1)?.content ?? '', /Tool execute_command is unavailable/);
      return reply('', [{ id: 'repeat-command', name: 'execute_command', arguments: { command: 'Write-Output must-not-run' } }]);
    }
    assert.match(messages.at(-1)?.content ?? '', /Do not retry/i);
    return reply('Polecenie jest zablokowane.');
  }, { permissions: 'ask', denyTools: ['execute_command'] });
  h.workspace.permissions.approve = async () => { approvals++; return false; };
  assert.equal(await h.runtime.run(h.session, 'Uruchom polecenie.', new AbortController().signal), 'Polecenie jest zablokowane.');
  assert.equal(calls, 4);
  assert.equal(approvals, 0, 'disabled tools must be rejected before requesting approval');
});

test('request_tool shows the exact blocked action, waits for approval, and authorizes one execution', async t => {
  const value = 'one approved fixture action';
  let calls = 0, approvals = 0, executions = 0;
  let resolveApproval!: (allowed: boolean) => void;
  let approvalStarted!: () => void;
  const started = new Promise<void>(resolve => { approvalStarted = resolve; });
  const h = await harness(t, async (messages, tools) => {
    calls++;
    if (calls === 1) {
      assert.equal(tools.some(tool => tool.name === 'request_tool'), false, 'approval schema is omitted until a disabled tool is discovered');
      return reply('', [{ id: 'discover-fixture', name: 'discover_tools', arguments: { query: 'fixture_disabled' } }]);
    }
    if (calls === 2) {
      assert.ok(tools.some(tool => tool.name === 'request_tool'));
      const found = JSON.parse(messages.at(-1)?.content ?? '[]') as { name: string; available: boolean; reason?: string }[];
      assert.equal(found[0]?.name, 'fixture_disabled');
      assert.equal(found[0]?.available, false);
      assert.match(found[0]?.reason ?? '', /denylist/);
      return reply('', [{ id: 'request-fixture', name: 'request_tool', arguments: { tool: 'fixture_disabled', arguments: { value }, reason: 'The user explicitly requested this action.' } }]);
    }
    assert.equal(messages.at(-1)?.role, 'tool');
    assert.match(messages.at(-1)?.content ?? '', /One-time approval granted/);
    return reply('Action completed.');
  }, { permissions: 'ask', denyTools: ['fixture_disabled'] });
  const { z } = await import('zod');
  h.tools.add('fixture_disabled', 'A controlled fixture action.', z.object({ value: z.string() }), false, async (args, context) => {
    await h.workspace.permissions.check('fixture_disabled', 'external', 'Run the exact fixture action', JSON.stringify(args), context.mode, context.signal);
    executions++;
    return `done: ${args.value}`;
  });
  h.workspace.permissions.approve = async request => {
    approvals++;
    assert.equal(request.tool, 'fixture_disabled');
    assert.equal(request.oneTimeOverride, true);
    assert.match(request.description, /Block:.*denylist/);
    assert.match(request.description, /The user explicitly requested/);
    assert.match(request.preview ?? '', /one approved fixture action/);
    approvalStarted();
    return new Promise(resolve => { resolveApproval = resolve; });
  };

  const run = h.runtime.run(h.session, 'Wykonaj jedną akcję fixture_disabled.', new AbortController().signal);
  await started;
  await setTimeout(30);
  assert.equal(calls, 2, 'model call remains paused until the user decides');
  assert.equal(executions, 0, 'the disabled tool cannot run before approval');
  resolveApproval(true);
  assert.equal(await run, 'Action completed.');
  assert.equal(approvals, 1);
  assert.equal(executions, 1);
  assert.equal(calls, 3);
});

test('request_tool refusal blocks the requested tool for the rest of the run', async t => {
  let calls = 0, approvals = 0, executions = 0;
  const h = await harness(t, async messages => {
    calls++;
    if (calls === 1) return reply('', [{ id: 'discover-refused', name: 'discover_tools', arguments: { query: 'fixture_disabled' } }]);
    if (calls === 2) return reply('', [{ id: 'request-refused', name: 'request_tool', arguments: { tool: 'fixture_disabled', arguments: { value: 'no' }, reason: 'The user asked for this exact action.' } }]);
    if (calls === 3) {
      assert.match(messages.at(-1)?.content ?? '', /Approval denied/);
      return reply('', [{ id: 'request-again', name: 'request_tool', arguments: { tool: 'fixture_disabled', arguments: { value: 'no' }, reason: 'Retry.' } }]);
    }
    assert.match(messages.at(-1)?.content ?? '', /already denied/i);
    return reply('The action was not performed.');
  }, { permissions: 'ask', denyTools: ['fixture_disabled'] });
  const { z } = await import('zod');
  h.tools.add('fixture_disabled', 'A controlled fixture action.', z.object({ value: z.string() }), false, async () => { executions++; return 'unexpected'; });
  h.workspace.permissions.approve = async request => { approvals++; assert.equal(request.oneTimeOverride, true); return false; };
  assert.equal(await h.runtime.run(h.session, 'Wykonaj fixture_disabled.', new AbortController().signal), 'The action was not performed.');
  assert.equal(calls, 4);
  assert.equal(approvals, 1);
  assert.equal(executions, 0);
});

test('rejected approval pauses repeated calls to that tool until the run ends', async t => {
  let calls = 0;
  let approvals = 0;
  const h = await harness(t, async messages => {
    calls++;
    if (calls === 1) return reply('', [{ id: 'write-once', name: 'execute_command', arguments: { command: 'Write-Output must-not-run' } }]);
    if (calls === 2) {
      assert.match(messages.at(-1)?.content ?? '', /Approval denied/);
      return reply('', [{ id: 'write-twice', name: 'execute_command', arguments: { command: 'Write-Output must-not-run' } }]);
    }
    assert.match(messages.at(-1)?.content ?? '', /already denied/i);
    return reply('The action was stopped.');
  }, { permissions: 'ask' });
  h.workspace.permissions.approve = async () => { approvals++; return false; };
  assert.equal(await h.runtime.run(h.session, 'Uruchom bezpieczne polecenie.', new AbortController().signal), 'The action was stopped.');
  assert.equal(calls, 3);
  assert.equal(approvals, 1);
});

test('parallel delegates share tools and budget while reviewer remains read-only', { timeout: 10_000 }, async t => {
  let release!: () => void;
  const bothStarted = new Promise<void>(resolve => { release = resolve; });
  const counts = new Map<string, number>();
  let active = 0;
  let maximumActive = 0;
  let firstChildren = 0;
  const h = await harness(t, async (messages, tools) => {
    const role = /Role: (\w+)\./.exec(messages[0]!.content)?.[1] ?? '';
    const count = (counts.get(role) ?? 0) + 1; counts.set(role, count);
    if (role === 'orchestrator') {
      if (count === 1) return reply('', [{ id: 'delegate-1', name: 'delegate', arguments: { tasks: [{ role: 'coder', task: 'Create independent coder result file.' }, { role: 'reviewer', task: 'Inspect independent file safety.' }] } }]);
      if (count === 2) {
        const outputs = JSON.parse(messages.at(-1)?.content ?? '[]') as { id: string; role: string; output?: string; changedFiles?: { path: string }[] }[];
        const coder = outputs.find(output => output.role === 'coder')!;
        const reviewer = outputs.find(output => output.role === 'reviewer')!;
        assert.match(coder.output ?? '', /coder complete/);
        assert.match(reviewer.output ?? '', /reviewer complete/);
        assert.deepEqual(coder.changedFiles?.map(file => file.path), ['coder.txt']);
        assert.ok(tools.some(tool => tool.name === 'agent_apply'));
        return reply('', [{ id: 'apply-coder', name: 'agent_apply', arguments: { agentId: coder.id, paths: ['coder.txt'] } }]);
      }
      assert.match(messages.at(-1)?.content ?? '', /coder.txt/);
      return reply('Delegates complete.');
    }
    if (count === 1) {
      active++; maximumActive = Math.max(maximumActive, active);
      if (++firstChildren === 2) release();
      await Promise.race([bothStarted, setTimeout(2_000).then(() => { throw new Error('Delegates did not run concurrently.'); })]);
      active--;
      if (role === 'reviewer') assert.equal(tools.some(tool => tool.name === 'write_file'), false);
      return reply('', [{ id: `${role}-write`, name: 'write_file', arguments: { path: `${role}.txt`, content: role } }]);
    }
    if (role === 'reviewer') assert.match(messages.at(-1)?.content ?? '', /REVIEW.*blocks/);
    return reply(`${role} complete`);
  }, { maxAgents: 2, maxDepth: 1 });
  assert.equal(await h.runtime.run(h.session, 'Run independent parallel work.', new AbortController().signal), 'Delegates complete.');
  assert.equal(maximumActive, 2);
  assert.equal(await readFile(path.join(h.workspace.root, 'coder.txt'), 'utf8'), 'coder');
  await assert.rejects(readFile(path.join(h.workspace.root, 'reviewer.txt')), { code: 'ENOENT' });
  assert.equal(h.runtime.agents.length, 2);
  assert.ok(h.runtime.agents.every(agent => agent.status === 'done'));
  assert.equal(h.store.usage(h.session).input, 70);
});

test('parallel subagents exchange a bounded direct note at a safe turn boundary', { timeout: 20_000 }, async t => {
  let h!: Awaited<ReturnType<typeof harness>>;
  let firstCalls = 0, messagesSent = 0;
  let releaseFirst!: () => void;
  const bothStarted = new Promise<void>(resolve => { releaseFirst = resolve; });
  const calls = new Map<string, number>();
  h = await harness(t, async (messages, tools) => {
    const role = /Role: (\w+)\./.exec(messages[0]!.content)?.[1] ?? '';
    const count = (calls.get(role) ?? 0) + 1; calls.set(role, count);
    if (role === 'orchestrator') {
      if (count === 1) return reply('', [{ id: 'team-delegate', name: 'delegate', arguments: { tasks: [
        { role: 'researcher', task: 'Send one useful finding to the reviewer.' },
        { role: 'reviewer', task: 'Receive and report one finding from the researcher.' },
      ] } }]);
      const results = JSON.parse(messages.at(-1)?.content ?? '[]') as { role: string; output?: string }[];
      assert.ok(results.every(result => /received teammate note/.test(result.output ?? '')), JSON.stringify(results));
      return reply('The two subagents exchanged a finding.');
    }
    if (count === 1) {
      if (++firstCalls === 2) releaseFirst();
      await bothStarted;
      const spec = tools.find(tool => tool.name === 'agent_message');
      assert.ok(spec, `missing team tool; team prompt=${messages[0]!.content.slice(-500)}; tools=${tools.map(tool => tool.name).join(',')}`);
      const properties = spec.parameters.properties as Record<string, { enum?: string[] }>;
      const to = properties.to?.enum?.[0]; assert.ok(to);
      return reply('', [{ id: `${role}-team-note`, name: 'agent_message', arguments: { to, message: `Finding from ${role}: check the parser boundary in src/core/context.ts.` } }]);
    }
    if (count === 2) {
      for (let attempt = 0; attempt < 400 && messagesSent < 2; attempt++) {
        messagesSent = h.events.filter(event => event.type === 'tool' && event.name === 'agent_message' && event.state === 'done').length;
        if (messagesSent < 2) await setTimeout(5);
      }
      assert.equal(messagesSent, 2, `both agents should send before either finishes: ${JSON.stringify(h.events.filter(event => event.type === 'tool'))}`);
      return reply('', [{ id: `${role}-yield`, name: 'list_directory', arguments: { path: '.' } }]);
    }
    if (count === 3) {
      const incoming = messages.findLast(message => message.name === 'agent_team');
      assert.match(incoming?.content ?? '', new RegExp(`Finding from ${role === 'reviewer' ? 'researcher' : 'reviewer'}: check the parser boundary in src/core/context\\.ts`));
      return reply(`${role} received teammate note and checked it.`);
    }
    return reply('No more team work.');
  }, { maxAgents: 2, maxDepth: 1 });

  assert.equal(await h.runtime.run(h.session, 'Coordinate a parser review.', new AbortController().signal), 'The two subagents exchanged a finding.');
});

test('parallel subagents reserve one shared token budget before issuing API calls', async t => {
  let parentCalls = 0;
  let childCalls = 0;
  let h!: Awaited<ReturnType<typeof harness>>;
  h = await harness(t, async (messages, tools) => {
    if (messages[0]!.content.includes('Role: orchestrator.')) {
      if (++parentCalls === 1) return reply('', [{ id: 'parallel-budget', name: 'delegate', arguments: { tasks: [{ role: 'reviewer', task: 'Inspect isolated alpha module.' }, { role: 'researcher', task: 'Inspect isolated beta module.' }] } }]);
      return reply('Complete.');
    }
    childCalls++;
    // One child is already reserved. A second child must account for that live reservation.
    h.settings.tokenBudget = Math.ceil(estimateTokens([messages, tools]) * 1.25) + h.settings.maxOutputTokens + 100;
    await setTimeout(40);
    return reply('Child complete.');
  }, { maxAgents: 2 });
  try { await h.runtime.run(h.session, 'Run independent checks.', new AbortController().signal); }
  catch (error) { assert.match(String(error), /token limit/); }
  assert.equal(childCalls, 1);
  const observation = h.store.messages(h.session).find(message => message.toolCallId === 'parallel-budget');
  assert.match(observation?.content ?? '', /token limit/);
  assert.equal(h.runtime.agents.length, 2);
  assert.ok(h.runtime.agents.some(agent => agent.status === 'error'));
});

test('global agent count rejects oversized delegation without spawning children', async t => {
  let calls = 0;
  const h = await harness(t, async messages => {
    if (++calls === 1) return reply('', [{ id: 'too-many', name: 'delegate', arguments: { tasks: [{ role: 'coder', task: 'Perform isolated alpha work.' }, { role: 'tester', task: 'Perform isolated beta work.' }, { role: 'reviewer', task: 'Perform isolated gamma work.' }] } }]);
    assert.match(messages.at(-1)?.content ?? '', /Subagent limit/);
    return reply();
  }, { cortex: 1, maxAgents: 2 });
  await h.runtime.run(h.session, 'Delegate independent work.', new AbortController().signal);
  assert.equal(h.runtime.agents.length, 0);
});

test('Cortex 0 omits delegate and rejects a forged delegate call', async t => {
  let calls = 0;
  const h = await harness(t, async (messages, tools) => {
    assert.equal(tools.some(tool => tool.name === 'delegate'), false);
    if (++calls === 1) return reply('', [{ id: 'forged', name: 'delegate', arguments: { tasks: [{ role: 'coder', task: 'Independent small file change.' }] } }]);
    assert.equal(messages.at(-1)?.isError, true);
    return reply('Single agent complete.');
  }, { cortex: 0 });
  assert.equal(await h.runtime.run(h.session, 'Perform direct work.', new AbortController().signal), 'Single agent complete.');
  assert.equal(h.runtime.agents.length, 0);
});

test('cancellation repairs pending tool observations before session resumes', async t => {
  const cancellation = new AbortController();
  let calls = 0;
  const h = await harness(t, async messages => {
    if (++calls === 1) {
      cancellation.abort(new Error('Test cancellation.'));
      return reply('', [{ id: 'cancelled-write', name: 'write_file', arguments: { path: 'must-not-exist.txt', content: 'forbidden' } }]);
    }
    const repaired = messages.find(message => message.toolCallId === 'cancelled-write');
    assert.equal(repaired?.role, 'tool');
    assert.equal(repaired?.isError, true);
    return reply('Resumed.');
  });
  await assert.rejects(h.runtime.run(h.session, 'Create one file.', cancellation.signal), /cancellation/i);
  await assert.rejects(readFile(path.join(h.workspace.root, 'must-not-exist.txt')), { code: 'ENOENT' });
  assert.equal(h.store.messages(h.session).filter(message => message.toolCallId === 'cancelled-write').length, 1);
  assert.equal(await h.runtime.run(h.session, 'Continue after cancellation.', new AbortController().signal), 'Resumed.');
});

test('fallback runs only before any response chunk has streamed', async t => {
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const h = await harness(t, async (_messages, _tools, delta) => {
    primaryCalls++;
    if (primaryCalls === 1) throw new Error('503 before stream');
    delta('Partial answer.'); throw new Error('503 after stream');
  }, { fallback: ['backup'] });
  h.settings.providers.backup = { ...h.settings.providers.fake!, id: 'backup' };
  h.fallback.set('backup', provider(async () => { fallbackCalls++; return reply('Fallback complete.'); }));
  assert.equal(await h.runtime.run(h.session, 'First request.', new AbortController().signal), 'Fallback complete.');
  assert.equal(fallbackCalls, 1);
  await assert.rejects(h.runtime.run(h.session, 'Second request.', new AbortController().signal), /after stream/);
  assert.equal(fallbackCalls, 1);
});

test('action tasks skip catalog-known no-tool models when a tool-capable fallback exists', async t => {
  let primaryCalls = 0, fallbackCalls = 0;
  const h = await harness(t, async () => { primaryCalls++; throw new Error('Known no-tool provider must not be called for file actions.'); }, { fallback: ['backup'] });
  h.settings.providers.fake!.toolCalling = false;
  h.settings.providers.backup = { ...h.settings.providers.fake!, id: 'backup', model: 'tool-model', toolCalling: true };
  h.fallback.set('backup', provider(async (_messages, specs) => {
    fallbackCalls++;
    assert.ok(specs.some(spec => spec.name === 'write_file'));
    return reply('I can handle the request.');
  }));
  await h.runtime.run(h.session, 'Create a file called result.txt.', new AbortController().signal);
  assert.equal(primaryCalls, 0);
  assert.equal(fallbackCalls, 1);
  assert.ok(h.events.some(event => event.type === 'status' && /does not support the required capabilities/.test(event.text ?? '')));
});

test('no-tool models answer ordinary questions without tool schemas and disclose their limit', async t => {
  let seenTools = -1, seenInstructions = '';
  const h = await harness(t, async (messages, specs) => {
    seenTools = specs.length;
    seenInstructions = messages.find(message => message.role === 'system')?.content ?? '';
    return reply('42.');
  });
  h.settings.providers.fake!.toolCalling = false;
  assert.equal(await h.runtime.run(h.session, 'What is six times seven?', new AbortController().signal), '42.');
  assert.equal(seenTools, 0);
  assert.match(seenInstructions, /does not support tool calls/i);
});

test('action request on a tool-less setup receives a transparent limitation and cannot mutate files', async t => {
  let seenTools = -1;
  const h = await harness(t, async (_messages, specs) => { seenTools = specs.length; return reply('This model cannot edit files because it has no tool support.'); });
  h.settings.providers.fake!.toolCalling = false;
  const result = await h.runtime.run(h.session, 'Fix the typo in README.md.', new AbortController().signal);
  assert.equal(seenTools, 0);
  assert.match(result, /cannot edit files/i);
  await assert.rejects(readFile(path.join(h.workspace.root, 'README.md')), { code: 'ENOENT' });
});

test('web research refuses to invent sources when every configured model lacks tool calling', async t => {
  let calls = 0;
  const h = await harness(t, async () => { calls++; return reply('Here is an unsupported answer.'); });
  h.settings.providers.fake!.toolCalling = false;
  await assert.rejects(h.runtime.run(h.session, 'Search the web for current information about PolonRLM.', new AbortController().signal), /search|wyszukiwanie.*wymaga modelu/i);
  assert.equal(calls, 0);
});

test('image requests bypass models catalogued without vision for capable fallbacks', async t => {
  let primaryCalls = 0, fallbackCalls = 0;
  const h = await harness(t, async () => { primaryCalls++; throw new Error('Vision-incompatible provider must not receive images.'); }, { fallback: ['vision'], maxInputTokens: 32_000 });
  h.settings.providers.fake!.vision = false;
  h.settings.providers.vision = { ...h.settings.providers.fake!, id: 'vision', model: 'vision-model', toolCalling: true, vision: true };
  h.fallback.set('vision', provider(async (messages, specs) => {
    fallbackCalls++;
    assert.ok(specs.length > 0);
    assert.ok(messages.some(message => message.role === 'user' && message.images?.length));
    return reply('The image contains a test pixel.');
  }));
  const image = { data: 'AA==', mediaType: 'image/png' as const };
  assert.match(await h.runtime.run(h.session, 'Describe this image.', new AbortController().signal, [image]), /test pixel/);
  assert.equal(primaryCalls, 0);
  assert.equal(fallbackCalls, 1);
  assert.ok(h.events.some(event => event.type === 'status' && /does not support the required capabilities/.test(event.text ?? '')));
});

test('withheld secret prefixes do not count as visible output when choosing a fallback', async t => {
  const secret = 'fallback-private-secret-abcdefgh'; registerSecret(secret);
  let fallbackCalls = 0;
  const h = await harness(t, async (_messages, _tools, delta) => { delta(secret.slice(0, 12)); throw new Error('primary failed'); }, { fallback: ['backup'] });
  h.settings.providers.backup = { ...h.settings.providers.fake!, id: 'backup' };
  h.fallback.set('backup', provider(async () => { fallbackCalls++; return reply('Recovered.'); }));
  assert.equal(await h.runtime.run(h.session, 'Answer briefly.', new AbortController().signal), 'Recovered.');
  assert.equal(fallbackCalls, 1);
  assert.equal(h.events.filter(event => event.type === 'text').length, 0);
});

test('split streaming secrets never reach text events, returned text or history', async t => {
  const secret = 'runtime-private-secret-123456789'; registerSecret(secret);
  const h = await harness(t, async (_messages, _tools, delta) => {
    delta('Before '); delta(secret.slice(0, 12)); delta(secret.slice(12)); delta(' after.');
    return reply(`Before ${secret} after.`);
  });
  const output = await h.runtime.run(h.session, 'Return a short answer.', new AbortController().signal);
  assert.equal(output, 'Before [REDACTED] after.');
  const streamed = h.events.filter(event => event.type === 'text').map(event => event.text).join('');
  assert.equal(streamed, output);
  assert.equal(JSON.stringify(h.store.messages(h.session)).includes(secret), false);
});

test('project instructions redact registered credentials before provider receives context', async t => {
  const secret = 'project-instructions-secret-123456789'; registerSecret(secret);
  const h = await harness(t, async messages => {
    assert.equal(JSON.stringify(messages).includes(secret), false);
    assert.match(messages[0]?.content ?? '', /\[REDACTED\]/);
    return reply();
  });
  await writeFile(path.join(h.workspace.root, 'AGENTS.md'), `Project instructions with legacy credential ${secret}.`);
  await h.runtime.run(h.session, 'Read project guidance.', new AbortController().signal);
});

test('project instructions include only nested AGENTS files on explicit target paths', async t => {
  const h = await harness(t, async messages => {
    const system = messages.find(message => message.role === 'system')?.content ?? '';
    assert.match(system, /Nested source rule/);
    assert.match(system, /Project instructions src\/AGENTS\.md/);
    assert.doesNotMatch(system, /Unrelated test rule/);
    return reply();
  });
  await mkdir(path.join(h.workspace.root, 'src'), { recursive: true });
  await mkdir(path.join(h.workspace.root, 'tests'), { recursive: true });
  await writeFile(path.join(h.workspace.root, 'src', 'AGENTS.md'), 'Nested source rule.');
  await writeFile(path.join(h.workspace.root, 'tests', 'AGENTS.md'), 'Unrelated test rule.');
  await h.runtime.run(h.session, 'Update src/feature.ts.', new AbortController().signal);
});

test('failed streams with partial secrets do not flush withheld text or trigger fallback', async t => {
  const secret = 'withheld-runtime-secret-abcdefgh'; registerSecret(secret);
  let fallbackCalls = 0;
  const h = await harness(t, async (_messages, _tools, delta) => {
    delta('Before '); delta(secret.slice(0, 15)); throw new Error('Interrupted stream');
  }, { fallback: ['backup'] });
  h.settings.providers.backup = { ...h.settings.providers.fake!, id: 'backup' };
  h.fallback.set('backup', provider(async () => { fallbackCalls++; return reply(); }));
  await assert.rejects(h.runtime.run(h.session, 'Answer briefly.', new AbortController().signal), /Interrupted/);
  assert.equal(h.events.filter(event => event.type === 'text').map(event => event.text).join(''), 'Before ');
  assert.equal(fallbackCalls, 0);
});

test('step and token budgets stop actual model calls', async t => {
  let calls = 0;
  const h = await harness(t, async () => {
    calls++; return reply('', [{ id: 'step-write', name: 'write_file', arguments: { path: 'one-step.txt', content: 'one call' } }]);
  }, { maxSteps: 1 });
  await assert.rejects(h.runtime.run(h.session, 'Write one file.', new AbortController().signal), /1-step limit/);
  assert.equal(calls, 1);
  assert.equal(await readFile(path.join(h.workspace.root, 'one-step.txt'), 'utf8'), 'one call');
  h.settings.maxSteps = 10; h.settings.tokenBudget = 1_000;
  await assert.rejects(h.runtime.run(h.session, 'Continue.', new AbortController().signal), /token limit/);
  assert.equal(calls, 1);
});

test('all subagents share maxSteps rather than multiplying API call limit', async t => {
  let calls = 0;
  const h = await harness(t, async messages => {
    calls++;
    if (messages[0]!.content.includes('Role: orchestrator.')) return reply('', [{ id: 'shared-step', name: 'delegate', arguments: { tasks: [{ role: 'reviewer', task: 'Inspect one isolated module.' }] } }]);
    return reply('Reviewed.');
  }, { maxSteps: 2 });
  await assert.rejects(h.runtime.run(h.session, 'Run isolated review.', new AbortController().signal), /Shared limit of 2 model calls/);
  assert.equal(calls, 2);
});

test('cost reservation includes highest configured fallback price', async t => {
  let calls = 0;
  const h = await harness(t, async () => { calls++; return reply(); }, { fallback: ['expensive'], dollarBudget: 0.000001 });
  h.settings.providers.expensive = { ...h.settings.providers.fake!, id: 'expensive', inputPrice: 10, outputPrice: 10 };
  await assert.rejects(h.runtime.run(h.session, 'Answer briefly.', new AbortController().signal), /Cost limit/);
  assert.equal(calls, 0);
});

test('compaction bounds a long single turn without orphan tool replies or lost current requirements', () => {
  const messages: Message[] = [{ role: 'user', content: 'Preserve this exact requirement and verify generated files.' }];
  for (let index = 0; index < 15; index++) {
    messages.push({ role: 'assistant', content: '', toolCalls: [{ id: `call-${index}`, name: 'write_file', arguments: { path: `result-${index}.ts`, content: 'export const result = 1;\n'.repeat(300) } }] });
    messages.push({ role: 'tool', name: 'write_file', toolCallId: `call-${index}`, content: `Created result-${index}.ts\n${'+verified\n'.repeat(300)}` });
  }
  const original = JSON.stringify(messages);
  const compacted = compactMessages(messages, 1_500);
  assert.ok(compacted.removed > 0);
  assert.ok(estimateTokens(compacted.messages) <= 1_500);
  assert.ok(compacted.messages.some(message => message.content === messages[0]!.content));
  for (const message of compacted.messages) if (message.role === 'tool') assert.ok(compacted.messages.some(assistant => assistant.toolCalls?.some(call => call.id === message.toolCallId)));
  assert.equal(JSON.stringify(messages), original);
});

test('compaction summarizes an oversized historical user requirement and keeps the latest request verbatim', () => {
  const marker = 'PRESERVE_HISTORICAL_REQUIREMENT_9421';
  const latest = 'Continue the current implementation and verify it.';
  const messages: Message[] = [{ role: 'user', content: `Never delete the migration source. Preserve the exact requirement ${marker}. ${'Historical implementation context. '.repeat(300)}` }];
  for (let index = 0; index < 50; index++) {
    messages.push({ role: 'user', content: `Historical request ${index}: inspect a routine module. ${'Routine context detail. '.repeat(48)}` });
    messages.push({ role: 'assistant', content: `Historical result ${index}: ordinary inspection completed. ${'Routine finding. '.repeat(48)}` });
  }
  messages.push({ role: 'user', content: latest });
  const compacted = compactMessages(messages, 1_800);
  const summary = compacted.messages.find(message => message.name === 'polonrlm_context')?.content ?? '';
  assert.ok(compacted.removed > 0);
  assert.ok(summary.includes(marker), 'the critical requirement should survive in the structured summary');
  assert.ok(compacted.messages.some(message => message.role === 'user' && message.content === latest));
  assert.ok(estimateTokens(compacted.messages) <= 1_800);
});

test('automatic compaction persists structured context and can retrieve exact older details on demand', async t => {
  const needle = 'immutable-ancient-constraint-token';
  let calls = 0;
  let h!: Awaited<ReturnType<typeof harness>>;
  h = await harness(t, async (messages, tools) => {
    calls++;
    const requestTokens = estimateTokens([messages, tools]);
    assert.ok(requestTokens <= h.settings.maxInputTokens, `complete request estimate ${requestTokens} exceeds ${h.settings.maxInputTokens}`);
    if (calls === 1) {
      assert.ok(messages.some(message => message.name === 'polonrlm_context'));
      assert.equal(tools.some(tool => tool.name === 'search_history'), false, 'history search appears on the next step after compaction');
      return reply('', [{ id: 'observe-workspace', name: 'list_directory', arguments: { path: '.' } }]);
    }
    if (calls === 2) {
      assert.ok(tools.some(tool => tool.name === 'search_history'));
      return reply('', [{ id: 'recover-constraint', name: 'search_history', arguments: { query: needle } }]);
    }
    assert.match(messages.at(-1)?.content ?? '', new RegExp(needle));
    return reply('Odzyskałem dokładny wymóg z archiwum.');
  });
  for (let index = 0; index < 18; index++) {
    h.store.append(h.session, { role: 'user', content: index === 0 ? `Never delete the migration source; preserve ${needle} in src/core/config.ts.` : `Old task ${index}: inspect ordinary fixture ${index}.` });
    h.store.append(h.session, { role: 'assistant', content: `Old result ${index}: ${'ordinary historical detail '.repeat(280)}` });
  }
  const originalCount = h.store.messages(h.session).length;
  assert.equal(await h.runtime.run(h.session, 'Continue the latest work.', new AbortController().signal), 'Odzyskałem dokładny wymóg z archiwum.');
  const full = h.store.messages(h.session);
  const active = h.store.context(h.session);
  assert.equal(full.length, originalCount + 6);
  assert.ok(full.some(message => message.content.includes(needle)), 'full transcript remains intact in SQLite');
  assert.ok(active.some(message => message.name === 'polonrlm_context'), 'compacted memory persists for the next turn');
  assert.ok(estimateTokens(active) < estimateTokens(full), 'future turns use the compact active context');
});

test('archived context resumes while complete SQLite conversation remains available', async t => {
  const h = await harness(t, async messages => { assert.ok(estimateTokens(messages) < 6_000); return reply('Resumed compact context.'); });
  for (let index = 0; index < 10; index++) {
    h.store.append(h.session, { role: 'user', content: `Historical task ${index}` });
    h.store.append(h.session, { role: 'assistant', content: `Historical evidence ${index}: ${'x'.repeat(4_000)}` });
  }
  const originalCount = h.store.messages(h.session).length;
  const compacted = compactMessages(h.store.context(h.session), 1_500);
  h.store.archiveContext(h.session, compacted.messages);
  assert.equal(h.store.messages(h.session).length, originalCount);
  assert.ok(estimateTokens(h.store.context(h.session)) <= 1_500);
  assert.equal(await h.runtime.run(h.session, 'Continue retained goal.', new AbortController().signal), 'Resumed compact context.');
  assert.equal(h.store.messages(h.session).length, originalCount + 2);
});

test('oversized current user requirements fail explicitly without API call or silent truncation', async t => {
  let calls = 0;
  const h = await harness(t, async () => { calls++; return reply(); });
  const task = 'Preserve every requirement.\n' + '🔥'.repeat(20_000);
  await assert.rejects(h.runtime.run(h.session, task, new AbortController().signal), /Context exceeds the limit/);
  assert.equal(calls, 0);
  assert.equal(h.store.messages(h.session)[0]?.content, task);
});
