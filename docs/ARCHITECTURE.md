# PolonRLM architecture

The terminal app is built with TypeScript, Node.js 24, and Ink. It does not need WSL or an HTTP server. Ink provides the React-based terminal renderer while keeping the number of native dependencies low on Windows. OpenTUI was considered, but its development workflow requires Bun, while this project already uses Node.js. See [Ink](https://github.com/vadimdemedes/ink) and [OpenTUI](https://github.com/anomalyco/opentui).

## Modules

- `src/core/types.ts`: provider, message, tool, permission, and UI contracts.
- `src/core/runtime.ts`: model and tool loop, budgets, delegation, and fallback handling.
- `src/core/agent-team.ts`: bounded in-memory messages between active subagents and user steering.
- `src/core/cortex.ts`: task complexity and subagent policy without extra mandatory model calls.
- `src/core/context.ts`: conservative token estimate and local extractive compaction with fact scoring, source labels, and intact tool-call boundaries.
- `src/core/verification.ts`: project check discovery, file hashes, persisted evidence formatting, and verification history.
- `src/core/controller.ts`: app session and renderer-independent commands.
- `src/core/config.ts`: validated configuration saved atomically.
- `src/core/store.ts`: SQLite history, working context, notes, usage, and event log.
- `src/core/secrets.ts`: Windows DPAPI, secret redaction, and stream filtering.
- `src/core/permissions.ts`: permission modes, allowlist, denylist, and approval flow.
- `src/providers/provider.ts`: Vercel AI SDK adapter and endpoint discovery.
- `src/tools`: argument validation, files, commands, Git, networking, and Playwright.
- `src/integrations`: Agent Skills and MCP.
- `src/ui`: terminal renderer and Markdown output.
- `src/ui/design.ts`: colors, block logo, and width scaling.
- `src/ui/menu.tsx`: filtered command palette, provider and model lists, without an extra model call.
- `src/cli.ts`: interactive UI, setup, run mode, diagnostics, and NDJSON output.

The Vercel AI SDK handles streaming and model protocols. Execa runs subprocesses with timeouts and cancellation. Zod validates tool arguments. Each layer uses one main library rather than several libraries for the same job. See [AI SDK](https://github.com/vercel/ai) and [Execa](https://github.com/sindresorhus/execa).

## Request flow

The controller accepts a message, stores it in SQLite, and starts the runtime. The runtime selects a small tool catalog and relevant skills, prepares context, reserves the shared budget, and calls the model. Tool calls are validated and checked against permissions. Their results are returned to the model. The task ends when the model has no more tool calls to make.

Subagents use the same loop with a separate, short conversation. They share tools, the event log, and the task budget, but do not receive the full main conversation. Members of one team can send brief messages through a bounded in-memory mailbox. A recipient reads a message before its next model call. If the recipient has already finished, the coordinator receives the message with the result. Messages are untrusted information, do not grant permissions, and count toward the budget. Subagents use separate project copies. File tools serialize writes in a workspace and check for file changes while waiting for approval. This does not isolate concurrent shell commands, so delegated tasks should work in separate areas.

While a team is active, the user can steer one agent with `/steer <id> <message>`. The message goes through the same mailbox and is treated as a current user instruction.

## History and resume

The full conversation remains in `messages`. Compacted context is stored separately with the ID of the last included message. New messages are appended when context is read. Automatic compaction preserves the current request and recent tool-call groups, then ranks older facts by requirements, progress, results, and blockers. It does not call a model to write a summary. If a detail is missing, `search_history` finds a few short excerpts in the SQLite archive. Interrupted tool calls receive an explicit interruption result before the next model call. The app does not automatically rerun a command after a crash.

File undo keeps originals in process memory. After a restart, conversation history and the event log remain, but `/undo` cannot restore changes from the earlier process. Registered secrets are removed from messages and logs. This is a filter, not a complete scanner for every possible secret.

The name change from JanuszGPT to PolonRLM uses a copy-based migration. The new data directory receives configuration, keys, skills, and a consistent SQLite backup. The old directory remains available for rollback. Migration never overwrites an existing destination.

## Integrations and trust

The MCP client uses the lockfile-pinned `@modelcontextprotocol/sdk` 1.x line. It supports stdio and Streamable HTTP through the official SDK. Skills use `SKILL.md` with YAML metadata and are treated as lower-trust instructions. See [MCP SDK 1.x](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x), [Agent Skills](https://agentskills.io/specification), and [Anthropic Skills](https://github.com/anthropics/skills).

OpenCode, Pi, and Hermes informed the review of terminal workflows, separate runtimes, extensions, and context management. Their source code was not copied into the engine. Browser automation uses [Playwright](https://github.com/microsoft/playwright).

## Future desktop UI

A future `.exe` could use `UIController`, runtime events, or `PolonRLM run --json`. The terminal renderer is not needed to execute tasks. A GUI framework or native Rust/C++ module should be chosen based on interface needs and measurements. There is no separate GUI or Grok Bot module today.

## Licensing

PolonRLM code is licensed under MIT. Direct dependencies have their own licenses in the npm packages, and the lockfile pins the versions used. External skills retain their own licenses and are not part of PolonRLM's MIT license.
