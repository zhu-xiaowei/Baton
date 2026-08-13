# Codex 接入设计与实施状态

> 最后更新：2026-08-12
> 当前状态：Phase 1、Phase 2 已完成；Phase 3 已完成 Session 创建与交互主链路
> API 与 WS 完整契约见 [api.md](api.md)

## 1. 目标与范围

AgentPeek 将 Codex 作为第二种本地 agent runtime 接入，并继续使用统一的
Device → Project → Session 信息架构。

当前已完成：

- 自动发现 Claude Code 和 Codex 历史 Session。
- 同一 cwd 的两种 runtime 归入相同 Project。
- 将 Codex Session metadata 和历史消息同步到现有 DynamoDB 表。
- 老用户升级 Bridge 后自动执行 Codex 初始化同步。
- DDB 无消息时，通过 REST → WS → Bridge 按需回填旧 Session。
- 监听所有 Codex Session 存储目录，并在 rollout append 后实时通过 WS 同步。
- WS ack、HTTP fallback、超大帧、失败重试和 watermark 提交与 Claude 使用同一可靠投递语义。
- 实时更新新 Session metadata 和 `running/completed` 状态。
- 列表和详情复用统一 UI，并用 runtime icon、短 ID 和局部展示差异区分。
- macOS、Linux 和原生 Windows Bridge 安装、启动及升级。
- 已有 Codex Session 使用 app-server `thread/resume` + `turn/start` 发送消息。
- 新建 Codex Session 使用同一个 cwd-scoped app-server client 连续执行 `thread/start`
  和首个 `turn/start`。
- 检测到 Codex managed daemon 时，Bridge 通过其 Unix WebSocket socket 复用同一
  app-server；没有 daemon 或连接失败时才回退到独立 `app-server --stdio`。
- 复用 daemon 后，已加载的 active turn 会被接管为当前流并重放 pending approval；
  新发送的消息排队到该 turn 完成后启动，后续 delta 仍走完整 streaming 链路。
- app-server delta 复用 Claude 的首包立即发送、50ms 合批、turn 级 `seq`、前端重排和追赶渲染。
- app-server 完整 user/assistant item 作为 live 权威行；rollout watcher 只持久化匹配行并负责漏事件兜底。
- interrupt 和 command/file/permissions/MCP elicitation/user-input 已接入现有 WS
  控制协议。command 审批按 App Server 的 `availableDecisions` 原序透传；permissions
  只回传语义动作并由 Bridge 从原请求构造授权；MCP 支持普通审批、session/always
  持久授权和 TUI 支持的 string/boolean/enum 表单。
- MCP 不支持的 form schema 与 TUI 一样降级为三项普通审批；AgentPeek 未实现 AppLink
  安装/认证 UI，因此 `openai/form`、URL 和 tool suggestion 会安全 `decline`。
- 每个活跃 thread 使用临时 app-server client lease；managed daemon 模式只关闭该连接，
  stdio fallback 才退出独立进程并释放 writer。
- 外部独立 Codex TUI 持有 writer 且仍有未结束回合时，Web 显式确认后可安全终止该
  holder、retry resume 并发送；TUI 仅空闲持锁时自动终止并 resume，取消不会终止正在
  运行的进程或发送消息。
- Project 创建已是 runtime 无关的目录和 metadata 操作，Claude/Codex 可复用同一个入口。

当前未完成：

- 跨 Bridge 进程重启恢复 pending request 和 `turn/steer`。
- app-server 工具输出是否切换为 live 权威；当前最终工具卡继续复用 Phase 2 watcher。

因此，Codex Session 已支持创建、历史读取、实时旁观和 Web 交互。New Session 页面按
设备的 `canCreate` 能力显示 runtime；仅一种 runtime 时自动选择，多种时允许切换并记住
该设备上次选择。

## 2. 阶段与完成条件

