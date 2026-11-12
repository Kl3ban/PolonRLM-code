# Cortex and context recovery

Cortex selects an orchestration strategy locally. It uses the task, project evidence, repeated failures, and measurements from earlier comparable runs. This adds no model request. The selected model still does the coding and reasoning.

## Choosing effort

`/cortex 0..5` sets the maximum level. Adaptive mode can start lower for a focused task and escalate after repeated failures. It never raises the configured ceiling. `/settings cortexStrategy fixed` keeps the selected level and disables historical calibration.

The initial route still uses local complexity signals. Project analysis can raise effort for a large or partial index. A mention of a typo no longer overrides an accompanying migration, security or cross-module task. A short continuation uses the previous original user task, even if active context contains only a compact summary.

The model receives the current strategy after an escalation, rather than stale initial guidance. Suggested call counts are no longer goals in its instructions. It is told to take the fewest calls that establish the result and to delegate only useful, independent work.

## Measured outcomes

`/cortex stats` shows recent records for the current project. Each root run records its initial and highest Cortex level, selected model, task class, complexity band, model call count, provider-reported input/output tokens, tool errors, compactions, and recalled excerpts. Records stay in the local SQLite database. Raw task text is not copied into these measurements. Deleting the chat removes its records.

Outcomes are deliberately specific:

| Outcome | Meaning |
| --- | --- |
| `checks_passed` | A recognized check exited zero and no later workspace edit invalidated it, or automatic controller verification passed. |
| `checks_failed` | The latest applicable check or controller verification failed. |
| `unverified` | There was no applicable check, the run failed, or files changed after the last check. |
| `stalled` | A repeated-read or tool-cycle guard stopped the run. |
| `cancelled` | The user cancelled the run. |

A model's completion message does not count as proof. Passing checks support those commands; they do not prove that every requirement is satisfied. Ordinary answers and web research usually remain unverified in these statistics because there is no independent answer-quality judge.

Automatic verification links its original report ID to the preceding run. A repair attempt gets its own run and its subsequent verification. A separate manual `/verify` does not retroactively mark an unrelated task successful. Provider failures and cancelled runs are not used as proof that more Cortex effort would help.

Adaptive calibration compares records from the same project, selected model, mode, task class and complexity band. A lower level needs at least three check-backed examples that did not escalate. Contrary lower-level failures or escalations block downshifting. When both levels have enough passing examples, the lower level must also have a lower median token count without more calls. Repeated comparable failing checks can raise initial effort by one level. Mixed-model fallback runs do not calibrate a single-model route.

This is conservative feedback from observed work, not a guarantee about an unseen task or a trained quality model. A project needs recorded examples before this affects routing.

## Recovering information after compaction

Automatic compaction remains local and extractive. The full transcript is preserved in SQLite. Context recovery adds a separate route to the original data, so the summary does not have to retain every detail forever.

After compaction, a local BM25 index searches original user messages, tool calls and results for the current task and the latest error. Rare identifiers, filenames and error codes help find the relevant passage. The index updates from new rows, detects external database writes and keeps a small session cache. Evicting a cache entry does not delete archived content.

Relevant original verification reports can also supply command results, report IDs and saved file hashes. These are labelled historical. The agent must recheck the current workspace before treating an old result as current evidence.

At most three excerpts are added to a model request. Recovery reserves up to 8% of available history space, capped at 600 locally estimated tokens, within the configured/model context window. Active full messages are excluded and irrelevant searches add no excerpts. These transient recall messages are not appended to the permanent transcript, so they do not accumulate through repeated compaction. The newest user request remains unchanged.

Each excerpt carries an original message ID, role/tool source, line range and content fingerprint. `search_history` can retrieve more detail:

```json
{"query":"SQLITE_BUSY src/storage.ts","limit":3}
```

Or read exact lines from a returned source:

```json
{"id":123,"startLine":4,"lines":12,"expectedDigest":"0123456789abcdef"}
```

IDs are scoped to the current chat. `expectedDigest` rejects a source whose identity changed. Outputs are bounded and redacted. Historical tool and assistant content remains untrusted data; newer user instructions take priority. Images are transient and cannot be reconstructed from text history.

The retrieval is lexical, so an unrelated synonym may miss a source. The agent can search with a filename, error code or unique phrase. Missing evidence stays explicit; the system does not invent a memory. `/compact model` remains an explicit model-backed option and consumes its normal provider usage.

## Evaluation

Run `npm run bench:cortex` for deterministic routing and source-retrieval cases without a model API. The report includes routing failures, ceiling checks, retrieval top-1 accuracy, reciprocal rank, excerpt size and elapsed time. It is a local regression benchmark, not a live coding-agent score.

Unit and runtime tests also cover incomplete checks, changes after verification, contradictory calibration history, continuation after compaction, source fingerprints, chat isolation, external SQLite updates and automatic recall without an extra model turn. Use `/cortex stats` to inspect actual run measurements. Local token estimates are not provider-billed savings.
