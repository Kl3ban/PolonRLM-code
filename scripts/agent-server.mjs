import { startAgentServer } from '../dist/server/agent-server.js';

const args = process.argv.slice(2);
function value(name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const next = args[index + 1];
  if (!next || next.startsWith('--')) throw new Error(`${name} requires a value.`);
  return next;
}
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: npm run serve -- [--workspace <path>] [--host 127.0.0.1] [--port 0] [--token <token>]');
  console.log('Starts a local HTTP/SSE agent server using the current PolonRLM provider configuration.');
  process.exit(0);
}
const port = Number(value('--port', '0'));
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be an integer from 0 to 65535.');
const token = value('--token', process.env.POLONRLM_SERVER_TOKEN);
const server = await startAgentServer({ workspace: value('--workspace', process.cwd()), host: value('--host', '127.0.0.1'), port, token });
console.log(JSON.stringify({ url: server.url, sessionId: server.client.sessionId, tokenRequired: Boolean(token) }));
const shutdown = async () => { try { await server.close(); } finally { process.exit(0); } };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
