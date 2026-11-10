import { parseArgs } from 'node:util';
import { Controller } from './core/controller.js';
import { ConfigManager } from './core/config.js';
import { SecretVault, redact, safeText } from './core/secrets.js';
import { createProvider } from './providers/provider.js';
import type { Settings } from './core/types.js';

const help = `PolonRLM 0.5.0 — coding agent for the terminal

PolonRLM                         Interactive TUI
PolonRLM setup                   Configure a provider, API key, and model
PolonRLM setup web               Set up local web tools (Python 3.11+)
PolonRLM run "task"              Run a task without the TUI
PolonRLM doctor                  Check the installation

--workspace <path>               Project directory (defaults to the current directory)
--provider <preset>              Select a provider
--model <id>                      Set a custom model ID
--mode PLAN|BUILD|REVIEW          Set the work mode
--session <id>                    Resume a saved session
--permission ask|workspace|readonly|all
--approve-tools <a,b>             Explicitly approve tools for run mode
--json                            Print NDJSON events without API keys
--help, --version

In the TUI: /connect, /key, /models, /model, /effort, /help. Tab changes mode; Alt+M opens the menu; Alt+D opens providers; Alt+L opens models.
Alt+Enter or Ctrl+J adds a line. Ctrl+C cancels work, then exits if idle.
Terminal commands run with your user permissions and are not sandboxed.`;

