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
  { key: 'tokenBudget', label: 'Tokens per task', section: 'limits', help: 'Shared budget for the task and its subagents. Enter infinity or 0 for no limit.' },
  { key: 'dollarBudget', label: 'Cost per task', section: 'limits', help: 'Separate USD cost limit. The app cannot calculate exact cost when model prices are unknown.', unit: 'USD' },
  { key: 'maxInputTokens', label: 'Input context', section: 'limits', help: 'Maximum context size for one request. The model limit still applies.', unit: 'tokens' },
  { key: 'maxOutputTokens', label: 'Response length', section: 'limits', help: 'Maximum response size for a single model request.', unit: 'tokens' },
  { key: 'maxSteps', label: 'Model calls', section: 'limits', help: 'Shared step limit for the task and its subagents. Cortex may set a lower limit.' },
  { key: 'maxAgents', label: 'Parallel subagents', section: 'limits', help: 'Maximum number of subagents working at the same time.' },
  { key: 'maxDepth', label: 'Delegation depth', section: 'limits', help: 'Maximum delegation depth. 0 disables delegation.' },
  { key: 'timeoutMs', label: 'Request timeout', section: 'limits', help: 'Time limit for one request or command, in milliseconds.', unit: 'ms' },
  { key: 'toolOutputLimit', label: 'Tool output', section: 'limits', help: 'Maximum number of output characters sent to the model. Full output is not expanded automatically.', unit: 'characters' },
];
