import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Controller } from '../dist/core/controller.js';
import { ConfigManager } from '../dist/core/config.js';
import { SecretVault, isSecretEnvironmentName } from '../dist/core/secrets.js';
import { createProvider } from '../dist/providers/provider.js';
const provider = process.env.POLONRLM_LIVE_PROVIDER;
const model = process.env.POLONRLM_LIVE_MODEL;
if (!provider || !model) throw new Error('Set POLONRLM_LIVE_PROVIDER and POLONRLM_LIVE_MODEL explicitly; this test uses real API credits and the provider key environment variable.');
const userConfig = new ConfigManager(); await userConfig.load();
const providerConfig = userConfig.settings.providers[provider];
if (!providerConfig) throw new Error(`Unknown configured provider: ${provider}`);
const apiKey = await new SecretVault(userConfig.home).get(provider, providerConfig.apiKeyEnv);
if (!apiKey) throw new Error(`No local credential found for ${provider}. Configure it through /key or its environment variable first.`);
for (const name of Object.keys(process.env)) if (isSecretEnvironmentName(name)) delete process.env[name];
const smokeConfig = { ...providerConfig, model, reasoning: undefined, reasoningSupported: undefined, maxOutputTokens: undefined, toolCalling: undefined, vision: undefined };
const textProvider = createProvider(smokeConfig, apiKey, 128);
const textReply = await textProvider.complete([{ role: 'user', content: 'Reply with exactly this text: POLONRLM_CHAT_OK' }], [], () => {}, AbortSignal.timeout(45000));
if (!textReply.text.includes('POLONRLM_CHAT_OK')) throw new Error('Text-only provider response did not contain its expected marker.');
let imageStatus = 'SKIP';
if (process.env.POLONRLM_LIVE_IMAGE === '1') {
  const imagePath = process.env.POLONRLM_LIVE_IMAGE_PATH;
  if (!imagePath) throw new Error('Set POLONRLM_LIVE_IMAGE_PATH to a local image before running the optional vision check.');
  const screenshot = await readFile(imagePath);
  const imageProvider = createProvider({ ...smokeConfig, vision: true }, apiKey, 128);
  const imageReply = await imageProvider.complete([{ role: 'user', content: 'If you can read the text PolonRLM in the image, reply exactly POLONRLM_IMAGE_OK. Otherwise, briefly describe what is shown.', images: [{ data: screenshot.toString('base64'), mediaType: 'image/png', name: 'image.png' }] }], [], () => {}, AbortSignal.timeout(45000));
  if (!imageReply.text.includes('POLONRLM_IMAGE_OK')) throw new Error('Vision response did not identify the expected PolonRLM screenshot marker.');
  imageStatus = 'PASS';
}
const directory = await mkdtemp(path.join(tmpdir(), 'PolonRLM-live-'));
const workspace = path.join(directory, 'project'); await mkdir(workspace);
let controller;
try {
controller = await Controller.open(workspace, path.join(directory, 'home'), { provider });
controller.setApprover(async request => ['write_file', 'execute_command', 'run_tests'].includes(request.tool));
let streamed = 0;
const tools = [];
controller.onEvent = event => {
  if (event.type === 'text') streamed += event.text?.length ?? 0;
  if (event.type === 'tool' && event.state === 'done') tools.push(event.name);
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
    throw new Error(['The tool test did not finish.', `status=${state.status}`, `tools=${toolSummary || '(none)'}`, ...errors, latestAnswer].filter(Boolean).join('\n'));
  }
  console.log(JSON.stringify({ status: 'PASS', chat: 'PASS', image: imageStatus, workspace, streamedCharacters: streamed, tools, usage: state.usage }, null, 2));
} finally {
  await controller?.close();
  const target = path.resolve(directory);
  if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith('PolonRLM-live-')) throw new Error('Unexpected temporary cleanup path.');
  await rm(target, { recursive: true, force: true });
}
