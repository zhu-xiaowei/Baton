# <img src="web/public/assets/baton-app-icon.svg" width="32" alt=""> Baton

Monitor and control your [Claude Code](https://github.com/anthropics/claude-code) and Codex sessions from your phone, tablet, or another computer.

<p align="center">
  <img src="docs/assets/promo.avif" alt="Baton" width="100%">
</p>

Baton connects your local agent runtimes to a self-hosted AWS serverless backend (Lambda + DynamoDB + API Gateway). Session data stays in your own AWS account while updates and controls remain available across devices.

## Why Baton

The name has two meanings:

- **Relay baton** — continue following progress and working from your phone after starting on your computer.
- **Conductor's baton** — direct and control local agents from Baton, even when the desktop UI is not in front of you.

## Quick Start

### 1. Deploy Server

Requires [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) with permissions to create CloudFormation stacks.

```bash
curl -fsSL https://raw.githubusercontent.com/zhu-xiaowei/baton/main/server/install.sh | bash
```

Takes ~6-8 minutes. Prints a **Start URL** and QR code on success. Supports `--region`, `--stack`, `--profile` options (pass after `bash -s --`).


### 2. Install Bridge

Requires [Node.js](https://nodejs.org/) >= 20.

1. Open the **Start URL** in your browser (this is also the web viewer)
2. Copy the one-line **Install bridge** command from the Setup page
3. Run it on the machine where Claude Code or Codex is running

### 3. Download App

| iOS | Android | macOS | Windows |
|:---:|:---:|:---:|:---:|
| <img src="docs/assets/baton_ios.png" width="120"> | <img src="docs/assets/baton_android.png" width="120"> | <img src="docs/assets/macOS.png" width="120"> | <img src="docs/assets/windows.png" width="120"> |
| Coming soon | Coming soon | Coming soon | Coming soon |

Baton is being prepared as a new app under `com.batonai.app`. Store and binary download links will be added with the first public release. The browser viewer remains available from the Start URL.

---

## Features

- **Multi-device browsing** — list all connected devices, projects, and sessions at a glance
- **Claude Code and Codex** — browse both runtimes through one Device → Project → Session catalog
- **Real-time session view** — follow agent output through WebSocket as work happens
- **Session status** — running (green) / needs input (amber) / done (gray)
- **Send messages** — continue an existing session or start a new turn from phone or desktop
- **Slash commands** — runtime-aware `/` autocomplete for Claude Code and Codex, including Codex Skills and saved prompts
- **Send images** — paste or pick photos, compressed and delivered to the local runtime
- **Claude Agents support** — monitor and interact with `claude agents` background sessions
- **Permission approval** — answer questions and approve or deny tool calls remotely
- **Create sessions** — launch new Claude Code, Codex, or Claude background-agent sessions
- **Code diff rendering** — inline diffs with syntax highlighting for file changes
- **Project file viewer** — click a file to sync and view its source, with line highlight & jump; rendered preview for HTML and Markdown
- **Markdown support** — full GFM rendering for Claude's responses
- **Execution nodes** — collapsible tool_use/tool_result blocks showing what Claude did
- **Dark theme UI** — clean, mobile-optimized interface that works on any screen size

---

## Architecture

```
┌────────────────┐               ┌────────────────┐               ┌──────────────────┐
│     Bridge     │ ◀────WS─────▶ │     Server     │ ◀────WS─────▶ │     App/Web      │
│  (EC2, Mac)    │               │  (AWS Lambda)  │               │  (phone/desktop) │
└────────────────┘               └───────┬────────┘               └──────────────────┘
                                         │
                                         ▼
                                 ┌────────────────┐
                                 │   DynamoDB     │
                                 │(metadata + msg)│
                                 └────────────────┘
```

**Bridge** discovers Claude Code and Codex sessions, normalizes their events, and handles local agent control. **Server** relays real-time messages to connected clients and caches history in DynamoDB. **App/Web** loads cached history, subscribes to live updates, and routes user actions back to the correct local runtime.

---

## License

MIT
