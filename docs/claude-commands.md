# Claude Code command support

AgentPeek does not use this document as a command manifest. At runtime, the Bridge asks the
installed Claude Code for its `initialize.commands` and `initialize.models`, then preserves the
returned descriptions, argument hints, aliases, provider filtering, and model order. Custom
commands and Skills therefore follow each user's environment.

This is an implementation audit against Claude Code `2.1.233` on 2026-08-15. The clean TUI exposed
54 built-in commands. Later Claude Code versions may add or remove commands without an AgentPeek
release; unknown headless commands remain usable as normal prompt/Skill entries unless explicitly
filtered.

## Status definitions

| Status | Meaning |
|---|---|
| Full | The primary command effect is available end to end. |
| Reduced | Useful behavior is available, but a TUI-only view, editor, or management action is omitted. |
| Filtered | Claude exposes the command to headless, but AgentPeek deliberately hides it. |
| TUI-only | Claude does not expose an executable headless entry and AgentPeek has no replacement. |

## TUI built-ins

| Command | Status | AgentPeek behavior or reason |
|---|---|---|
| `/add-dir` | TUI-only | Working-directory management UI is not exposed by headless. |
| `/agents` | Filtered | Current runtime marks this entry removed. Runtime agent sessions remain visible in AgentPeek. |
| `/autocompact` | Reduced | Native command works with typed `auto` or token value; no TUI slider/picker. |
| `/background` | TUI-only | Moves ownership to a terminal background worker; no equivalent phone action. |
| `/branch` | TUI-only | Conversation branching UI is not exposed by headless. |
| `/btw` | TUI-only | Side-question overlay depends on TUI conversation state. |
| `/bug` | TUI-only | Anthropic feedback form is not exposed by headless. |
| `/cd` | TUI-only | Session working-directory picker is not exposed by headless. |
| `/clear` | Filtered | It changes session identity; sending it headlessly would desynchronize AgentPeek's session mapping. |
| `/color` | Filtered | Changes only the terminal prompt bar. |
| `/compact` | Full | Executes through the active headless session and streams the compaction result. |
| `/config` | Reduced | Bare command opens Config data; `key=value` uses Claude's native write. TUI setting pickers are not replicated. |
| `/context` | Reduced | Returns Claude's context report as terminal-style output rather than the interactive colored-grid view. |
| `/copy` | TUI-only | Reads the terminal renderer's response history/clipboard. |
| `/diff` | TUI-only | Per-turn TUI diff browser is not exposed by headless. |
| `/effort` | Full | Live values come from the current command hint and open a second-level picker. |
| `/exit` | TUI-only | Terminal lifecycle action; intentionally absent from the remote catalog. |
| `/export` | TUI-only | TUI file/clipboard export flow is not exposed by headless. |
| `/feedback` | TUI-only | Anthropic feedback form is not exposed by headless. |
| `/focus` | TUI-only | Terminal presentation mode only. |
| `/fork` | TUI-only | Background-session fork UI is not exposed by headless. |
| `/goal` | Full | Current runtime command is sent through the active Claude session. |
| `/help` | TUI-only | Terminal help overlay; the slash list itself is available in AgentPeek. |
| `/hooks` | TUI-only | Claude's hook detail panel is not exposed by headless. |
| `/ide` | TUI-only | Manages local IDE integrations. |
| `/keybindings` | TUI-only | Opens the local keyboard-shortcuts file/editor. |
| `/login` | TUI-only | Local authentication wizard. |
| `/mcp` | Reduced | Native list/reconnect/enable/disable syntax works; auth, details, and interactive management pages are omitted. |
| `/memory` | TUI-only | Multi-file CLAUDE.md editor is not exposed by headless. |
| `/mobile` | TUI-only | Displays a terminal QR code for Claude's mobile app. |
| `/model` | Full | Models, descriptions, values, and order come from live `initialize.models`; selection changes the current session only. |
| `/permissions` | TUI-only | Allow/Ask/Deny rule editor and scope management are not implemented. |
| `/plan` | TUI-only | TUI plan-mode page is not exposed as a command entry. |
| `/plugin` | TUI-only | Marketplace, authentication, install, and uninstall flows are not implemented. |
| `/powerup` | TUI-only | Interactive terminal tutorial. |
| `/recap` | Full | Current runtime command is sent through the active Claude session. |
| `/release-notes` | TUI-only | Terminal release-notes viewer. |
| `/reload-plugins` | TUI-only | Current headless catalog does not expose it. |
| `/reload-skills` | Full | Reloads command/Skill files in the active session. |
| `/rename` | Full | Composes a name and executes Claude's native session rename. |
| `/resume` | TUI-only | AgentPeek already provides session navigation; the TUI resume browser is not embedded. |
| `/rewind` | TUI-only | Code/conversation checkpoint browser and destructive confirmation are not implemented. |
| `/sandbox` | TUI-only | Local sandbox configuration wizard. |
| `/setup-bedrock` | TUI-only | Local provider authentication/region wizard. |
| `/skills` | Reduced | The TUI Skill browser is omitted, but every invocable Skill returned by `initialize.commands` appears and runs directly. |
| `/status` | Reduced | Opens the Status tab with live version/session/provider/model/mode/settings data; CC's private API/tool diagnostics are unavailable. |
| `/stickers` | TUI-only | External merchandise flow. |
| `/subtask` | TUI-only | TUI side-task lifecycle is not exposed by headless. |
| `/tasks` | TUI-only | Background task list/detail/stop UI is not implemented. |
| `/terminal-setup` | TUI-only | Modifies local terminal key bindings. |
| `/theme` | TUI-only | Changes the local terminal theme. |
| `/tui` | TUI-only | Changes the local terminal renderer. |
| `/usage` | Reduced | Four tabs are implemented. Stats is independently derived from JSONL; Config is view + typed write, not the TUI toggle editor. |
| `/workflows` | TUI-only | Running/completed workflow browser is not exposed by headless. |

