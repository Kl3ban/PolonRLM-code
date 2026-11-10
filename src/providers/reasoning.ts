import type { ModelInfo, ProviderConfig, ReasoningControl } from '../core/types.js';

export interface EffortChoice {
  id: string;
  label: string;
  detail?: string;
  nativeValue?: string;
}

interface EffortProfile {
  control: ReasoningControl;
  values: string[];
}

const AUTOMATIC: EffortChoice = { id: 'auto', label: 'Automatic', detail: 'Use the model default' };
const SAFE_NATIVE_VALUE = /^[A-Za-z0-9][A-Za-z0-9_. -]{0,31}$/;

function normalized(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/-+/g, '-');
}

export function normalizeEffort(value: string): string {
  const key = normalized(value);
  if (['auto', 'automatic', 'default'].includes(key)) return 'auto';
  if (['none', 'off', 'disabled', 'disable'].includes(key)) return 'off';
  if (['on', 'enabled', 'enable', 'thinking'].includes(key)) return 'on';
  if (['xhigh', 'x-high', 'veryhigh', 'very-high'].includes(key)) return 'very-high';
  return key;
}

function choice(value: string): EffortChoice | undefined {
  const raw = value.trim();
  if (!SAFE_NATIVE_VALUE.test(raw)) return undefined;
  const id = normalizeEffort(raw);
  if (id === 'auto') return undefined;
  if (id === 'off') return { id, label: 'Off', detail: 'Disable model reasoning', nativeValue: raw };
  if (id === 'on') return { id, label: 'Thinking on', detail: 'Enable the model reasoning mode', nativeValue: raw };
  if (id === 'very-high') return { id, label: 'Very high (xhigh)', nativeValue: raw };
  if (id === 'minimal') return { id, label: 'Minimal', detail: 'Light reasoning; not the same as Off', nativeValue: raw };
  if (id === 'max') return { id, label: 'Max', nativeValue: raw };
  if (id === 'ultra') return { id, label: 'Ultra', nativeValue: raw };
  if (id === 'low' || id === 'medium' || id === 'high') return { id, label: id[0]!.toUpperCase() + id.slice(1), nativeValue: raw };
  return { id, label: raw.replace(/[-_]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase()), detail: 'Provider-specific level', nativeValue: raw };
}

function choices(profile: EffortProfile): EffortChoice[] {
  const seen = new Set<string>(['auto']);
  const result = [AUTOMATIC];
  for (const nativeValue of profile.values) {
    const value = choice(nativeValue);
    if (!value || seen.has(value.id)) continue;
    seen.add(value.id); result.push(value);
  }
  return result;
}

