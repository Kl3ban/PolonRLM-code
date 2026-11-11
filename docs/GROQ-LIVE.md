# Groq live smoke test

The live test uses Groq's OpenAI-compatible endpoint `https://api.groq.com/openai/v1` with `openai/gpt-oss-120b`. The model is text-only, supports tool use, has a 131,072-token context window and a 65,536-token output limit. Groq lists pricing on its [model page](https://console.groq.com/docs/model/openai/gpt-oss-120b).

## Run

```sh
export GROQ_API_KEY=...        # PowerShell: $env:GROQ_API_KEY = '...'
npm run test:groq
```

The script (`scripts/live-groq-smoke.mjs`) requires a built `dist/` tree (the npm script builds first). It:

1. Calls the provider directly and checks a fixed text marker.
2. Writes the key into a temporary DPAPI vault on Windows, removes it from the parent environment, and starts a temporary `Controller`.
3. Asks the model to:
   - `write_file` a known file,
   - `read_file` it,
   - run `node -e ...` through `execute_command`.
4. Verifies the actual file, the `read_file` tool output, and the shell output. It does not trust the assistant's prose.
5. Writes a machine-local report to `docs/groq-live-report.json` (ignored by Git) and removes the temporary workspace/home.

The key is never written to the repository, tests, README, command arguments, or report. On non-Windows systems the DPAPI step is unavailable; the script reports that limitation instead of silently using a different provider.

## Last result

- Date: 2026-11-11
- Model: `openai/gpt-oss-120b`
- Direct text stage: PASS (84 input, 79 output tokens)
- Agent stage: PASS
- Agent usage: 8,963 input, 325 output, 2,048 cached tokens; USD cost not reported by the provider
- Tools: `write_file`, `read_file`, `execute_command` all succeeded
- Shell: `SHELL_OK`, exit code 0
- File: `GROQ_TOOL_OK`

The provider reported `costKnown=false`, so this test does not claim a dollar cost. It also does not claim that the model is reliable across long tasks; that is what the benchmark and harness comparison measure separately.