## Conditional headless commands

These entries are supplied by `initialize.commands` but were not present in the 54-item clean TUI
snapshot above:

| Command | Status | AgentPeek behavior |
|---|---|---|
| `/init` | Full | Initializes CLAUDE.md through the active Claude session when the runtime offers it. |
| `/fast` | Full | Opens a live on/off picker only when the current provider/account enables fast mode. |

## Runtime commands and aliases

- Bundled, user, project, and plugin commands/Skills returned by `initialize.commands` are shown with
  Claude's exact description and argument hint. They execute as prompts unless Claude identifies a
  supported local command signature.
- `/cost` and `/stats` open the Usage and Stats tabs. `/settings` and bare `/config` open Config.
  These aliases remain hidden from the menu when Claude hides them, matching the TUI.
- A custom command that shadows names such as `model`, `usage`, or `status` keeps custom prompt
  semantics; AgentPeek does not replace it with a built-in picker or panel.
- If `initialize` is unavailable on an old Claude Code version, disk fallback discovers only custom
  commands and Skills. It does not invent an obsolete static built-in list.

## Settings panel data

- **Status:** current session JSONL plus live `initialize` and `get_settings`.
- **Config:** redacted `get_settings` values and sources. Secret-like keys never leave the Bridge.
- **Usage:** live `get_usage`; historical token fields fall back to the selected session JSONL.
- **Stats:** Worker-thread, read-only aggregation of `~/.claude/projects/**/*.jsonl`, excluding
  sidechains and duplicate assistant message IDs. Models includes a token-over-time coordinate
  chart plus the complete ranked model list; 7/30-day ranges use daily buckets and all-time adapts
  to month/quarter/year buckets.

The panel is not persisted to Claude JSONL or DynamoDB. A bounded response is sent over WebSocket;
very large settings catalogs are marked `truncated` instead of exceeding the transport frame limit.
