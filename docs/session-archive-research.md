# Session 状态与归档：官方文档研究

> 核心结论：运行活动、单次执行结果、归档是独立维度。Claude Code 的后台 `state`、存活进程 `status`，以及 Codex 的 `Thread.status`、`Turn.status` 不能直接视为同一种枚举。[S1][O1]

核对日期：2026-09-16。范围是本地 Claude Code CLI、Agent SDK、Codex App Server，以及桌面/网页归档的产品边界。通过 HTTPS 获取官方页面正文，不依赖搜索摘要。Claude 枚举按本次在线文档，未验证本机 Claude 版本；Codex 另以本机 CLI 0.154.0 生成协议交叉核对。旧版本需单独验证。

## Claude Code：已核实事实

**结论：不能把完成、进程退出、会话结束和归档合并。也没有从所查文档中得到一个覆盖所有 Claude Code 历史会话的统一 `session.status`。** CLI 实时清单、后台工作状态、SDK 消息和历史元数据是不同接口。[S1][S2][S4]

### 1. 本地 CLI：两个不同的状态字段

官方明确支持用 `claude agents --json --all` 从外部读取状态。默认列表包含存活会话，以及进程已退出但仍 working/blocked 的后台会话；`--all` 还包含已完成的后台会话，并非所有历史 transcript 的清单。[S1]

| 接口字段 | 官方值 | 适用范围／含义 |
| --- | --- | --- |
| `kind` | `interactive`、`background` | 会话种类，不是状态 |
| `state` | `working`、`blocked`、`done`、`failed`、`stopped` | 后台会话才有 |
| `status` | `busy`、`waiting`、`idle` | 进程存活时才有，与 `pid` 一起出现 |
| `waitingFor` | 等待原因文本 | `status=waiting` 时提供，不当作稳定枚举 |

以上字段均来自 [S1]。`working` 包括正在执行及自主工作步骤之间的等待，未必此刻 busy；`blocked` 是继续执行前需要用户帮助；`done` 是上一轮完成、可接收下一条提示，进程可以仍存活。`failed` 是错误结束，`stopped` 是被停止。普通“回复完成，等待下一条提示”是 done，不是 blocked。[S1]

官方警告 `~/.claude/jobs/<id>/` 文件不是稳定接口，不应把其中字段视为公开状态协议。[S1]

### 2. Agent SDK：历史元数据不等于运行事件

`listSessions()` / `getSessionInfo()` 的 `SDKSessionInfo` 列出 `sessionId`、`summary`、`lastModified`、`fileSize`、`customTitle`、`firstPrompt`、`gitBranch`、`cwd`、`tag`、`createdAt`；**该类型未列 `status` 或 `archived`**。这只说明所查公开元数据接口缺少字段，不证明内部没有归档状态。[S4]

| 消息／字段 | 精确值或事件名 | 不能混淆的边界 |
| --- | --- | --- |
| `type=result` 的 `subtype` | `success`、`error_max_turns`、`error_during_execution`、`error_max_budget_usd`、`error_max_structured_output_retries` | agent loop 的结果；还应读取 `is_error`，不是会话归档状态 |
| `type=system, subtype=status` 的 `status` | `compacting`、`null` | 压缩过程状态，不是 CLI 的 busy/waiting/idle |
| `type=system, subtype=task_notification` 的 `status` | `completed`、`failed`、`stopped` | `task_id` 对应的后台 Bash、子 agent 等任务结果，不代表父会话结束 |
| system 生命周期消息的 `subtype`，举例 | `init`、`compact_boundary`、`informational`、`worker_shutting_down` | 初始化、压缩、提示、宿主退出等事件，不是可互换的 session 状态枚举 |

前三行见 [S4]，末行见 [S5]。`result` 后仍可能有尾随 system 消息；会话历史可经 continue/resume 继续，因此“收到 result”不等于会话不可恢复。[S5][S6]

当前 TypeScript 页面还在 `SDKMessage` 联合类型中列出 `SDKSessionStateChangedMessage`，但未展开其字段或枚举；**不能仅凭类型名推断它提供 canonical `session.status` 或归档字段**。这是本次文档证据缺口，不作运行时猜测。[S4]

### 3. Hooks：事件、原因与通知，不是持久状态

| Hook／字段 | 当前官方值／触发条件 |
| --- | --- |
| `SessionStart.source` | `startup`、`resume`、`clear`、`compact`、`fork` |
| `SessionEnd.reason` | `clear`、`resume`、`logout`、`prompt_input_exit`、`other` |
| `Stop` | 主 agent 回复完成；用户中断不触发，API 错误改触发 `StopFailure` |
| `Notification.notification_type` | 通知类别；见下文，不是 session 状态 |

