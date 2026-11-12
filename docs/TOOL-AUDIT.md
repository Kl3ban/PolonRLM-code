# Tool audit

Reviewed on 2026-11-12 against the current `main` tree (`91e3cbc` plus this audit). This is a deterministic review of the tool surface and its local probes, not a claim that every live website or desktop application behaves identically.

## Result

| Check | Result |
| --- | --- |
| Registered tools in BUILD | **68** |
| JSON Schema checks | **68 / 68 pass** |
| Unique tools exercised by dynamic probes | **53** |
| Dynamic probes | **60 / 60 pass** |
| Tools skipped for external/native prerequisites | **15** |
| Full test suite | **456 tests, 455 pass, 1 native Windows skip** |
| `npm run check`, `npm run build`, `npm run check:package` | pass |

Reproduce:

```sh
npm run audit:tools
```

The machine-readable result is [`tool-audit-report.json`](tool-audit-report.json). It records the schema audit, every probe and the skip reason. Durations are local measurements and vary by machine.

## What the audit found

### Fixed: nested defaults were incorrectly required

`read_files.files[]` required `start` and `lines`, and `search_batch.queries[]` required `path`, `files` and `limit`, even though those fields have Zod defaults. A model that sent only `path` or only `pattern` could be rejected by JSON Schema validation before the handler ran.

The schema fix is in `src/tools/registry.ts`; it now strips defaulted properties recursively, not only at the top level. Regression assertions are in `tests/tools.test.ts`.

### `process_wait` requires a marker by design

`process_wait` waits for a literal output marker, exits, cancellation or timeout. It is not a generic “sleep until exit” call. The audit initially passed only an ID and correctly received a schema error; the probe now sends `{ id, text: '42' }`.

### Schema and catalog checks

- Every tool has a distinct, lowercase name, a non-empty description and a JSON Schema object.
- No JSON Schema marks a property with a default as required, including nested objects and arrays.
- `PLAN`/`REVIEW` omit mutating tools; `BUILD` exposes 68 tools after MCP/plugin tools are added at runtime.
- Dynamic tools still pass normal permission checks; plugin tools are registered from the isolated plugin host.

## Tools exercised dynamically

File reads and aliases, batched reads/searches, directory listing, ripgrep searches, project manifest analysis, project map, TypeScript diagnostics/outline, symbol definition/hover/references/rename preview, AST search/edit, exact edit/write/patch/delete, Git status/diff/log/show/blame/commit, document text reads, plans, shell/PowerShell/tests/Python, process start/list/output/wait/input/stop, checkpoints, transactions, and install/inspect aliases.

## Skipped and why

| Tools | Reason |
| --- | --- |
| `browser`, `browser_automation`, `browser_inspect`, `browser_configure`, `browser_sessions` | Real Playwright browser; covered by `tests/browser-network.test.ts` and `tests/browser-inspection.test.ts`. |
| `computer_use` | Native Windows desktop; the native test is opt-in and skipped on CI without a desktop session. |
| `web_search`, `read_webpage`, `fetch_webpage`, `fetch_documentation`, `download_to_disk`, `github_repo_inspector` | Live network; deterministic local-web fixtures and `tests/web.test.ts` cover parsing, policy and budgets. |
| `lsp_request` | Requires an installed language server; LSP framing is covered by the LSP tests. |
| `ocr_image` | Requires Tesseract and language data on the host. |
| `delegate`, `agent_resume`, `agent_message`, `agent_changes`, `agent_apply` | Require a model run/team; covered by runtime/task-graph tests. |
| `request_tool`, `ask_question`, `get_goal`, `update_goal` | Require an interactive/model permission flow; covered by runtime tests. |
| `search_history` | Requires archived history; covered by history/recall tests. |

Passing local probes do not prove that a remote website, MCP server, browser engine or desktop application is compatible. Those remain external dependencies.

## Cross-harness benchmark

The repository already contains a 50-task coding pack with hidden graders and reference solutions, and [`scripts/compare-harnesses.mjs`](compare-harnesses.mjs) runs the same task prompt and workspace against PolonRLM, OpenCode and Qwen.

The deterministic tool audit is directly comparable across commits and machines. The model-based harness comparison is not reproduced here because the current machine has no shared provider credential: PolonRLM is configured for TeamRouter, while OpenCode has separate stored providers (Nvidia and OpenCode Console). Running those two would compare different models, not harnesses.

Use the same provider and model for a fair run:

```sh
node scripts/compare-harnesses.mjs \
  --harnesses polonrlm,opencode \
  --model <shared-model> \
  --tasks retry-status,group-by,merge-intervals \
  --timeout-ms 600000
```

The script currently expects `GROQ_API_KEY` and an OpenAI-compatible Groq endpoint. A previous run on `openai/gpt-oss-20b` scored PolonRLM 2/3 and OpenCode 3/3; that result predates the browser/context changes and must not be presented as the current benchmark. See [HARNESS-COMPARISON.md](HARNESS-COMPARISON.md).

## Remaining risk

- Browser and desktop tools depend on external engines, websites and window state.
- Local web search depends on remote HTML layouts; CAPTCHA and regional results can break it.
- MCP and plugin tools are added dynamically and are not represented in the static BUILD count above.
- The deterministic audit checks local behavior, not model tool selection or task success.
