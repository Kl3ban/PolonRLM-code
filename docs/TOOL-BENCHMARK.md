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

Run the same tasks, prompt, starter workspace and hidden grader against both harnesses with the same provider and model:

```sh
node scripts/compare-shared-model.mjs \
  --provider teamorouter \
  --model gpt-6.1-sol \
  --tasks retry-status,group-by,merge-intervals \
  --report docs/harness-shared-report.json
```

The script reads the provider key from the PolonRLM DPAPI vault; OpenCode uses its own configured TeamRouter provider. It never prints the key.

### Result — 2026-11-12

Model: `teamorouter/gpt-6.1-sol` for both harnesses. One run per task. Sandbox disabled for this comparison because both harnesses used host execution; this measures coding/tool use, not sandboxing.

| Task | PolonRLM | OpenCode |
| --- | --- | --- |
| `retry-status` | **PASS** — 22.5 s | **PASS** — 20.7 s |
| `group-by` | **PASS** — 26.0 s | **PASS** — 21.8 s |
| `merge-intervals` | **PASS** — 29.6 s | **PASS** — 32.2 s |
| Score | **3/3** | **3/3** |
| Total wall time | 78.0 s | 74.8 s |

Raw results: [`harness-shared-report.json`](harness-shared-report.json).

This is a small, single-run smoke comparison. It shows that PolonRLM can complete the same three tasks with the same model and does not establish a statistically meaningful speed or quality difference. A 50-task pack and hidden graders are available for a larger run.

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