上表见 [S3]。`SessionStart` 的 fork 在 v2.1.214 前报告 resume；`SessionEnd` 的旧值 `bypass_permissions_disabled` 已于 v2.1.234 移除。`Stop` 可以被 hook 阻止并继续运行，`stop_hook_active` 帮助防止循环。因此 Stop 不是永久结束；SessionEnd 也可能只是 `/clear` 或切换会话，不能当作归档证据。[S3]

当前 Notification 表包括：`permission_prompt`、`idle_prompt`、`auth_success`、`elicitation_dialog`、`elicitation_url_dialog`、`elicitation_complete`、`elicitation_response`、`agent_needs_input`、`agent_completed`、`quota_auto_resume_fired`、`quota_auto_resume_stale`、`quota_auto_resume_disabled`。`idle_prompt` 是回复完成约 60 秒仍未输入的延时通知；`agent_completed` 也可表示失败，且后台 agent 通知受 agent view 是否在终端打开等条件限制。不能用“没收到通知”反推出状态。[S3]

### 4. 归档到底属于哪个产品？

- **本地 CLI／SDK**：所查公开接口未给通用 `archived` 标志或归档查询协议。官方 sessions 页说 SessionEnd hook 可以自行归档 transcript，指自定义处理，不是宣布内置 archived 状态。transcript JSONL 格式明确属于内部格式；`claude rm` 移出后台清单后，transcript 仍可通过 `--resume` 恢复。[S1][S2]
- **Claude Desktop Code tab**：有归档按钮、PR 合并／关闭后自动归档；自动归档仅适用于已运行完成的本地会话。桌面跨会话功能默认跳过归档会话，但不包含终端 CLI／VS Code 启动的会话。页面没有给出供本地 bridge 查询的归档字段协议。[S7]
- **Claude Code on the web**：归档后默认隐藏，可筛选查看。`--cloud <id> --output-format json` 的发送失败结果可以反映目标已归档，但这是云会话操作结果，不是本地历史会话的归档查询接口。[S8]
- **Claude Managed Agents**：独立云产品。当前文档的 `status` 是 `idle | running | rescheduling | terminated`；归档或不可恢复错误均可导致 terminated。不能把它套给 Claude Code CLI，甚至不能仅凭 terminated 判断归档。[S9]

## Codex：Thread、Turn 与归档是三个维度

### 官方文档明确列出的运行状态

Codex App Server 的持久对话对象称为 `Thread`；一次用户输入触发的执行称为 `Turn`。不要将一次执行结束等同于整段对话结束。[O1：Overview / Core primitives]

`thread/read` 返回 `thread.status`，`thread/status/changed` 推送已加载 thread 的运行状态变化：[O1：Read a stored thread / Track thread status changes]

| `ThreadStatus.type` | 含义 | 不能据此推出 |
|---|---|---|
| `notLoaded` | thread 未加载到此 App Server 的运行内存 | 已归档、已删除，或另一执行端没有在运行 |
| `idle` | 空闲 | 永久完成或已归档 |
| `active` | 活跃，另附 `activeFlags` | 一定正在生成文本；可能在等待交互 |
| `systemError` | 系统错误状态 | 已归档 |

官方文档展示 `activeFlags: ["waitingOnApproval"]`。另外按文档建议使用**本机 Codex CLI 0.154.0**导出的 TypeScript 协议，核对出完整枚举为 `waitingOnApproval | waitingOnUserInput`。后者是版本绑定的生成协议证据，不冒称网页已经穷举所有 flag。[O1：Schemas / Track thread status changes；O2]

```ts
// codex-cli 0.154.0 生成协议的相关字段摘录
type ThreadStatus =
  | { type: "notLoaded" }
  | { type: "idle" }
  | { type: "systemError" }
  | { type: "active"; activeFlags: ThreadActiveFlag[] };
type ThreadActiveFlag = "waitingOnApproval" | "waitingOnUserInput";
type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";
```

`Turn.status` 的 `inProgress` 对应执行中，`completed` / `interrupted` / `failed` 对应正常完成 / 中断 / 失败。特别注意：事件名 `turn/completed` 并不意味着成功，仍需检查 payload 中的 `turn.status`。[O1：Turn events；O2]

### 如何确认已归档

