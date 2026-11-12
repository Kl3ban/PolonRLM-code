# Harness comparison — PolonRLM, OpenCode, Qwen Code, DeepSeek Harness, Codex, Aider, Pi

Date: 2026-11-11. This document separates **implemented and tested in PolonRLM** from **documented by another project** and from **not implemented**. A capability listed for OpenCode or Qwen Code is not a claim that PolonRLM has it.

Sources:

- OpenCode: [intro](https://opencode.ai/docs/), [CLI](https://opencode.ai/docs/cli/), [agents](https://opencode.ai/docs/agents/), [plugins](https://opencode.ai/docs/plugins/), [tools](https://opencode.ai/docs/tools/), [permissions](https://opencode.ai/docs/permissions/).
- Qwen Code: [tools](https://github.com/QwenLM/qwen-code/blob/main/docs/developers/tools/introduction.md), [subagents](https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/sub-agents.md), [headless](https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/headless.md), [model providers](https://github.com/QwenLM/qwen-code/blob/main/docs/users/configuration/model-providers.md).
- DeepSeek Harness: [README](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md), [SAFETY](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md).
- Groq GPT-OSS 120B: [model page](https://console.groq.com/docs/model/openai/gpt-oss-120b).
- Codex, Aider and Pi: official project documentation, marked below as documentation-only.

## Capability matrix

| Area | PolonRLM (current code) | OpenCode v2.1.1 | Qwen Code | DeepSeek Harness |
| --- | --- | --- | --- | --- |
| File read/search | `read_file`, `read_files`, `search_files`, `search_content`, `search_batch`, `project_map`; tested | File tools, glob/grep, LSP integration; docs | `read_file`, `glob`, `grep_search`, `list_directory`, `notebook_edit`; docs | `read`, `glob`, `grep`; implemented in current profile |
| Editing | Exact text edit, patch, delete, AST edit, TypeScript rename; tested | Edit/write/patch; docs | `write_file`, `edit` with multi-stage correction, notebook edit; docs | `write`, `edit`; implemented |
| Shell and PTY | `execute_command`, PowerShell, Python, `run_tests`, background jobs, real PTY option; tested | Shell tool; docs | `run_shell_command`, `monitor`; docs | `pwsh` + background jobs; implemented |
| Git | `git_status/diff/log/show/blame/commit`; tested | Via shell / project snapshot features; docs | Via shell (`run_shell_command`); no dedicated Git tool in tool reference | Via `pwsh`; no dedicated Git tool |
| LSP / diagnostics | `lsp_request`, TypeScript diagnostics, outline, AST; tested | LSP integration documented | Experimental LSP tool, diagnostics, code actions; docs | Not in current tool list |
| Web / browser | Web search without API key, fetch, downloads, headless browser sessions; tested | Web search, MCP, browser integration; docs | `web_fetch`, `web_search` (provider-backed), browser/computer use; docs | `web_search`, `web_fetch`; implemented |
| Images / documents | Image attachments, PDF/DOCX/XLSX reading, OCR; tested | Attachments; docs | Images, PDFs, media, notebook reading; docs | `read_image`, Office skills; implemented |
| Permissions / sandbox | Approval rules, per-tool policies, OS sandbox when SRT/Seatbelt/Bubblewrap is available; sandbox currently unprovisioned on this Windows machine | Permission/policy system; docs | Approval modes, Docker/macOS sandbox; docs | Approval/sandbox controls; safety notice says no security audit |
| Subagents | Isolated copies, task graph, atomic apply, persisted runs, transcript-aware resume; tested | Agents/subagents; docs | Named subagents, fork context, background continuation, team/worktree features; docs | `subagent`/`subagent_fork`, workflow; implemented |
| Planning / goals | `/goal`, persistent plan, task graph; tested | Agents/commands; docs | `/goal`, todo, plan mode; docs | `goal`, `schedule`, `todo_write`; implemented |
| History / context | SQLite history, local compaction, requirements/blockers retention, archive search; tested | Compaction/snapshots; docs | Compression, memory, session continuation; docs | Session log/compaction; implemented |
| Plugins / MCP | MCP, lifecycle-hook plugin SDK, skills; tested but plugins cannot register tools | Plugins, MCP, skills; docs | MCP, extensions, hooks, skills, channels; docs | Everything-is-a-plugin Cordis architecture; development preview |
| Verification / recovery | `/verify`, impact analysis, reproduction command, recovery journal, checkpoints; tested | Snapshots; docs | Approval and tests; no equivalent named verification engine in tool docs | Not a built-in verification engine |
| Benchmark / comparison | 50-task local pack target, hidden graders, harness matrix; this work | Not a built-in benchmark | Not a built-in benchmark | Not a built-in benchmark |
| Interfaces | Terminal TUI, local web tooling, no desktop GUI | CLI, desktop app, web, ACP, Docker | CLI, VS Code/Zed/JetBrains, headless, daemon, SDKs, channels | CLI, web UI, desktop |

## Live comparison protocol

The live comparison uses the same Groq model (`openai/gpt-oss-120b`), the same task prompt, the same starter workspace and the same hidden grader. Harnesses are run in separate temporary copies. PolonRLM runs through its `Controller`; OpenCode runs with `opencode run --standalone`; Qwen Code is attempted in headless mode with an isolated `USERPROFILE` and Groq OpenAI-compatible settings. A harness that cannot run is recorded as `not run` with the concrete error, never as a pass.

Live results are stored in `docs/harness-live-report.json` (ignored by Git because it is machine-local evidence). The report records task, harness, pass/fail, duration, and token usage where the harness exposes it.

### Same-model result — 2026-11-12

Model: `nvidia/nemotron-3.5-lightning:free` via OpenRouter for both harnesses. Same prompt, starter workspace and hidden grader. One run per task. Details: [TOOL-BENCHMARK.md](TOOL-BENCHMARK.md).

| Task | PolonRLM | OpenCode |
| --- | --- | --- |
| `retry-status` | PASS — 21.3 s | FAIL — 77.4 s; grader 1/2 |
| `group-by` | PASS — 39.4 s | PASS — 21.6 s |
| `merge-intervals` | PASS — 51.0 s | PASS — 66.2 s |
| Score | **3/3** | **2/3** |
| Total wall time | 111.7 s | 165.2 s |

This is a small, single-run smoke test with a free model, not evidence of parity or superiority. Raw results: [`harness-shared-report.json`](harness-shared-report.json).

### Historical live result — 2026-11-11

Model: `openai/gpt-oss-20b` via Groq, `reasoning_effort=low`. One run per harness/task, same prompt and starter, hidden grader. This is a smoke test, not a ranking. The 120B run earlier hit Groq's 200,000 TPD limit; the 20B model has a separate allowance.

| Task | PolonRLM (observed) | OpenCode v2.1.1 |
| --- | --- | --- |
| `retry-status` | PASS twice — 35.3 s / 42.4 s | PASS — 163.9 s |
| `group-by` | PASS after the tool-schema fix — 112.1 s; failed before it | PASS — 210.2 s |
| `merge-intervals` | PASS in the first run — 125.8 s; the latest run hit Groq HTTP 429 | PASS — 281.0 s |

PolonRLM: **2/3 in both three-task runs**. OpenCode: **3/3** in its run. The two PolonRLM failures had different causes: the first was a tool-call schema rejection (`read_file` default fields were incorrectly required), fixed; the second was an upstream HTTP 429 after the preceding tasks. No task failed for a logic reason after the schema fix.

PolonRLM reported 7.3–7.7k input tokens for `retry-status`, 7.5k for the passing `group-by`, and 14.6k for `merge-intervals`; `costKnown=false`. The result shows that the same model can behave differently in two harnesses, but three tasks and one run are far too little to claim a general advantage.

Qwen Code 0.27.2 was installed in a temporary prefix. A text-only probe through Groq passed in safe mode (4,586 input / 41 output tokens). The benchmark attempt failed at the provider boundary: Groq returned HTTP 400 because Qwen sent an assistant `reasoning_content` property that the endpoint rejects; earlier attempts also hit the 8,000 TPM limit and a Windows file-watcher crash. Qwen Code is therefore **not run** on the benchmark tasks; the table must not be read as a Qwen result.

## Real gaps after this work

1. **Exact subagent session restore**: PolonRLM persists a bounded transcript and can resume with it, but it does not restore the deleted worktree or unapplied diff. Qwen Code retains background-agent state and can continue completed agents; OpenCode has session/agent infrastructure.
2. **Background agent notifications**: Qwen Code can run named agents in the background and deliver completion notifications. PolonRLM subagents are synchronous within a task.
3. **Formatters, references, snapshots, policies**: OpenCode documents these as first-class configuration surfaces. PolonRLM has checkpoints/recovery but not a formatter pipeline or reference index.
4. **Product surfaces**: Qwen Code and OpenCode expose more ready-made product integrations (GUI/IDE/daemon). PolonRLM now has a typed SDK, HTTP/SSE server and ACP adapter, but no bundled GUI and no ACP permission-rich load/mode surface.
5. **Plugin tools**: PolonRLM now registers plugin tools and runs plugin activation, hooks and tools in a host process; it still lacks a plugin UI extension surface.
6. **Sandbox provisioning and coverage**: SRT is installed on this machine but cannot launch from the mapped `C:` workspace; Docker is unavailable because the host's Workstation/SMB services are disabled. `required` mode therefore fails closed for unisolated browser, desktop, MCP and file actions, and host fallback remains the behaviour in `auto`.
7. **Notebook and media breadth**: Qwen Code documents notebook editing, PDF/media handling and computer use. PolonRLM has text/PDF/DOCX/XLSX and images, not notebook editing or audio/video.
8. **Code index**: PolonRLM caps source indexing and uses best-effort non-JS parsers. It does not have BM25/vector search or monorepo-sharded indexes.
9. **Benchmark scale**: PolonRLM now has a larger local pack, but it is not a public SWE-bench-style comparison and does not prove parity with any harness.
10. **Prompt-cache and local-model optimisation**: Qwen Code and OpenCode document provider/caching features; PolonRLM tracks cached usage but does not optimise prompt prefixes per provider.

## What PolonRLM does better or differently

- One repository with built-in Git, AST/LSP, checkpoints, durable recovery, `/verify` evidence and a task-graph subagent model, rather than relying on shell or plugins for all of it.
- Local web search without a paid search API key, plus browser egress controls.
- Explicit Windows desktop automation and a local web research worker.
- A small, readable TypeScript codebase with CI on Windows, Ubuntu and macOS.

These are architectural choices, not proof of better coding results. The live matrix is deliberately small and should not be presented as a ranking.
