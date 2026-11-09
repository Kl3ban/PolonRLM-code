import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Controller } from '../dist/core/controller.js';
import { ConfigManager } from '../dist/core/config.js';
import { SecretVault, isSecretEnvironmentName, redact } from '../dist/core/secrets.js';
import { createProvider } from '../dist/providers/provider.js';
const provider = process.env.POLONRLM_LIVE_PROVIDER;
const model = process.env.POLONRLM_LIVE_MODEL;
if (!provider || !model) throw new Error('Set POLONRLM_LIVE_PROVIDER and POLONRLM_LIVE_MODEL explicitly; this test uses real API credits and the provider key environment variable.');
const reportPath = path.resolve('docs/live-smoke-report.json');
const timeoutMs = Number(process.env.POLONRLM_LIVE_TIMEOUT_MS ?? 600000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw new Error('POLONRLM_LIVE_TIMEOUT_MS must be an integer between 1000 and 600000.');
const skipChatPreflight = process.env.POLONRLM_LIVE_SKIP_CHAT === '1';
console.log(`Live agent smoke test: ${provider}/${model}; timeout ${timeoutMs}ms.`);
const userConfig = new ConfigManager(); await userConfig.load();
const providerConfig = userConfig.settings.providers[provider];
if (!providerConfig) throw new Error(`Unknown configured provider: ${provider}`);
const apiKey = await new SecretVault(userConfig.home).get(provider, providerConfig.apiKeyEnv);
if (!apiKey) throw new Error(`No local credential found for ${provider}. Configure it through /key or its environment variable first.`);
for (const name of Object.keys(process.env)) if (isSecretEnvironmentName(name)) delete process.env[name];
const smokeConfig = { ...providerConfig, model, reasoning: undefined, reasoningSupported: undefined, maxOutputTokens: undefined, toolCalling: undefined, vision: undefined };
const textProvider = createProvider(smokeConfig, apiKey, 128);
let firstTokenMs = null;
let textLatencyMs = null;
if (skipChatPreflight) console.log('Skipping the standalone chat preflight.');
else {
  console.log('Waiting for the first text response…');
  const requestStartedAt = performance.now();
  try {
    const textReply = await textProvider.complete([{ role: 'user', content: 'Reply with exactly this text: POLONRLM_CHAT_OK' }], [], () => {
      if (firstTokenMs === null) {
        firstTokenMs = Math.round(performance.now() - requestStartedAt);
        console.log(`First streamed token: ${firstTokenMs}ms.`);
      }
    }, AbortSignal.timeout(timeoutMs));
    if (!textReply.text.includes('POLONRLM_CHAT_OK')) throw new Error('Text-only provider response did not contain its expected marker.');
    textLatencyMs = Math.round(performance.now() - requestStartedAt);
  } catch (error) {
    const report = { date: new Date().toISOString(), status: 'FAIL', stage: 'text-generation', provider, model, elapsedMs: Math.round(performance.now() - requestStartedAt), firstTokenMs, error: redact(error instanceof Error ? error.message : String(error)) };
    await saveReport(report);
    console.error(JSON.stringify({ ...report, reportPath }));
    throw error;
  }
}
let imageStatus = 'SKIP';
if (process.env.POLONRLM_LIVE_IMAGE === '1') {
  const imagePath = process.env.POLONRLM_LIVE_IMAGE_PATH;
  if (!imagePath) throw new Error('Set POLONRLM_LIVE_IMAGE_PATH to a local image before running the optional vision check.');
  const screenshot = await readFile(imagePath);
  const imageProvider = createProvider({ ...smokeConfig, vision: true }, apiKey, 128);
  const imageReply = await imageProvider.complete([{ role: 'user', content: 'If you can read the text PolonRLM in the image, reply exactly POLONRLM_IMAGE_OK. Otherwise, briefly describe what is shown.', images: [{ data: screenshot.toString('base64'), mediaType: 'image/png', name: 'image.png' }] }], [], () => {}, AbortSignal.timeout(timeoutMs));
  if (!imageReply.text.includes('POLONRLM_IMAGE_OK')) throw new Error('Vision response did not identify the expected PolonRLM screenshot marker.');
  imageStatus = 'PASS';
}
const providers = structuredClone(userConfig.settings.providers);
providers[provider].requestTimeoutMs = timeoutMs;
const directory = await mkdtemp(path.join(tmpdir(), 'PolonRLM-live-'));
const workspace = path.join(directory, 'project'); await mkdir(workspace);
let controller;
try {
controller = await Controller.open(workspace, path.join(directory, 'home'), { provider, timeoutMs, providers });
controller.setApprover(async request => ['write_file', 'execute_command', 'run_tests'].includes(request.tool));
let streamed = 0;
const tools = [];
const toolEvents = [];
const agentStartedAt = performance.now();
let firstAgentTextMs;
controller.onEvent = event => {
  if (event.type === 'text') {
    streamed += event.text?.length ?? 0;
    if (firstAgentTextMs === undefined) {
      firstAgentTextMs = Math.round(performance.now() - agentStartedAt);
      console.log(`First visible agent text: ${firstAgentTextMs}ms.`);
    }
  }
  if (event.type === 'tool' && event.state !== 'running') {
    if (event.state === 'done') tools.push(event.name);
    const toolEvent = { name: event.name, state: event.state, elapsedMs: Math.round(performance.now() - agentStartedAt), durationMs: event.durationMs, ...(event.state === 'error' ? { error: redact(event.text ?? 'Tool failed') } : {}) };
    toolEvents.push(toolEvent);
    console.log(JSON.stringify({ type: 'tool', ...toolEvent }));
  }
};
  await controller.setModel(model);
  await controller.setApiKey(apiKey);
  await controller.submit('Integration test. Create live-check.txt containing exactly POLONRLM_OK, without a trailing newline. Use read_file to verify its contents. Then use execute_command or run_tests with node -e "const f=require(\'node:fs\');if(f.readFileSync(\'live-check.txt\',\'utf8\')!==\'POLONRLM_OK\')process.exit(1);console.log(\'PASS\')". Finish with a short summary of the tools you used.');
  const state = controller.snapshot();
  const content = await readFile(path.join(workspace, 'live-check.txt'), 'utf8').catch(() => undefined);
  if (content !== 'POLONRLM_OK' || !tools.includes('read_file') || !tools.some(name => ['run_tests', 'execute_command'].includes(name)) || state.status === 'Error') {
    const errors = state.messages.filter(message => message.role === 'error').map(message => message.text);
    const latestAnswer = state.messages.findLast(message => message.role === 'assistant')?.text;
    const toolSummary = state.messages.filter(message => message.role === 'tool').map(message => `${message.toolName}:${message.toolState}`).join(', ');
    const report = { date: new Date().toISOString(), status: 'FAIL', stage: 'agent-tool-workflow', provider, model, chat: skipChatPreflight ? 'SKIP' : 'PASS', textLatencyMs, durationMs: Math.round(performance.now() - agentStartedAt), firstVisibleTextMs: firstAgentTextMs ?? null, streamedCharacters: streamed, tools: toolEvents, errors: errors.map(error => redact(error)), answer: latestAnswer ? redact(latestAnswer) : undefined, usage: state.usage };
    await saveReport(report);
    console.error(JSON.stringify({ ...report, reportPath }));
    throw new Error(['The tool test did not finish.', `status=${state.status}`, `tools=${toolSummary || '(none)'}`, ...errors.map(error => redact(error)), latestAnswer ? redact(latestAnswer) : undefined].filter(Boolean).join('\n'));
  }
  const report = { date: new Date().toISOString(), status: 'PASS', provider, model, chat: skipChatPreflight ? 'SKIP' : 'PASS', firstTokenMs, textLatencyMs, agentDurationMs: Math.round(performance.now() - agentStartedAt), firstVisibleAgentTextMs: firstAgentTextMs ?? null, image: imageStatus, streamedCharacters: streamed, tools: toolEvents, usage: state.usage };
  await saveReport(report);
  console.log(JSON.stringify({ ...report, reportPath }, null, 2));
} finally {
  await controller?.close();
  const target = path.resolve(directory);
  if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith('PolonRLM-live-')) throw new Error('Unexpected temporary cleanup path.');
  await rm(target, { recursive: true, force: true });
}

async function saveReport(report) {
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
}