归档与上面两组状态独立：不能通过 `completed`、`idle`、`notLoaded` 或 `thread/closed` 推断 `archived`。[O1：Unsubscribe from a loaded thread / Archive a thread]

- **初始快照 / 重连校准**：分页调用 `thread/list`，设置 `archived: true` 查询归档集合；`false` 或省略时只返回未归档集合。应保证 Home、来源、cwd 等查询范围一致；默认 `sourceKinds` 只覆盖交互来源，不能漏掉自己关心的子 agent。[O1：List threads]
- **实时变化**：消费 `thread/archived`、`thread/unarchived`，依据 `threadId` 更新归档状态。`thread/archive` / `thread/unarchive` 是修改状态的命令，不应为“检查状态”而调用。[O1：Archive a thread / Unarchive a thread]
- **本地文件**：官方说明 archive 会把 JSONL 移入归档目录，unarchive 则移回活动目录。文件位置可作为本地适配器的辅助证据，但文档没有在该节承诺目录名字是稳定接口，不建议把硬编码目录当唯一契约。[O1：Archive a thread / Unarchive a thread；后半句为工程建议]
- **子 agent**：归档父 thread 会尝试归档后代，但允许后代失败而父请求成功；仅为实际归档的 thread 发出归档通知。不能只收到父通知就无条件把全部后代标成已归档。[O1：Archive a thread]

本机 0.154.0 生成的 `Thread` 类型本身**没有 `archived` 属性**，`ThreadListParams` 有 `archived?: boolean | null`；因此不要臆造 `thread/read().thread.archived`。上面的集合查询和事件是已确认的契约。[O2]

> 版本边界：在线文档会演进；安装版本的字段以该版本 `generate-ts` / `generate-json-schema` 为准。`notLoaded` 是所在 App Server 的观察，不应在没有同一运行端证据时提升为全局“离线”。后一句是跨执行端集成边界建议。[O1：Schemas / Read a stored thread；O2]

### Codex 证据来源

- **O1 — OpenAI 官方 Codex App Server 文档**。本次通过 HTTPS 获取正文，检索并阅读上述章节；访问日期 2026-09-16。

  ```text
  https://developers.openai.com/codex/app-server/
  ```

- **O2 — 官方 CLI 生成的版本绑定协议**。本机 `codex --version` 返回 `codex-cli 0.154.0`；执行下列离线生成命令，未对任何真实会话发起归档、恢复或交互请求：

  ```bash
  codex app-server generate-ts --out /tmp/baton-codex-schema-dATPQ3
  ```

  核对文件：`/tmp/baton-codex-schema-dATPQ3/v2/ThreadStatus.ts`、`/tmp/baton-codex-schema-dATPQ3/v2/ThreadActiveFlag.ts`、`/tmp/baton-codex-schema-dATPQ3/v2/TurnStatus.ts`、`/tmp/baton-codex-schema-dATPQ3/v2/Thread.ts`、`/tmp/baton-codex-schema-dATPQ3/v2/ThreadListParams.ts`、`/tmp/baton-codex-schema-dATPQ3/v2/ThreadArchivedNotification.ts`、`/tmp/baton-codex-schema-dATPQ3/v2/ThreadUnarchivedNotification.ts`。这些是可复现的临时证据，不依赖提交到仓库。

## Baton：已有代码事实与建议

**代码事实**（基线 `52cb01a`）：[状态映射](/home/ubuntu/.codex/worktrees/23f4/Baton/bridge/session.mjs:445) 把 blocked 映射为 needs_input、working/running 映射为 running，其余统一 completed；[前端标签](/home/ubuntu/.codex/worktrees/23f4/Baton/web/js/app.js:262) 将其余状态显示 Done。因此 Baton 的 completed 既不保留 failed/stopped 差异，也不是归档证据。[Claude discovery](/home/ubuntu/.codex/worktrees/23f4/Baton/bridge/claude-runtime.mjs:86) 构造的元数据没有归档字段（86–99 行）。这不是完整归档链路审计。

Codex 的 [扫描结果](/home/ubuntu/.codex/worktrees/23f4/Baton/bridge/codex-session.mjs:340) 也只输出 running/completed；[发现目录](/home/ubuntu/.codex/worktrees/23f4/Baton/bridge/codex-session.mjs:367) 和 [查找历史文件](/home/ubuntu/.codex/worktrees/23f4/Baton/bridge/codex-session.mjs:432) 只扫描 Home 下的 sessions。[/archive 实现](/home/ubuntu/.codex/worktrees/23f4/Baton/bridge/codex-interaction.mjs:1080) 调用 thread/archive 后只返回成功提示与 leave-session 动作。因此，已有 completed 字段本身不能回答是否归档。