| 阶段 | 状态 | 范围 | 完成条件 |
|---|---|---|---|
| Phase 1 | 已完成 | 初始化发现、metadata、历史消息、按需回填、统一 UI、跨平台安装升级 | 本地/DDB/REST/UI 数量一致；重启和重复打开无新增重复；Claude 行为无回归 |
| Phase 2 | 已完成 | Codex watcher、增量读取、状态更新、实时旁观 | macOS/Linux/Windows 的新增行不漏不重；断连、重启、半行写入和 watermark 恢复通过 |
| Phase 3 | 进行中 | app-server、创建、发送、streaming、interrupt、权限 | 主链路、完整审批类型、daemon 复用和显式 TUI 接管已完成；跨 Bridge 重启自动恢复仍待完成 |
| Phase 4 | 待开始 | 性能、诊断、灰度、回滚和体验完善 | 大 Session、弱网、升级失败和多设备场景均有可执行验收与回滚流程 |

### 2.1 实施规则

- Runtime 差异通过 adapter/controller 接口实现，并按 runtime 分文件。
- 共享 coordinator 只负责编排、identity、上传和路由，不解析 runtime 私有格式。
- Claude Code adapter 重构只允许代码组织变化；路径、状态、watermark、消息、发送和权限语义保持不变。
- UI 默认复用统一组件，仅在 runtime/capability 层做局部差异。
- 新增方法保持单一职责；每个方法最多保留一行必要注释。
- 测试覆盖与改动风险匹配；完成状态必须有自动化或真实环境验证证据。

## 3. Runtime Adapter

Phase 1 的初始化读链路由以下文件组成：

| 文件 | 职责 |
|---|---|
| `bridge/runtime-adapter.mjs` | 定义和校验 runtime 公共接口及 feature flags |
| `bridge/runtime-registry.mjs` | 注册 runtime、查找 adapter、统一能力检测 |
| `bridge/claude-runtime.mjs` | Claude discovery、读取、状态、删除和能力 |
| `bridge/codex-runtime.mjs` | Codex discovery、读取和状态轮询能力 |
| `bridge/sync.mjs` | 合并 catalog、聚合、筛选和上传 |
| `bridge/ws.mjs` | 通用 WS 路由，通过 adapter 执行 `sync_session` |

Phase 2 的实时链路：

| 文件 | 职责 |
|---|---|
| `bridge/watcher-adapter.mjs` | 定义 runtime watcher 接口 |
| `bridge/runtime-watcher-registry.mjs` | 注册并启动 Claude/Codex watcher |
| `bridge/watcher.mjs` | Claude JSONL watcher |
| `bridge/codex-watcher.mjs` | Codex 多 Home rollout watcher、watermark 和状态更新 |
| `bridge/realtime-delivery.mjs` | 两种 runtime 共用的 WS ack、HTTP fallback 和大帧策略 |

Phase 3 的已有 Session 交互链路：

| 文件 | 职责 |
|---|---|
| `bridge/interaction-adapter.mjs` | 定义和校验 runtime interaction 接口 |
| `bridge/codex-app-server.mjs` | managed Unix WebSocket/stdio app-server transport、握手、请求配对和反向请求 |
| `bridge/codex-interaction.mjs` | daemon 复用、临时 writer lease、active-turn 接管、resume、turn、item、interrupt、审批和 Session 内排队 |
| `bridge/codex-writer.mjs` | active-writer 识别、独立 TUI holder 校验和确认后的安全终止 |
| `bridge/stream-framer.mjs` | Claude/Codex 共用首包立即发送、50ms 合批和 turn 级 `seq` |
| `bridge/codex-live.mjs` | app-server item 到统一 preview/完整消息的映射 |
| `bridge/live-message-registry.mjs` | live 完整行与 rollout watcher 的短期去重 |
| `bridge/ws.mjs` | 通过 interaction adapter 进入现有统一 WS streaming contract |

Adapter 必须实现：

```text
discover
detectCapability
findSessionFile
shouldSkipInitial
baselineToEnd
syncInitialMessages
syncAllMessages
```

