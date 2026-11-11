# Tools

Local web tools run on demand: `web_search`, `read_webpage`, `download_to_disk`, and `github_repo_inspector`. They do not use a search API or search key. Setup, schemas, limits, and examples are in [LOCAL-WEB.md](LOCAL-WEB.md).

Run `/tools` or `/tools <filter>` in the terminal to see the current catalog for the selected mode and permissions. The agent uses `discover_tools` to load additional schemas when needed. If a tool is blocked and the user explicitly wants that action, the model can ask for one-time approval with `request_tool`. The approval prompt shows the exact arguments. Approval runs that call only; a rejected request is not retried.

Task-relevant MCP schemas are preloaded when the request clearly names a connected server and matching tool. Other MCP schemas load only when `discover_tools` finds them by server or tool name. This keeps unrelated integrations out of provider requests without adding a discovery turn for obvious requests. MCP calls still use their normal permission checks and external-action approvals.

Subagent roles can have strict tool allowlists with `/settings agentToolProfiles {"reviewer":["read_file","search_files"]}`. Unset roles keep the normal catalog. An empty list disables all tools for that role. The runtime filters advertised and discovered tools and rejects calls outside the profile. This controls tool access inside PolonRLM; it complements the separate OS sandbox in [SANDBOX.md](SANDBOX.md).

Use `/permissions` to manage tool access. With no argument, it shows effective rules. `/permissions <tool> ask|auto|off` sets a per-tool rule, and `default` removes that override. `/permissions all` permanently approves every tool without asking. This includes the terminal, desktop, browser, and MCP tools, and overrides PLAN, REVIEW, and readonly restrictions. `/permissions reset` restores the safer `ask` mode and removes overrides. A per-tool `auto` rule still respects PLAN, REVIEW, and readonly restrictions. A per-tool `off` rule also blocks one-time approval requests.

## Development and project tools

`computer_use` uses coordinates from a window screenshot rather than the whole desktop. Its output includes the image size, coordinate ranges, and the latest `snapshotId`. Each successful action requires the new ID returned by that action. Invalid arguments keep the current snapshot; a Windows execution error requires a fresh `observe`. When an app does not expose editable accessibility elements, such as Discord, the model can use the screenshot or grid to click and then call `type` with a `text` field.

| Use | Tools |
| --- | --- |
| Batch file reading and search | `read_files`, `search_batch` (both normally run up to four independent operations at once and preserve input order; searches with explicit approval run serially) |
| Background processes and stdin | `process_start`, `process_list`, `process_output`, `process_wait`, `process_input`, `process_stop` |
| File checkpoints | `checkpoint_create`, `checkpoint_list`, `checkpoint_diff`, `checkpoint_restore`, `checkpoint_drop`; encrypted and persistent across restarts |
| TypeScript and JavaScript analysis | `code_diagnostics`, `code_outline`, `symbol_definition`, `symbol_references`, `symbol_hover`, `rename_symbol` |
| On-demand project architecture map | `project_map` (local file inventory, JS/TS import graph and exports, best-effort top-level symbols/imports for Python, Go and Rust, plus safe manifest summaries; validates cached entries with content hashes and reparses changed files) |
| Structural search and edits | `ast_search`, `ast_edit` |
| Other language servers | `lsp_request` |
| Git history | `git_log`, `git_show`, `git_blame` |
| Task plan | `plan_update`, `plan_status` |
| Stateful browser | `browser`, `browser_sessions` |
| Documents and OCR | `read_document`, `ocr_image` |
| Grouped file changes | `transaction_begin`, `transaction_status`, `transaction_commit`, `transaction_rollback`; durable journal supports `/recover`, `/history changes`, and `/rollback` |

When a provider returns two to four independent file, search, project, or Git reads in one response, PolonRLM runs them concurrently and keeps their results in call order. Explicit approval rules, repeated or previously failed calls, writes, browser actions, and stateful tools stay sequential. This reduces waiting time; it does not reduce provider token billing by itself.