**研究建议**：分别保存运行活动、后台工作结果及归档信息，并记录来源／版本。缺少明确归档证据应记 unknown，而非 false；不要由 completed、SessionEnd、文件缺失或清单消失推断 archived。新增协议前先核对部署版本的实际输出。

可考虑的模型草案（不是两家官方共同定义，尚未实施）：

```ts
activity: "running" | "needs_input" | "idle" | "unknown";
lastRunOutcome: "completed" | "failed" | "interrupted" | "stopped" | "unknown";
archiveState: "archived" | "unarchived" | "unknown";
```

另行保留 runtime 原始状态、来源、观察时间及版本；例如 Codex systemError 应保留并展示，而不是静默当作 idle。Claude 的 blocked 可包含无法自行解决的错误，不仅限于问题或审批。Baton 自己的归档功能如需加入，应与上游原生归档来源区分，不伪装成 Claude CLI 已提供的接口。

### 2026-09-16 实施结果

本次只落地 **Codex 原生归档维度**，没有实施上面的完整状态模型草案，也未改变 Claude 行为。
Server 新增现有 Session 行上的 `archiveState`／`archiveVersion`，Bridge 使用独立归档服务，
Web/App 提供 Sessions / Archived、单选／批量归档恢复、详情只读及子 agent 单独恢复。
父子实际状态来自分页集合与原生事件，不推测级联结果。失败同步保留本地 outbox 并重试，
没有原生反向补偿操作；初始发现覆盖全部 provider 与子 agent 来源。

安装版本 `0.154.0` 的隔离临时 Home 测试确认：归档／恢复移动日志后仍可读取历史，
外部 App Server 操作可被完整快照识别，归档路径没有 resume／turn 调用。
仅有 `response_item`、没有原生 `event_msg/user_message` 的子线程可能不在该版本列表中，
但仍会被原生父归档处理。因此归档前还读取本 Home 日志的身份和父关系，未列出的后代或
无法完整读取的拓扑会阻止修改；文件位置不用于推断归档状态。这是版本绑定的保守防护，
不是新的公开 JSONL 协议承诺。隔离测试覆盖了未列出子线程已有 Baton 待执行发送的场景。

协议探测异常与明确不支持分开处理，异常期间保持未知、阻止写入并重试，不能使用离线前的
未归档缓存放行。父归档部分成功后的重试继续确认后代同步结果，保留部分失败提示。

跨原生客户端仍无状态条件的原子互斥保证；本地保护是执行前状态重查、writer 拒绝与 Baton
操作串行。Windows 缺少可靠 writer 检查，因此本期修改能力禁用。HTTP 同步仍沿用现有
账户 API-key 信任模型，不声称能够防御持有同账号 key 的伪造 Bridge。

## Claude 官方来源

以下均为获取并阅读过正文的官方页面。来源编号对应前文断言，URL 便于复核。

- [S1] Agent view：List sessions as JSON / Read session state from a script。
- [S2] Manage sessions：Access conversations from scripts / Where transcripts are stored / Delete session data。
- [S3] Hooks reference：SessionStart / SessionEnd / Stop / Notification。
- [S4] Agent SDK TypeScript reference：SDKSessionInfo / SDKMessage / SDKResultMessage / SDKStatusMessage / SDKTaskNotificationMessage。
- [S5] Agent loop：Message types / Handle the result。
- [S6] Agent SDK sessions：Continue, resume, and fork。
- [S7] Desktop：Worktree location / Work across sessions / 自动归档。
- [S8] Claude Code on the web：Archive sessions / 云会话发送结果。
- [S9] Managed Agents session operations：Session statuses / Archiving a session。

- **S1**：`https://code.claude.com/docs/en/agent-view`
- **S2**：`https://code.claude.com/docs/en/sessions`
- **S3**：`https://code.claude.com/docs/en/hooks`
- **S4**：`https://platform.claude.com/docs/en/agent-sdk/typescript`
- **S5**：`https://platform.claude.com/docs/en/agent-sdk/agent-loop`
- **S6**：`https://platform.claude.com/docs/en/agent-sdk/sessions`
- **S7**：`https://code.claude.com/docs/en/desktop`
- **S8**：`https://code.claude.com/docs/en/claude-code-on-the-web`
- **S9**：`https://platform.claude.com/docs/en/managed-agents/session-operations`