可选能力通过 `features` 声明，当前包括：

```text
read
create
send
interrupt
deleteHistory
statusPolling
```

Phase 2 的 Claude/Codex watcher 已采用独立 adapter + registry；Phase 3 的
send/streaming/permission controller 也必须保持同样结构，不能在共享实现中堆积 runtime
条件分支。

## 4. Identity 与路径

### 4.1 Session ID

统一 runtime 值：

```text
claude
codex
```

Claude 的历史 ID 和 DDB key 完全不变。Codex 使用：

```text
nativeSessionId = Codex rollout UUID
sessionId       = codex:<nativeSessionId>
```

`sessionId` 用于 DDB message partition、Session row、WS subscription 和本地 watermark；
`nativeSessionId` 用于定位本地 rollout 和未来 app-server 调用。前端显示 Codex native ID
末 8 位，避免 UUIDv7 前缀在相近时间创建的 Session 中缺乏区分度。

Server 对缺少 `runtime` 的旧 payload 和旧 DDB item 默认按 Claude 处理。

### 4.2 Project Hash

Codex 的 `session_meta.cwd` 使用现有 Claude 兼容规则计算 `projectHash`。不引入第二套 hash，
也不对路径执行 `realpath` 或统一转小写。

```text
macOS/Linux cwd → Claude 兼容路径 hash
Windows C:\...  → 兼容现有 C--Users-* / C-Users-* 候选
worktree        → 归一到 parent project hash
```

同一 cwd 的 Claude/Codex Session 必须落入同一 Device → Project。原生 Windows 已验证盘符、
空格、中文路径和现有 Claude project hash 兼容；Codex 不依赖 WSL。

## 5. DynamoDB 数据模型

Codex 接入不新增表，不修改主键、GSI 或 TTL。

### 5.1 BridgeSessions

```text
PK = accountId

SK = DEV#<deviceName>
SK = PROJ#<deviceName>#<projectHash>
SK = SESS#<deviceName>#<projectHash>#<sessionId>
```

Session item 新增或标准化以下字段：

```text
sessionId
nativeSessionId
runtime
modelProvider
clientSource
cliVersion
```

`runtime` 缺失时读取为 `claude`。状态统一为：

```text
running
needs_input
completed
```

Codex JSONL 目前只能可靠得到 `running` 或 `completed`，无法仅靠落盘历史判断一个外部
Codex 进程是否正在等待审批，因此 JSONL watcher 不生成 Codex `needs_input`。

### 5.2 Device Runtime Capabilities

每个账号和 `deviceName` 只有一条 DEV item。能力是该 item 上的嵌套 map，不是每个 runtime
单独一行：

```json
{
  "runtimeCapabilities": {
    "claude": {
      "installed": true,
      "historyAvailable": true,
      "canRead": true,
      "canCreate": true,
      "canSend": true,
      "version": "..."
    },
    "codex": {
      "installed": true,
      "historyAvailable": true,
      "canRead": true,
      "canCreate": true,
      "canSend": true,
      "version": "..."
    }
  }
}
```

`installed` 与 `historyAvailable` 分离，因为 CLI 被卸载后本地历史仍可能可读。创建
Session 时，UI 使用 `capability.canCreate` 过滤 runtime；已有历史展示使用
`historyAvailable/canRead`。

### 5.3 BridgeMessages

```text
PK = sessionId
SK = timestamp#uuid
TTL = 90 days
```

重复提取使用相同 `uuid` 和 sort key，DDB `PutItem` 覆盖同一行，不累积副本。消息 item
保持统一结构：`uuid`、`type`、`content`、`timestamp`，以及可选 `nativeId`、
`stopReason`、`toolUseResult`。`nativeId` 是 live 与 watcher/DDB 行共用的稳定身份，
前端通过与 Claude 相同的 identity set 去重。

## 6. Codex Discovery 与状态

Bridge 递归扫描：