Example requests:

~~~text
Find this function's definition and all references. Rename it semantically.
Create a file checkpoint before editing, then show the diff.
Run the tests in the background and check their result.
Find calls to this function in the AST and update the selected node.
Check the Git history and find who changed these lines.
~~~

## Other capabilities

The current set also includes file reading, writing, exact replacements, patches, and deletes; ripgrep; project and dependency inspection; terminal, PowerShell, Python, and test commands; Git status, diff, and commit; web search and downloads; headless Playwright Chromium, Chrome, Edge, Brave, and Firefox; and Windows `computer_use`. Choose browser engines in `/settings`. Auto tries available installs. Playwright Chromium or Firefox is downloaded to its cache on first use if needed. Browser automation does not use a signed-in user profile. The runtime also supports subagents and MCP tools. `/image` attaches an image to the next task for a model that supports images.

`browser` keeps cookies and tabs between calls for up to 30 minutes of inactivity, with up to 3 sessions and 8 tabs per session. It supports navigation, history, page reading, link and form-field lists, clicks, typing, option selection, screenshots for vision models, and recent console and network error inspection. `console` and `network` return at most 30 recent entries by default, with a maximum of 50; console text is clipped and redacted, and URLs omit query strings, fragments, and credentials. Network diagnostics include failed requests and HTTP responses with status 400 or higher, without headers or response bodies. Each action follows browser permission rules. Local addresses are blocked, WebSockets and service workers are disabled, and file downloads are blocked. Expired sessions are closed when another browser operation runs. Sessions stay in memory and close when the app exits.

Subagents work in separate copies under the system temporary directory. Snapshots follow `.gitignore` and related ignore rules, and omit common local credential files. They do not receive conversation history, MCP, project memory, API keys from the process environment, or `computer_use`. Members of the same team can send short messages through `agent_message`. Recipients receive them at the next step, and unread messages are returned to the coordinator with the results. The mailbox exists only for the current team, with up to 4 messages per agent and 24 messages total. Messages are limited to 700 characters and sanitized. Delivered messages use the shared token budget. Subagents do not share the conversation or files. Review results with `agent_changes`; `agent_apply` checks every selected base version, then applies the set while serializing workspace writes and requesting normal approvals. If a write fails, is denied, or is cancelled, earlier writes are rolled back in reverse order. If a file changed outside PolonRLM during that rollback, the external edit is preserved and the incomplete merge is reported. Proposals stay in process memory, up to 20 change sets, and can be reviewed after the agent finishes. This is a project copy, not a strict OS sandbox. Subagent shell, Python and LSP calls follow the OS sandbox mode; on Windows, temporary copies require an approved host fallback in auto mode and are refused in required mode.

The user can steer an agent during work with `/steer <id> <message>`. The ID is shown in the Alt+A panel. A steering message is delivered at the next step without interrupting the current model call. If the agent finishes first, the coordinator receives the message. Limits are 4 messages per agent and 700 characters per message.

`delegate` also accepts task IDs and `dependsOn` IDs to run a dependency graph. It starts independent nodes in parallel up to `maxAgents`, then starts later nodes only after every prerequisite succeeded. Each wave gets a fresh isolated copy; successful changes from completed waves are staged into later copies, while same-wave siblings never see each other's work. Prerequisite outputs are included as untrusted context. Conflicting file changes fail the conflicting node and skip nodes that depend on it. No graph changes reach the project until the model reviews the combined diff with `agent_changes` and applies selected paths with `agent_apply` using the returned `graphId`.

Example delegation payload:

~~~json
{
  "tasks": [
    { "id": "analysis", "role": "researcher", "task": "Inspect the API contract and report the required interface." },
    { "id": "backend", "dependsOn": ["analysis"], "role": "coder", "task": "Implement the backend against the analyzed contract." },
    { "id": "frontend", "dependsOn": ["analysis"], "role": "coder", "task": "Implement the frontend against the analyzed contract." },
    { "id": "integration", "dependsOn": ["backend", "frontend"], "role": "tester", "task": "Review the combined implementation and run relevant checks." }
  ]
}
~~~

