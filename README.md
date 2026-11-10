# PolonRLM

A terminal coding agent for working in an existing project. It can inspect code, use a language model, call local tools, edit files, and run commands with your approval settings.

PolonRLM is written in TypeScript and runs on Node.js 24 or newer. The workflow takes inspiration from OpenCode, while the codebase and interface are its own.

## What it can do

- Connect to Google, OpenAI, Anthropic, OpenRouter, NVIDIA, Mistral, DeepSeek, TeamRouter, Groq, Ollama, LM Studio, vLLM, and custom OpenAI-compatible endpoints.
- Read and edit files, search code, inspect Git, run tests, and use shell tools.
- Find TypeScript/JavaScript definitions, references, and AST nodes; use installed language servers for other languages, including workspace symbols and call hierarchy.
- Delegate focused work to subagents that share the task budget.
- Keep conversation history in a local SQLite database and compact old context without another model call.
- Start with no global task caps for tokens, cost, calls, context, agents, or tool output. Configure caps in `/settings` or `/budget` if you need them; model and provider limits still apply. NVIDIA keeps a provider-specific long timeout for slow inference startup.
- Search the web through ordinary public search pages, without a search API key.
- Automate a headless browser with Playwright. Missing Chromium or Firefox builds are downloaded only when first needed.
- Attach images when the selected model supports vision.
- Control the Windows desktop through the `computer_use` tool.
- Load local skills and connect MCP servers.

The model chooses when to use tools. File edits, shell commands, browser actions, and other operations follow the configured permission rules.

## Quick start

You need Node.js 24 or newer.

~~~sh
git clone https://github.com/Kl3ban/PolonRLM-code.git
cd PolonRLM-code
npm ci
npm run build
npm link
PolonRLM setup
PolonRLM
~~~

On Windows, you can also run the PowerShell installer:

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
PolonRLM setup
PolonRLM
~~~

The setup wizard helps choose a provider and model. API keys are entered locally and are not stored in the repository. On Windows, keys are encrypted with DPAPI. On other systems, use the environment variable shown for your provider.

Local web search uses a small Python helper and needs Python 3.11 or newer. Its dependencies are installed automatically on first use. You can also prepare them with `PolonRLM setup web`. Browser engines are installed only when the chosen engine needs them.

## A few commands

~~~text
/connect google
/key <your-api-key>
/models
/model gemini-3.5-flash-lite
/plan Explain how this project is structured
/build Fix the failing settings code
/review Look for unsafe file handling
/settings
/permissions
/goal Add a config export command
/image C:/Pictures/diagram.png
/undo
~~~

The models available to you depend on the provider and your account. A model may appear in a provider catalog but still be unavailable to your account. Use `/help` for the full list, or see [docs/COMMANDS.md](docs/COMMANDS.md).

## Run without the interactive UI

~~~sh
PolonRLM run "Review this project and list the main risks" --mode PLAN
PolonRLM run "Add a README section" --permission workspace
PolonRLM run "Check the current setup" --json
PolonRLM doctor
~~~

The default permission mode asks before sensitive actions. `workspace` allows normal file changes in the project. `readonly` blocks writes and shell actions. Shell commands run with your account and are not sandboxed, so read approval prompts before accepting them.

## Providers

Built-in presets cover hosted APIs and local model servers. Local endpoints such as Ollama and LM Studio can be used without a hosted API key.

~~~text
/connect nvidia
/connect teamorouter
/connect ollama
/connect custom https://host.example/v1
/models
/model <model-id>
/effort
/effort high
/settings provider.reasoning low
~~~

Provider catalogs may not report prices or every model capability. When the information is unknown, PolonRLM leaves it marked as unknown. See [docs/PROVIDERS.md](docs/PROVIDERS.md) for more detail.

## Browser and web tools

The settings panel lets you choose a browser engine:

- `auto` tries available Playwright Chromium, Chrome, Edge, Brave, and Firefox engines.
- `chromium` and `firefox` use Playwright browser builds. Missing builds are downloaded on first use, not during startup.
- `chrome`, `edge`, and `brave` use an installed system browser.

Browser automation runs headless and does not read your regular browser profile or cookies. The network layer blocks local and private destinations. Brave is detected in common locations or can be selected with `POLONRLM_BRAVE_PATH`.

Local web search reads ordinary HTML result pages from Bing, Brave, and Yahoo. It does not use a paid search API or a search key. See [docs/LOCAL-WEB.md](docs/LOCAL-WEB.md).

## Development

~~~sh
npm ci
npm run check
npm test
npm run build
npm run bench
~~~

The regular tests use local fixtures and do not need an AI API key. `npm run test:live` calls a real provider and may spend API credits, so it is separate from the regular test command.

GitHub Actions runs checks on Windows, macOS, and Linux for pushes and pull requests.

More background is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/TOOLS.md](docs/TOOLS.md), and [docs/COMPUTER-USE.md](docs/COMPUTER-USE.md).

## License

PolonRLM is released under the MIT License. See [LICENSE](LICENSE).
