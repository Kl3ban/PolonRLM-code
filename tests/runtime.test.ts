import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { AgentRuntime, createRunBudget } from '../src/core/runtime.js';
import { MAX_PROVIDER_RETRIES, PROVIDER_RETRY_DELAY_MS } from '../src/providers/retry.js';
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
import { PluginManager } from '../src/plugins/manager.js';
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

test('trusted plugin hooks add task context, block tools without bypassing permissions, and observe task completion', async t => {
  let calls = 0;
  let sawPluginContext = false;
  let sawBlockedTool = false;
  const h = await harness(t, async messages => {
    calls++;
    if (calls === 1) {
      sawPluginContext = /Supplemental trusted plugin context[\s\S]*review reminder/.test(String(messages[0]?.content ?? ''));
      return reply('', [{ id: 'blocked-write', name: 'write_file', arguments: { path: 'blocked-by-plugin.txt', content: 'not written' } }]);
    }
    sawBlockedTool = messages.some(message => message.role === 'tool' && /blocked write_file: manual review required/.test(message.content));
    return reply('The write was blocked by the plugin policy.');
  });
  const plugins = new PluginManager(h.home);
  t.after(() => plugins.close());
  const id = 'runtime-policy';
  const marker = `__polonrlm_runtime_plugin_${Date.now()}`;
  const directory = await plugins.create(id);
  await writeFile(path.join(directory, 'index.mjs'), `
globalThis[${JSON.stringify(marker)}] = { status: null };
export default {
  id: ${JSON.stringify(id)}, version: '1.0.0',
  activate(api) {
    api.hooks.beforeTask(() => 'review reminder');
    api.hooks.beforeTool(({ tool }) => tool === 'write_file' ? 'manual review required' : undefined);
    api.hooks.afterTask(({ status }) => { globalThis[${JSON.stringify(marker)}].status = status; });
  },
};
`, 'utf8');
  const preview = await plugins.review(id);
  assert.equal(plugins.consumeReview(id, preview.sha256), true);
  await plugins.activate(id, preview.sha256);
  (h.runtime as any).plugins = plugins;

  assert.equal(await h.runtime.run(h.session, 'Write a new file.', new AbortController().signal), 'The write was blocked by the plugin policy.');
  assert.equal(sawPluginContext, true);
  assert.equal(sawBlockedTool, true);
  await assert.rejects(readFile(path.join(h.workspace.root, 'blocked-by-plugin.txt')), /ENOENT/);
  assert.equal((globalThis as Record<string, any>)[marker].status, 'complete');
  assert.ok(h.events.some(event => event.type === 'tool' && event.name === 'write_file' && event.state === 'error'));
});

test('runtime warns once and stops a repeated five-tool cycle without a model call for completion', async t => {
  const { z } = await import('zod');
  let calls = 0;
  let toolCalls = 0;
  const cycleTools = ['cycle_alpha', 'cycle_beta', 'cycle_gamma', 'cycle_delta', 'cycle_epsilon'];
  const cycleResults = ['alpha result', 'beta result', 'gamma result', 'delta result', 'epsilon result'];
  const h = await harness(t, async () => {
    calls++;
    if (calls === 1) return reply('', [{ id: 'discover-cycle-tools', name: 'discover_tools', arguments: { query: 'cycle' } }]);
    if (calls <= 16) {
      const tool = cycleTools[(calls - 2) % cycleTools.length]!;
      toolCalls++;
      return reply('', [{ id: `cycle-${calls}`, name: tool, arguments: { value: tool } }]);
    }
    assert.fail('The runtime should stop after the already-warned cycle repeats.');
  }, { maxSteps: 20 });
  cycleTools.forEach((tool, index) => h.tools.add(tool, `Tool ${index + 1} in a deterministic cycle.`, z.object({ value: z.string() }), false, async () => cycleResults[index]!));

  const answer = await h.runtime.run(h.session, 'Investigate this by using the cycle tools.', new AbortController().signal);
  assert.match(answer, /Stopped because the same tool sequence repeated again/);
  assert.equal(calls, 12, 'the runtime should stop at the first continued cycle phase without another model turn');
  assert.equal(toolCalls, 11);
  const results = h.store.messages(h.session).filter(message => message.role === 'tool' && cycleTools.includes(message.name ?? ''));
  assert.equal(results.length, 11);
  assert.match(results[9]!.content, /Adaptive tool-cycle guard: the same 5-step tool sequence repeated twice/);
  assert.match(results[10]!.content, /repeated again after a warning/);
});

