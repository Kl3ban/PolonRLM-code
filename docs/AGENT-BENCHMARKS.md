# Agent benchmarks

`npm run bench` runs a local synthetic check for prompt-size estimates and context compaction. Its byte-based token estimate is a comparison signal, not provider billing data.

`npm run bench:live` runs tool-review cases through the selected model against a disposable workspace. It records each model request's first-token and total latency, and checkpoints progress to a redacted, local-only report at `docs/tool-review-live.json`. It also appends a compact per-run history to `docs/tool-review-live-history.jsonl`; the history has no prompts or credentials. Reports and credentials are ignored by Git. File and shell tools only touch the disposable workspace. Desktop control is excluded. Fallback models are disabled so the results measure only the selected provider and model.

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