```text
<CODEX_HOME>/sessions/**/*.jsonl
```

未设置 `CODEX_HOME` 时使用默认 `~/.codex`。Discovery 规则：

- native ID 取 rollout 文件名末尾 UUID。
- 存在多条 `session_meta` 时，优先选择 ID 与文件名匹配的 metadata。
- cwd、provider、originator/source 和 CLI version 来自 `session_meta`。
- preview 取首个 `event_msg/user_message`。
- model 取最新有效 `turn_context.model`。
- lastActive 和 size 来自文件 stat。
- 空文件、无用户消息或缺少必要 metadata 的文件不产生 Session。
- 损坏的中间行被跳过；半写入尾行不会阻塞其他 Session。
- 发现过程出现不可读文件或关键 metadata 缺失时，不覆盖权威 DEV/PROJ 聚合。

`running` 判定要求存在未闭合 task，且同时满足文件仍新鲜、匹配 Session 进程或匹配
Project 进程之一；否则为 `completed`。Windows 不枚举 Codex 进程，只使用文件生命周期
和新鲜度，因此状态精度低于 Bridge 自己管理的交互进程。

页面状态轮询和 writer 接管检查统一通过 `inspectCodexSession()` 获取该状态。writer 已经
从 lock holder 得到当前 Session 的进程证据，因此只额外提供该上下文，不维护另一套
`running` 判断。

## 7. Phase 1 数据流程

### 7.1 Bridge 初始化

```text
Bridge 启动或升级重启
→ 恢复 synced.json watermark
→ Claude/Codex adapter 分别 discovery
→ 合并为统一 catalog
→ 一次计算 Device/Project 聚合
→ 上传全部 Session metadata
→ 选择 running、needs_input 或最近 24h Session
→ 并发 2 个 Session 提取和上传消息
→ 上传成功后提交 watermark
→ 通过 watcher registry 启动 Claude/Codex watcher
```

启动同步负责关闭 Bridge 离线期间的缺口，运行期间由 Codex watcher 从同一 watermark
继续读取。两条链路都只在消息成功写入后提交 watermark。

Bridge 重启期间补齐的消息通过 HTTP 写入 DDB，不会经过实时消息广播。启动同步若实际
补写了消息，Bridge 会在 WS 建连后发送一次设备级恢复完成通知；当前设备的 App 随即从
DDB 合并当前 Session，避免中间的工具结果必须手动刷新后才出现。无补写时不发送通知。

`--skip-init` 不上传消息，但会为两种 runtime 建立文件末尾 watermark。Catalog 超过 5000
个 Session 时分批上传，只有第一批携带权威 DEV/PROJ 聚合。

### 7.2 旧 Session 按需回填

超过 24 小时且 DDB 尚无消息的 Session 在详情页打开时走：

```text
App GET /api/bridge/messages
→ Server 返回 needSync=true
→ Server WS sync_session
   { sessionId, runtime, nativeSessionId }
→ Bridge 选择 runtime adapter 并从第 0 行提取
→ Bridge POST /api/bridge/sync-messages
→ Bridge WS sync_complete
→ Server 向账号下 App 广播 sync_complete
→ App 重新 GET /messages
```

默认消息读取使用一致性读，缩短 `sync_complete` 后立即刷新看不到刚写入行的窗口。
连续打开、重复同步和 Bridge 重启都依赖确定性 UUID + DDB key 保持幂等。

### 7.3 Phase 2 实时读取

```text
Parcel 原生目录订阅发现 rollout
或 active/recent 文件 watcher 收到 append
→ 与 Claude 相同的 busy/pending 合并
→ 按 nativeSessionId 立即串行处理
→ 从 watermark 提取完整 JSON 行
→ WS messages 并等待 messages_ack
→ 无 WS/ack 超时则 HTTP 写 DDB
→ 成功后提交 watermark
→ 同步 Session metadata/status
```

