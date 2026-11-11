# Commands

PolonRLM has two command layers. The first is the normal command line used to start a task. Slash commands are entered inside the interactive terminal app. Run `/help` in the app or `PolonRLM --help` for the current full list.

## Start the app

~~~sh
PolonRLM
PolonRLM setup
PolonRLM doctor
PolonRLM run "Review the project and explain the main risks" --mode PLAN
PolonRLM run "Add a small settings panel" --permission workspace
~~~

`setup` helps choose a provider and model. `doctor` checks the local setup. `run` executes one task without opening the interactive interface. `--json` prints events as newline separated JSON for scripts.

## Providers and models

| Command | What it does |
| --- | --- |
| `/connect` | Shows provider presets and the custom endpoint option. |
| `/connect google` | Selects a provider preset. |
| `/connect custom https://host.example/v1` | Adds an OpenAI compatible endpoint. |
| `/key <secret>` | Stores a provider key in the local secret vault. Never put a real key in a script or commit. |
| `/models` | Fetches models exposed by the selected provider. |
| `/model <id>` | Changes the active model without restarting. |
| `/effort` | Opens the reasoning controls supported by the selected model. |
| `/effort <value>` | Sets a listed level, toggle, or provider-specific mode. Use `/effort auto` to restore the model default. |

Provider APIs decide which models work with a given account. A model can appear in a provider list and still be unavailable to your account.

Reasoning options are model-aware. OpenAI, Gemini and compatible providers use different request fields. The picker only shows known options for the selected model; providers that return their own reasoning modes take precedence over the built-in model profiles. If no reasoning control is known, `Automatic` leaves the provider's default unchanged.

## Modes, permissions and limits

| Command | What it does |
| --- | --- |
| `/plan <task>` | Asks the agent to inspect and propose work without making project changes. |
| `/build <task>` | Runs a task in BUILD mode. Writes still follow the approval rules. |
| `/review <task>` | Reviews the project without allowing edits. |
| `/mode PLAN\|BUILD\|REVIEW` | Changes the mode for later tasks. Tab also cycles modes. |
| `/permissions` | Shows effective permissions. |
| `/permissions <tool> ask\|auto\|off\|default` | Sets a rule for one tool. |
| `/permissions workspace` | Allows normal project file changes, with the configured workspace boundary. |
| `/permissions readonly` | Blocks writes and shell actions. |
| `/settings` | Opens settings for browser choice, budgets, model options, search and other preferences. |
| `/settings verificationCommands ["npm test", "npm run check"]` | Sets project verification commands. Use `[]` to detect checks from the project manifest. |
| `/budget <tokens> <USD>` | Sets limits for the next task. Use `infinity` for no token or cost cap. |
| `/cortex 0..5` | Changes how much planning and subagent work is allowed. |
| `/verify` | Runs configured or detected checks, gathers diagnostics for changed TypeScript/JavaScript files, and records file hashes and exit codes. |
| `/verify <command>` | Runs one explicit project command through the normal shell approval rules. |
| `/verify history [count]` | Shows saved verification reports for this chat. |
| `/verify report <id>` | Opens the full evidence report using its ID from `/verify history`. |

Shell commands run with the current user's operating system permissions. They are not sandboxed. Review command approval prompts before accepting them.

With no configured verification commands, `/verify` detects standard scripts in `package.json`, Cargo, Go, Python, .NET, Gradle, or Maven manifests. Detection does not install dependencies. A passing command is evidence for that command only; it does not prove correctness against hidden tests or guarantee that every project change is covered.

## Files, images and research

| Command | What it does |
| --- | --- |
| `/tools` | Lists available tools. Add a word to filter the list. |
| `/image <path>` | Adds an image to the next task for a vision capable model. |
| `/image clear` | Removes images waiting to be sent. |
| `/undo` | Reverts the most recent file change made through PolonRLM in this process. |
| `/compact` | Makes a local extractive summary without another model call. The full transcript stays archived. |
| `/context` | Shows a local token estimate, the app input cap, and known model context. |
| `/cost` | Shows token use and known provider costs. Unknown prices stay marked unknown. |
| `/settings browserEngine auto` | Lets PolonRLM choose an available browser. |
| `/settings browserEngine firefox` | Selects Playwright Firefox. It downloads on first use if needed. |
| `PolonRLM setup web` | Prepares the local Python web search helper. |

The built in search reads ordinary public search result pages. It does not use a search API key. Browser automation runs headless and does not reuse a personal browser profile.

## Sessions and agents

| Command | What it does |
| --- | --- |
| `/sessions [text]` | Searches saved conversations for this project. |
| `/new` | Starts a new conversation. |
| `/resume [id]` | Reopens a previous conversation. |
| `/forget <id>` | Removes one saved conversation. |
| `/export <file.md>` | Writes the conversation to a Markdown file. |
| `/agents` | Shows subagents and their current state. |
| `/steer <id> <note>` | Gives an active subagent a short instruction for its next step. |
| `/goal <task>` | Saves a longer goal and continues it across turns. |
| `/goal pause` | Pauses the saved goal. |
| `/goal resume` | Continues a paused goal. |

Subagents share the configured task budget. Token, cost, call, context, output, global-timeout, tool-output, parallel-agent, and background-process caps start unlimited in the app and can be set in `/settings` or `/budget`. Background processes have no default timeout; the global timeout or a per-call timeout can limit them. NVIDIA NIM has a separate long request timeout because its free inference can take several minutes to start. Providers still enforce their own context and output limits, rate limits, and billing. Subagents receive a focused task and project instructions rather than the full conversation history.

## Skills and MCP

`/skills list` shows local agent skills. Other actions include `install`, `enable`, `disable`, `show`, `update`, `remove`, and `create`. Installed skills are disabled by default until reviewed.

`/mcp list` shows configured servers. Use `/mcp add`, then `/mcp connect <name>` to connect a server. Keep server credentials in environment variables and reference their variable names in config.

## Other useful commands

`/status` shows the current session state. `/retry` repeats the last task. `/cancel` stops current work. `/copy` opens the message picker. `/help` lists all commands. `/exit` closes the app.
