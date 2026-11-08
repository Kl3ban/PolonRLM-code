# `computer_use` and image attachments

## Desktop control

PolonRLM automatically makes `computer_use` available for requests about the desktop, windows, mouse, cursor, computer, or apps. There is no need to discover the tool manually or enter a separate command.

1. `list` shows visible application windows and the Windows taskbar as separate targets.
2. `observe` for a selected `windowId` returns a screenshot and UI elements when Windows exposes them.
3. The agent selects an accessibility element or image coordinates. If elements are not available, it uses the invisible grid: 10×10 for an application window and one adaptive row of cells for the wide, short taskbar.
4. `click`, `fill`, `type`, `key`, or `scroll` performs one action. Each action needs a fresh, single-use `snapshotId` and refreshes accessibility state. Clicking a UI Automation element refreshes the element list without an image. Clicking coordinates or a grid cell, `type`, and `key` without an element attach a screenshot for verification. Every `observe` call includes an image.

`fill` clicks a field and types its text in one call. Every tool call, including `list` and `observe`, waits for separate user approval. The agent stays paused until the user approves or rejects it. A rejected call is not repeated in the current task. Cancelling the task cancels a pending request.

There is no overlay, separate preview window, or animation. A screenshot captures the selected window. The **Windows taskbar** target captures only the taskbar. Images and visible text are sent to the selected model provider, so only use actions that fit what the user wants to share with that provider.

## Modes and limitations

- `computer_use` works in PLAN, REVIEW, and BUILD. Every click or input needs approval, regardless of mode. PLAN and REVIEW still block project file writes and shell commands.
- `readonly`, the denylist, the allowlist, or a model without image support can block the tool. The model receives a reason and a fix instead of repeating the attempt.
- The tool operates on the real, unlocked Windows desktop. The target application must already be running. It does not run arbitrary commands to launch programs, but it can click a visible taskbar icon.
- Password managers, the sign-in screen, UAC prompts, and terminal applications are excluded. The user must enter passwords.
- The target window must still belong to the same process and keep the same size. Covered points, lost focus, stale screenshots, and holding `Pause` block input.
- Screenshots are temporary and are not saved to SQLite. Text results remain in tool history. After resuming a session, the agent must take a new screenshot.
- Do not control the desktop manually during an action or in parallel with subagents.

## User images

Press `Ctrl+Shift+V` in the task field to paste an image from the Windows clipboard. `Alt+I` opens attachments: `A` adds an image from a file, `P` pastes from the clipboard, `X` removes the selected image, and `C` clears the list. Up to four PNG, JPEG, WebP, or GIF images can be attached, each up to 8 MB. The list and the selected model's vision support are shown before sending. Images are not stored in SQLite conversation history.

You can also use `/image "C:\Users\Administrator\Pictures\image.png"`, then send a normal message describing the task. `/image clear` removes pending images.

## Verification

Unit tests cover single-use snapshots, permissions, coordinate scaling, the 10×10 grid, and the taskbar's adaptive row. A runtime test checks that requests in Polish about the PC or clicking a taskbar app make `computer_use` available immediately, including in REVIEW mode.

The optional native test creates its own temporary WinForms window, types and clicks only inside that window, and captures the taskbar:

~~~powershell
$env:POLONRLM_DESKTOP_TEST = '1'
npx tsx --test tests/computer-native.test.ts
~~~

Sources: [Microsoft UI Automation](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-uiautomationoverview), [SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput), [AI SDK prompts](https://ai-sdk.dev/docs/foundations/prompts).
