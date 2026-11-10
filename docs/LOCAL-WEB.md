# Local web tools

Each operation starts a separate Python process over stdio, reads compact JSON, and waits for the process to exit. No server, Docker container, or background browser is kept running. `windowsHide` prevents a helper console from appearing. Search uses regular HTML pages without a search API, account, or key.

## Setup and direct use

Python 3.11 or newer is required. Set up the helper once with `PolonRLM setup web` or `py -3.11 scripts/setup_local_web.py`. Dependencies from `scripts/local-web-requirements.lock.txt` are installed in the private `%LOCALAPPDATA%/PolonRLM/web-runtime` directory, without changing global packages. The first web request checks that this runtime has all required dependencies and retries setup if an earlier install was interrupted. Set `POLONRLM_WEB_PYTHON` to select a specific interpreter; it must already have the web dependencies installed, and PolonRLM will not modify it.

`scripts/local_web_tool.py` accepts JSON on stdin or as an argument, for example:

~~~json
{"tool":"web_search","arguments":{"query":"Python asyncio documentation","max_results":6}}
~~~

It writes only JSON to stdout. Errors use `{"error":{"code":"...","message":"..."}}` and exit code 1. Tool schemas for model APIs are in `scripts/local_web_tools.schema.json`; generate them with `local_web_tool.py --schema`. See `scripts/local_web_example.py` for a subprocess example. The PEP 723 header also allows `uv run --script`.

## Tools

| Tool | Behavior |
| --- | --- |
| `web_search(query, max_results=6, source="auto")` | Queries Bing, Brave, and Yahoo result pages in parallel. The process and parsing run locally. It uses no search API, key, or visible browser window. Results are merged, deduplicated, and ranked locally with BM25; relevant documentation pages come first when a query asks for docs, an API reference, or a standard library. Select `auto`, `bing`, `brave`, or `yahoo` as the source. The runtime allows at most two searches per task. |
| `read_webpage(url, focus_query=null)` | Trafilatura returns Markdown without navigation. GitHub `/blob/` URLs are changed to raw URLs. BM25 selects up to three matching sections from long pages and includes titles for other sections. Short pages return metadata and visible text. Literal HTML or JavaScript redirects are read without executing JavaScript. |
| `download_to_disk(url, save_filename=null)` | Streams data in 64 KB chunks to `agent_workspace/downloads`, up to 100 MB. It never overwrites, runs, or extracts files. The result includes path, size, SHA-256, and MIME type. Requires write approval. |
| `github_repo_inspector(repo_url, subpath="")` | Returns up to 200 names, paths, types, and sizes from one public repository directory. It uses the public GitHub Contents API without a key and does not clone the repository. |

`fetch_webpage` and `fetch_documentation` remain aliases for the page reader. A web research task gets search and page reading immediately. The interactive `browser` tool is for clicks and pages that require JavaScript.

## Limits and security

Connection timeout: 5 seconds. Read timeout: 15 seconds. The parent process adds an overall operation timeout. HTML is limited to 5 MB and downloads to 100 MB. Bytes are counted even when `Content-Length` is missing. On error or cancellation, partial files are removed. The app also cleans up after a forced process exit on Windows.

Every destination and redirect is checked for HTTP(S), DNS, and IP ranges. curl connects to the checked IP through `CURLOPT_RESOLVE` while preserving the original TLS host. Local, private, multicast, and special-purpose IP addresses are blocked, including mixed DNS responses. Environment proxy settings and API keys are not passed to the worker.

Downloads check the target directory, symlinks, path traversal, and Windows device names. Existing files are never overwritten. Archives are not extracted, so this tool cannot trigger a zip-bomb during extraction.

Control characters and invisible Unicode characters are removed. Page content remains untrusted data. Sanitizing characters cannot remove every possible instruction embedded in a page. Missing content is explicit: `readable: false`. For factual descriptions, if no source returns content that can be checked, the runtime reports that it could not verify the information instead of filling in a description. This is not a complete truth check for every claim.

Search output is limited to 1,200 UTF-8 bytes. Full URLs are kept first, so there may be fewer results than `max_results`. Around 320 tokens is a target that depends on language and tokenizer. The page reader limits its main text to about 1,200 tokens. Short search results are cached for 2 minutes, up to 32 entries, without keeping Python running.

Rate limits (429), CAPTCHA pages, certificate errors, and changes to search page HTML can prevent results. The code does not solve CAPTCHA, disable TLS validation, or switch to a paid API. Once one source responds, slower sources get at most another 0.5 seconds.

## Checks

`npm test` also runs Python tests when the web runtime is set up. Tests cover DNS pinning, redirects to loopback, stream limits, parsers, BM25 ranking, traversal, SHA-256, filename collisions, and cleanup.

Run `npm run test:web:local` for the direct local check. It verifies official-site search results and caching, the reader aliases, GitHub metadata, a real download's SHA-256, and rejection of loopback URLs. The report is written to `docs/network-integration-check.json`.

Run `npm run test:web:browser` to check the persistent browser, tabs, page actions, screenshots, and one-shot browser automation. It requires a working Playwright Chromium already in the local cache. The preflight does not start the app's installer or download a browser.

The live model test uses tokens and requires the explicit `POLONRLM_LIVE_WEB=1` flag: `npm run test:web:live`. It reads the Google key from the local vault or environment and uses a temporary project. It exercises search, page reading and aliases, GitHub metadata, a bounded download, persistent browser sessions, and one-shot automation. Chromium is checked before any model call and the test does not install it. The test grants narrowly scoped approval only for the URLs and actions in its cases. It reports tool-call errors separately from upstream failures. Its local report is `docs/web-live-check.json`.
