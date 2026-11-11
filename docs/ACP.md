# ACP adapter

PolonRLM includes a small **Agent Client Protocol v1** adapter over newline-delimited JSON-RPC on stdio. It is intended for editors and desktop clients that already speak ACP. The HTTP/SSE server remains the simpler custom-client protocol.

```sh
npm run build
npm run acp
```

The process must keep stdout clean for JSON-RPC. Diagnostics go to the client through ACP error responses; use stderr for local debugging if you add any.

## Supported methods

| Method | Behaviour |
| --- | --- |
| `initialize` | Returns protocol version 1, image prompt support, session load/resume/close/list capability. |
| `authenticate`, `logout` | Acknowledged; provider credentials come from the normal PolonRLM profile. |
| `session/new` | Opens a real PolonRLM controller for the absolute `cwd` and returns a `sessionId`. |
| `session/load` | Resumes an existing PolonRLM session and replays text history through `session/update`. |
| `session/resume` | Resumes a session without replaying history. |
| `session/list` | Lists live sessions in this process. |
| `session/prompt` | Runs text and image content blocks; streams `session/update` text and tool-call status; returns `end_turn` or `cancelled`. |
| `session/cancel` | Cancels the running prompt; the response uses the `cancelled` stop reason. |
| `session/close` | Cancels and closes the session. |

Approval-required tools call `session/request_permission` with `allow_once` and `reject_once` options. Without a connected client transport the request is denied. `mcpServers` in `session/new` is currently ignored; MCP servers come from the profile. Audio, arbitrary embedded binary content, ACP session modes, configuration options, client filesystem/terminal methods and `session/set_mode` are not implemented.

## Example

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}
{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"C:\\work\\project","mcpServers":[]}}
{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"...","prompt":[{"type":"text","text":"Fix the failing test."}]}}
```

```js
import { AcpServer } from 'polonrlm-agent/acp';
const server = new AcpServer();
server.startStdio();
```

The adapter is not a substitute for the HTTP/SSE server when a client needs multiple workspaces, a browser UI or rich approval flows. Like the rest of PolonRLM, it runs with the user's filesystem and process permissions.