async function setup(root: string): Promise<void> {
  const { select, input, password } = await import('@inquirer/prompts');
  const config = new ConfigManager(); await config.load(); const settings = config.settings;
  const id = await select({ message: 'AI provider', choices: Object.keys(settings.providers).map(value => ({ name: value, value })), default: settings.provider });
  const provider = settings.providers[id]!;
  provider.baseURL = await input({ message: 'Base URL', default: provider.baseURL, validate(value) {
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash || 'Base URL must use HTTP(S) and contain no password, query parameters, or fragment.'; }
    catch { return 'Enter a valid HTTP(S) URL.'; }
  } });
  const key = await password({ message: `API key (press Enter for: ${provider.apiKeyEnv ?? 'no key'})`, mask: '*' });
  const vault = new SecretVault(config.home); if (key) await vault.set(id, key);
  const apiKey = await vault.get(id, provider.apiKeyEnv);
  for (const field of ['contextWindow', 'toolCalling', 'vision', 'inputPrice', 'outputPrice'] as const) delete provider[field];
  let models: Awaited<ReturnType<ReturnType<typeof createProvider>['listModels']>> = [];
  try { models = await createProvider(provider, apiKey, settings.maxOutputTokens).listModels(); }
  catch (error: any) { console.error(safeText(`Model list: ${error.message}`)); }
  if (models.length) {
    const value = await select({ message: 'Model', choices: [{ name: 'Enter a model ID manually', value: '' }, ...models.map(model => ({ name: model.id, value: model.id }))], pageSize: 15 });
    provider.model = value || await input({ message: 'Model ID', required: true });
    const metadata = models.find(model => model.id === provider.model);
    for (const field of ['contextWindow', 'toolCalling', 'vision', 'inputPrice', 'outputPrice'] as const) { delete provider[field]; if (metadata?.[field] !== undefined) (provider as any)[field] = metadata[field]; }
  } else {
    provider.model = await input({ message: 'Model ID (check the key if the API returned an error)', required: true });
  }
  settings.provider = id; await config.save(); console.log(`Settings saved. Workspace: ${root}\nRun PolonRLM.`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' }, workspace: { type: 'string', short: 'w' },
    provider: { type: 'string' }, model: { type: 'string' }, mode: { type: 'string' }, permission: { type: 'string' },
    session: { type: 'string' }, 'approve-tools': { type: 'string' }, json: { type: 'boolean' }
  } });
  if (values.help) { console.log(help); return; }
  if (values.version) { console.log('0.5.0'); return; }
  const root = values.workspace ?? process.cwd();
   if (positionals[0] === 'setup' && positionals[1] === 'web') { const { setupNetworkRuntime } = await import('./tools/network.js'); console.log(`Local web tools ready: ${await setupNetworkRuntime()}`); return; }
   if (positionals[0] === 'setup') { await setup(root); return; }
  const overrides: Partial<Settings> = {};
  if (values.provider) overrides.provider = values.provider;
  if (values.mode) overrides.mode = values.mode.toUpperCase() as Settings['mode'];
  if (values.permission) overrides.permissions = values.permission as Settings['permissions'];
  if (!positionals.length && (!process.stdin.isTTY || !process.stdout.isTTY)) { console.log(help); return; }
  const controller = await Controller.open(root, undefined, overrides);
  try {
  if (values.model) await controller.setModel(values.model);
  if (positionals[0] === 'doctor') {
    const { execa } = await import('execa');
    const { rgPath } = await import('@vscode/ripgrep');
    const { networkPython } = await import('./tools/network.js');
    const checks = await Promise.all([['git', 'git'], ['rg', rgPath], ['python (web)', networkPython()]].map(async ([name, command]) => { try { const result = await execa(command!, ['--version'], { timeout: 5000, windowsHide: true }); return `${name}: ${result.stdout.split('\n')[0]}`; } catch { return `${name}: missing or unavailable${name === 'python (web)' ? ' · PolonRLM setup web' : ''}`; } }));
    let sqlite: string;
    try { sqlite = controller.integrityCheck(); } finally { await controller.close(); }
    console.log(`Node ${process.version} · ${process.platform}\n${checks.join('\n')}\nData: ${controller.config.home}\nSQLite: ${sqlite}\n${controller.snapshot().workspace}`); return;
  }
  if (values.session) controller.resumeSession(values.session);
  if (positionals[0] === 'run') {
    const task = positionals.slice(1).join(' '); if (!task) { await controller.close(); throw new Error('Provide a task: PolonRLM run "..."'); }
    const allow = new Set(values['approve-tools']?.split(',').filter(Boolean) ?? []);
    controller.setApprover(async request => {
      if (allow.has(request.tool)) return true;
      if (!process.stdin.isTTY || values.json) return false;
      const { confirm } = await import('@inquirer/prompts');
      console.error(safeText(`${request.description}\n${request.preview ?? ''}`));
      return confirm({ message: `Approve ${request.tool}?`, default: false });
    });
    let failed = false;
    controller.onEvent = event => {
      if (values.json) process.stdout.write(`${JSON.stringify(event)}\n`);
      else if (event.type === 'text') process.stdout.write(safeText(event.text ?? ''));
      else if (event.type === 'tool' && event.state === 'running') process.stderr.write(`\n[${event.name}]\n`);
    };
    const interrupt = () => controller.cancel(); process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
    try { await controller.submit(task); failed = ['Error', 'Cancelled'].includes(controller.snapshot().status); }
    finally {
      process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
      const state = controller.snapshot();
      if (failed) {
        const error = state.messages.filter(message => message.role === 'error').at(-1)?.text ?? state.status;
        if (values.json) console.log(JSON.stringify({ type: 'error', text: error })); else console.error(`\n${error}`);
      }
      if (!values.json) console.log(`\nTokens: ${state.usage.input + state.usage.output} · Cost: ${state.usage.costKnown ? `$${state.usage.cost.toFixed(5)}` : 'unknown'}\n`);
      await controller.close();
    }
    if (failed) process.exitCode = 1; return;
  }
  if (positionals.length) { await controller.close(); throw new Error('Unknown command. PolonRLM --help'); }
  if (!process.stdin.isTTY || !process.stdout.isTTY) { await controller.close(); console.log(help); return; }
  const { startTUI } = await import('./ui/tui.js');
  let terminated = false;
  const terminate = () => { terminated = true; void controller.close().catch(error => { console.error(safeText(redact(error.message ?? String(error)))); process.exitCode = 1; }); };
  process.once('SIGTERM', terminate);
  try { await startTUI(controller); }
  finally {
    process.removeListener('SIGTERM', terminate);
    if (terminated && process.exitCode === undefined) process.exitCode = 143;
  }
  } finally { await controller.close(); }
}
main().catch(error => { console.error(safeText(redact(error.message ?? String(error)))); process.exitCode = 1; });
