# Command sandbox

PolonRLM can run selected project commands under an operating-system sandbox. This is separate from tool approval: approval decides whether a command may run, while the OS backend limits what the process and its children can read, write, and reach over the network.

The current integration applies to `execute_command`, `execute_powershell`, `run_tests`, `install_dependencies`, `inspect_errors`, `execute_python`, `process_start`, and `lsp_request`. Built-in read-only Git and process inspection commands, browser automation, desktop control, and MCP servers use their existing controls and are not covered by this sandbox integration.

## Modes

`/settings sandboxMode auto` is the default. On macOS and Linux it uses the OS backend when its dependencies are available. On Windows, `auto` uses the SRT backend when the one-time setup is already provisioned; it never installs or elevates anything by itself. If setup is missing, PolonRLM shows the reason and applies the normal permission policy before host fallback. `/permissions all` intentionally allows commands without prompts. It never installs OS packages automatically.

`/sandbox on` is the explicit switch for required isolation. It verifies the backend first, refuses with the concrete reason when setup is missing, and otherwise saves `sandboxMode required`. `/sandbox status` shows whether commands will run isolated, fall back to the host, or be blocked. `/sandbox off` saves `off`; `/sandbox auto` saves `auto`. These commands only change the setting and never run the installer.

`/settings sandboxMode required` refuses to start a command unless the OS backend is ready. On Windows it enables the bundled SRT backend. `/sandbox setup` previews the machine changes; `/sandbox setup confirm` explicitly starts the installer and triggers Windows UAC. It creates a dedicated local sandbox account and a machine-wide WFP network filter. The installer skips user-profile read grants. PolonRLM refuses to elevate the bundled installer if it is inside the writable project. After setup succeeds, PolonRLM verifies readiness and enables `required` mode. No setup runs on app startup.

When a sandboxed command first uses a project, Windows ACL grants can persist after the command and app close. Another sandboxed session on the same machine may be able to read a granted project. Remove one with `srt-win acl forget <project-path>` or all grants with `srt-win acl forget --all`. Read `/sandbox status` first. On Windows, isolated subagent copies are outside the main workspace grant, so `auto` asks before host execution and `required` blocks those commands.

`/settings sandboxMode off` runs commands on the host and follows the regular permission policy.

## Files and network

Sandboxed processes can read and write the project directory plus a temporary directory created for that process. Reads from the user's home directory are denied except for the project and that temporary directory. On Windows, PolonRLM also denies previously granted sandbox roots outside the active project for each command; another sandbox program that does not apply those same per-command denials may still read kept grants. Credential-like environment variables inherited from the parent shell are removed before project code starts.

Sandbox network access is deny-by-default. Add only the hosts needed by project tools:

```text
/settings sandboxNetworkDomains ["registry.npmjs.org","github.com","*.githubusercontent.com"]
```

This rule applies only to sandboxed processes. A host fallback follows the configured permission policy; `/permissions all` intentionally allows it without a prompt. Network domains support an optional port, for example `api.example.com:443`.

Use `/sandbox status` to check the selected mode and local backend readiness. Linux uses Bubblewrap and `socat`; macOS uses its built-in Seatbelt backend. Windows uses SRT and needs its separate Windows setup to be ready. PolonRLM does not install OS dependencies silently.

The upstream sandbox backend is a beta research preview. Its platform limitations still apply; this integration does not sandbox every PolonRLM tool or replace process permissions. See the [sandbox-runtime documentation](https://github.com/anthropics/sandbox-runtime/blob/main/README.md) for backend details.