test('zero provider timeout inherits the configured global timeout', async t => {
  const h = await harness(t, async (_messages, _specs, _onDelta, signal) => {
    await setTimeout(100, undefined, { signal });
    return reply('The global timeout was ignored.');
  }, { timeoutMs: 20, maxSteps: 1 }, 1);
  h.settings.providers.fake!.requestTimeoutMs = 0;
  await assert.rejects(h.runtime.run(h.session, 'Answer briefly.', new AbortController().signal), /Shared limit of 1 model calls reached while retrying fake/);
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

test('session task plans persist through tools and resume with compact active-goal progress', async t => {
  const plan = [
    { step: 'Inspect the existing authentication flow', status: 'done' as const },
    { step: 'Add regression tests', status: 'in_progress' as const },
    { step: 'Run the verification suite', status: 'pending' as const },
  ];
  let calls = 0;
  const h = await harness(t, async messages => {
    calls++;
    if (calls === 1) return reply('', [{ id: 'discover-plan', name: 'discover_tools', arguments: { query: 'plan_update' } }]);
    if (calls === 2) return reply('', [{ id: 'save-plan', name: 'plan_update', arguments: { steps: plan } }]);
    if (calls === 3) {
      const system = messages.find(message => message.role === 'system')?.content ?? '';
      assert.match(system, /TASK PLAN PROGRESS: 1\/3 steps marked done; active step: Add regression tests/);
      return reply('', [{ id: 'read-plan', name: 'plan_status', arguments: {} }]);
    }
    const saved = messages.findLast(message => message.role === 'tool' && message.name === 'plan_status')?.content;
    assert.deepEqual(JSON.parse(saved ?? 'null'), plan);
    return reply('The persisted task plan is available.');
  }, { maxSteps: 8 });
  h.store.saveWorkflow(h.session, { goal: { objective: 'Verify the authentication change', status: 'active', tokenBudget: 0, usedTokens: 0 } });

  assert.equal(await h.runtime.run(h.session, 'Refactor authentication across auth.ts and sessions.ts, add regression tests, and verify it.', new AbortController().signal), 'The persisted task plan is available.');
  assert.deepEqual(h.store.workflow(h.session).plan, plan);
  const reopened = new SessionStore(h.home);
  try { assert.deepEqual(reopened.workflow(h.session).plan, plan); }
  finally { reopened.close(); }
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
    cortex: 2, cortexStrategy: 'fixed', permissions: 'workspace', maxOutputTokens: 128, maxInputTokens: 12_000,
    maxSteps: 12, tokenBudget: 100_000, timeoutMs: 5_000, ...overrides,
  };
  const permissions = new Permissions(settings);
  const workspace = await Workspace.open(folder, permissions);
  const store = new SessionStore(home);
  const tools = new ToolRegistry(permissions, settings.toolOutputLimit);
  registerBuiltins(tools, workspace, settings, { store });
  const skills = new SkillsManager(home, workspace.root);
  const mcp = new MCPManager({});
  const session = store.create(workspace.root);
  const events: RuntimeEvent[] = [];
  const fallback = new Map<string, LLMProvider>();
  const providerSelections: Array<{ id?: string; model?: string }> = [];
  const primary = provider(complete);
  const runtime = new AgentRuntime(settings, store, tools, workspace, skills, mcp, async (id, model) => {
    providerSelections.push({ id, model });
    return fallback.get(id ?? 'fake') ?? primary;
  }, event => events.push(event), retryDelayMs);
  t.after(async () => { await mcp.close(); store.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  return { root, home, settings, workspace, store, tools, skills, mcp, session, events, fallback, providerSelections, runtime };
}

test('role model routing passes the selected model override without changing the saved provider', async t => {
  const h = await harness(t, async () => reply('Routed response.'), {
    providers: {
      fake: { id: 'fake', kind: 'compatible', baseURL: 'http://127.0.0.1:1/v1', model: 'fake', inputPrice: 0, outputPrice: 0, contextWindow: 64_000 },
      alternate: { id: 'alternate', kind: 'compatible', baseURL: 'http://127.0.0.1:1/v1', model: 'saved-model', inputPrice: 0, outputPrice: 0, contextWindow: 64_000 },
    },
    modelRoutes: { orchestrator: { provider: 'alternate', model: 'fast-flash' } },
  });
  assert.equal(await h.runtime.run(h.session, 'Answer briefly.', new AbortController().signal), 'Routed response.');
  assert.deepEqual(h.providerSelections, [{ id: 'alternate', model: 'fast-flash' }]);
  assert.equal(h.settings.provider, 'fake');
  assert.equal(h.settings.providers.alternate!.model, 'saved-model');
  const modelEvidence = h.store.evidenceTimeline(h.session).find(event => event.kind === 'model');
  assert.ok(modelEvidence);
  assert.equal(modelEvidence.actor, 'orchestrator');
  assert.equal(modelEvidence.status, 'done');
  assert.match(modelEvidence.summary, /alternate\/fast-flash.*15 tokens/);
});

test('adaptive Cortex skips subagent schemas for simple tasks even at Maximum', async t => {
  let offered: string[] = [];
  const h = await harness(t, async (_messages, specs) => { offered = specs.map(spec => spec.name); return reply('Four.'); }, { cortex: 5, cortexStrategy: 'adaptive' });
  assert.equal(await h.runtime.run(h.session, 'What is 2 + 2?', new AbortController().signal), 'Four.');
  assert.ok(!offered.includes('delegate'));
  assert.ok(h.events.some(event => event.type === 'status' && /Adaptive Cortex: Fast strategy/.test(event.text ?? '')));
});

test('adaptive Cortex keeps delegation available for a cross-file change', async t => {
  let offered: string[] = [];
  const h = await harness(t, async (_messages, specs) => { offered = specs.map(spec => spec.name); return reply('Ready for focused parallel work.'); }, { cortex: 5, cortexStrategy: 'adaptive' });
  await h.runtime.run(h.session, 'Refactor authentication across auth.ts, sessions.ts, and api.ts; add regression tests, verify behavior, and update architecture documentation.', new AbortController().signal);
  assert.ok(offered.includes('delegate'));
  assert.ok(h.events.some(event => event.type === 'status' && /Adaptive Cortex: Deep strategy \(complex task\)/.test(event.text ?? '')));
});

test('fixed Cortex strategy preserves the selected level on a simple task', async t => {
  let offered: string[] = [];
  const h = await harness(t, async (_messages, specs) => { offered = specs.map(spec => spec.name); return reply('Four.'); }, { cortex: 5, cortexStrategy: 'fixed' });
  await h.runtime.run(h.session, 'What is 2 + 2?', new AbortController().signal);
  assert.ok(offered.includes('delegate'));
  assert.ok(!h.events.some(event => event.type === 'status' && /Adaptive Cortex/.test(event.text ?? '')));
});

test('role model call budgets block retries before a second provider request', async t => {
  let calls = 0;
  const h = await harness(t, async () => { calls++; throw new Error('The selected provider is temporarily busy.'); }, {
    modelRoleBudgets: { orchestrator: { maxCalls: 1 } },
  }, 0);
  await assert.rejects(h.runtime.run(h.session, 'Answer briefly.', new AbortController().signal), /Role budget for orchestrator reached its 1-call limit/);
  assert.equal(calls, 1);
  assert.equal(h.store.evidenceTimeline(h.session)[0]?.status, 'error');
});

test('run reuses a shared task budget across verification repair attempts', async t => {
  let calls = 0;
  const h = await harness(t, async () => { calls++; return reply('Repair analysis complete.'); }, { maxSteps: 1 }, 0);
  const budget = createRunBudget();
  await h.runtime.run(h.session, 'First bounded repair attempt.', new AbortController().signal, undefined, budget);
  assert.equal(budget.calls, 1);
  await assert.rejects(h.runtime.run(h.session, 'Second bounded repair attempt.', new AbortController().signal, undefined, budget), /Shared limit of 1 model calls reached/);
  assert.equal(calls, 1);
});

test('role token budgets stop an oversized request before contacting the provider', async t => {
  let calls = 0;
  const h = await harness(t, async () => { calls++; return reply('Should not be requested.'); }, {
    modelRoleBudgets: { orchestrator: { maxTokens: 100 } },
  });
  await assert.rejects(h.runtime.run(h.session, 'Answer briefly.', new AbortController().signal), /Role budget for orchestrator reached its 100-token limit/);
  assert.equal(calls, 0);
});

test('role cost budgets preflight against configured provider prices', async t => {
  let calls = 0;
  const h = await harness(t, async () => { calls++; return reply('Should not be requested.'); }, {
    providers: { fake: { id: 'fake', kind: 'compatible', baseURL: 'http://127.0.0.1:1/v1', model: 'fake', inputPrice: 10, outputPrice: 10, contextWindow: 64_000 } },
    modelRoleBudgets: { orchestrator: { maxCost: 0.000001 } },
  });
  await assert.rejects(h.runtime.run(h.session, 'Answer briefly.', new AbortController().signal), /Role budget for orchestrator reached its \$0\.000001 cost limit/);
  assert.equal(calls, 0);
});

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
  assert.ok(h.events.some(event => event.type === 'status' && new RegExp(`fake did not respond\\. Retrying in 10 seconds \\(retry 1/${MAX_PROVIDER_RETRIES}\\)`).test(event.text ?? '')));
  assert.equal(PROVIDER_RETRY_DELAY_MS, 10_000);
});

test('HTTP 402 payment errors never enter the retry loop even when the message says busy', async t => {
  let calls = 0;
  const h = await harness(t, async () => {
    calls++;
    throw Object.assign(new Error('The selected provider is temporarily busy (HTTP 402).'), { statusCode: 402 });
  }, { maxSteps: 2 }, 0);
  await assert.rejects(h.runtime.run(h.session, 'Answer briefly.', new AbortController().signal), /HTTP 402/);
  assert.equal(calls, 1);
  assert.ok(!h.events.some(event => event.type === 'status' && /Retrying/.test(event.text ?? '')));
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

test('empty model replies retry with a recovery instruction and retain usage', async t => {
  let calls = 0;
  const h = await harness(t, async (messages, _specs, _onDelta, _signal, options) => {
    calls++;
    if (calls === 1) return reply('');
    assert.match(messages.at(-1)?.content ?? '', /previous response was empty/i);
    assert.equal(options?.toolChoice, 'required');
    return reply('Recovered from empty response.');
  }, {}, 0);
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

test('provider retries stop after a bounded number when no budget limits are set', async t => {
  let calls = 0;
  const h = await harness(t, async () => {
    calls++;
    throw new Error('The selected provider is temporarily busy.');
  }, { maxSteps: 0, tokenBudget: 0, dollarBudget: 0 }, 0);
  await assert.rejects(h.runtime.run(h.session, 'Answer briefly.', new AbortController().signal), /temporarily busy/);
  assert.equal(calls, MAX_PROVIDER_RETRIES + 1);
  assert.equal(h.events.filter(event => event.type === 'status' && /Retrying in/.test(event.text ?? '')).length, MAX_PROVIDER_RETRIES);
  assert.ok(h.events.some(event => event.type === 'status' && new RegExp(`retry 3/${MAX_PROVIDER_RETRIES}`).test(event.text ?? '')));
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

test('read-cycle detection stops A-B-A when no successful state change occurred', async t => {
  let calls = 0;
  const h = await harness(t, async messages => {
    calls++;
    if (calls === 1) return reply('', [{ id: 'read-a-1', name: 'read_file', arguments: { path: 'first.txt' } }]);
    if (calls === 2) {
      assert.match(messages.at(-1)?.content ?? '', /first file/);
      return reply('', [{ id: 'read-b', name: 'read_file', arguments: { path: 'second.txt' } }]);
    }
    assert.match(messages.at(-1)?.content ?? '', /second file/);
    return reply('', [{ id: 'read-a-2', name: 'read_file', arguments: { path: 'first.txt' } }]);
  }, { permissions: 'all' });
  await writeFile(path.join(h.workspace.root, 'first.txt'), 'first file');
  await writeFile(path.join(h.workspace.root, 'second.txt'), 'second file');

  const result = await h.runtime.run(h.session, 'Read first.txt, then second.txt, then inspect first.txt again.', new AbortController().signal);

  assert.match(result, /repeated the same read/);
  assert.equal(calls, 3, 'the runtime stops after detecting the cycle instead of making another model request');
  const toolMessages = h.store.messages(h.session).filter(message => message.role === 'tool' && message.name === 'read_file');
  assert.equal(toolMessages.filter(message => !message.isError).length, 2);
  assert.equal(toolMessages.filter(message => message.isError).length, 1);
});

test('parallel reads are tracked by the read-cycle guard', async t => {
  let calls = 0;
  const h = await harness(t, async messages => {
    calls++;
    if (calls === 1) return reply('', [
      { id: 'parallel-a', name: 'read_file', arguments: { path: 'first.txt' } },
      { id: 'parallel-b', name: 'read_file', arguments: { path: 'second.txt' } },
    ]);
    const readResults = messages.filter(message => message.role === 'tool' && message.name === 'read_file').map(message => message.content);
    assert.equal(readResults.length, 2);
    assert.ok(readResults.some(content => content.includes('first file')));
    assert.ok(readResults.some(content => content.includes('second file')));
    return reply('', [{ id: 'parallel-a-repeat', name: 'read_file', arguments: { path: 'first.txt' } }]);
  }, { permissions: 'all' });
  await writeFile(path.join(h.workspace.root, 'first.txt'), 'first file');
  await writeFile(path.join(h.workspace.root, 'second.txt'), 'second file');

  const result = await h.runtime.run(h.session, 'Read first.txt and second.txt, then use those results.', new AbortController().signal);

  assert.match(result, /repeated the same read/);
  assert.equal(calls, 2);
  const toolMessages = h.store.messages(h.session).filter(message => message.role === 'tool' && message.name === 'read_file');
  assert.equal(toolMessages.filter(message => !message.isError).length, 2);
  assert.equal(toolMessages.filter(message => message.isError).length, 1);
});

test('a successful file write clears read-cycle history so verification reads can run', async t => {
  let calls = 0;
  const h = await harness(t, async messages => {
    calls++;
    if (calls === 1) return reply('', [{ id: 'read-before', name: 'read_file', arguments: { path: 'sample.txt' } }]);
    if (calls === 2) {
      assert.match(messages.at(-1)?.content ?? '', /before/);
      return reply('', [{ id: 'write', name: 'write_file', arguments: { path: 'sample.txt', content: 'after' } }]);
    }
    if (calls === 3) return reply('', [{ id: 'read-after', name: 'read_file', arguments: { path: 'sample.txt' } }]);
    assert.match(messages.at(-1)?.content ?? '', /after/);
    return reply('Verified the updated file.');
  }, { permissions: 'all' });
  await writeFile(path.join(h.workspace.root, 'sample.txt'), 'before');

  assert.equal(await h.runtime.run(h.session, 'Read sample.txt, update it, and verify the new content.', new AbortController().signal), 'Verified the updated file.');
  assert.equal(calls, 4);
});

test('independent file reads in one model response run concurrently and keep result order', async t => {
  let calls = 0, active = 0, peak = 0;
  const h = await harness(t, async () => ++calls === 1
    ? reply('', [
      { id: 'read-a', name: 'read_file', arguments: { path: 'a.txt' } },
      { id: 'read-b', name: 'read_file', arguments: { path: 'b.txt' } },
    ])
    : reply('Both files were read.'));
  const { z } = await import('zod');
  h.tools.add('read_file', 'Parallel fixture read.', z.object({ path: z.string() }), true, async args => {
    active++; peak = Math.max(peak, active);
    try { await setTimeout(30); return `content:${args.path}`; }
    finally { active--; }
  });
  assert.equal(await h.runtime.run(h.session, 'Read a.txt and b.txt.', new AbortController().signal), 'Both files were read.');
  assert.equal(peak, 2, 'safe independent reads should overlap');
  assert.deepEqual(h.store.messages(h.session).filter(message => message.role === 'tool').map(message => message.content), ['content:a.txt', 'content:b.txt']);
});

test('parallel file reads stay sequential when a tool has an explicit approval rule', async t => {
  let calls = 0, active = 0, peak = 0, approvals = 0, activeApprovals = 0, approvalPeak = 0;
  const h = await harness(t, async () => ++calls === 1
    ? reply('', [
      { id: 'read-a', name: 'read_file', arguments: { path: 'a.txt' } },
      { id: 'read-b', name: 'read_file', arguments: { path: 'b.txt' } },
    ])
    : reply('Both files were read.'), { permissions: 'workspace', toolPermissions: { read_file: 'ask' } });
  const { z } = await import('zod');
  h.workspace.permissions.approve = async () => {
    activeApprovals++; approvalPeak = Math.max(approvalPeak, activeApprovals);
    try { await setTimeout(10); approvals++; return true; }
    finally { activeApprovals--; }
  };
  h.tools.add('read_file', 'Approval fixture read.', z.object({ path: z.string() }), true, async args => {
    active++; peak = Math.max(peak, active);
    try { await setTimeout(20); return `content:${args.path}`; }
    finally { active--; }
  });
  assert.equal(await h.runtime.run(h.session, 'Read a.txt and b.txt.', new AbortController().signal), 'Both files were read.');
  assert.equal(peak, 1, 'approval-gated reads must not race or open overlapping prompts');
  assert.equal(approvals, 2);
  assert.equal(approvalPeak, 1, 'approval prompts should remain sequential');
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

test('adaptive loop guard warns after three identical test failures and resets after a project change', async t => {
  const { z } = await import('zod');
  let calls = 0;
  const h = await harness(t, async () => {
    calls++;
    if (calls <= 3 || calls === 5) return reply('', [{ id: `loop-test-${calls}`, name: 'run_tests', arguments: { command: `npm test -- case-${calls}` } }]);
    if (calls === 4) return reply('', [{ id: 'loop-write', name: 'write_file', arguments: { path: 'progress.txt', content: 'changed' } }]);
    return reply('The same test failure returned after the edit. I will inspect its cause instead of repeating the same test command.');
  }, { repeatFailureThreshold: 3 });
  h.tools.add('run_tests', 'Return a stable failing test diagnostic.', z.object({ command: z.string() }), false, async () => ({ exitCode: 1, stdout: '', stderr: 'Expected true but received false' }));
  const result = await h.runtime.run(h.session, 'Diagnose and fix the failing test.', new AbortController().signal);
  const testResults = h.store.messages(h.session).filter(message => message.role === 'tool' && message.name === 'run_tests');
  assert.equal(testResults.length, 4);
  assert.match(testResults[2]!.content, /Adaptive loop guard: the same run_tests failure occurred 3 times/);
  assert.doesNotMatch(testResults[3]!.content, /Adaptive loop guard/);
  assert.match(result, /inspect its cause/);
});

test('adaptive Cortex escalates one level after repeated failure without progress', async t => {
  const { z } = await import('zod');
  let calls = 0;
  const h = await harness(t, async () => {
    calls++;
    if (calls <= 3) return reply('', [{ id: `escalate-test-${calls}`, name: 'run_tests', arguments: { command: `npm test -- case-${calls}` } }]);
    return reply('Changed the approach after the escalation.');
  }, { repeatFailureThreshold: 3, cortex: 3, cortexStrategy: 'adaptive' });
  h.tools.add('run_tests', 'Return a stable failing test diagnostic.', z.object({ command: z.string() }), false, async () => ({ exitCode: 1, stdout: '', stderr: 'Expected true but received false' }));
  await h.runtime.run(h.session, 'Diagnose and fix the failing test.', new AbortController().signal);
  assert.ok(h.events.some(event => event.type === 'status' && /Adaptive Cortex: escalating to Advanced after stagnation/.test(event.text ?? '')));
  const testResults = h.store.messages(h.session).filter(message => message.role === 'tool' && message.name === 'run_tests');
  assert.match(testResults[2]!.content, /Adaptive Cortex escalated to Advanced/);
});

test('adaptive loop guard does not reset after a successful no-op write', async t => {
  const { z } = await import('zod');
  let calls = 0;
  const h = await harness(t, async () => {
    calls++;
    if (calls <= 2 || calls === 4) return reply('', [{ id: `noop-loop-test-${calls}`, name: 'run_tests', arguments: { command: `npm test -- case-${calls}` } }]);
    if (calls === 3) return reply('', [{ id: 'noop-loop-write', name: 'write_file', arguments: { path: 'progress.txt', content: 'unchanged' } }]);
    return reply('The failure repeated after a no-op write, so I will inspect it instead of retrying.');
  }, { repeatFailureThreshold: 3 });
  await writeFile(path.join(h.workspace.root, 'progress.txt'), 'unchanged');
  h.tools.add('run_tests', 'Return a stable failing test diagnostic.', z.object({ command: z.string() }), false, async () => ({ exitCode: 1, stdout: '', stderr: 'Expected true but received false' }));
  const result = await h.runtime.run(h.session, 'Diagnose the repeated test failure.', new AbortController().signal);
  const writes = h.store.messages(h.session).filter(message => message.role === 'tool' && message.name === 'write_file');
  const testResults = h.store.messages(h.session).filter(message => message.role === 'tool' && message.name === 'run_tests');
  assert.match(writes[0]!.content, /No changes\./);
  assert.equal(testResults.length, 3);
  assert.match(testResults[2]!.content, /Adaptive loop guard: the same run_tests failure occurred 3 times/);
  assert.match(result, /inspect it instead of retrying/);
});

test('adaptive loop guard catches changing test failures when no workspace progress is made', async t => {
  const { z } = await import('zod');
  let calls = 0;
  const diagnostics = ['Expected true but received false', 'Missing export: parseConfig', 'Module not found: plugin-core'];
  const h = await harness(t, async () => {
    calls++;
    if (calls <= diagnostics.length) return reply('', [{ id: `changing-test-${calls}`, name: 'run_tests', arguments: { command: `npm test -- suite-${calls}` } }]);
    return reply('The test output keeps changing without a code edit, so I will inspect the project before continuing.');
  }, { repeatFailureThreshold: 3 });
  h.tools.add('run_tests', 'Return changing test diagnostics.', z.object({ command: z.string() }), false, async () => ({ exitCode: 1, stdout: '', stderr: diagnostics[calls - 1] }));
  const result = await h.runtime.run(h.session, 'Diagnose the failing tests.', new AbortController().signal);
  const testResults = h.store.messages(h.session).filter(message => message.role === 'tool' && message.name === 'run_tests');
  assert.equal(testResults.length, 3);
  assert.match(testResults[2]!.content, /failed 3 times without verified progress, with changing errors/);
  assert.match(result, /inspect the project/);
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
    'git_log/git_show/git_blame', 'plan_update/plan_status', 'connected MCP by task match or discover_tools', 'Load only needed schemas.',
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

test('connected MCP schemas load only after discovery and remain callable for the task', async t => {
  let calls = 0, executions = 0, approvals = 0;
  const tool = {
    name: 'mcp_linear_create_issue',
    description: '[MCP linear] Create an issue in Linear.',
    parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
  };
  const h = await harness(t, async (messages, specs) => {
    calls++;
    if (calls === 1) {
      assert.ok(!specs.some(spec => spec.name === tool.name), 'unused MCP schemas should not be sent initially');
      return reply('', [{ id: 'discover-linear', name: 'discover_tools', arguments: { query: 'linear create issue' } }]);
    }
    if (calls === 2) {
      assert.ok(specs.some(spec => spec.name === tool.name), 'discovery should load the matching MCP schema');
      assert.match(messages.at(-1)?.content ?? '', /mcp_linear_create_issue/);
      return reply('', [{ id: 'create-issue', name: tool.name, arguments: { title: 'Fix login' } }]);
    }
    assert.match(messages.at(-1)?.content ?? '', /Fix login/);
    return reply('Created the Linear issue.');
  }, { permissions: 'workspace' });
  h.mcp.tools = () => [tool];
  h.mcp.call = async (name, args) => { executions++; assert.equal(name, tool.name); return JSON.stringify({ isError: false, content: [{ type: 'text', text: `Created: ${args.title}` }] }); };
  h.workspace.permissions.approve = async request => { approvals++; assert.equal(request.tool, tool.name); return true; };
  assert.equal(await h.runtime.run(h.session, 'Create an issue titled Fix login using the connected project tracker.', new AbortController().signal), 'Created the Linear issue.');
  assert.equal(executions, 1);
  assert.equal(approvals, 1, 'MCP remains an external action even after its schema is discovered');
  assert.equal(calls, 3);
});

test('task-matched MCP schemas preload only the relevant connected tools', async t => {
  let calls = 0, executions = 0;
  const linear = { name: 'mcp_linear_create_issue', description: '[MCP linear] Create an issue in Linear.', parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } };
  const slack = { name: 'mcp_slack_send_message', description: '[MCP slack] Send a channel message.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } };
  const h = await harness(t, async (messages, specs) => {
    calls++;
    if (calls === 1) {
      assert.ok(specs.some(spec => spec.name === linear.name), 'a named provider and matching action should load directly');
      assert.ok(!specs.some(spec => spec.name === slack.name), 'unrelated MCP schemas stay out of the request');
      return reply('', [{ id: 'create-linear', name: linear.name, arguments: { title: 'Fix login' } }]);
    }
    assert.match(messages.at(-1)?.content ?? '', /Fix login/);
    return reply('Created the Linear issue.');
  }, { permissions: 'all' });
  h.mcp.tools = () => [linear, slack];
  h.mcp.call = async name => { executions++; assert.equal(name, linear.name); return JSON.stringify({ isError: false, content: [{ type: 'text', text: 'Created Fix login' }] }); };
  assert.equal(await h.runtime.run(h.session, 'Create a Linear issue titled Fix login.', new AbortController().signal), 'Created the Linear issue.');
  assert.equal(executions, 1);
  assert.equal(calls, 2, 'task matching avoids a separate schema-discovery model call');
});

test('a disabled MCP tool is reported without offering unsupported one-time approval', async t => {
  let calls = 0;
  const tool = { name: 'mcp_linear_create_issue', description: '[MCP linear] Create an issue in Linear.', parameters: { type: 'object', properties: {} } };
  const h = await harness(t, async (messages, specs) => {
    calls++;
    if (calls === 1) return reply('', [{ id: 'discover-disabled-mcp', name: 'discover_tools', arguments: { query: 'linear create issue' } }]);
    assert.ok(!specs.some(spec => spec.name === tool.name));
    assert.ok(!specs.some(spec => spec.name === 'request_tool'));
    assert.match(messages.at(-1)?.content ?? '', /"available":false/);
    assert.match(messages.at(-1)?.content ?? '', /"requestable":false/);
    return reply('The connected MCP tool is disabled in permissions.');
  });
  h.settings.toolPermissions[tool.name] = 'off';
  h.mcp.tools = () => [tool];
  assert.equal(await h.runtime.run(h.session, 'Inspect the Linear issue tool.', new AbortController().signal), 'The connected MCP tool is disabled in permissions.');
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

test('parallel subagents share the task-wide two-search limit', async t => {
  const previousWebPython = process.env.POLONRLM_WEB_PYTHON;
  // If a regression lets a child execute a real search, fail locally without
  // preparing Python or contacting a search engine.
  process.env.POLONRLM_WEB_PYTHON = process.execPath;
  t.after(() => {
    if (previousWebPython === undefined) delete process.env.POLONRLM_WEB_PYTHON;
    else process.env.POLONRLM_WEB_PYTHON = previousWebPython;
  });
  let parentCalls = 0, parentSearches = 0;
  const childCalls = new Map<string, number>();
  const h = await harness(t, async (messages, specs) => {
    const role = /Role: (\w+)\./.exec(messages[0]!.content)?.[1] ?? '';
    if (role === 'orchestrator') {
      if (++parentCalls === 1) {
        assert.ok(specs.some(spec => spec.name === 'delegate'));
        return reply('', [
          { id: 'search-one', name: 'web_search', arguments: { query: 'first source' } },
          { id: 'search-two', name: 'web_search', arguments: { query: 'second source' } },
          { id: 'delegate-research', name: 'delegate', arguments: { tasks: [
            { role: 'researcher', task: 'Search the web for official docs about topic alpha.' },
            { role: 'reviewer', task: 'Search the web for official docs about topic beta.' },
          ] } },
        ]);
      }
      const outputs = JSON.parse(messages.at(-1)?.content ?? '[]') as { output?: string }[];
      assert.equal(outputs.length, 2);
      assert.ok(outputs.every(output => /shared search limit/.test(output.output ?? '')), JSON.stringify(outputs));
      return reply('Search limit was shared across the team.');
    }
    const count = (childCalls.get(role) ?? 0) + 1; childCalls.set(role, count);
    if (count === 1) {
      assert.ok(specs.some(spec => spec.name === 'web_search'));
      return reply('', [{ id: `${role}-search`, name: 'web_search', arguments: { query: role } }]);
    }
    const skipped = messages.findLast(message => message.role === 'tool' && message.name === 'web_search');
    assert.match(skipped?.content ?? '', /two-search limit/);
    return reply(`${role} stopped at the shared search limit.`);
  }, { maxAgents: 2, maxDepth: 1 });
  const { z } = await import('zod');
  h.tools.add('web_search', 'Fixture local search', z.object({ query: z.string() }), true, async args => {
    parentSearches++;
    return [{ title: String(args.query), url: `https://example.org/${args.query}`, snippet: 'fixture result' }];
  });
  assert.equal(await h.runtime.run(h.session, 'Search the web for reliable documentation and delegate independent checks.', new AbortController().signal), 'Search limit was shared across the team.');
  assert.equal(parentSearches, 2, 'no more than two searches run for the complete parent and subagent task');
  assert.equal(parentCalls, 2);
  assert.equal(childCalls.get('researcher'), 2);
  assert.equal(childCalls.get('reviewer'), 2);
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

test('interactive process input stays hidden in approval, transcript and audit', async t => {
  const secret = 'private-process-input-value';
  let calls = 0, approvals = 0;
  const h = await harness(t, async (messages, specs) => {
    calls++;
    if (calls === 1) return reply('', [{ id: 'discover-input', name: 'discover_tools', arguments: { query: 'process_input' } }]);
    if (calls === 2) {
      assert.ok(specs.some(spec => spec.name === 'process_input'));
      return reply('', [{ id: 'send-input', name: 'process_input', arguments: { id: 'job-fixture', input: secret, closeStdin: false } }]);
    }
    assert.equal(JSON.stringify(messages).includes(secret), false);
    return reply('Input sent.');
  }, { mode: 'BUILD', permissions: 'ask' });
  h.workspace.permissions.approve = async request => {
    approvals++;
    assert.equal(request.tool, 'process_input');
    assert.equal(request.preview, '[input content hidden]');
    return true;
  };
  const { z } = await import('zod');
  h.tools.add('process_input', 'Fixture process input.', z.object({ id: z.string(), input: z.string(), closeStdin: z.boolean().default(false) }), false, async (args, context) => {
    await h.workspace.permissions.check('process_input', 'external', 'Input to interactive process; exact content is hidden.', '[input content hidden]', context.mode, context.signal);
    assert.equal(args.input, secret);
    return { id: args.id, sent: args.input.length, closed: args.closeStdin };
  });

  assert.equal(await h.runtime.run(h.session, 'Use process_input to send the private value.', new AbortController().signal), 'Input sent.');
  assert.equal(calls, 3);
  assert.equal(approvals, 1);
  const transcript = JSON.stringify(h.store.messages(h.session));
  assert.equal(transcript.includes(secret), false);
  assert.match(transcript, /\[hidden \d+ characters\]/);
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

test('agent_apply rolls back earlier files when a later write is denied', async t => {
  let calls = 0;
  let approvals = 0;
  let mergeResult = '';
  const h = await harness(t, async messages => {
    if (++calls === 1) return reply('', [{ id: 'atomic-apply', name: 'agent_apply', arguments: { agentId: 'worker', paths: ['first.txt', 'second.txt'] } }]);
    mergeResult = messages.at(-1)?.content ?? '';
    return reply('The merge was rolled back safely.');
  }, { permissions: 'ask' });
  await writeFile(path.join(h.workspace.root, 'first.txt'), 'before first');
  await writeFile(path.join(h.workspace.root, 'second.txt'), 'before second');
  (h.runtime as any).agentChanges.set('worker', [
    { path: 'first.txt', before: 'before first', after: 'after first', diff: '', binary: false },
    { path: 'second.txt', before: 'before second', after: 'after second', diff: '', binary: false },
  ]);
  h.workspace.permissions.approve = async request => { approvals++; assert.equal(request.tool, 'agent_apply'); return approvals === 1; };

  assert.equal(await h.runtime.run(h.session, 'Apply the worker changes.', new AbortController().signal), 'The merge was rolled back safely.');
  assert.equal(approvals, 2);
  assert.equal(await readFile(path.join(h.workspace.root, 'first.txt'), 'utf8'), 'before first');
  assert.equal(await readFile(path.join(h.workspace.root, 'second.txt'), 'utf8'), 'before second');
  assert.match(mergeResult, /"applied":\[\]/);
  assert.match(mergeResult, /"rolledBack":\["first\.txt"\]/);
  assert.match(mergeResult, /"changesRetained":true/);
  assert.equal((h.runtime as any).agentChanges.get('worker').length, 2);
});

test('agent_apply rollback preserves an external change and reports the unfinished merge', async t => {
  let calls = 0;
  let approvals = 0;
  let mergeResult = '';
  const h = await harness(t, async messages => {
    if (++calls === 1) return reply('', [{ id: 'atomic-apply-conflict', name: 'agent_apply', arguments: { agentId: 'worker', paths: ['first.txt', 'second.txt'] } }]);
    mergeResult = messages.at(-1)?.content ?? '';
    return reply('An external edit was preserved.');
  }, { permissions: 'ask' });
  await writeFile(path.join(h.workspace.root, 'first.txt'), 'before first');
  await writeFile(path.join(h.workspace.root, 'second.txt'), 'before second');
  (h.runtime as any).agentChanges.set('worker', [
    { path: 'first.txt', before: 'before first', after: 'after first', diff: '', binary: false },
    { path: 'second.txt', before: 'before second', after: 'after second', diff: '', binary: false },
  ]);
  h.workspace.permissions.approve = async request => {
    approvals++;
    assert.equal(request.tool, 'agent_apply');
    if (approvals === 2) { await writeFile(path.join(h.workspace.root, 'first.txt'), 'external edit'); return false; }
    return true;
  };

  assert.equal(await h.runtime.run(h.session, 'Apply the worker changes.', new AbortController().signal), 'An external edit was preserved.');
  assert.equal(approvals, 2);
  assert.equal(await readFile(path.join(h.workspace.root, 'first.txt'), 'utf8'), 'external edit');
  assert.equal(await readFile(path.join(h.workspace.root, 'second.txt'), 'utf8'), 'before second');
  assert.match(mergeResult, /"applied":\["first\.txt"\]/);
  assert.match(mergeResult, /"rollbackFailures":\[\{"path":"first\.txt"/);
  assert.match(mergeResult, /"changesRetained":true/);
});

test('task graph waits for prerequisites, stages their files, and exposes one reviewable atomic result', { timeout: 15_000 }, async t => {
  let rootCalls = 0;
  const childCalls = new Map<string, number>();
  const h = await harness(t, async (messages, specs) => {
    const role = /Role: (\w+)\./.exec(messages[0]!.content)?.[1] ?? '';
    const userTask = messages.find(message => message.role === 'user')?.content ?? '';
    if (role === 'orchestrator') {
      if (++rootCalls === 1) return reply('', [{ id: 'graph', name: 'delegate', arguments: { tasks: [
        { id: 'analysis', role: 'researcher', task: 'Inspect the project API contract and report the interface.' },
        { id: 'backend', dependsOn: ['analysis'], role: 'coder', task: 'Build the backend slice from the analysis.' },
        { id: 'frontend', dependsOn: ['analysis'], role: 'coder', task: 'Build the frontend slice from the analysis.' },
        { id: 'integration', dependsOn: ['backend', 'frontend'], role: 'coder', task: 'Check the integration of both slices.' },
      ] } }]);
      if (rootCalls === 2) {
        const delegation = JSON.parse(messages.findLast(message => message.name === 'delegate')!.content) as { graphId: string; status: string; tasks: { status: string }[]; changedFiles: string[] };
        assert.equal(delegation.status, 'done', JSON.stringify(delegation));
        assert.equal(delegation.tasks.length, 4);
        assert.ok(delegation.tasks.every(task => task.status === 'done'));
        assert.deepEqual(delegation.changedFiles, ['backend.txt', 'frontend.txt']);
        assert.ok(specs.some(spec => spec.name === 'agent_apply'));
        return reply('', [{ id: 'graph-changes', name: 'agent_changes', arguments: { agentId: delegation.graphId } }]);
      }
      if (rootCalls === 3) {
        const changes = JSON.parse(messages.findLast(message => message.name === 'agent_changes')!.content) as { path: string }[];
        assert.deepEqual(changes.map(change => change.path), ['backend.txt', 'frontend.txt']);
        return reply('', [{ id: 'graph-apply', name: 'agent_apply', arguments: { agentId: JSON.parse(messages.findLast(message => message.name === 'delegate')!.content).graphId, paths: changes.map(change => change.path) } }]);
      }
      return reply('The dependency graph completed and both changes were reviewed and applied.');
    }

    const taskKey = role === 'coder' ? /Build the backend slice/.test(userTask) ? 'backend' : /Build the frontend slice/.test(userTask) ? 'frontend' : 'integration' : role;
    const taskCall = (childCalls.get(taskKey) ?? 0) + 1;
    childCalls.set(taskKey, taskCall);
    if (role === 'researcher') {
      assert.match(userTask, /Inspect the project API contract/);
      return reply('The API returns JSON records with stable IDs.');
    }
    if (/Build the backend slice/.test(userTask)) {
      assert.match(userTask, /stable IDs/);
      if (taskCall === 1) return reply('', [{ id: 'backend-write', name: 'write_file', arguments: { path: 'backend.txt', content: 'backend slice' } }]);
      assert.match(messages.at(-1)?.content ?? '', /backend\.txt/);
      return reply('Backend slice complete.');
    }
    if (/Build the frontend slice/.test(userTask)) {
      assert.match(userTask, /stable IDs/);
      if (taskCall === 1) return reply('', [{ id: 'frontend-write', name: 'write_file', arguments: { path: 'frontend.txt', content: 'frontend slice' } }]);
      assert.match(messages.at(-1)?.content ?? '', /frontend\.txt/);
      return reply('Frontend slice complete.');
    }
    assert.match(userTask, /backend slice/i);
    assert.match(userTask, /frontend slice/i);
    if (taskCall === 1) return reply('', [{ id: 'integration-read-backend', name: 'read_file', arguments: { path: 'backend.txt' } }]);
    if (taskCall === 2) {
      assert.match(messages.at(-1)?.content ?? '', /backend slice/);
      return reply('', [{ id: 'integration-read-frontend', name: 'read_file', arguments: { path: 'frontend.txt' } }]);
    }
    assert.match(messages.at(-1)?.content ?? '', /frontend slice/);
    return reply('Integration checked both staged slices.');
  }, { maxAgents: 2, maxDepth: 1 });

  assert.equal(await h.runtime.run(h.session, 'Build and then integrate the dependent slices.', new AbortController().signal), 'The dependency graph completed and both changes were reviewed and applied.');
  assert.equal(await readFile(path.join(h.workspace.root, 'backend.txt'), 'utf8'), 'backend slice');
  assert.equal(await readFile(path.join(h.workspace.root, 'frontend.txt'), 'utf8'), 'frontend slice');
  const graph = h.runtime.agents.find(agent => agent.role === 'task-graph');
  assert.equal(graph?.status, 'done');
  assert.equal(childCalls.get('researcher'), 1);
  assert.equal((childCalls.get('backend') ?? 0) + (childCalls.get('frontend') ?? 0) + (childCalls.get('integration') ?? 0), 7, 'two writers and an integrator with two reads and a final response');
  const runs = h.store.agentRuns(h.session, 10);
  assert.equal(runs.filter(run => run.role !== 'task-graph').length, 4, 'every delegated task is persisted');
  assert.ok(runs.every(run => run.status === 'done'), JSON.stringify(runs));
  const graphRun = runs.find(run => run.role === 'task-graph');
  assert.ok(graphRun);
  assert.deepEqual([...graphRun!.changedFiles].sort(), ['backend.txt', 'frontend.txt']);
});

test('agent_resume continues a persisted subagent run', { timeout: 15_000 }, async t => {
  let mainCalls = 0, childCalls = 0, providerCalls = 0;
  const h = await harness(t, async messages => {
    providerCalls++;
    const role = /Role: (\w+)\./.exec(messages[0]?.content ?? '')?.[1] ?? '';
    if (role === 'orchestrator') {
      mainCalls++;
      if (mainCalls === 1) return reply('', [{ id: 'delegate-first', name: 'delegate', arguments: { tasks: [{ role: 'coder', task: 'Write first.txt from the first run.' }] } }]);
      if (mainCalls === 2) return reply('First run done.');
      if (mainCalls === 3) {
        const saved = h.store.agentRuns(h.session, 10).find(run => run.role === 'coder');
        assert.ok(saved);
        return reply('', [{ id: 'resume-second', name: 'agent_resume', arguments: { id: saved.id, instruction: 'Write second.txt as the continuation.' } }]);
      }
      assert.match(messages.findLast(message => message.role === 'tool')?.content ?? '', /resumedFrom/);
      return reply('Resumed run done.');
    }
    if (role === 'coder') {
      childCalls++;
      const task = messages.find(message => message.role === 'user')?.content ?? '';
      if (childCalls === 1) { assert.match(task, /Write first\.txt from the first run/); return reply('', [{ id: 'first-write', name: 'write_file', arguments: { path: 'first.txt', content: 'first' } }]); }
      if (childCalls === 2) return reply('First coder complete.');
      if (childCalls === 4) return reply('Second coder complete.');
      assert.match(task, /Previous result/);
      assert.match(task, /Previous transcript excerpt/);
      assert.match(task, /Write second\.txt as the continuation/);
      return reply('', [{ id: 'second-write', name: 'write_file', arguments: { path: 'second.txt', content: 'second' } }]);
    }
    return reply('Unexpected role.');
  }, { maxAgents: 2, maxDepth: 1, maxSteps: 30 });
  const signal = new AbortController().signal;
  await h.runtime.run(h.session, 'Run the first delegated task.', signal);
  const first = h.store.agentRuns(h.session, 10).find(run => run.role === 'coder');
  assert.ok(first);
  assert.ok(first.transcript?.some(message => message.content.includes('Write first.txt')));
  await h.runtime.run(h.session, 'Resume the saved coder run.', signal);
  const runs = h.store.agentRuns(h.session, 10).filter(run => run.role === 'coder');
  assert.equal(runs.length, 2, 'the resumed run is a new persisted run');
  const resumed = runs.find(run => run.id !== first!.id);
  assert.equal(resumed?.status, 'done', resumed?.error);
  assert.deepEqual(resumed?.changedFiles, ['second.txt']);
  assert.ok(providerCalls <= 10, `unexpected provider call count: ${providerCalls}`);
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

test('subagent tool profiles filter schemas and discovery, then reject forged calls', { timeout: 10_000 }, async t => {
  let parentCalls = 0;
  const childCalls = new Map<string, number>();
  const h = await harness(t, async (messages, specs) => {
    const role = /Role: (\w+)\./.exec(messages[0]!.content)?.[1] ?? '';
    if (role === 'orchestrator') {
      if (++parentCalls === 1) return reply('', [{ id: 'profile-delegate', name: 'delegate', arguments: { tasks: [{ role: 'reviewer', task: 'Inspect one file and report whether the restricted profile works.' }] } }]);
      return reply('The reviewer was limited to its configured tools.');
    }
    const count = (childCalls.get(role) ?? 0) + 1; childCalls.set(role, count);
    if (count === 1) {
      assert.ok(specs.some(spec => spec.name === 'read_file'));
      assert.ok(specs.some(spec => spec.name === 'discover_tools'));
      assert.ok(!specs.some(spec => spec.name === 'write_file'));
      return reply('', [{ id: 'profile-discover', name: 'discover_tools', arguments: { query: 'write_file' } }]);
    }
    if (count === 2) {
      const discovery = messages.findLast(message => message.name === 'discover_tools')?.content ?? '';
      assert.doesNotMatch(discovery, /"name":"write_file"/);
      return reply('', [{ id: 'profile-request-tool', name: 'request_tool', arguments: { tool: 'write_file', arguments: { path: 'blocked.txt', content: 'must not be written' }, reason: 'I need to write a file.' } }]);
    }
    if (count === 3) {
      assert.match(messages.at(-1)?.content ?? '', /not allowed for subagent role reviewer/);
      return reply('', [{ id: 'profile-forged-write', name: 'write_file', arguments: { path: 'blocked.txt', content: 'must not be written' } }]);
    }
    assert.match(messages.at(-1)?.content ?? '', /not allowed for subagent role reviewer/);
    return reply('The restricted call was blocked.');
  }, { maxAgents: 1, maxDepth: 1, agentToolProfiles: { reviewer: ['read_file', 'discover_tools', 'request_tool'] } });

  assert.equal(await h.runtime.run(h.session, 'Ask a reviewer to inspect a file.', new AbortController().signal), 'The reviewer was limited to its configured tools.');
  await assert.rejects(readFile(path.join(h.workspace.root, 'blocked.txt')), { code: 'ENOENT' });
  assert.equal(childCalls.get('reviewer'), 4);
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

test('unlimited agent setting runs a 32-agent batch concurrently', { timeout: 20_000 }, async t => {
  const tasks = Array.from({ length: 32 }, (_, index) => ({ role: 'reviewer' as const, task: `Inspect independent fixture ${index} and report any issue found.` }));
  let parentCalls = 0, childCalls = 0, activeChildren = 0, peakActiveChildren = 0;
  let releaseChildren!: () => void;
  const allChildrenStarted = new Promise<void>(resolve => { releaseChildren = resolve; });
  const h = await harness(t, async (messages, tools) => {
    if (messages[0]!.content.includes('Role: orchestrator.')) {
      if (++parentCalls === 1) {
        const delegate = tools.find(tool => tool.name === 'delegate');
        assert.ok(delegate);
        const parameters = delegate.parameters.properties as Record<string, { items?: { maxItems?: number } }>;
        assert.equal(parameters.tasks?.items?.maxItems, undefined, 'unlimited defaults do not impose the former fixed parallel cap');
        return reply('', [{ id: 'thirty-two-reviewers', name: 'delegate', arguments: { tasks } }]);
      }
      return reply('All 32 reviewers completed.');
    }
    childCalls++; activeChildren++; peakActiveChildren = Math.max(peakActiveChildren, activeChildren);
    if (childCalls === tasks.length) releaseChildren();
    await allChildrenStarted;
    activeChildren--;
    return reply('Review complete.');
  }, { maxAgents: 0, maxDepth: -1, maxSteps: 0, tokenBudget: 0, dollarBudget: 0, maxInputTokens: 0, maxOutputTokens: 0, timeoutMs: 0, toolOutputLimit: 0 });
  assert.equal(await h.runtime.run(h.session, 'Run thirty-two independent reviews.', new AbortController().signal), 'All 32 reviewers completed.');
  assert.equal(childCalls, 32);
  assert.equal(peakActiveChildren, 32, 'all 32 independent subagents should overlap instead of being capped or serialized');
  assert.equal(h.runtime.agents.length, 32);
  assert.ok(h.runtime.agents.every(agent => agent.status === 'done'));
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

test('compaction stays within budget after accounting for summary envelope overhead', () => {
  let seed = 923401;
  const next = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed; };
  const budget = 800 + (next() % 4200), messages: Message[] = [];
  const count = 20 + (next() % 100);
  for (let index = 0; index < count; index++) {
    const size = 100 + (next() % 2000);
    const content = `Historical requirement ${index}: preserve stable Polish context, verify tool results, and retain key decisions. ${'Routine history detail. '.repeat(Math.ceil(size / 24))}`;
    if (index % 13 === 12) {
      const id = `call-${index}`;
      messages.push({ role: 'assistant', content: '', toolCalls: [{ id, name: 'read_file', arguments: { path: `file-${index}.ts` } }] });
      messages.push({ role: 'tool', name: 'read_file', toolCallId: id, content: `Tool result. ${'line detail. '.repeat(Math.ceil(size / 24))}` });
    } else messages.push({ role: index % 2 ? 'assistant' : 'user', content });
  }
  const latest = { role: 'user' as const, content: 'Continue and verify the current change.' };
  messages.push(latest);
  const compacted = compactMessages(messages, budget);
  assert.ok(estimateTokens(messages) > budget);
  assert.ok(compacted.removed > 0);
  assert.ok(compacted.afterTokens <= budget);
  assert.ok(compacted.messages.some(message => message.role === 'user' && message.content === latest.content));
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

test('local compaction keeps a Polish historical requirement and the latest request verbatim', () => {
  const marker = 'POLSKIE_WYMAGANIE_5837';
  const latest = 'Kontynuuj implementację i sprawdź wynik.';
  const messages: Message[] = [{ role: 'user', content: `Wymaganie trwałe: zawsze zachowaj plik źródłowy, marker ${marker}, i nigdy nie zmieniaj tej decyzji. ${'Zwykły kontekst historyczny projektu. '.repeat(300)}` }];
  for (let index = 0; index < 50; index++) {
    messages.push({ role: 'user', content: `Poprzednie zadanie ${index}: sprawdź zwykły moduł. ${'Zwykły szczegół techniczny. '.repeat(48)}` });
    messages.push({ role: 'assistant', content: `Wynik ${index}: zwykła kontrola została zakończona. ${'Rutynowa obserwacja. '.repeat(48)}` });
  }
  messages.push({ role: 'user', content: latest });
  const compacted = compactMessages(messages, 1_800);
  const summary = compacted.messages.find(message => message.name === 'polonrlm_context')?.content ?? '';
  assert.ok(compacted.removed > 0);
  assert.ok(summary.includes(marker), 'the Polish requirement should survive in the local summary');
  assert.ok(compacted.messages.some(message => message.role === 'user' && message.content === latest));
  assert.ok(estimateTokens(compacted.messages) <= 1_800);
});

test('local compaction retains an explicit decision marker', () => {
  const marker = 'DECISION_KEEP_PUBLIC_API_7712';
  const messages: Message[] = [{ role: 'user', content: `Decision: keep the public API stable and preserve ${marker}. ${'Historical context. '.repeat(300)}` }];
  for (let index = 0; index < 40; index++) messages.push({ role: 'assistant', content: `Routine inspection ${index}: ${'ordinary detail. '.repeat(60)}` });
  messages.push({ role: 'user', content: 'Continue and verify.' });
  const compacted = compactMessages(messages, 1_800);
  const summary = compacted.messages.find(message => message.name === 'polonrlm_context')?.content ?? '';
  assert.ok(compacted.removed > 0);
  assert.ok(summary.includes(marker), 'the explicit decision should survive compaction');
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
