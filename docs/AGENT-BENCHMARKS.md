# Agent benchmarks

## Task success benchmark

`PolonRLM benchmark run` sends real requests to the configured provider and runs the default task pack in `benchmarks/default`. Narrow a run with `--case <id>`. Select a provider or model with `--provider <id>` and `--model <id>`, pass another trusted pack with `--task-pack <path>`, or select a harness with `--profile single|adaptive|fixed`. `npm run bench:agent -- --case retry-delay` builds the CLI and runs one case.

The default `single` profile disables Cortex delegation and uses one model. `adaptive` and `fixed` both allow up to three subagents at one level, with Cortex 5; the difference is whether Cortex scales effort to the task or always uses the selected level. These two profiles can make substantially more provider requests, so they are opt-in. Compare profiles with the same provider, model, and task pack. Benchmark runs ignore saved per-role model routes so every agent uses the selected model; normal permission and tool restrictions still apply. Each report records the profile and its effective Cortex and delegation limits.

Every run is saved to `benchmark-reports/runs/` with a unique filename; `agent-benchmark-latest.json` remains the latest-run shortcut. Compare saved reports without sending model requests: `PolonRLM benchmark compare <run-a.json> <run-b.json>`. The comparison shows pass rate, duration, input/output tokens, known cost, and tool errors for each run.

Run a sequential comparison with `PolonRLM benchmark matrix --models <model-a,model-b> [--provider <id>] [--profiles single,adaptive,fixed] [--case <id>] [--task-pack <path>]`. For models from different configured providers, use `--targets <provider=model,provider=model>`, for example `--targets qwen=qwen-flash,openrouter=meta/llama-free`; do not also pass `--provider`. If `--profiles` is omitted, it runs only `single`; each model/profile combination runs the selected task pack and sends real requests. Use the same task pack and case when comparing. The matrix prints a comparison table from the saved run reports, stops if a run does not complete, and prints paths that can be passed to `benchmark compare` later. It does not discover model IDs automatically.

The runner uses a temporary config and session database. It never writes to the user's saved provider settings or chat history. It uses the selected provider only, with no fallback. The model works in a fresh task copy; the hidden grader is outside that workspace. Scratch files live in the user profile so the OS sandbox's profile read-deny also covers the grader, even if Windows `TEMP` points elsewhere. Each sandbox opens only its own task or grader workspace. Before the first API request, every task and grader sandbox must report ready and every starter must fail its grader. If a check fails, the suite stops without asking the provider. Shell and code execution require OS isolation; network access, browser/computer tools, and MCP are excluded in all profiles. Only `single` excludes subagents. The runner refuses to start a profile if a required tool is disabled by the user's permissions.

Each task has its own timeout, default ten minutes, with a 15-minute maximum. Each local report records pass/fail, duration, token usage, known cost, tool counts, and test summary. It does not store prompts, model replies, tool arguments, or API keys. A failed provider request stops the remaining cases to avoid repeated calls.

The default pack has fifty JavaScript harness tasks: single-file algorithms and validation, multi-file module tasks, asynchronous/concurrency tasks, and the existing regression cases. Every default task now has a `reference/` solution, and the test suite validates that the starter fails and the reference passes. Repository-backed cases cover two pinned `sindresorhus/yocto-queue` regressions and a documentation fix from `sindresorhus/p-limit`: tail-reference retention, `drain()` stopping at an `undefined` entry, and a warning about recursive limiter deadlocks. Run a case with `PolonRLM benchmark run --task-pack <pack-path> --case <case-id>`. The `yocto-queue` cases install locked dependencies with lifecycle scripts disabled and only `registry.npmjs.org` allowed; the `p-limit` documentation case needs no dependency setup. These three cases span only two repositories, so they are still too small to claim broad repository-level performance or model parity. Pack provenance and licenses are in the README files under [`benchmarks/real`](../benchmarks/real/). The grader submission keeps only dependencies prepared from the original task before the model request, so model-added dependencies are not installed.

## Existing checks

`npm run bench` runs a local synthetic check for prompt-size estimates and context compaction. Its byte-based token estimate is a comparison signal, not provider billing data.

`npm run bench:live` runs tool-review cases through the selected model against a disposable workspace. It records each model request's first-text-token and total latency, and checkpoints progress to a redacted, local-only report at `docs/tool-review-live.json`. It also appends a compact per-run history to `docs/tool-review-live-history.jsonl`, including request latency percentiles and tool names, states, and durations. The history has no prompts, tool arguments, results, or credentials. Reports and credentials are ignored by Git. File and shell tools only touch the disposable workspace. Desktop control is excluded. Fallback models are disabled so the results measure only the selected provider and model.

Live benchmark runs use real provider requests. Configure the provider key in the local vault or its environment variable, then set these process environment variables:

~~~powershell
$env:POLONRLM_LIVE_TOOL_REVIEW = '1'
$env:POLONRLM_LIVE_PROVIDER = 'custom'
$env:POLONRLM_LIVE_BASE_URL = 'https://api.teamorouter.com/v1'
$env:POLONRLM_LIVE_API_KEY = '<your TeamRouter key>'
$env:POLONRLM_LIVE_MODEL = 'deepseek-v4-flash-free'
$env:POLONRLM_LIVE_REQUEST_TIMEOUT_MS = '120000'
$env:POLONRLM_LIVE_CASE_TIMEOUT_MS = '600000'
npm run bench:live
~~~

Select a comma-separated subset with `POLONRLM_LIVE_TOOL_REVIEW_CASE`; see the script's `liveCaseNames` for available cases. Use `POLONRLM_LIVE_TOOL_REVIEW_RESUME=1` to keep passing cases from the previous report and rerun the rest. The provider and model are recorded in each report. The API key is not written into the report.

For a one-off OpenAI-compatible endpoint, use the `custom` provider and pass its endpoint and key through process environment variables. They are removed from the benchmark process environment after the key is read:

~~~powershell
$env:POLONRLM_LIVE_PROVIDER = 'custom'
$env:POLONRLM_LIVE_BASE_URL = 'https://api.teamorouter.com/v1'
$env:POLONRLM_LIVE_API_KEY = '<your key>'
$env:POLONRLM_LIVE_MODEL = 'deepseek-v4-flash-free'
~~~

When a model ID is supplied explicitly, the benchmark can proceed if the endpoint does not implement `/models`; the actual completion/tool-call request still verifies support.

`npm run test:live` is a smaller chat plus file-tool smoke test. It uses `POLONRLM_LIVE_PROVIDER`, `POLONRLM_LIVE_MODEL`, and `POLONRLM_LIVE_TIMEOUT_MS` and also uses real model requests. The default live timeout is ten minutes; set it lower for faster providers. Set `POLONRLM_LIVE_SKIP_CHAT=1` to skip the standalone chat preflight when it has already passed. A redacted local report with response timing and tool results is saved to `docs/live-smoke-report.json` and is excluded from Git.