- 每个 `CODEX_HOME/sessions` 使用一个 `@parcel/watcher` 原生递归订阅，负责新目录、
  新 rollout、rename 和大规模历史目录发现。
- 所有 `running` rollout 及最近 64 个已完成 rollout 使用直接文件 watcher，负责实时
  append。该有界集合规避 macOS FSEvents 对 Codex 长期持有文件追加的漏事件，同时不会
  为 10,000 个历史 Session 建立 10,000 个句柄。
- 正常事件与 Claude 一样立即进入 `busy/pending` 串行循环；所有根目录每 5 分钟做一次
  低频安全重扫，补齐底层文件事件遗漏。
- 文件事件可以被系统合并；任意一次事件都会从 watermark 读取到完整行 EOF，并在投递后
  再比较文件 size/mtime。处理期间继续增长时立即进入下一轮，不依赖第二个文件事件。
- 半写入尾行不推进 watermark；补全后按原行号生成同一个确定性 UUID。
- 同一 Session 只有一个处理循环，密集事件只设置一个 pending 标记。
- WS 小消息在帧预算内保持顺序批量发送；Server 仅在 DDB 持久化成功后 ack，断连、写入失败
  或 ack 超时均走严格 HTTP fallback。
- 超过 WS 帧预算的消息实时发送截断 `noCache` 副本，完整副本通过 HTTP 保存。
- 任何投递失败都保留 watermark 并定时重试；重启时 `synced.json` 再次补齐。
- `task_started/task_complete/turn_aborted` 驱动实时状态；普通 assistant/tool append 不重扫
  rollout 状态。长期未闭合 turn 由 stale timer 和现有 `checkStopped` adapter 再检查。

## 8. 消息标准化与 UI

### 8.1 已支持映射

| Codex 原始节点 | 统一模型 / UI |
|---|---|
| `event_msg/user_message` | `user` |
| `response_item/message(role=assistant)` | `assistant` text |
| `event_msg/task_complete` | 不可见的 `assistant/end_turn` lifecycle，用于结束当前 spinner |
| `exec_command` | `Bash` |
| `update_plan` | `TodoWrite` |
| `apply_patch` | 一个或多个 `Edit`；无 `FileChange/PatchApply` lifecycle 的预校验失败不显示 |
| `write_stdin` | `WriteStdin` |
| `item_completed/CommandExecution` | 更新原 `Bash` 的权威输出、退出状态、命令分类和完成时间 |
| `item_completed/McpToolCall` | 更新原 MCP 调用的 server/tool、最终结果和 `Calling/Called` 状态 |
| `view_image` | `ViewImage` |
| `tool_search_call` | `ToolSearch` |
| `item_completed/WebSearch`、`web_search_call` | 去重后的 `WebSearch` |
| 其他工具 | generic 工具卡 |
| `compacted`（有非空 `message`） | 默认收起的 Markdown summary |
| `item_completed/ContextCompaction`、`context_compacted` | `Context compacted` system event |
| `entered_review_mode` | `Review started` system event |
| `exited_review_mode` | `Review completed` system event |
| `thread_rolled_back` | rollback system event |
| `turn_aborted` | interrupt |

不显示 developer message、重复 `agent_message` 和没有明文的加密 reasoning。Review
范围内相邻、同内容、同一轮 prompt 只保留一次；普通重复用户
消息不做全局去重。

Codex 的中间进度和最终正文都使用 `response_item/message(role=assistant)`；其中
`phase=final_answer` 只表示正文阶段，不代表 turn 已经完成。前端在这些文本到达后继续
显示 running，直到随后独立的 `event_msg/task_complete` 被标准化为不可见
`stopReason=end_turn` lifecycle。该 lifecycle 参与状态计算但不产生额外时间线节点。
前端状态判断通过 runtime status adapter 分离：Claude 保留原有错误结果/交互工具规则；
Codex 的普通工具失败仍属于运行中的回合，只有 `task_complete` 或 `turn_aborted` 才结束。

