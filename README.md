# AgentPeek 🔭

<p align="center">
  <img src="docs/assets/promo.avif" alt="AgentPeek" width="100%">
</p>

View and interact with your [Claude Code](https://github.com/anthropics/claude-code) sessions from anywhere — phone, tablet, or another computer.

```
┌────────────────┐               ┌────────────────┐               ┌──────────────────┐
│     Bridge     │ ◀────WS─────▶ │     Server     │ ◀────WS─────▶ │     App/Web      │
│  (EC2, Mac)    │               │  (AWS Lambda)  │               │  (phone/desktop) │
└────────────────┘               └────────────────┘               └──────────────────┘
```

**Bridge** watches Claude Code session files on your machine, **Server** relays messages via WebSocket, **App** renders the conversation with full markdown/diff/image support and lets you send messages back.

---

## Quick Start

### 1. Deploy Server

Requires [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) with permissions to create CloudFormation stacks.

```bash
curl -fsSL https://raw.githubusercontent.com/zhu-xiaowei/agentpeek/main/server/install.sh | bash
```

Prints a **Start URL** and QR code on success. Supports `--region`, `--stack`, `--profile` options (pass after `bash -s --`).


### 2. Install Bridge

**Prerequisites:**
- [Node.js](https://nodejs.org/) >= 20
- [tmux](https://github.com/tmux/tmux/wiki/Installing) (required for sending messages back to Claude Code)

Open the Start URL in a browser → copy the one-line **Install bridge** command from the Setup page → run it on the machine where Claude Code is running.

### 3. Download App

| Platform | Download |
|----------|----------|
| Android  | [AgentPeek.apk](https://github.com/zhu-xiaowei/agentpeek/releases/download/0.2.0/AgentPeek.apk) |
| macOS    | [AgentPeek.dmg](https://github.com/zhu-xiaowei/agentpeek/releases/download/0.2.0/AgentPeek.dmg) |
| iOS      | Coming soon |
| Windows  | Coming soon |

You can also use the web viewer directly — no app install needed.

---

## Features

- **Multi-device browsing** — list all connected devices, projects, and sessions at a glance
- **Real-time session view** — ultra-fast sync via WebSocket as Claude Code works
- **Session status** — running (green) / idle (yellow) / stopped (gray) indicators
- **Send messages** — type prompts directly from phone or desktop, delivered via tmux
- **Send images** — paste or pick photos, compressed & uploaded to S3, read by Claude Code
- **Permission approval** — approve or deny tool calls (Bash, Edit, Write) remotely
- **Start / stop sessions** — launch new Claude Code sessions or interrupt running ones
- **Code diff rendering** — inline diffs with syntax highlighting for file changes
- **Markdown support** — full GFM rendering for Claude's responses
- **Execution nodes** — collapsible tool_use/tool_result blocks showing what Claude did
- **Dark theme UI** — clean, mobile-optimized interface that works on any screen size

---

## License

MIT