function binary(): EffortProfile { return { control: 'toggle', values: ['off', 'on'] }; }
function modelFamilyProfile(provider: ProviderConfig, modelId: string): EffortProfile | undefined {
  const id = modelId.toLowerCase();
  const slug = id.split('/').at(-1) ?? id;
  const isOpenRouter = provider.id === 'openrouter' || /(?:^|\.)openrouter\.ai$/i.test(new URL(provider.baseURL).hostname);
  const isDirectZai = ['zai', 'zhipuai'].includes(provider.id) || /(?:^|\.)(?:z\.ai|bigmodel\.cn)$/i.test(new URL(provider.baseURL).hostname);
  const glm = /glm[^a-z0-9]*([45])[^a-z0-9]*([0-9]+)/i.exec(id);

  if (glm && glm[1] === '5' && glm[2] === '3') return { control: 'effort', values: ['low', 'high', 'max'] };
  if (glm && glm[1] === '5' && glm[2] === '2' && (isOpenRouter || isDirectZai)) {
    return { control: 'effort', values: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] };
  }
  if (glm && isDirectZai) return binary();

  if (provider.kind === 'google' || /(?:^|[/_-])gemini[-/]?2\.5(?:[-/]|$)/.test(id)) {
    const isGemini25 = /gemini[-/]?2\.5/.test(id);
    if (isGemini25) {
      const isPro = /gemini[-/]?2\.5[-/]?pro/.test(id);
      const control = provider.kind === 'google' || isOpenRouter ? 'thinking-budget' : 'effort';
      return { control, values: [...(!isPro ? ['off'] : []), 'low', 'medium', 'high'] };
    }
    if (/gemini[-/]?3\./.test(id)) {
      if (/gemini[-/]?3(?:\.0)?[-/]?pro(?:[-/]|$)/.test(id)) return { control: provider.kind === 'google' ? 'thinking-level' : 'effort', values: ['low', 'high'] };
      if (/3\.1[-/]?flash[-/]?lite[-/]?image/.test(id)) return { control: provider.kind === 'google' ? 'thinking-level' : 'effort', values: ['minimal', 'high'] };
      if (/3\.(?:7|8)|3\.1[-/]?pro/.test(id)) return { control: provider.kind === 'google' ? 'thinking-level' : 'effort', values: ['low', 'medium', 'high'] };
      return { control: provider.kind === 'google' ? 'thinking-level' : 'effort', values: ['minimal', 'low', 'medium', 'high'] };
    }
  }

  if (provider.kind === 'openai' || /(?:^|[/_-])openai[/_-]/.test(id)) {
    if (/^gpt-6(?:\.\d+)?[-/](?:astra|sol|luna|terra)(?:[-/]|$)/.test(slug)) {
      const levels = ['low', 'medium', 'high', 'xhigh', 'max'];
      if (/^gpt-6[-/](?:sol|luna)(?:[-/]|$)|^gpt-6\.1[-/]terra(?:[-/]|$)/.test(slug)) levels.unshift('none');
      return { control: 'effort', values: levels };
    }
    if (/^gpt-5\.6(?:[-/]|$)/.test(slug)) return { control: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] };
    if (/^gpt-5\.(?:4|5)(?:[-/]|$)/.test(slug)) return { control: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh'] };
    if (/^gpt-5\.3-codex(?:[-/]|$)/.test(slug)) return { control: 'effort', values: ['low', 'medium', 'high', 'xhigh'] };
    if (/^gpt-5\.2(?:[-/]|$)/.test(slug)) return { control: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh'] };
    if (/^gpt-5(?:\.|[-/])/.test(slug)) {
      return { control: 'effort', values: ['minimal', 'low', 'medium', 'high'] };
    }
    if (/^o[134](?:[-/.]|$)/.test(slug)) return { control: 'effort', values: ['low', 'medium', 'high'] };
  }

  if (provider.kind === 'anthropic') return undefined;
  if (isOpenRouter && /deepseek-v3\.2/.test(id)) return binary();
  if (isOpenRouter && /deepseek-v4/.test(id)) return { control: 'effort', values: ['low', 'medium', 'high', 'xhigh'] };
  return undefined;
}

function rawProfile(config: ProviderConfig, model?: ModelInfo): EffortProfile | undefined {
  const modelId = model?.id || config.model;
  const nativeValues = model?.reasoningEfforts ?? config.reasoningEfforts;
  if (nativeValues?.length) return { control: model?.reasoningControl ?? config.reasoningControl ?? 'effort', values: nativeValues };

  if (model?.reasoning === false || config.reasoningSupported === false) return undefined;

  const known = modelFamilyProfile(config, modelId);
  if (known) return known;

  const control = model?.reasoningControl ?? config.reasoningControl;
  if (config.kind === 'anthropic') return { control: 'toggle', values: ['off'] };
  if (control === 'toggle') return binary();
  if (control === 'effort') return { control, values: ['low', 'medium', 'high'] };
  if (control === 'thinking-level') return { control, values: ['minimal', 'low', 'medium', 'high'] };
  if (control === 'thinking-budget') return { control, values: ['off', 'low', 'medium', 'high'] };
  return undefined;
}

export function effortChoices(config: ProviderConfig, model?: ModelInfo): EffortChoice[] {
  const profile = rawProfile(config, model);
  return profile ? choices(profile) : [{ ...AUTOMATIC, detail: config.model ? 'No selectable reasoning control is known for this model' : 'Select a model to see its reasoning controls' }];
}