工具通过 `call_id + occurrence` 配对，支持同一 Session 重用 call ID；消息 UUID 与工具
配对 ID 分离。未完成或中断的工具允许只有 IN，不能制造不存在的 OUT。

Codex 在 patch 语法或上下文预校验失败时只写 `custom_tool_call_output`，不会生成
`FileChange` 或旧版 `patch_apply_begin/end`，TUI 因而不会创建 `Edited` 节点。Bridge
同样跳过这类临时失败；一旦 patch 已进入 FileChange/PatchApply lifecycle，即使最终失败，
仍保留 Edit 及其错误结果。

### 8.2 ViewImage

Codex `ViewImage` 是 agent 查看本地图片，不是用户发送图片。Bridge 保留本地路径，不在
初始化时上传 base64。用户点击后复用既有 `request_file` 流程，由 Bridge 按需上传 S3，
再由现有预览组件显示。

### 8.3 Runtime 展示差异

两种 runtime 复用列表、详情、message、tool、diff、todo 和文件预览组件。Codex 只增加：

- 首页、Session 列表和详情右上角的 runtime icon。
- native ID 后 8 位。
- `Explored`、`Ran`、`Edited`、`Updated Plan`、`Viewed Image` 等展示名称。
- 只有 Codex `parsed_cmd` 全部属于 `Read/ListFiles/Search` 且来源不是 `UserShell` 的
  `Bash` 才是 `Explored`；连续调用按 TUI `ExecCell` 语义组成一组，组内保持调用顺序。
  子项使用 `Read/Search/List` 结构化摘要，只有组首显示时间线节点和 `Explored` 标题；
  后续子项隐藏重复圆点；组位于末尾时不画悬空竖线，后续已有独立节点时则以一条连续
  竖线穿过折叠组并连接下一个节点。底层 call ID、IN、OUT、结果和 UUID 仍分别保留。
- 其他 `Bash` 显示为 `Ran`，最终位置以 `CommandExecution` 完成时间为准。此前用于猜测
  只读命令的前端正则已删除，组合命令不会再因包含 `git diff`、`find` 等片段被误分组。
- 空输入 `WriteStdin` 是后台终端轮询：等待中的实时节点显示 `Waiting for background
  terminal`；同一 process 的连续轮询在历史中折叠为一个 `Waited for background
  terminal`；较长命令默认单行省略，点击标题可展开完整内容。直接结束进程的轮询不创建
  额外 Waited。非空终端输入仍显示为 `Ran`。
- `CommandExecution` 的聚合输出是权威 OUT；`Chunk ID`、`Wall time`、token count 等
  wrapper 结果在最终事件存在时标记为 superseded。退出码作为节点状态展示，不拼入 OUT。
- MCP 调用使用 `McpToolCall.server/tool` 作为权威身份：执行中显示 `Calling`，完成后显示
  `Called`，摘要保留 `server.tool`；通用 `function_call_output` wrapper 不重复展示。
- 工具详情使用统一 runtime policy：Codex 历史加载默认只显示标题，实时 WS 新节点默认展开；
  点击标题或箭头切换详情。`Explored` 组由组首一次控制全部成员，内部 `Show more` 仍作为
  第二层长内容展开。Claude 当前保持原有展开行为，未来只需启用对应 policy。
- 历史 `Edit` 收起时不下载或执行 Diff2Html；首次展开才动态加载并渲染，后续展开复用结果。
- Codex 局部强调色 `#13A7CD`；工具标题仍使用统一白色。
- 底部运行文案固定为逐字循环的 `Working...`。

Review JSON 使用结构化结果展示；普通独立 JSON 使用格式化代码块。Summary 默认收起，
展开后按 Markdown 渲染。Review 生命周期和 rollback 使用统一 system event 时间线行。

### 8.4 大消息边界

