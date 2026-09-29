# <sub><picture><source media="(prefers-color-scheme: dark)" srcset="web/public/assets/baton-logo.svg"><img src="web/public/assets/baton-logo-dark.svg" width="36" height="36" alt=""></picture></sub>Baton

Pick up your [Claude Code](https://github.com/anthropics/claude-code) and [Codex](https://openai.com/codex) tasks on your phone, right where you left off on your computer.

<p align="center">
  <img src="docs/assets/promo.avif" alt="Baton" width="100%">
</p>

Baton provides non-intrusive, real-time streaming and rendering for Claude Code and Codex sessions across your devices. Your session data stays in your own AWS account.

### Why Baton?

Named after both a relay baton and a conductor's baton, Baton lets you pick up work on another device and direct your agents remotely.

## Quick Start

### 1. Deploy Server

Requires [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) with permissions to create CloudFormation stacks.

```bash
curl -fsSL https://raw.githubusercontent.com/zhu-xiaowei/baton/main/server/install.sh | bash
```

Takes ~6-8 minutes. Prints a **Start URL** and QR code on success. Supports `--region`, `--stack`, `--profile` options (pass after `bash -s --`).


### 2. Install Bridge

Requires [Node.js](https://nodejs.org/) 20.9+.

1. Open the **Start URL** in your browser (this is also the web viewer)
2. Copy the one-line **Install bridge** command from the Setup page
3. Run it on the machine where Claude Code or Codex is running

On native Windows, run the install command in PowerShell using **Run as administrator**.

### 3. Download App

| iOS | Android | macOS | Windows |
|:---:|:---:|:---:|:---:|
| <img src="docs/assets/baton_ios.png" width="120"> | <img src="docs/assets/baton_android.png" width="120"> | <img src="docs/assets/macOS.png" width="120"> | <img src="docs/assets/windows.png" width="120"> |
| [TestFlight](https://testflight.apple.com/join/UekStGCA) | [Baton.apk](https://github.com/zhu-xiaowei/baton/releases/download/v1.0.0/Baton.apk) | [Baton.dmg](https://github.com/zhu-xiaowei/baton/releases/download/v1.0.0/Baton.dmg) | [Baton.exe](https://github.com/zhu-xiaowei/baton/releases/download/v1.0.0/Baton.exe) |

After downloading the app, scan the QR code or input the Start URL to get started.

---

## Features

- **Real-time streaming and rendering** — follow responses, tool activity, diffs, Mermaid diagrams, and LaTeX as they arrive
- **Non-intrusive workflow** — keep using Claude Code and Codex normally while a lightweight local Bridge observes and relays sessions
- **Claude Code and Codex** — browse and control both runtimes through one Device → Project → Session catalog
- **Recent projects** — browse projects across devices, with Claude Code and Codex sessions grouped by project and Codex worktree sessions grouped under their original project
- **Multi-device session control** — track running, needs input, and done states, then continue work from any connected device
- **Remote interaction** — send follow-ups while Claude Code or Codex is running, interrupt turns, answer questions, and approve or deny tool calls
- **Project terminals** — open and switch between up to five shells per project, share live terminals across devices, and restore their screens when returning (macOS / Linux Bridge)
- **Mobile terminal controls** — use an on-screen Esc / Tab / Ctrl / Shift / Alt / Paste / Enter keybar, a directional joystick, and touch scrolling
- **Multi-agent session aggregation** — keep one main session in the catalog while viewing and switching between its nested Claude Code or Codex subagents
- **Live agent status** — follow running, needs input, and completed subagents through a real-time status indicator and hierarchical thread list
- **Sessions and agents** — create Claude Code, Codex, or Claude background-agent sessions and monitor them after detaching
- **Session renaming** — select a session in the list and rename it through its native Claude Code or Codex runtime
- **Runtime-aware commands** — `/` autocomplete for Claude Code and Codex, including Codex Skills and saved prompts
- **File, image and voice input** — upload files directly to S3, send compressed images, and dictate messages from the iOS app
- **QR sign-in** — scan a Start URL directly from the native app
- **Claude usage insights** — view status, settings, rate limits, token history, and model usage charts
- **Execution timeline** — inspect collapsible tool calls and results with runtime-specific states
- **Project and artifact viewer** — browse source with line highlighting and preview HTML, Markdown, images, files, and videos
- **Download and share** — download project files and attachments using native Downloads or system sharing, with a browser fallback
- **Git workflow** — review changes, stage / unstage / discard files, commit, push or publish a branch, and browse a branch graph with historical diffs
- **Inline HTML previews** — view interactive HTML directly in conversations and expand previews to full screen without losing their state

---

## Git Workflow

Open Git from a session's toolbar or switch to it from Project Files:

- Review conflicts, staged files, and working-tree changes within the current project; stage, unstage, or discard individual files or a whole changes section.
- Write a commit message and commit staged changes. Push to the configured upstream, or publish the current branch to a configured remote, after confirming the destination.
- Expand **Graph** to inspect branch and merge topology. Choose **Auto**, **All branches**, or a local / remote branch to change the history view without checking out another branch.
- Expand a commit to inspect its changed files and historical diffs; tap its displayed hash to copy the seven-character hash.

Working-tree diffs reuse the file viewer's Diff / Code / Preview modes where applicable.
Historical diffs are read-only and do not substitute the current working-tree file for the historical version.
Git commands run on the selected device's Bridge using that machine's Git configuration and credentials.
Checkout, fetch, pull, force-push, and hunk-level staging are not exposed by this UI.

On mobile, opening the commit keyboard keeps the Git header and input in place; the first tap
outside the input only dismisses the keyboard. File viewing shares the left-side back button,
and toolbar icons use matching desktop-hover and mobile-press feedback.

## Session Control

Additional instructions can be sent while an agent is working; there is no need to stop the
current turn first. Codex uses native turn steering, while Claude Code receives the input through
its running session. The runtime decides when to consume the instruction, so this does not
guarantee immediate interruption of a running tool. Explicit stop and approval controls remain available.

To rename a session, enter selection mode in the session list, select one session, and choose
**Rename**. The Bridge updates the native session name and synchronizes the title back to Baton.

## File Attachments

The composer accepts files up to 512 MiB each. Images keep the existing compressed-image
flow; other files upload as original bytes with a presigned S3 PUT, not through Lambda.
Word, Excel and PowerPoint use the same Material Icon Theme icons as Project Files.
Files appear as small icon/name badges below image thumbnails, with progress, retry and removal.
Sending waits for every attachment to finish, and works without accompanying text.

Clicking an uploaded file reuses the file preview overlay, even before sending it.
Text uses the existing source viewer (preview reads are capped at 5 MiB); PDF and supported
media use browser previews. The viewer's **Download file** button also handles Office and other
binary files. Office content rendering is not included, and no files are sent to a third-party viewer.
The Bridge streams attachments to `~/.baton-bridge/attachments/` and passes local file paths
to the runtime; parsing still depends on the agent's tools and filesystem permissions.

The same download action is available for project files. Native macOS / Windows apps save to
Downloads, Android uses system Downloads, and iOS opens the system share sheet. Supported mobile
browsers can share files up to 50 MiB; other browser cases use the normal download flow.
Downloads show progress and prevent duplicate clicks while running.

Deploy the updated Server, Bridge and frontend together. `server/install.sh` configures the
dedicated bucket's browser CORS policy and attempts to enable S3 Transfer Acceleration.
Acceleration can incur extra AWS transfer charges; use `S3_UPLOAD_ACCELERATE=false` when
running the installer to use standard S3 only. Uploads also retry the standard S3 URL if
the accelerated endpoint fails. Signing is account-scoped, expires after one hour, and
binds the upload size and metadata. Bucket objects remain private. This does not add multipart
uploads or resumable transfers, and removed/orphaned uploads are not automatically deleted.

Attachment checks: `node --test test/bridge/attachments.test.mjs test/frontend/attachments.test.mjs`,
`python3 -m pytest test/server/test_attachments.py`, and `node test/browser/attachments-chrome.mjs`.
The Chrome check uses isolated local S3-like endpoints (no AWS account), uploads an 8 MiB file,
and saves desktop/mobile screenshots in `.test-runs/`.

## Multi-agent Sessions

Baton groups a multi-agent task under its main session instead of listing every worker separately. Open a session's runtime icon to inspect its **Subagents**:

- nested agents form a parent-child tree, including multi-level delegation when the runtime exposes parent metadata
- each thread shows its task, identity, size, last activity, and running / needs input / done state
- the status dot is green while any subagent runs, yellow when one needs input, gray once all finish
- updates arrive over a root-session WebSocket subscription, so the list and status refresh without reloading

Claude Code and Codex share this UI. Nesting depth depends on the runtime; Codex, for example, controls recursive delegation with `agents.max_depth`.

---

## Architecture

```
┌────────────────┐               ┌────────────────┐               ┌──────────────────┐
│     Bridge     │ ◀────WS─────▶ │     Server     │ ◀────WS─────▶ │     App/Web      │
│ (local hosts)  │               │  (AWS APIs)    │               │  (phone/desktop) │
└────────────────┘               └───────┬────────┘               └──────────────────┘
                                         │
                                         ▼
                                 ┌────────────────┐
                                 │ DynamoDB + S3  │
                                 │ (data + media) │
                                 └────────────────┘
```

**Bridge** discovers Claude Code and Codex sessions, normalizes their events, preserves main/subagent relationships, and handles local agent control, project files, Git commands, and terminal processes. **Server** authenticates and routes control messages, stores session and root-thread data in DynamoDB, and serves synced media through S3. **App/Web** loads cached history, subscribes to session and root-agent updates, aggregates nested threads under the main session, and routes user actions back to the correct local runtime.

With the updated Server, Bridge, and frontend, eligible live chat events use a signed API Gateway
data path that bypasses Lambda per event; this is still an AWS relay, not a peer-to-peer connection.
Commands, file / Git requests, and durable history retain the control and storage paths, with
control-channel fallback for live events when needed. See [realtime transport](docs/realtime-direct.md)
and [running-session input](docs/steer.md) for the deployment requirements and behavior.

---

## Uninstall

See the [uninstall guide](scripts/uninstall/README.md).

---

## License

MIT