export function findEffortChoice(options: EffortChoice[], input: string): EffortChoice | undefined {
  const key = normalizeEffort(input);
  return options.find(option => option.id === key || normalizeEffort(option.nativeValue ?? '') === key);
}

export function providerEffortOptions(config: ProviderConfig): Record<string, Record<string, unknown>> | undefined {
  const requested = config.reasoning;
  if (!requested || normalizeEffort(requested) === 'auto') return undefined;
  const available = effortChoices(config);
  const selected = findEffortChoice(available, requested);
  if (!selected) {
    if (config.reasoningSupported === false && normalizeEffort(requested) === 'off') return undefined;
    if (config.reasoningSupported === false) throw new Error(`Model ${config.model || 'the selected model'} does not support reasoning settings. Use /effort auto or choose a model with reasoning support.`);
    throw new Error(`Reasoning effort "${requested}" is not available for ${config.model || 'the selected model'}. Use /effort to see supported choices or /effort auto to use the model default.`);
  }
  if (selected.id === 'auto') return undefined;

  const profile = rawProfile(config);
  if (!profile) return undefined;
  const native = selected.nativeValue ?? selected.id;
  const openRouter = config.id === 'openrouter' || /(?:^|\.)openrouter\.ai$/i.test(new URL(config.baseURL).hostname);
  const directZai = ['zai', 'zhipuai'].includes(config.id) || /(?:^|\.)(?:z\.ai|bigmodel\.cn)$/i.test(new URL(config.baseURL).hostname);

  if (profile.control === 'toggle') {
    const enabled = selected.id === 'on';
    if (openRouter) return { [config.id.replace(/[^a-zA-Z0-9_-]/g, '_')]: { reasoning: { enabled } } };
    if (directZai || /glm/i.test(config.model)) return { [config.id.replace(/[^a-zA-Z0-9_-]/g, '_')]: { thinking: { type: enabled ? 'enabled' : 'disabled' } } };
    if (config.kind === 'anthropic' && !enabled) return { anthropic: { thinking: { type: 'disabled' } } };
    return { [config.id.replace(/[^a-zA-Z0-9_-]/g, '_')]: { reasoning: { enabled } } };
  }

  if (profile.control === 'thinking-level') {
    if (config.kind === 'google') return { google: { thinkingConfig: { thinkingLevel: native.toLowerCase() } } };
    return { [config.id.replace(/[^a-zA-Z0-9_-]/g, '_')]: { thinkingLevel: native } };
  }

  if (profile.control === 'thinking-budget') {
    const budget = selected.id === 'off' ? 0 : selected.id === 'low' ? 1024 : selected.id === 'medium' ? 8192 : selected.id === 'high' ? 24576 : Number(native);
    if (!Number.isSafeInteger(budget) || budget < 0) throw new Error(`Invalid thinking budget "${native}" for ${config.model}.`);
    if (openRouter) return { [config.id.replace(/[^a-zA-Z0-9_-]/g, '_')]: { reasoning: { max_tokens: budget } } };
    if (config.kind === 'google') return { google: { thinkingConfig: { thinkingBudget: budget } } };
    return { [config.id.replace(/[^a-zA-Z0-9_-]/g, '_')]: { thinkingBudget: budget } };
  }

  if (config.kind === 'anthropic') throw new Error('Selectable Anthropic effort needs signed thinking-block preservation, which is not available yet. Use /effort auto or off.');
  if (config.kind === 'openai') return { openai: { reasoningEffort: selected.id === 'off' ? 'none' : native.toLowerCase() } };
  if (openRouter) {
    if (selected.id === 'off') return { [config.id]: { reasoning: { enabled: false } } };
    return { [config.id]: { reasoning: { effort: native.toLowerCase() } } };
  }
  return { [config.id.replace(/[^a-zA-Z0-9_-]/g, '_')]: { reasoningEffort: selected.id === 'off' ? 'none' : native } };
}
