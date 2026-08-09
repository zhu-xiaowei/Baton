# Codex 接入设计与实施状态

> 最后更新：2026-08-09
> 当前状态：Phase 1 已完成；Phase 2、Phase 3 待实施
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
- 列表和详情复用统一 UI，并用 runtime icon、短 ID 和局部展示差异区分。
- macOS、Linux 和原生 Windows Bridge 安装、启动及升级。

当前未完成：

- Codex JSONL 文件监听和运行期间的实时增量同步。
- Codex 消息发送、streaming、interrupt 和权限交互。
- Codex app-server 的生产接入。

因此，Codex Session 当前是历史读取能力。产品不显示额外“只读”标签，也不为此删除或隐藏
现有输入区域；Bridge capability 会阻止未支持的请求进入 Claude controller。

## 2. 阶段与完成条件

| 阶段 | 状态 | 范围 | 完成条件 |
|---|---|---|---|
| Phase 1 | 已完成 | 初始化发现、metadata、历史消息、按需回填、统一 UI、跨平台安装升级 | 本地/DDB/REST/UI 数量一致；重启和重复打开无新增重复；Claude 行为无回归 |
| Phase 2 | 待开始 | Codex watcher、增量读取、状态更新、实时旁观 | macOS/Linux/Windows 的新增行不漏不重；断连、重启、半行写入和 watermark 恢复通过 |
| Phase 3 | 待开始 | app-server、发送、streaming、interrupt、权限 | 同一 Session 多轮发送、流式顺序、权限、重连恢复和外部进程接管边界通过 |
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
| `bridge/codex-runtime.mjs` | Codex discovery、读取和 Phase 1 能力 |
| `bridge/sync.mjs` | 合并 catalog、聚合、筛选和上传 |
| `bridge/ws.mjs` | 通用 WS 路由，通过 adapter 执行 `sync_session` |

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

Phase 2 的 Claude/Codex watcher、Phase 3 的 send/streaming/permission controller 也必须采用
同样的 registry + 分文件结构，不能在共享实现中逐步堆积 runtime 条件分支。

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
Codex 进程是否正在等待审批，因此 Phase 1 不生成 Codex `needs_input`。

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
      "canCreate": false,
      "canSend": false,
      "version": "..."
    }
  }
}
```

`installed` 与 `historyAvailable` 分离，因为 CLI 被卸载后本地历史仍可能可读。未来创建
Session 时，UI 应使用 `device.online && capability.canCreate` 过滤 runtime；已有历史展示
使用 `historyAvailable/canRead`。

### 5.3 BridgeMessages

```text
PK = sessionId
SK = timestamp#uuid
TTL = 90 days
```

重复提取使用相同 `uuid` 和 sort key，DDB `PutItem` 覆盖同一行，不累积副本。消息 item
保持统一结构：`uuid`、`type`、`content`、`timestamp`，以及可选 `stopReason`、
`toolUseResult`。

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
→ 启动现有 Claude watcher
```

Codex Phase 1 没有 watcher，因此每次 Bridge 启动都会从已保存 watermark 继续读取新增行，
而不是像 Claude watcher 一样在进程运行期间实时跟踪。

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

## 8. 消息标准化与 UI

### 8.1 已支持映射

| Codex 原始节点 | 统一模型 / UI |
|---|---|
| `event_msg/user_message` | `user` |
| `response_item/message(role=assistant)` | `assistant` text |
| `exec_command` | `Bash` |
| `update_plan` | `TodoWrite` |
| `apply_patch` | 一个或多个 `Edit` |
| `write_stdin` | `WriteStdin` |
| `view_image` | `ViewImage` |
| `tool_search_call` | `ToolSearch` |
| 其他工具 | generic 工具卡 |
| `compacted` | 默认收起的 Markdown summary |
| `entered_review_mode` | `Review started` system event |
| `exited_review_mode` | `Review completed` system event |
| `thread_rolled_back` | rollback system event |
| `turn_aborted` | interrupt |

