# Tool review

Reviewed on 2026-11-12 against the linked primary documentation and the local code. This is a capability review, not a benchmark proving that one agent beats another model or harness.

## What the other projects do well

| Project | Useful approach | PolonRLM's current approach |
| --- | --- | --- |
| OpenCode | Focused reads, text search, exact edits and deferred tools keep routine work small. Its web search supports several configured remote providers. | Core file tools plus on-demand discovery. Search runs through local HTML requests without a search API. Browser DOM inspection is separate from search. |
| Qwen Code | Targeted file tools and configurable compaction. Experimental Code Mode can defer tool schemas through tool search. | Optional schemas are loaded by feature through `discover_tools`. Cortex selects a local strategy, compaction archives the full transcript, and recall can recover omitted evidence. |
| Caveman | Evaluate task quality, latency, failures and recovery alongside token cost. Shorter prompts alone do not prove an improvement. | Local outcome and usage records exist. No Caveman runtime report was available for this review, so no Caveman savings figure is claimed. |

Sources: [OpenCode tools](https://opencode.ai/docs/tools/), [OpenCode web search](https://opencode.ai/docs/websearch/), [Qwen Code file tools](https://github.com/QwenLM/qwen-code/blob/main/docs/developers/tools/file-system.md), [Qwen Code settings](https://github.com/QwenLM/qwen-code/blob/main/docs/users/configuration/settings.md), [Caveman optimizations](https://docs.caveman.so/concepts/optimizations).

Remote search providers have their own accounts, quotas and service policies. OpenCode supporting one does not establish that it is permanently free or unlimited. PolonRLM keeps local search as requested; no automatic search API fallback was added.

## Changes from this review

- Removed the hard two-search task limit. The default is no search-count cap, with configurable result bytes, count and transient retries.
- Increased the default search result budget from 1,200 to 6,000 bytes. URLs remain complete, with fewer results if necessary. Output size is not a provider token measurement.
- Added retries for transient connection and selected server failures, with fixtures for result budgets and retry behavior. CAPTCHA and access-denied pages are not repeatedly retried.
- Added exact loopback browser access for local development sites. Other ports and private-network destinations remain denied unless separately allowed by supported policy.
- Added WebSocket forwarding through the guarded proxy. Service workers can be enabled for a new session; default remains blocked.
- Added encrypted, project-scoped login snapshots. Saving and loading start disabled and require `/browser-auth on`. The regular browser profile is never imported.
- Added dedicated local secret-variable filling, so a password need not be part of model tool arguments.
- Improved TypeScript analysis with installed declaration resolution, `.mjs` and `.cjs` sources, and strict line/column validation.
- Changed semantic rename previews to bounded diffs and hashes. Multi-file apply checks current contents and rolls back earlier writes if a later write fails.

## Keeping context useful

Use a scoped read or search before loading whole files. Prefer a symbol definition or project map over repeated directory listings. Browser snapshots can return changes from an earlier snapshot; inspect only the target element when a click fails. Search results lead to a focused page read rather than repeated broad searches.

Cortex compaction is extractive by default and makes no extra model call. Explicit requirements, decisions and evidence links are retained; archived context can be recalled when something is missing. `/compact model` is an optional provider call, not the default. `/cortex stats` reports recorded outcomes and available usage. These mechanisms reduce unnecessary context, but their effect on task quality must still be checked on representative tasks.

## Gaps that remain

- Local search depends on external HTML layouts. Regional results, throttling and CAPTCHA can break a live query even when parser fixtures pass. The agent should report missing evidence and use available page URLs rather than inventing results.
- Browser tests use controlled fixtures. They prove the tested actions and network boundaries, not compatibility with every website. MFA, CAPTCHA, anti-bot checks and login expiry still apply.
- Service-worker-owned traffic uses the proxy, but page diagnostics and resource blocking do not observe every worker request. The browser tools are not a full DevTools debugger, CPU profiler or response-body archive.
- Cookies and localStorage can restore many logins; IndexedDB is explicitly optional. Session storage and password-manager entries are not persisted. A site can require a fresh login. See [Playwright authentication](https://playwright.dev/docs/auth).
- Built-in compiler-backed semantic tooling is TS/JS. Other languages need a suitable installed language server. Project maps for Python, Go and Rust are best effort, not a replacement for each compiler.
- Index bounds, safe file types and output budgets still apply. Unlimited task tokens do not mean unbounded in-memory indexes or full DOM dumps. Truncated output must be followed with a scoped read.
- Subagent isolation is a project copy plus the configured command sandbox. It is not a virtual machine, and a saved plan or passing unit test is not proof of task completion.

## Evidence

`tests/browser-network.test.ts` uses the production egress policy with a real Chromium: loopback allowlisting, a WebSocket handshake, service-worker denial of a different port, secret filling and encrypted login restore. `tests/browser-inspection.test.ts` covers the DOM workbench. `tests/advanced.test.ts` checks declaration resolution, positions and rename rollback. Python fixtures cover local search parsing, budgets and retries. `scripts/check-local-web.ts` exercises real search, page reads, GitHub metadata and a hashed download without a model API.

Run `npm run check`, `npm test`, `npm run build` and `npm run check:package`. Real-browser tests need a cached Playwright Chromium; CI explicitly installs it and requires the tests on Windows, Linux and macOS. Live search checks remain separate from deterministic CI because the upstream pages are not under this project's control.
