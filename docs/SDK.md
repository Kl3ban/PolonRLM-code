# SDK

The SDK is a typed wrapper around the same `Controller` used by the terminal UI. It embeds an agent in a Node.js process without Ink or a terminal.

```js
import { AgentClient } from 'polonrlm-agent/sdk';

const agent = await AgentClient.create({
  workspace: process.cwd(),
  provider: {
    id: 'groq',
    config: { kind: 'compatible', baseURL: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-20b' },
    apiKey: process.env.GROQ_API_KEY,
  },
  settings: { permissions: 'workspace' },
});

const result = await agent.run('Fix the failing test in src/parser.js.', event => {
  if (event.type === 'text') process.stdout.write(event.text ?? '');
});
console.log(result.text, result.usage);

await agent.close();
```

`AgentClient.create` loads the normal configuration from `home` (or `POLONRLM_HOME`), applies the optional settings, validates the complete schema, stores an optional API key in the local secret vault, and opens a real workspace/session. It never writes the API key to the config.

## API

| Member | Meaning |
| --- | --- |
| `AgentClient.create(options)` | Open a controller, provider, workspace and session. |
| `AgentClient.fromController(controller)` | Embed an existing controller. |
| `agent.sessionId` | Current session id. |
| `agent.describe()` | Workspace, provider, model, mode and status. |
| `agent.tools()` | Tool names, descriptions, availability and policies. |
| `agent.run(prompt, onEvent?)` | Run one task and return `{ text, sessionId, usage }`. |
| `agent.setEventSink(listener)` | Replace the runtime event listener. |
| `agent.cancel()` | Cancel the current task. |
| `agent.close()` | Stop background work and close the controller. |

`settings.permissions` defaults to the saved config; set it explicitly for headless use. Approval-required tools fail unless an `approve` callback is supplied:

```js
approve: async request => request.tool === 'execute_command' && request.description.startsWith('Run tests:')
```

The SDK does not register new model tools and does not isolate plugin code. Use the plugin hook API for lifecycle extensions; both are local trusted code.

The build output is `dist/sdk/index.js`; the package export is `polonrlm-agent/sdk`.