- generic 工具 IN 在 UI 中显示前 1500 字符的预览。
- 工具 OUT 不再由前端按字符数截断，只做视觉折叠。
- API Gateway WS 帧预算约 31 KB；超限实时消息发送缩小的预览并标记 `noCache`。
- 完整副本通过 HTTP 写 DDB，单条标准化消息上限约 360 KB。
- 用户重新进入 Session 后从 REST/DDB 读取可用的完整版本。
- Codex 自身已写入 `Warning: truncated output` 的内容无法由 AgentPeek 恢复。

## 9. 不进入时间线的 Codex 数据

以下节点主要是 Session/turn 全局上下文，不应逐条显示在消息时间线：

```text
session_meta
token_count
turn_context
world_state
thread_settings_applied
```

后续可实现统一 Session metadata modal：点击详情右上角 runtime icon 后按需显示 runtime、
完整 native ID、model/provider、来源、CLI version 和最后活动时间。Codex 可增加有上限的
token、thread settings 和 turn context 摘要，但不上传完整 world state、base/developer
instructions、skills 或权限路径列表。

Codex TUI 的 `N background terminal(s) running` 属于未落 JSONL 的内存状态，Phase 1
不重建该运行计数。后台命令完成后会写入 `item_completed/CommandExecution`；Bridge
使用该事件更新原 Bash 节点的最终输出、退出状态和完成位置，节点仍显示为 `Ran` 或
`Explored`。`Waited for background terminal` 只代表空 stdin 轮询形成的等待 streak，
不会替代原 Bash 节点。

## 10. 验证证据

### 10.1 本机与混合数据

| 检查项 | 结果 |
|---|---:|
| Codex rollout / SQLite thread 对照 | 17 / 17 |
| 混合 catalog | 2403 Claude + 17 Codex = 2420 |
| 初始化 dry-run 最终消息 | 约 4095 |
| metadata/message key 冲突 | 0 |
| Bridge 测试 | 37 passed |
| Codex 测试 | 52 passed |
| Server 测试 | 22 passed |
| Frontend 回归 | 60 passed |
| Packaging 边界测试 | 4 passed |
| Production build | passed |

本地自动化合计 175 项。

AgentPeekTest 实际升级后发现 18 个 Codex Session，最近或运行中的 Session 共写入 4281 条
唯一消息；REST 分页返回 4281 条，缺失 0、重复 0。

Phase 2 真实链路验证使用隔离 `CODEX_HOME` 并发启动 2 个 Codex Session：

- rollout 工具输出和最终回复均实时到达 App WS。
- WS UUID 重复 0，DDB UUID 重复 0。
- 两个 Session 最终 metadata 均为 `runtime=codex/status=completed`。
- rollout 到最终回复 WS 的最大观测延迟 1363ms。
- 最大现有 rollout 为 22.4MB / 9072 行。普通 append 路径从约 207.7ms 降至
  138.4ms，CPU 时间减少约 33.4%；固定安全扫描从 30 秒改为 5 分钟，扫描频率减少 90%。

Phase 2 验证版本 `0.2.0-codex-p2-20260810-13` 曾部署到 `MacBook-Pro`、`agentpeek_test`、
`test-ec2` 和 `test-ec2-ap`；四台均通过 WS 连接记录自报相同 `bridgeVersion` 且在线。
Mac 真实 Codex turn 的最终 assistant rollout 到 App WS 为 1359ms，DDB UUID 重复 0；
东京 Linux 真实 turn 的用户消息、工具调用、工具结果和最终回复共 4 条，状态
`completed` 且无重复。

移除 Codex WSL/polling 分支后，Codex 使用 Parcel 根订阅做发现，并对 active/recent
rollout 使用有界直接文件 watcher；Claude 的现有 WSL fallback 保持不变。生产 Mac 的
纯 assistant 消息从 rollout 时间戳到真实 App WS 约 0.56 秒，同一 UUID 在 DDB 中仅
1 条。以已提交 watermark 做本地 extractor 与 DDB UUID 集合核对，缺失 0、重复 0。

