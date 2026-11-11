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
| `/fallback` | Shows the configured fallback order and provider IDs. |
| `/fallback google openrouter` | Tries Google, then OpenRouter if the selected provider fails. |
| `/fallback none` | Clears the fallback list. |
| `/key <secret>` | Stores a provider key in the local secret vault. Never put a real key in a script or commit. |
| `/models [provider]` | Fetches models exposed by the selected or named provider without switching providers. |
| `/model <id>` | Changes the active model without restarting. |
| `/route` | Shows the model route used by the orchestrator and each subagent role. |
| `/route reviewer google gemini-3.5-flash` | Routes reviewer calls through Google using the given model ID. |
| `/route reviewer default` | Removes the reviewer override and uses the main model again. |
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
| `/settings verificationMode <value>` | Use `after_changes` (default) to run checks after BUILD changes files, or `manual` to run them only with `/verify`. Automatic checks still use normal approval and sandbox rules. |
| `/settings verificationRepairAttempts <number>` | Sets 0 to 3 model repair attempts after automatic checks fail. Default is `1`; `0` reports failures without asking the model to edit files. Repair uses the same task budget. |
| `/settings fallback ["google", "openrouter"]` | Sets ordered fallback providers. Provider IDs must already exist in the configuration. |
| `/settings modelRoutes {"reviewer":{"provider":"google","model":"gemini-3.5-flash"}}` | Sets role-specific provider and optional model IDs. |
| `/settings modelRoleBudgets {"coder":{"maxTokens":50000,"maxCost":1,"maxCalls":30}}` | Sets optional per-role caps shared across agents of that role. Omitted values and 0 are unlimited. They remain inside the task-wide budget; cost caps need provider pricing to be known. |
| `/timeline [count]` | Shows recent model requests, tool outcomes, and saved verification evidence for this chat. It does not show full prompts or tool arguments. |
| `/sandbox status` | Checks the OS command sandbox and shows its current mode, readiness, execution path, and network allowlist. |
| `/sandbox on` | Enables required isolation after verifying that the backend is ready. Refuses and explains what is missing when it is not. |
| `/sandbox off` | Disables OS isolation; commands run on the host under the normal permission policy. |
| `/sandbox auto` | Uses the OS backend when ready and falls back to host execution under the normal permission policy when it is not. |
| `/sandbox docker` | Uses an explicitly pulled Linux Docker image with no network and only the project mounted. Requires Docker. |
| `/sandbox setup docker` | Pulls `sandboxDockerImage` and enables Docker mode. Downloads the image only on this explicit command. |
| `/sandbox setup` | Previews the Windows sandbox system changes. Nothing runs yet. |
| `/sandbox setup confirm` | Explicitly starts the Windows installer, skips user-profile read access, verifies readiness, and enables required isolation. Windows will ask for administrator approval. |
| `/budget <tokens> <USD>` | Sets limits for the next task. Use `infinity` for no token or cost cap. |
| `/cortex 0..5` | Sets the maximum work level. Adaptive mode may choose a lower strategy for simple tasks. |
| `/settings cortexStrategy adaptive\|fixed` | Adaptive lowers delegation for simple tasks without adding a hard call limit. Fixed always uses the selected `/cortex` level. |
| `/settings repeatFailureThreshold 3` | Warns the agent after the same tool or test failure repeats three times. A successful project change or passing test resets the counter. Set `0` to disable. |
| `/settings agentToolProfiles {"reviewer":["read_file","search_files"]}` | Restricts that subagent role to the listed tools. Omitted roles keep the normal tool set; an empty list disables tools for that role. |
| `/verify` | Runs configured or detected checks, gathers diagnostics for changed TypeScript/JavaScript files and their direct or transitive importers, and records file hashes and exit codes. If a reproduction command is saved, it runs first as the `reproduction` check. |
| `/verify reproduce <command>` | Runs a command that demonstrates the reported bug through the normal shell permission and sandbox rules, then saves its exit code and bounded output. A later `/verify` reruns it; a baseline that already exited 0 is reported as incomplete evidence rather than a fix. |
| `/verify <command>` | Runs one explicit project command through the normal shell approval rules. |
| `/verify repair [attempts]` | After a failed check, asks the selected model to repair the reported failure, then independently reruns verification. Defaults to one repair attempt; accepts 1 to 3. Repair calls share the same token, cost, model-call, and role budgets; tool calls still follow normal permissions and approvals. |
| `/verify history [count]` | Shows saved verification reports for this chat. |
| `/verify report <id>` | Opens the full evidence report using its ID from `/verify history`. |

