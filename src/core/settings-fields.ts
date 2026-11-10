export interface SettingField {
  key: string; label: string; section: 'general' | 'limits'; help: string;
  options?: { value: string | number; label: string }[];
  unit?: string;
}
export const SETTINGS_FIELDS: SettingField[] = [
  { key: 'mode', label: 'Mode', section: 'general', help: 'Build makes changes. Plan prepares a plan, and Review inspects code.', options: [{ value: 'BUILD', label: 'Build' }, { value: 'PLAN', label: 'Plan' }, { value: 'REVIEW', label: 'Review' }] },
  { key: 'cortex', label: 'Cortex level', section: 'general', help: 'Higher levels allow more steps and subagents.', options: [0, 1, 2, 3, 4, 5].map(value => ({ value, label: String(value) })) },
  { key: 'permissions', label: 'Tool permissions', section: 'general', help: 'Ask: request approval for risky actions. Workspace: allow project writes. All: approve everything, including shell and desktop actions.', options: [{ value: 'ask', label: 'Ask' }, { value: 'workspace', label: 'Project writes' }, { value: 'readonly', label: 'Read only' }, { value: 'all', label: 'Approve all' }] },
  { key: 'theme', label: 'Theme', section: 'general', help: 'The dark theme uses the terminal background.', options: [{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }] },
  { key: 'webSearchMode', label: 'Web search', section: 'general', help: 'A local worker queries the regular Bing, Brave, and Yahoo pages without an API, key, or visible browser window.', options: [{ value: 'auto', label: 'Auto · Bing + Brave + Yahoo' }, { value: 'bing', label: 'Bing' }, { value: 'brave', label: 'Brave' }, { value: 'yahoo', label: 'Yahoo' }] },
  { key: 'browserEngine', label: 'Browser engine', section: 'general', help: 'Auto skips missing engines and selects the first working one. Chromium or Firefox is downloaded on first use if missing. Automation runs in the background and does not use your profile.', options: [{ value: 'auto', label: 'Auto · choose an available engine' }, { value: 'chromium', label: 'Chromium · Playwright' }, { value: 'chrome', label: 'Google Chrome' }, { value: 'edge', label: 'Microsoft Edge' }, { value: 'brave', label: 'Brave' }, { value: 'firefox', label: 'Firefox · Playwright' }] },
  { key: 'tokenBudget', label: 'Tokens per task', section: 'limits', help: 'Shared task budget. Unlimited by default; enter a token count to set a cap.' },
  { key: 'dollarBudget', label: 'Cost per task', section: 'limits', help: 'No app cost cap by default. Prices may be unknown, so provider billing can still differ.', unit: 'USD' },
  { key: 'maxInputTokens', label: 'Input context', section: 'limits', help: 'No app input cap by default. The selected model context window still applies.', unit: 'tokens' },
  { key: 'maxOutputTokens', label: 'Response length', section: 'limits', help: 'No app output cap by default. The model or provider can still enforce its own output limit.', unit: 'tokens' },
  { key: 'maxSteps', label: 'Model calls', section: 'limits', help: 'Unlimited by default. Set a maximum shared across the task and its subagents.' },
  { key: 'maxAgents', label: 'Parallel subagents', section: 'limits', help: 'No configured parallel-agent cap by default. The operating system and provider still have resource limits.' },
  { key: 'maxProcesses', label: 'Parallel processes', section: 'limits', help: 'No configured background process cap by default. Set a positive count to limit active process jobs.' },
  { key: 'maxDepth', label: 'Delegation depth', section: 'limits', help: 'Unlimited by default. Enter 0 to disable delegation or a number to cap its nesting depth.' },
  { key: 'timeoutMs', label: 'Request timeout', section: 'limits', help: 'No global app timeout by default. A configured value also caps background processes. NVIDIA keeps a provider-specific timeout for slow inference startup. Cancel a request with Esc or Ctrl+C.', unit: 'ms' },
  { key: 'toolOutputLimit', label: 'Tool output', section: 'limits', help: 'No app character cap by default. Large results may exceed the selected model context.', unit: 'characters' },
];
