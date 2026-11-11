import test from 'node:test';
import assert from 'node:assert/strict';
import type { ProviderConfig } from '../src/core/types.js';
import { effortChoices, findEffortChoice, normalizeEffort, providerEffortOptions } from '../src/providers/reasoning.js';

function provider(values: Partial<ProviderConfig> = {}): ProviderConfig {
  return { id: 'test', kind: 'compatible', baseURL: 'https://api.example.test/v1', model: 'unknown-model', ...values };
}

test('unknown compatible models default to provider control and require discovered capability metadata', () => {
  const unknown = provider();
  assert.deepEqual(effortChoices(unknown).map(option => option.id), ['auto']);
  assert.throws(() => providerEffortOptions({ ...unknown, reasoning: 'high' }), /not available/);

  const discovered = provider({ reasoningControl: 'effort', reasoningEfforts: ['swift', 'deep'], reasoning: 'deep' });
  assert.deepEqual(effortChoices(discovered).map(option => option.id), ['auto', 'swift', 'deep']);
  assert.deepEqual(providerEffortOptions(discovered), { test: { reasoningEffort: 'deep' } });
});

test('Gemini 3 uses thinking levels and Gemini 2.5 uses token budgets', () => {
  const gemini3 = provider({ id: 'google', kind: 'google', baseURL: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-3.5-flash-lite', reasoning: 'medium' });
  assert.deepEqual(effortChoices(gemini3).map(option => option.id), ['auto', 'minimal', 'low', 'medium', 'high']);
  assert.deepEqual(providerEffortOptions(gemini3), { google: { thinkingConfig: { thinkingLevel: 'medium' } } });

  const gemini25 = provider({ id: 'google', kind: 'google', baseURL: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash', reasoning: 'medium' });
  assert.deepEqual(effortChoices(gemini25).map(option => option.id), ['auto', 'off', 'low', 'medium', 'high']);
  assert.deepEqual(providerEffortOptions(gemini25), { google: { thinkingConfig: { thinkingBudget: 8192 } } });

  const noThinking = { ...gemini3, model: 'gemini-3.5-flash-lite', reasoning: 'off' };
  assert.throws(() => providerEffortOptions(noThinking), /not available/);
});

test('OpenAI model families expose only their supported effort values', () => {
  const astra = provider({ id: 'openai', kind: 'openai', baseURL: 'https://api.openai.com/v1', model: 'gpt-6-astra' });
  assert.deepEqual(effortChoices(astra).map(option => option.id), ['auto', 'low', 'medium', 'high', 'very-high', 'max']);
  assert.deepEqual(providerEffortOptions({ ...astra, reasoning: 'high' }), { openai: { reasoningEffort: 'high' } });
  assert.deepEqual(providerEffortOptions({ ...astra, reasoning: 'xhigh' }), { openai: { reasoningEffort: 'xhigh' } });
  assert.throws(() => providerEffortOptions({ ...astra, reasoning: 'none' }), /not available/);

  const luna = { ...astra, model: 'gpt-6-luna', reasoning: 'none' };
  assert.ok(effortChoices(luna).some(option => option.id === 'off'));
  assert.deepEqual(providerEffortOptions(luna), { openai: { reasoningEffort: 'none' } });
});

test('Groq GPT-OSS exposes low, medium and high reasoning effort', () => {
  const oss = provider({ id: 'groq', model: 'openai/gpt-oss-120b' });
  assert.deepEqual(effortChoices(oss).map(option => option.id), ['auto', 'low', 'medium', 'high']);
  assert.deepEqual(providerEffortOptions({ ...oss, reasoning: 'low' }), { groq: { reasoningEffort: 'low' } });
});

test('OpenRouter and Anthropic reasoning use their own supported request shapes', () => {
  const openrouter = provider({ id: 'openrouter', baseURL: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-v4-flash-free', reasoning: 'high' });
  assert.deepEqual(providerEffortOptions(openrouter), { openrouter: { reasoning: { effort: 'high' } } });

  const anthropic = provider({ id: 'anthropic', kind: 'anthropic', baseURL: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5', reasoning: 'off' });
  assert.deepEqual(providerEffortOptions(anthropic), { anthropic: { thinking: { type: 'disabled' } } });
  assert.throws(() => providerEffortOptions({ ...anthropic, reasoning: 'high' }), /not available/);
});

test('effort aliases normalize for command input without changing native provider values', () => {
  const options = effortChoices(provider({ reasoningControl: 'effort', reasoningEfforts: ['xhigh'] }));
  assert.equal(normalizeEffort(' very_high '), 'very-high');
  assert.equal(findEffortChoice(options, 'x-high')?.id, 'very-high');
  assert.equal(findEffortChoice(options, 'automatic')?.id, 'auto');
});
