# <sub><picture><source media="(prefers-color-scheme: dark)" srcset="web/public/assets/baton-logo.svg"><img src="web/public/assets/baton-logo-dark.svg" width="36" height="36" alt=""></picture></sub>Baton

**English** | [中文](README.zh-CN.md) | [Español](README.es-ES.md)

Pick up your [Claude Code](https://github.com/anthropics/claude-code), [Codex](https://openai.com/codex) and other coding-agent tasks on your phone, right where you left off on your computer.

<p align="center">
  <img src="docs/assets/promo.avif" alt="Baton" width="100%">
</p>

Baton provides non-intrusive, real-time streaming and rendering for Claude Code, Codex, Pi, Hermes, OpenCode, Kiro and DeepSeek Harness sessions across your devices. Everything is end-to-end encrypted and your conversations stay on your own computer.


## Quick Start

### 1. Install Bridge

On the computer where your agents run:

```bash
curl -fsSL https://agentbaton.app/install | bash
```

<details>
<summary>Windows</summary>

In PowerShell, using **Run as administrator**:

```powershell
irm https://agentbaton.app/install.ps1 | iex
```

</details>

### 2. Get the App and scan

| iOS | Android | HarmonyOS | macOS | Windows | Linux |
|:---:|:---:|:---:|:---:|:---:|:---:|
| <img src="docs/assets/baton_ios.avif" width="88" alt="iOS"> | <img src="docs/assets/baton_android.avif" width="88" alt="Android"> | <img src="docs/assets/harmonyos.avif" width="88" alt="HarmonyOS"> | <img src="docs/assets/macOS.avif" width="88" alt="macOS"> | <img src="docs/assets/windows.avif" width="88" alt="Windows"> | <img src="docs/assets/linux.avif" width="88" alt="Linux"> |
| [TestFlight](https://testflight.apple.com/join/UekStGCA) | [Baton.apk](https://github.com/zhu-xiaowei/baton/releases) | [Build & install](harmony/README.md) | [Baton.dmg](https://github.com/zhu-xiaowei/baton/releases) | [Baton.exe](https://github.com/zhu-xiaowei/baton/releases) | [Baton.deb](https://github.com/zhu-xiaowei/baton/releases) |

Scan the QR code the installer printed, or open [web.agentbaton.app](https://web.agentbaton.app) in a browser. The first scan creates your account; to add another computer, install Bridge there and scan its QR code.

---

### Developer tools

<p align="center">
  <picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/project-files.avif" width="48%"><img src="docs/assets/showcase/project-files.avif" alt="Project files" width="24%"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/empty.svg" width="2%" height="0"><img src="docs/assets/showcase/empty.svg" alt="" width="1%" height="0"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/git.avif" width="48%"><img src="docs/assets/showcase/git.avif" alt="Git changes" width="24%"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/tools-mobile.svg" width="100%"><img src="docs/assets/showcase/empty.svg" alt="" width="1%"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/terminal.avif" width="48%"><img src="docs/assets/showcase/terminal.avif" alt="Mobile terminal" width="24%"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/empty.svg" width="2%" height="0"><img src="docs/assets/showcase/empty.svg" alt="" width="1%" height="0"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/remote-preview.avif" width="48%"><img src="docs/assets/showcase/remote-preview.avif" alt="Remote preview" width="24%"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/tools-mobile-second.svg"><img src="docs/assets/showcase/tools-desktop.svg" alt="" width="100%"></picture>
</p>

### Rich rendering

<p align="center">
  <picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/permissions.avif" width="48%"><img src="docs/assets/showcase/permissions.avif" alt="Permission approvals" width="24%"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/empty.svg" width="2%" height="0"><img src="docs/assets/showcase/empty.svg" alt="" width="1%" height="0"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/mermaid.avif" width="48%"><img src="docs/assets/showcase/mermaid.avif" alt="Mermaid diagrams" width="24%"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/rendering-mobile.svg" width="100%"><img src="docs/assets/showcase/empty.svg" alt="" width="1%"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/inline-html.avif" width="48%"><img src="docs/assets/showcase/inline-html.avif" alt="Inline HTML preview" width="24%"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/empty.svg" width="2%" height="0"><img src="docs/assets/showcase/empty.svg" alt="" width="1%" height="0"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/file-preview.avif" width="48%"><img src="docs/assets/showcase/file-preview.avif" alt="File preview" width="24%"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/rendering-mobile-second.svg"><img src="docs/assets/showcase/rendering-desktop.svg" alt="" width="100%"></picture>
</p>

---

## Features

### Core

- **Seven agents** — Claude Code, Codex, Pi, Hermes, OpenCode, Kiro, and DeepSeek Harness in one Device → Project → Session catalog
- **Real-time streaming** — responses, thinking, and tool calls appear as they are generated
- **Follow existing sessions** — keep using Claude Code and Codex on your computer as usual; a lightweight local Bridge mirrors live progress and running / needs input / done status
- **Interact with existing sessions** — send follow-ups, even mid-turn, interrupt running turns, and continue work from any connected device
- **Create projects and sessions** — create a new project, start Claude Code, Codex, or Claude background-agent sessions remotely, and keep monitoring them after detaching
- **Permissions and questions** — approve or deny tool calls, answer questions, and review plans, including Codex command, file, and MCP approvals
- **Slash commands and Skills** — `/` autocomplete for each runtime's built-in and custom commands, Codex Skills, and saved prompts
- **Codex Goals** — set, pause, resume, or clear thread goals with `/goal`, and follow autonomous continuation turns in real time
- **Subagents** — nested Claude Code and Codex subagents grouped under their main session, with live status and a hierarchical thread list
- **Mobile notifications** — receive iOS and Android alerts when a session finishes or needs input; tap an alert to open the session (Android alerts on the hosted service are coming)
- **Private by design** — end-to-end encrypted; conversations stay on your computer and the server only relays them; use the hosted service or self-host on AWS

### Developer tools

- **Project files** — browse source with line highlighting, and download or share files natively
- **Git** — review changes, stage / unstage / discard files, commit, push or publish a branch, and browse a branch graph with historical diffs
- **Terminals** — up to five shells per project, shared live across devices and restored when you return, with a mobile keybar, a long-press arrow joystick that auto-repeats faster the farther you drag, and smooth momentum scrolling (macOS / Linux Bridge)
- **Localhost previews** — open the Bridge machine's `http://localhost:3000` (or any local port) inside the native App by tapping a session link or entering the port, with no SSH, port forwarding, or public exposure

### Fast, stable, lightweight

- **Native-like App** — the native splash hands off seamlessly to matching skeleton screens at every stage with no white flash, and edge-swipe back reveals the previous page underneath
- **Light and dark themes** — choose System, Light, or Dark in Settings; the interface, code, diagrams, and native app appearance update together
- **Adjustable page size** — change font size on mobile or use desktop zoom shortcuts; your choice persists across pages and app restarts
- **Instant loading** — lists, history, and project data open from local page caches, then refresh in the background
- **Stable delivery** — ordered streaming, automatic reconnect, and queued sends keep sessions intact on flaky mobile networks and after backgrounding the App
- **Lightweight Apps** — small Tauri-based native packages, plus an ArkWeb shell for HarmonyOS NEXT
- **Zero-maintenance Bridge** — runs always-on across macOS, Linux, and Windows, connects multiple computers to one account, and updates itself

### Rich rendering

- **Execution timeline** — collapsible tool calls and results, with full output loaded on demand
- **Diffs, Mermaid, and LaTeX** — rendered inline while streaming; copy source and download as images
- **Inline HTML in conversations** — interactive previews, expandable to full screen without losing their state
- **File previews** — Markdown, HTML, PDF, Office, image, and video files from projects or messages; HTML pages load their relative CSS, scripts, and images, so they render fully without a local server; images in messages display inline and open full screen with pinch-to-zoom

### More

- **File, image, and voice input** — attach files, drag and drop files or images on desktop, send compressed images, and dictate messages on iOS
- **Session drafts** — keep text and uploaded attachments when switching sessions or reopening the App on the same device
- **Session management** — rename sessions through their native runtime, and long-press to multi-select and delete sessions or projects, optionally removing their local files
- **Pairing and devices** — add computers and phones by QR code, remove a device (which replaces the encryption key), and recover your account with a recovery phrase
- **API key rotation** — rotate the API key with `--rotate-key` while preserving existing data
- **macOS tabs** — work on multiple sessions in independent tabs
- **Claude usage insights** — status, settings, rate limits, token history, and model usage charts

---

## Architecture

```
┌────────────────┐               ┌──────────────────────┐               ┌──────────────────┐
│     Bridge     │ ◀────WS─────▶ │        Relay         │ ◀────WS─────▶ │     App/Web      │
│ (local hosts)  │               │                      │               │  (phone/desktop) │
└────────────────┘               └──────────┬───────────┘               └──────────────────┘
                                            │
                                            ▼
                                 ┌──────────────────────┐
                                 │ accounts + devices,  │
                                 │ 1-day file transfer  │
                                 └──────────────────────┘
```

**Bridge** discovers agent sessions, normalizes their events, preserves main/subagent relationships, and handles local agent control, project files, Git commands, and terminal processes. **Relay** authenticates the devices of one account and forwards their end-to-end encrypted messages; it keeps only account, device and token records (sessions stay on your computer) and a 1-day transfer area for files. **App/Web** loads cached history, subscribes to session and root-agent updates, aggregates nested threads under the main session, and routes user actions back to the correct local runtime.

---

## Self-hosting (AWS)

Run your own server in your AWS account instead of the hosted service.

### 1. Deploy Server

Requires [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) with permissions to create CloudFormation stacks.

```bash
curl -fsSL https://raw.githubusercontent.com/zhu-xiaowei/baton/main/server/install.sh | bash
```

Takes ~6-8 minutes. Prints a **Start URL** and QR code on success. Supports `--region`, `--stack`, `--profile` options (pass after `bash -s --`).


### 2. Install Bridge

1. Open the **Start URL** in your browser (this is also the web viewer)
2. Copy the one-line **Install bridge** command from the Setup page
3. Run it on the machine where Claude Code or Codex is running

On native Windows, run the install command in PowerShell using **Run as administrator**.

Then get the App above and scan the QR code or input the Start URL.

---

## Why Baton?

Named after both a relay baton and a conductor's baton, Baton lets you pick up work on another device and direct your agents remotely.

---

## Uninstall

See the [uninstall guide](scripts/uninstall/README.md).

---

## License

MIT
