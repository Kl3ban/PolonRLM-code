# Agent task packs

The task benchmark uses one directory per task. A pack is a directory containing task directories directly:

```text
my-pack/
  retry-delay/
    task.json
    workspace/
      package.json
      src/retry.js
    grader.mjs
```

`task.json` contains `id`, `title`, `prompt`, and an optional `timeoutMs` between 10 seconds and 15 minutes. The directory name must match `id`. A task can declare an optional setup command:

```json
{
  "id": "repo-fix",
  "title": "Fix a repository bug",
  "prompt": "Fix the failing request retry behavior.",
  "setup": {
    "command": ["npm", "ci"],
    "timeoutMs": 300000,
    "networkDomains": ["registry.npmjs.org"]
  }
}
```

Setup uses an argv array, never an implicit shell string. It runs once in the agent copy and once in the private grader copy before any model request. The command runs in the required OS sandbox, inherits no API-key environment variables, and can reach only the listed domains. The default domain list is empty. Keep the list narrow and include every registry or source host needed by the lockfile. Setup runs package lifecycle scripts, so task packs and their setup commands must be trusted. Use lockfiles and deterministic install commands such as `npm ci`.

The agent receives only `prompt` and a fresh copy of `workspace`. It does not receive `task.json` or `grader.mjs`. The grader must export `async function grade(workspacePath)` and return `{ passed: boolean, summary: string }`. It is run against the untouched starter first; a task is rejected before any model request if the starter already passes or the grader cannot run. After the agent finishes, its workspace is copied to the private grader directory and checked again.

Graders run under the required OS sandbox with network access disabled and no inherited API-key environment variables. The scratch suite is created inside the user's home directory so the sandbox's home read-deny also protects the private grader when Windows `TEMP` points elsewhere. Each agent or grader sandbox re-opens only its own workspace. A task without `setup` remains fully offline and does not install dependencies. Workspace copies omit Git metadata, `node_modules`, local config and credential files; symbolic links and special files are rejected. After grading starts, the runner keeps only the grader copy's preinstalled `node_modules` while syncing the agent's changed files, so model-added dependencies are not installed during grading.

Task packs are code. Only use grader scripts you trust. The grader and agent workspaces are disposable. Windows SRT grants are removed at the end; if removal fails, the report identifies the preserved temporary path.

## Repository-backed case

`real/yocto-queue` contains two pinned upstream repository cases. `tail-after-empty` uses v1.2.1 and tests the stale-tail reference fixed upstream in commit `8aead27`. Its test and grader force garbage collection and check that the final dequeued value is released. `drain-undefined` uses v1.2.0 and tests issue #13, fixed in commit `ee91589`, where `drain()` stopped at an `undefined` queue entry. Both workspaces keep upstream source and the MIT license.

Run it with:

```sh
node bin/polonrlm.cjs benchmark run --task-pack benchmarks/real/yocto-queue --case tail-after-empty
node bin/polonrlm.cjs benchmark run --task-pack benchmarks/real/yocto-queue --case drain-undefined
```

The setup installs the pinned dependencies with `npm ci --ignore-scripts` in both copies. Network access is limited to `registry.npmjs.org`. The benchmark refuses to send a model request unless both OS sandboxes are ready.