不显示 developer message、`response_item/message(role=user)`、重复 `agent_message` 和没有明文
的加密 reasoning。Review 范围内相邻、同内容、同一轮 prompt 只保留一次；普通重复用户
消息不做全局去重。

工具通过 `call_id + occurrence` 配对，支持同一 Session 重用 call ID；消息 UUID 与工具
配对 ID 分离。未完成或中断的工具允许只有 IN，不能制造不存在的 OUT。

### 8.2 ViewImage

Codex `ViewImage` 是 agent 查看本地图片，不是用户发送图片。Bridge 保留本地路径，不在
初始化时上传 base64。用户点击后复用既有 `request_file` 流程，由 Bridge 按需上传 S3，
再由现有预览组件显示。

### 8.3 Runtime 展示差异

两种 runtime 复用列表、详情、message、tool、diff、todo 和文件预览组件。Codex 只增加：

- 首页、Session 列表和详情右上角的 runtime icon。
- native ID 后 8 位。
- `Explored`、`Ran`、`Edited`、`Updated Plan`、`Viewed Image` 等展示名称。
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

Codex TUI 的 `N background terminal(s) running` 属于未落 JSONL 的内存状态。底层 Bash 和
WriteStdin 历史已经显示，Phase 1 不重建该计数。

## 10. 验证证据

### 10.1 本机与混合数据

| 检查项 | 结果 |
|---|---:|
| Codex rollout / SQLite thread 对照 | 17 / 17 |
| 混合 catalog | 2403 Claude + 17 Codex = 2420 |
| 初始化 dry-run 最终消息 | 约 4095 |
| metadata/message key 冲突 | 0 |
| Bridge 本地测试 | 29 passed |
| Server runtime 测试 | 9 passed |
| Frontend 回归 | 21 passed |
| Production build | passed |

AgentPeekTest 实际升级后发现 18 个 Codex Session，最近或运行中的 Session 共写入 4281 条
唯一消息；REST 分页返回 4281 条，缺失 0、重复 0。

### 10.2 原生 Windows

东京 `agentpeek_test` Windows Server 2025 EC2 验证：

- Claude 2.1.148、Codex 0.147.0 均被识别。
- 原生 Bridge 运行，不依赖 WSL 或 tmux。
- 初始化得到 6 Sessions / 5 Projects。
- 旧 Codex Session 经完整按需链路回填 11 条消息。
- 三组样本为 11/11、11/11、10/10，消息数与唯一 UUID 数一致。
- 连续打开、Bridge 重启、重新安装和自动升级后数量不增加。
- PowerShell 安装、Task Scheduler 自启动和 commit 版本升级通过。

## 11. 后续任务

### Phase 2：实时读取

1. 新建 Codex watcher adapter，只处理 Codex rollout。
2. 复用确定性 extractor、watermark、上传和 WS 大帧策略。
3. 覆盖文件新增、append、半行、rename、多个 CODEX_HOME 和断连恢复。
4. 定义实时状态降级规则，不能把无法观测的审批等待误报为 `needs_input`。
5. 在 macOS、Linux、原生 Windows 验证不漏、不重和重启恢复。

### Phase 3：交互

1. 建立 Codex app-server client/pool 和协议版本协商。
2. 分别实现 Codex send、streaming、interrupt、permission controller。
3. 将 app-server item/event 映射到现有 message 和 streaming UI。
4. 验证 resume、外部 codex-tui 正在运行时的接管边界和单写者约束。
5. 接通能力后更新 `canCreate/canSend`，继续复用现有输入、权限和流式组件。

### 体验与覆盖

- 验证接近 360 KB 工具输出的移动端展开性能。
- 决定是否显示无正文的 Thinking 占位。
- 为真实多媒体输入定义上传和显示契约。
- 实现点击 runtime icon 打开的 Session metadata modal。