Legacy delegation payloads without IDs or dependencies keep the existing independent-batch result format.

`read_document` reads PDF, DOCX, XLSX, and common text formats. It does not run macros or formulas. PDF pages and spreadsheet row ranges can be selected. A scanned PDF without a text layer must first be converted to an image. `ocr_image` uses local Tesseract when installed and recognizes Polish and English.

Transactions group file-tool changes in the durable project journal. `transaction_rollback` reverts them in reverse order after checking current contents and requesting the normal approvals. A transaction left open by a crash appears in `/recover`; PolonRLM never reruns its shell commands. Processes started with `interactive=true` accept input through a pipe with `process_input`; they do not emulate a PTY, so tools that require a real terminal may not work.

## Requirements and limits

- Search and semantic indexing use the ripgrep binary bundled for the current platform; no system `rg` install is needed. Git and Python require their own executables. Choose a browser in `/settings`. Auto checks available installs and downloads Chromium or Firefox only if needed. Chrome and Edge use Playwright channels; Brave uses a detected executable. If installation fails, the error includes the manual command `npx playwright install chromium` or `npx playwright install firefox`.
- Built-in semantic and AST tools support TS/JS. The index is limited to 500 files and 20 MB and skips dependencies in `node_modules`. It reads local `compilerOptions`, without loading plugins or extending `tsconfig`. Missing dependency types can cause unknown-module diagnostics.
- `project_map` is read-only and local. It returns file/module metadata only, never source text or manifest script bodies. Its SQLite cache stores file metadata, SHA-256 content hashes, and parsed summaries, not source contents. It re-reads eligible files to validate their hashes, reparses only changed files, and accepts `refresh: true` to force a full reparse. It skips credential-like paths and generated/dependency folders, indexes at most 300 JS/TS, Python, Go or Rust files and 15 MB per call, and caps symbols at 16 per file and 600 total. The response also caps imports at 12 per module and 800 total, and exports at 20 per module and 1,200 total. JS/TS uses the TypeScript parser for import edges and exports. Python, Go and Rust symbol/import extraction is best-effort line-based indexing, not a compiler-grade parse or complete dependency resolver. Partial maps are marked as truncated.
- `lsp_request` runs the selected, already-installed stdio server for the operation. It supports hover, definitions, implementations, type definitions, references, document/workspace symbols, call hierarchy, and diagnostics. Workspace symbol search needs only a query. Incoming/outgoing call queries prepare and inspect the selected symbol within one server session. It uses OS isolation when available and asks before host fallback. It does not install language servers. Missing diagnostics are reported explicitly.
- PDF.js, Mammoth, and ExcelJS are included for supported documents. OCR requires a separate Tesseract install and its `pol`/`eng` language data.
- Checkpoints are encrypted in the project-local journal and persist across restarts. There is no checkpoint-count or total-size cap; each file must be a supported text file up to 5 MB. Restore requires the current hashes from `checkpoint_diff`. Session task plans also persist in SQLite and can be read with `plan_status` after restart. An active `/goal` receives a short done/total count and current-step summary; this is planning metadata, not proof that work is complete.
- Semantic rename reports partial progress if a filesystem write fails. A multi-file checkpoint restore is grouped, journals each write, and compensates earlier writes if a later file fails; external changes are preserved and reported as conflicts. It cannot make unrelated shell commands transactional.
- Background processes use OS isolation when available and ask before host fallback. Time and output limits default to unlimited; configured global limits apply. Cancelling a task or closing the app stops jobs started through this mechanism. `process_stop` does not accept an arbitrary PID.
- PLAN and REVIEW block project writes and program execution. `computer_use` is available in every mode, but each desktop action needs separate approval. Permissions still apply after a tool is discovered.

Tool integration tests live in `tests/advanced.test.ts`. The regular suite does not open desktop control windows. The native desktop test is disabled by default.
