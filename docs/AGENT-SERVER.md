# Agent server

The agent server exposes one PolonRLM session over local HTTP and Server-Sent Events. It is the protocol for a desktop app, IDE extension or custom client. It is not an ACP implementation; ACP clients need a separate adapter.

## Start

```powershell
npm run build
npm run serve -- --workspace C:\work\project --port 4317 --token change-me
```

The command prints JSON with `url` and `sessionId`. The default bind address is `127.0.0.1`; do not expose it to a network without a token and an explicit host. The server uses the saved provider and model from the PolonRLM home. Set `POLONRLM_HOME` to select another profile.

The server has no interactive approval prompt. A tool that requires approval is denied. Configure `permissions` and `toolPermissions` in the profile before starting it, or use the SDK and pass an `approve` callback.

## Endpoints

| Method | Path | Behaviour |
| --- | --- | --- |
| `GET` | `/health` | `{ status: "ok", sessionId }` |
| `GET` | `/v1/session` | Workspace, provider, model, mode and status |
| `GET` | `/v1/tools` | Available tools and policies |
| `POST` | `/v1/messages` | `{ prompt }`; returns `{ text, sessionId, usage }` |
| `POST` | `/v1/messages` | `{ prompt, stream: true }` or `Accept: text/event-stream`; streams `ready`, `runtime`, `done` or `error` events |
| `POST` | `/v1/cancel` | Cancels the current task |

```powershell
$headers = @{ Authorization = 'Bearer change-me'; 'Content-Type' = 'application/json' }
Invoke-RestMethod -Method Post -Headers $headers -Uri http://127.0.0.1:4317/v1/messages -Body '{"prompt":"Summarize the project."}'
```

SSE example:

```js
const response = await fetch('http://127.0.0.1:4317/v1/messages', {
  method: 'POST',
  headers: { Authorization: 'Bearer change-me', 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: 'Fix the failing test.', stream: true }),
});
for (const chunk of response.body) {
  // Parse the text/event-stream frames; every frame has event: and data: lines.
}
```

Only one task can run in a session at a time. A second concurrent prompt returns an error instead of interleaving model calls. Body size is capped at 1 MB. Event text is redacted by the same secret redaction as the CLI.

## Programmatic server

```js
import { startAgentServer } from 'polonrlm-agent/server';
const server = await startAgentServer({ workspace: process.cwd(), port: 0, token: 'secret' });
console.log(server.url);
await server.close();
```

`startAgentServer` accepts the same options as `AgentClient.create`, plus `host`, `port`, `token` and an optional injected `client`.
