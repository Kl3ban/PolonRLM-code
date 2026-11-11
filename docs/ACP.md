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
| `initialize` | Returns protocol version 1, text-only prompt capabilities, and session close/list capability. |
| `authenticate`, `logout` | Acknowledged; provider credentials come from the normal PolonRLM profile. |
| `session/new` | Opens a real PolonRLM controller for the absolute `cwd` and returns a `sessionId`. |
| `session/list` | Lists live sessions in this process. |
| `session/prompt` | Runs text content blocks; streams `session/update` `agent_message_chunk` and tool-call status updates; returns `end_turn` or `cancelled`. |
| `session/cancel` | Cancels the running prompt; the response uses the `cancelled` stop reason. |
| `session/close` | Cancels and closes the session. |

`session/load`, `session/resume`, modes, configuration options, client filesystem/terminal methods and `session/request_permission` are **not implemented**. A tool that requires approval is denied because there is no interactive permission bridge. `mcpServers` in `session/new` is currently ignored; MCP servers come from the profile. Images and embedded binary content are not advertised or forwarded.

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
