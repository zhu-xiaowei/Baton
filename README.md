# 🔭 AgentPeek

View and interact with your [Claude Code](https://github.com/anthropics/claude-code) sessions from anywhere — phone, tablet, or another computer.

<p align="center">
  <img src="docs/assets/promo.avif" alt="AgentPeek" width="100%">
</p>

AgentPeek is built on AWS serverless (Lambda + DynamoDB + API Gateway) with zero intrusion to Claude Code. All data stays in your own AWS account — fast, real-time, and always in sync.

## Quick Start

### 1. Deploy Server

Requires [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) with permissions to create CloudFormation stacks.

```bash
curl -fsSL https://raw.githubusercontent.com/zhu-xiaowei/agentpeek/main/server/install.sh | bash
```

Takes ~6-8 minutes. Prints a **Start URL** and QR code on success. Supports `--region`, `--stack`, `--profile` options (pass after `bash -s --`).


### 2. Install Bridge

Requires [Node.js](https://nodejs.org/) >= 20.

1. Open the **Start URL** in your browser (this is also the web viewer)
2. Copy the one-line **Install bridge** command from the Setup page
3. Run it on the machine where Claude Code is running

### 3. Download App

| iOS | Android | macOS | Windows |
|:---:|:---:|:---:|:---:|
| <img src="docs/assets/agentpeek_ios.png" width="120"> | <img src="docs/assets/agentpeek_android.png" width="120"> | <img src="docs/assets/macOS.png" width="120"> | <img src="docs/assets/windows.png" width="120"> |
| [TestFlight](https://testflight.apple.com/join/jJ4KQWjZ) | [AgentPeek.apk](https://github.com/zhu-xiaowei/agentpeek/releases/download/v0.2.0/AgentPeek.apk) | [AgentPeek.dmg](https://github.com/zhu-xiaowei/agentpeek/releases/download/v0.2.0/AgentPeek.dmg) | [AgentPeek.exe](https://github.com/zhu-xiaowei/agentpeek/releases/download/v0.2.0/AgentPeek.exe) |

After downloading the app, scan the QR code or input the Start URL to get started.

---

## Features

- **Multi-device browsing** — list all connected devices, projects, and sessions at a glance
- **Real-time session view** — ultra-fast sync via WebSocket as Claude Code works
- **Session status** — running (green) / idle (yellow) / stopped (gray) indicators
- **Send messages** — type prompts directly from phone or desktop, delivered via a headless Claude Code process
- **Slash commands** — `/`-autocomplete just like the Claude Code terminal, listing your user, project, and plugin commands
- **Send images** — paste or pick photos, compressed & uploaded to S3, read by Claude Code
- **Claude Agents support** — monitor and interact with `claude agents` background sessions
- **Permission approval** — approve or deny tool calls (Bash, Edit, Write) remotely
- **Start / stop sessions** — launch new Claude Code or Agent sessions from anywhere
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

**Bridge** watches Claude Code session files and pushes messages via WebSocket. **Server** relays real-time messages to connected clients and caches them in DynamoDB. **App** loads session history from DDB on open (instant, <100ms) for performance and offline availability, then subscribes via WebSocket for real-time updates.

---

## License

MIT
