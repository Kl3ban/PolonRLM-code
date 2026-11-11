import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Controller } from '../dist/core/controller.js';
import { SecretVault, isSecretEnvironmentName, redact } from '../dist/core/secrets.js';
import { createProvider } from '../dist/providers/provider.js';

const baseURL = process.env.GROQ_BASE_URL ?? 'https://api.groq.com/openai/v1';
const model = process.env.GROQ_MODEL ?? 'openai/gpt-oss-120b';
const timeoutMs = Math.max(10_000, Math.min(300_000, Number(process.env.GROQ_TIMEOUT_MS ?? 120_000)));
const reportPath = path.resolve(process.env.GROQ_REPORT_PATH ?? 'docs/groq-live-report.json');

function usageOf(value) {
  if (!value || typeof value !== 'object') return null;
  return { input: value.input ?? 0, output: value.output ?? 0, cached: value.cached ?? 0, cost: value.cost ?? 0, costKnown: value.costKnown === true };
}

async function main() {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('Set GROQ_API_KEY for this test. The key is read only from the environment and is never written to the report.');
  const root = await mkdtemp(path.join(tmpdir(), 'polonrlm-groq-'));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'project');
  await mkdir(home); await mkdir(workspace);
  const report = { date: new Date().toISOString(), provider: 'groq', baseURL, model, status: 'FAIL', stages: {}, usage: null };
  let controller;
  try {
    report.stages.text = 'running';
    const direct = createProvider({ id: 'groq', kind: 'compatible', baseURL, model, contextWindow: 131072, maxOutputTokens: 512 }, key, 512);
    const text = await direct.complete([{ role: 'user', content: 'Reply with exactly this text and nothing else: GROQ_TEXT_OK' }], [], () => {}, AbortSignal.timeout(timeoutMs));
    if (!text.text.includes('GROQ_TEXT_OK')) throw new Error('Text generation did not contain GROQ_TEXT_OK.');
    report.stages.text = 'passed';
    report.usage = usageOf(text.usage);

    // Keep the key out of the controller environment and child commands:
    // the temporary DPAPI vault holds it for this run only.
    const vault = new SecretVault(home);
    await vault.set('groq', key);
    delete process.env.GROQ_API_KEY;
    for (const name of Object.keys(process.env)) if (isSecretEnvironmentName(name)) delete process.env[name];

    report.stages.agent = 'running';
    controller = await Controller.open(workspace, home, {
      provider: 'groq',
      providers: {
        groq: { id: 'groq', kind: 'compatible', baseURL, model, apiKeyEnv: 'GROQ_API_KEY', contextWindow: 131072, maxOutputTokens: 512 },
      },
      cortex: 0,
      maxSteps: 20,
      maxOutputTokens: 512,
      timeoutMs,
      permissions: 'workspace',
      toolPermissions: { write_file: 'auto', read_file: 'auto', execute_command: 'auto' },
      verificationMode: 'manual',
    });
    controller.setApprover(async () => true);
    await controller.submit('Use write_file to create live-groq.txt with exactly the text GROQ_TOOL_OK. Then use read_file to read it and execute_command to run node -e "process.stdout.write(\'SHELL_OK\')". After the tools, reply with the exact file content and the shell output.');
    await controller.active;
    const file = await readFile(path.join(workspace, 'live-groq.txt'), 'utf8');
    if (!file.includes('GROQ_TOOL_OK')) throw new Error('The model did not create the expected file content.');
    const messages = controller.snapshot().messages;
    const tools = messages.filter(message => message.role === 'tool').map(message => ({ name: message.toolName ?? 'tool', isError: message.toolState === 'error', output: message.toolOutput ?? '' }));
    const names = new Set(tools.map(tool => tool.name));
    if (!names.has('write_file')) throw new Error('The agent did not call write_file.');
    if (!names.has('read_file')) throw new Error('The agent did not call read_file.');
    if (!names.has('execute_command')) throw new Error('The agent did not call execute_command.');
    if (tools.some(tool => tool.isError)) throw new Error('A required tool call failed.');
    if (!tools.find(tool => tool.name === 'read_file')?.output.includes('GROQ_TOOL_OK')) throw new Error('read_file did not return the expected content.');
    if (!tools.find(tool => tool.name === 'execute_command')?.output.includes('SHELL_OK')) throw new Error('execute_command did not return the expected output.');
    report.stages.agent = 'passed';
    report.file = file.trim();
    report.tools = tools;
    report.agentUsage = usageOf(controller.snapshot().taskUsage);
    report.status = 'PASS';
  } catch (error) {
    report.error = redact(error instanceof Error ? error.message : String(error));
  } finally {
    if (controller) {
      try {
        const snapshot = controller.snapshot();
        report.agentStatus = snapshot.status;
        report.messages = snapshot.messages.slice(-12).map(message => ({
          role: message.role,
          toolName: message.toolName,
          toolState: message.toolState,
          text: redact(message.text ?? message.toolOutput ?? '').slice(0, 1200),
        }));
      } catch { /* Snapshot is diagnostic only. */ }
    }
    if (controller) await controller.close().catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
    await mkdir(path.dirname(reportPath), { recursive: true }).catch(() => {});
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ ...report, reportPath }));
  }
  if (report.status !== 'PASS') process.exitCode = 1;
}

main().catch(error => {
  console.error(redact(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