The runtime also detects repeated two to eight step tool sequences with matching arguments and results. It warns after the same cycle repeats twice, then stops if that cycle returns again without a recorded project change or passing test. It uses local fingerprints and does not make an extra model call.

Shell, Python, background-process and LSP commands use OS isolation when available. In `auto` mode an unavailable backend is reported and host execution follows the configured permission policy; `/permissions all` intentionally bypasses prompts. `required` mode blocks the command instead of falling back. See [SANDBOX.md](SANDBOX.md) and `/sandbox status`.

With no configured verification commands, `/verify` detects standard scripts in `package.json`, Cargo, Go, Python, .NET, Gradle, or Maven manifests. Detection does not install dependencies. A passing command is evidence for that command only; it does not prove correctness against hidden tests or guarantee that every project change is covered. When changed TypeScript/JavaScript files are present, the report also includes bounded reverse-import dependents from `project_map` so diagnostics and hashes cover code that imports the change. `/verify reproduce` stores an explicit reproduction command; the controller reruns it during verification and reports `incomplete` when the command already passed before the change.

## Files, images and research

| Command | What it does |
| --- | --- |
| `/tools` | Lists available tools. Add a word to filter the list. |
| `/image <path>` | Adds an image to the next task for a vision capable model. |
| `/image clear` | Removes images waiting to be sent. |
| `/undo` | Safely reverts the latest file change or complete change group, including changes from a previous run. |
| `/history changes [count]` | Lists saved file changes. Snapshots are encrypted in local app data. |
| `/recover` | Shows unfinished groups and conflicts after an interrupted write. |
| `/rollback <id>` | Reverts a saved change or its complete group after checking current file hashes. |
| `/recover rollback <id>` | Recovers an unfinished transaction, atomic group, or single pending change. Files changed outside PolonRLM are kept and reported as conflicts. |
| `checkpoint_create` and related tools | Save, list, compare, restore, or remove project checkpoints. They are encrypted and persist across restarts. |
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
| `/plugins list` | Shows configured plugins and whether they are active. |
| `/plugins create <id>` | Creates a disabled plugin starter in the user config folder. |
| `/plugins show <id>` | Shows the plugin manifest and current approval hash. |
| `/plugins enable <id>` | Prints the source path and hash to review. Does not run code. |
| `/plugins enable <id> confirm` | Runs the reviewed version and pins its current SHA-256 hash. |
| `/plugins disable <id>` | Stops a plugin and keeps its files for later. |
| `/plugins remove <id>` | Removes its PolonRLM config entry; leaves the source files on disk. |
| `/agents` | Shows active subagents, recent persisted runs, and their states. The model can continue a saved run from its persisted result with `agent_resume`. |
| `/steer <id> <note>` | Gives an active subagent a short instruction for its next step. |
| `/goal <task>` | Saves a longer goal and continues it across turns. |
| `/goal pause` | Pauses the saved goal. |
| `/goal resume` | Continues a paused goal. |

Subagents share the configured task budget. Token, cost, call, context, output, global-timeout, tool-output, parallel-agent, and background-process caps start unlimited in the app and can be set in `/settings` or `/budget`. Background processes have no default timeout; the global timeout or a per-call timeout can limit them. NVIDIA NIM has a separate long request timeout because its free inference can take several minutes to start; set `/settings provider.requestTimeoutMs 0` to inherit the global timeout. Providers still enforce their own context and output limits, rate limits, and billing. Subagents receive a focused task and project instructions rather than the full conversation history.

## Skills and MCP

`/skills list` shows local agent skills. Other actions include `install`, `enable`, `disable`, `show`, `update`, `remove`, and `create`. Installed skills are disabled by default until reviewed.

`/mcp list` shows configured servers. Use `/mcp add`, then `/mcp connect <name>` to connect a server. Keep server credentials in environment variables and reference their variable names in config.

Custom local plugins use `/plugins`. They run trusted JavaScript with the current user's full operating-system permissions. Read and understand `index.mjs` before confirming it. PolonRLM checks the manifest and source hash at startup; changed files do not run until reviewed and confirmed again. This hash check is not an OS sandbox. See the [Plugin SDK guide](PLUGIN-SDK.md).

## Other useful commands

`/status` shows the current session state. `/retry` repeats the last task. `/cancel` stops current work. `/copy` opens the message picker. `/help` lists all commands. `/exit` closes the app.