Parcel 10,000 Session 压测均使用真实 `CodexWatcher`，一次更新 100 个不同 Session：

| 平台 | 根订阅 | 直接 watcher | 初始化 | RSS 增量 | 总 FD | 100 个更新 |
|---|---:|---:|---:|---:|---:|---:|
| macOS arm64 | 1 | 64 | 843.6ms | 39.6MB | 93 | 665.1ms |
| Linux x64 | 1 | 64 | 249.8ms | 41.4MB | 47 | 803.0ms |
| Windows x64 | 1 | 64 | 1812.0ms | 37.6MB | N/A | 1229.4ms |

三组均为 100/100 到达、唯一 UUID 100、缺失 0、重复 0。Windows 初始安装脚本显式把
Node 目录加入 PATH，确保 Parcel 原生包安装脚本能找到 `node.exe`。

Codex TUI 还存在只写 `response_item role=user`、不写 `event_msg user_message` 的 rollout
变体。scanner 和 extractor 同时支持两种来源：旧格式同内容按计数去重，新格式补齐
preview、Session metadata 和用户消息，并过滤 `environment_context`/`turn_aborted`
内部上下文。

### 10.2 原生 Windows

东京 `agentpeek_test` Windows Server 2025 EC2 验证：

- Claude 2.1.148、Codex 0.147.0 均被识别。
- 原生 Bridge 运行，不依赖 WSL 或 tmux。
- 初始化得到 6 Sessions / 5 Projects。
- 旧 Codex Session 经完整按需链路回填 11 条消息。
- 三组样本为 11/11、11/11、10/10，消息数与唯一 UUID 数一致。
- 连续打开、Bridge 重启、重新安装和自动升级后数量不增加。
- PowerShell 安装、Task Scheduler 自启动和 commit 版本升级通过。
- Phase 2 临时源码通过 SSM 在原生 Windows Node 22 环境执行，4/4 watcher 测试通过。
- 已部署 watcher 的受控 rollout append 通过 App WS、DDB 和 `completed` metadata
  全链路验证；真实模型 turn 因该机 Codex 凭证返回 401 未执行。
- 安装脚本使用 `S4U` 任务，Bridge 无需交互式用户登录即可启动。

### 10.3 Linux

东京 Linux EC2 使用临时源码和独立依赖安装执行 Phase 2 watcher 测试，4/4 通过；随后使用
已部署 Bridge 完成真实 Codex turn 的 WS/DDB/status 验证。

## 11. 后续任务

### Phase 3：交互

已完成：

1. app-server managed Unix WebSocket + stdio fallback client、initialize 握手、请求配对、
   notification 和 ServerRequest。
2. 已有 Session 的 `thread/resume`、`turn/start`、同 Session 排队、interrupt 和完整审批类型。
3. Codex delta 复用 Claude 的 `StreamFramer`、统一 WS 事件和现有前端 streaming 渲染。
4. app-server 完整 user/assistant 行与 rollout watcher 的 live 优先、文件兜底语义。
5. 每个活跃 thread 的临时 app-server client lease；managed daemon 关闭连接，stdio
   fallback 退出独立进程并释放 writer。
6. 外部独立 Codex TUI 的结构化冲突、运行中 Web 确认、空闲自动终止、retry resume
   和取消路径。
7. Codex 新 Session 的 capability/UI 入口、`thread/start` 和首个 `turn/start`。
8. managed daemon 复用、active turn/审批恢复和新消息排队；无 daemon 时保留独立
   stdio app-server lease。

待完成：

1. `turn/steer` 和 pending approval 重连恢复。
2. 剩余 ServerRequest 变体。
3. Linux/Windows 显式 TUI 接管 smoke test 与生产灰度。

### 体验与覆盖

- 验证接近 360 KB 工具输出的移动端展开性能。
- 决定是否显示无正文的 Thinking 占位。
- 为真实多媒体输入定义上传和显示契约。
- 实现点击 runtime icon 打开的 Session metadata modal。
