# Local Plugin SDK

PolonRLM plugins are optional JavaScript modules stored in the user's PolonRLM config directory. The current SDK provides lifecycle hooks for task context and tool-call policy. Plugins do not register new model-facing tools yet.

## Trust and approval

Plugin code runs inside the PolonRLM process with the same filesystem, network, process, and credential access as the current user. It is not sandboxed. A timeout limits how long PolonRLM waits for a hook, but JavaScript that has already started may continue running after that timeout.

Read the source before enabling it. `/plugins enable <id>` prints the plugin path and SHA-256 without executing the module. After reviewing the files, `/plugins enable <id> confirm` runs that version and stores its hash. On startup, PolonRLM checks the hash again and skips changed code. The hash covers `plugin.json` and `index.mjs`; imported modules and other external code are outside that hash, so plugins should be self-contained and imports should be reviewed separately.

Plugin hooks cannot approve a tool or change its permission rule. Normal mode, workspace, and tool approval checks still run. A `beforeTool` hook can deny a call; a hook error also blocks that call. `afterTool` and `afterTask` receive read-only copies and cannot change the tool result.

## Create and manage a plugin

```text
/plugins create example-notes
/plugins show example-notes
/plugins enable example-notes
```

Review the displayed path, then read its `plugin.json` and `index.mjs`. If you trust the code:

```text
/plugins enable example-notes confirm
/plugins list
/plugins disable example-notes
```

`/plugins disable` keeps the files. `/plugins remove` removes only the PolonRLM settings entry and leaves the files in place. Editing a pinned plugin requires reviewing and confirming it again. PolonRLM supports up to 16 active plugins and 64 registered hooks, with a 5 second wait per hook and 12,000 UTF-8 bytes of supplemental context per task.

## Plugin files

Each plugin lives in its own folder under `<PolonRLM config>/plugins/<id>/` and contains exactly:

```text
plugin.json
index.mjs
```

`plugin.json`:

```json
{
  "id": "example-notes",
  "name": "Example notes",
  "version": "1.0.0",
  "description": "Adds short project reminders to matching tasks.",
  "entry": "index.mjs"
}
```

`index.mjs`:

```js
export default {
  id: 'example-notes',
  version: '1.0.0',
  activate(api) {
    api.hooks.beforeTask(({ task }) => {
      if (task.toLowerCase().includes('release')) {
        return 'Plugin note: check the changelog before preparing a release.';
      }
    });

    api.hooks.beforeTool(({ tool, arguments: args }) => {
      if (tool === 'execute_command' && String(args.command ?? '').includes('deploy')) {
        return 'Deployment needs a separate manual review.';
      }
    });

    api.hooks.afterTool(({ tool, isError, durationMs }) => {
      // Observe completed calls. Do not put secrets in console output.
    });

    api.hooks.afterTask(({ status }) => {
      // This hook runs after the top-level chat task.
    });
  },
  deactivate() {
    // Release timers or resources owned by this plugin.
  },
};
```

The API has version `1`. Hook inputs are frozen copies. Task and tool arguments are redacted and clipped before PolonRLM passes them to plugins. `beforeTask` may return short supplemental context; the runtime labels it as plugin context and it cannot override the user's request or the safety rules. `beforeTool` may return a reason to block the call. Empty or missing return values allow normal permission checks to continue.

The public TypeScript types are available from the package subpath:

```ts
import type { PolonRLMPlugin } from 'polonrlm-agent/plugin';
```

The SDK is intentionally small for now. It does not expose private runtime objects, provider clients, secrets, or a way to add or approve model tools.
