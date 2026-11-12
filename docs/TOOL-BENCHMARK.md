# Tool benchmark

This benchmark has two layers: a deterministic tool audit that needs no model, and a same-model coding-task comparison against OpenCode.

## 1. Deterministic tool audit

```sh
npm run audit:tools
```

The script registers the real BUILD tool catalog, validates every JSON Schema and invokes representative tools against a temporary project with files, Git, a TypeScript module, checkpoints and transactions.

| Metric | Result |
| --- | --- |
| Registered tools | **68** |
| JSON Schema checks | **68 / 68 pass** |
| Unique tools exercised directly | **53** |
| Probe calls | **60 / 60 pass** |
| Skipped external/native tools | **15** |
| Failed probes | **0** |

The machine-readable result is [`tool-audit-report.json`](tool-audit-report.json). Full details and the skip reasons are in [`TOOL-AUDIT.md`](TOOL-AUDIT.md).

The audit found and fixed one real compatibility defect: nested default fields in `read_files.files[]` and `search_batch.queries[]` were marked required in JSON Schema. A model sending only `path` or `pattern` could be rejected before the handler ran. `src/tools/registry.ts` now strips defaulted fields recursively, with a regression test in `tests/tools.test.ts`.

The deterministic audit is not a model benchmark. It proves the local tool contracts and smoke behavior, not that a model selects the right tool.

## 2. Same-model comparison with OpenCode

Run the same tasks, prompt, starter workspace and hidden grader against both harnesses with the same **free** provider and model:

```sh
OPENROUTER_API_KEY=... node scripts/compare-shared-model.mjs \
  --provider openrouter \
  --model nvidia/nemotron-3.5-lightning:free \
  --tasks retry-status,group-by,merge-intervals \
  --report docs/harness-shared-report.json
```

The script reads the key from `OPENROUTER_API_KEY` or the PolonRLM vault. It never prints the key. The default is OpenRouter's free `nvidia/nemotron-3.5-lightning:free`; no paid model is used.

### Result — 2026-11-12

Model: `nvidia/nemotron-3.5-lightning:free` via OpenRouter for both harnesses. One run per task. Sandbox disabled for this comparison because both harnesses used host execution; this measures coding/tool use, not sandboxing.

| Task | PolonRLM | OpenCode |
| --- | --- | --- |
| `retry-status` | **PASS** — 21.3 s | **FAIL** — 77.4 s; grader 1/2 |
| `group-by` | **PASS** — 39.4 s | **PASS** — 21.6 s |
| `merge-intervals` | **PASS** — 51.0 s | **PASS** — 66.2 s |
| Score | **3/3** | **2/3** |
| Total wall time | 111.7 s | 165.2 s |

Raw results: [`harness-shared-report.json`](harness-shared-report.json).

The free model is small and intermittently tool-weak. The `retry-status` failure is an OpenCode run that produced a partially correct edit but failed one hidden group; it is not a general statement about OpenCode. This is a single-run smoke comparison, not a statistically meaningful ranking.

## 3. OpenCode tool-surface differences

The deterministic audit covers PolonRLM's tools. OpenCode has its own tool names and schemas, so a tool-by-tool call comparison is not meaningful. The useful comparison is at the task level plus the documented capability surface:

| Capability | PolonRLM | OpenCode |
| --- | --- | --- |
| File reads, search, exact edits | Yes | Yes |
| Shell and test commands | Yes, optional OS sandbox / fail-closed mode | Yes, permission modes |
| Browser automation | Yes, Playwright sessions and DevTools-style inspection | Depends on configured tools/MCP |
| Desktop control | Windows `computer_use` | Not a built-in in this configuration |
| LSP/semantic tools | Built-in TS/JS plus generic LSP | Depends on plugins/MCP |
| MCP | Yes | Yes |
| Subagents/task graph | Yes | Depends on configuration |
| SDK/HTTP server/ACP | Yes | ACP server; SDK surface differs |
| Benchmark runner | 50 local tasks, hidden graders, reference solutions | External benchmark setup |

This matrix is a capability inventory, not a quality score. Browser and desktop tools remain externally dependent and are not covered by the OS command sandbox.

## Reproduce and extend

- Deterministic audit: `npm run audit:tools`
- Same-model 3-task comparison: command above
- Coding task pack: `benchmarks/default` (50 tasks, 50 reference solutions)
- Historical harness comparison: [`HARNESS-COMPARISON.md`](HARNESS-COMPARISON.md)

Run the full test suite before publishing any score:

```sh
npm run check
npm test
npm run build
npm run check:package
```
