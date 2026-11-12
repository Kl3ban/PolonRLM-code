# Browser workbench

PolonRLM has a persistent, headless Playwright browser. The agent can read and inspect the DOM without a screenshot or a vision model. It runs in a separate browser context, not your signed-in browser profile. No inspection overlay appears on your desktop.

## A short interaction

Launch a session:

```json
{"action":"launch","url":"https://example.com"}
```

Use the returned `sessionId` with `browser`:

```json
{"action":"snapshot","sessionId":"SESSION"}
```

The result contains a `snapshotId`, a short text extract, and ARIA elements with `ref`, `role`, `name`, and relevant state flags. These are native Playwright references. Form control values are omitted from the snapshot. Use the exact returned IDs:

```json
{"action":"click","sessionId":"SESSION","ref":"e7","snapshotId":"SNAPSHOT"}
```

CSS selectors still work. Exact text clicks require one matching element; ambiguous text never silently selects the first match. Playwright waits for the target to become actionable. An error asks the agent to refresh the snapshot or inspect the target instead of blindly retrying.

After an action, request changes from a known snapshot:

```json
{"action":"snapshot","sessionId":"SESSION","since":"SNAPSHOT"}
```

Unchanged output is just `snapshotId` and `unchanged: true`. A delta reports added, changed and removed entries and changed text. Removed entries are absent from the returned scope; this does not prove they were deleted from the DOM. Unknown or expired baselines return a full snapshot with `reset: true`. A delta that would exceed the output budget also becomes a bounded full snapshot, so later comparisons have a complete baseline.

Navigation, reloads and configuration changes invalidate old refs. Use the latest snapshot ID. Detached or replaced elements are never automatically retargeted to a different node.

## Inspect an element

Discover `browser_inspect` when deeper inspection is needed. This is the agent's equivalent of inspecting an element in DevTools, with selected data returned as JSON.

```json
{"sessionId":"SESSION","ref":"e7","snapshotId":"SNAPSHOT","styles":["display","position","color"],"matchedRules":true}
```

Element inspection returns attributes, bounds, computed CSS, visibility, disabled/editable state, parents and children. Its center-point hit test describes an overlay blocking the element. With `matchedRules: true`, readable stylesheets contribute matching selectors and the requested properties. Inaccessible cross-origin stylesheets are counted, not bypassed.

Inspect a point without moving the desktop cursor:

```json
{"sessionId":"SESSION","x":220,"y":160}
```

Coordinates are CSS pixels relative to the selected frame's viewport. `frameId` selects a child frame. DOM inspection also walks open Shadow DOM:

```json
{"sessionId":"SESSION","view":"dom","selector":"main","depth":3,"limit":40}
```

Scripts, event handlers and form values are omitted from DOM output. The default depth is 2 and the default node limit is 20. Closed shadow roots remain inaccessible.

For a more thorough click check:

```json
{"sessionId":"SESSION","selector":"button[type=submit]","probe":true}
```

`probe` uses Playwright's trial click, waits up to 1.5 seconds, and reports whether the target is clickable. It never clicks, but it may scroll the element into view. This checks full Playwright actionability, including iframe overlays; the ordinary element hit test only checks the selected frame's center point. A page can change after either check.

## Frames, diagnostics and loading times

`browser` with `action: "frames"` lists stable IDs for attached frames. Supply `frameId` with a snapshot, selector, text read, scroll, or inspection. Refs returned for child frames already identify their frame.

`console` and `network` return compact, bounded records. `network` defaults to failures and HTTP errors; set `errorsOnly: false` for successful responses too. Records contain request method, safe URL, status, resource type and completed request duration where available. Request headers, payloads and response bodies are not captured.

```json
{"action":"network","sessionId":"SESSION","errorsOnly":false,"filter":"api","limit":10}
```

Use the returned `cursor` as `sinceId` on the next diagnostics call. Incremental reads return the oldest unread matching records first. `truncated: true` means some matching records were omitted. Each tab retains at most 200 records per stream. URLs omit credentials, query strings and fragments; diagnostic text is redacted.

```json
{"sessionId":"SESSION","view":"performance"}
```

Performance inspection returns navigation, DNS, connection, TTFB, paint and resource timings, DOM element count, transfer sizes and up to eight slow resources. It is a page timing report, not a CPU or memory profiler. Browser privacy rules may hide cross-origin sizes.

## Configuration

Choose an engine in `/settings` under Browser engine. Change persistent defaults through Browser options or:

```text
/settings browserOptions {"viewportWidth":1440,"viewportHeight":900,"locale":"en-US","timezoneId":"Europe/Warsaw","timeoutMs":15000,"navigationTimeoutMs":25000,"snapshotElements":40,"maxChars":6000,"blockedResources":["media","font"]}
```

Omitted properties receive defaults. Defaults apply to new sessions. The initial viewport is 1365 by 900, locale is `en-US`, timezone is `UTC`, theme is light, interaction timeout is 10 seconds and navigation timeout is 20 seconds. Reduced motion is enabled. Resource blocking is off by default because missing resources can affect a page.

The agent can discover `browser_configure` to read defaults or adjust an existing session:

```json
{"sessionId":"SESSION","options":{"viewportWidth":900,"viewportHeight":700,"maxChars":4000,"blockedResources":["image","media","font"]}}
```

Viewport, theme, timeouts, snapshot size and resource blocking can change during a session. Locale and timezone require a new session. Optional resource blocking affects future requests, not resources already loaded. New tabs inherit the session configuration.

Snapshots return up to 40 elements and aim to stay within 6,000 characters by default. Tools mark truncated output. These are configurable result sizes, not a provider token limit or a promise about billed usage. Narrow `selector`, use `since`, and load the extra inspection schema only when needed to keep context smaller.

## Reliability and permissions

Actions in one session are serialized, including calls made concurrently through the SDK. Popups become managed tabs, within the existing tab limit. Cancelling an active page operation closes that tab so a pending click cannot fire later; other tabs remain available. Sessions expire after 30 minutes of inactivity, with up to 3 sessions and 8 tabs per session.

Normal tool permission rules still apply. Page reads and inspection are available in PLAN/REVIEW; clicks, typing and form changes require BUILD unless the user has explicitly approved all tools. Public-address validation and the egress proxy remain in place. Private/local addresses, WebSockets, service workers and file downloads remain blocked. Page content is untrusted data.

## Checks

`tests/browser-inspection.test.ts` uses a real headless Chromium and an isolated local HTTP fixture. Only its injected test dependencies allow the loopback fixture. Production address rules are unchanged. It covers references, deltas, stale IDs, DOM/CSS, overlays, actionability probes, Shadow DOM, iframes, diagnostics, configuration, popups, serialization and cancellation.

Run `npx tsx --test tests/browser-inspection.test.ts tests/web.test.ts`. If Chromium is absent, the real-browser case skips without downloading it. Set `POLONRLM_BROWSER_TEST_REQUIRED=1` to require it. CI explicitly installs the headless browser and runs these tests on Windows, Ubuntu and macOS. No model API key is needed.
