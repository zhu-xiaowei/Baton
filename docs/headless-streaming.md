# Headless Stream-JSON 实时性 — 实现流程文档

> 当前状态：Claude Phase 2E 已完成，headless 是唯一发送路径，tmux 已删除。
> 本文保留早期实测数据，并以当前实现描述最终架构。Codex 已完成历史读取和实时只读监控；
> 发送、streaming 与权限交互属于 Phase 3 的独立 app-server controller，见
> [Codex 接入设计与实施状态](codex.md)。
>
> 目标:App 发送的消息获得**逐 token 的流式反馈**,同时完整保留现有的所有能力(读 jsonl、
> 接管终端已开会话、回电脑继续)。参考 `dnakov/litter`(headless 驱动 + ClaudePool)。
>
> **架构定型:per-session 常驻 headless 进程池**(不是回合级一次性 `-p`)。bridge 为每个会话维护
> **一个**常驻 `claude` 进程,通过持久 stdin 管道多轮喂消息;多网页/多端的消息全部路由到 bridge,
> 由 bridge 分发给那**唯一**的进程 → 天然单写者,从架构上消除双写。已用本机实跑
> (CC 2.1.204)校准所有假设。

## 一、实测结论(本机实跑)

一次会读文件的回合(`claude -p "Read sample.txt…" --output-format stream-json
--include-partial-messages --verbose`)产出 34 行,分析后确认:

1. **stream-json 的 `assistant`/`user` 行与 jsonl 同条消息 `uuid` 完全一致、`content[]` 结构等价。**
   实测四条消息 uuid `6a9902ba/b9962950/5fc7bf11/d42ab640` 两边一一对应。→ 落地复用现有
   `extract.mjs` 解析逻辑没问题。

2. **⭐(已更正)stream-json 的 `assistant`/`user` 完整行有 `uuid` + `timestamp` + 完整
   `content`(含 tool_use / tool_result),与 jsonl 同条消息 uuid 一致。**
   顶层 keys:`type / message / parent_tool_use_id / session_id / uuid / timestamp`(user 行多
   `tool_use_result`)。实测 stream 的 uuid **全部**能在 jsonl 里找到(4/4 匹配)→ **stream 完整行
   就是权威消息**,和 jsonl 是同一条消息的两次到达,靠 **uuid 去重**(现有 `bufferAndFetch`
   的 `existing[uuid]` 逻辑)天然合并、不重不漏。
   缺的只有 `parentUuid`(有 `parent_tool_use_id`,语义是"属于哪个子 agent/工具",不是父消息链)。
   → **架构:stream 完整行当权威消息渲染(工具卡/tool_result 免费);`text_delta` 仅作"完整行到达前"
   的打字机预览;jsonl 后到 uuid 命中即跳过 → 零闪烁。**
   （早期本条曾误记为"stream 无 uuid/timestamp";实测 CC 2.1.204+ 均有,已更正。）

3. **headless 会写 jsonl(新建写新文件,resume/多轮追加同一文件)。**
   新建会话产生 `~/.claude/projects/<hash>/<sessionId>.jsonl`;`--resume` 或持久管道的后续回合
   追加进同一文件、sessionId 不变。→ 现有 fs.watch + 行号追踪天然兼容。

4. **⭐ 持久 stdin 管道可多轮对话(常驻进程池的基石,已实测)。**
   `claude -p --input-format stream-json --output-format stream-json --verbose`,**stdin 保持打开**
   时进程常驻,可连续喂多条 `{"type":"user","message":{...}}\n`;实测同一进程、同一 sessionId
   处理 2 个回合,第二轮答出第一轮记住的数字(上下文保持)。**关闭 stdin → 进程退出。**
   → 一个会话一个进程 = 唯一写者,连发/多端消息串行进同一 stdin,双写不可能发生。
   输入格式:每条 user 消息是一行 JSON `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}`。

5. **⚠️ cwd 的 symlink 会改变 project hash。**
   在 `/tmp/hltest` 跑,`system/init.cwd` 实际是 `/private/tmp/hltest`(macOS `/tmp`→`/private/tmp`),
   jsonl 落在 `-private-tmp-hltest/` 而非 `-tmp-hltest/`。
   → **新建会话的 sessionId 由 Bridge 预生成并传给 `--session-id`；实际 cwd 仍以
   `system/init.cwd` 为准。** watcher 递归监听整个 `CLAUDE_PROJECTS`，symlink 解析后的 hash
   目录也能被捕获。

6. **流式增量的形态**(逐行分派见第六节):
   - 文本走 `content_block_start(text)` → 多个 `content_block_delta(text_delta)` → `content_block_stop`,
     `text_delta` 是半截文本(如 `"The file says a simple greeting from the"`)。
   - 工具走 `content_block_start(tool_use)` → 多个 `content_block_delta(input_json_delta)`(入参 JSON 分片)。
   - `tool_result` 作为后续**完整 `user` 行**出现(带 uuid,携带 `content` + 顶层 `tool_use_result`
     `{stdout,stderr,interrupted,...}` — 与 jsonl 完全同构)。

7. **⭐ 子 agent(Task 工具)中间过程:stream 有,主 jsonl 没有。** 实测发一个 Task 子 agent:
   stream 里出现 5 条带 `parent_tool_use_id` 的行(子 agent 的 Bash/Read/tool_result 全过程),
   而主 jsonl **完全没有**这些(watcher 本就 `if (filename.includes('subagents')) return` 跳过,
   且内联 Task 连 `subagents/` 文件都不落)。→ **streaming 在"子 agent 过程"上比 jsonl 更完整**,
   但这是 streaming 独有的实时价值,**不写 DDB**(见架构决策)——刷新/历史看不到子 agent 过程,已接受此取舍。

8. **各有独有,谁都不是超集**(实测汇总):
   | 内容 | stream | 主 jsonl |
   |---|---|---|
   | assistant 文本/thinking/tool_use/tool_result | ✅ | ✅ |
   | 子 agent 中间步骤(parent_tool_use_id) | ✅ 独有 | ❌ |
   | `ai-title` / `last-prompt`(会话标题元数据) | ❌ | ✅ 独有(CC 异步写盘,不走 stream stdout) |
   | 用户输入回显 / `file-history-snapshot` | ❌ | ✅ |
   - **标题不受影响**:沿用现有多级 fallback(ai-title → last-prompt → **第一条 user 消息**),与 CC 本身
     逻辑一致。ai-title 仍随 jsonl 落 DDB;实时期前端有 user 消息即可出标题。litter 同思路
     (`claude_session_scan.rs` 直接取首条 user 消息文本作 preview)。

## 二、核心架构:per-session 常驻进程池(ClaudePool)

bridge 维护 `Map<sessionId, HeadlessProc>`,每个会话一个常驻 `claude` 进程:

```
HeadlessProc = {
  proc,           // child_process,持久
  stdin,          // 保持打开的管道;写 user 消息;关闭 = 让进程退出
  sessionId,      // resume/create 时已知；否则由 system/init 回传
  cwd,
  busy,           // 当前是否有回合在生成(用于 UI 状态 / 串行)
  queue,          // busy 时到达的消息排队,回合结束后依次喂
  lastActiveAt,   // idle 回收用
  streamId,       // 当前回合的预览累积 id
}
```

**为什么是进程池而非回合级 spawn**:回合级一次性 `-p` 时,同一会话的第二条消息(多网页/多端/连发)
会 spawn 第二个 `--resume` 进程,与第一个同写一个 jsonl → 双写损坏。常驻进程 + 持久 stdin 让
**同一会话永远只有一个写者**,连发消息串行进同一 stdin,双写从架构上消失(实测见结论 4)。

### 决策表

| 项 | 采用 |
|---|---|
| 驱动方式 | **per-session 常驻进程 + 持久 stdin 管道**(`--input-format stream-json`) |
| 多网页/多端 | 全路由到 bridge(单例)→ 分发给该 sessionId 的**唯一**进程 |
| 同会话连发 | 进 `queue` 串行,不并行 spawn(stdin 天然单写者) |
| 新建会话 | Bridge 预生成 UUID 并用 `--session-id` 启动；`system/init` 用于确认 session/cwd |
| 发送路径 | headless 是唯一发送路径；`streamMode` 和 tmux fallback 已删除 |
| 接管判据 | daemon agent 先 `claude stop` 再 resume；其他 session 直接复用或启动 headless |
| 权限 | **默认 `--permission-prompt-tool stdio` 不加 bypass** — 用户配什么权限就什么权限(零侵入)。见第六·五节 |
| 显示/落地 | stream 完整行=权威(渲染),`text_delta`=打字机预览,jsonl 后到 uuid 去重;DDB 只由 jsonl 写(见结论 2/8) |
| 预览渲染 | 完整 markdown 容错重渲(见第五节) |
| 按需启动 | **不预启动**;新消息到达且无进程时才 spawn(spawn→init 就绪约 ≤30s,之后同会话复用) |
| idle 回收 | 周期 `reap`:`lastActiveAt` 超 **idleTTL(默认 10min)** 且非 busy → 关 stdin,进程干净退出(jsonl 保留) |
| 数量上限 | **默认 16 个进程**,超限时 LRU 淘汰最久未活跃的 idle 进程;busy 进程永不回收/淘汰 |

### 单写者约束(两层)
1. **内部**:同会话只有一个 headless 进程(进程池保证)→ 消除"我们自己起多个"的双写。
2. **外部**:daemon agent 可通过 `claude stop` 后接管；普通 terminal/VS Code 没有等价锁，
   不支持在原进程仍生成时同时从 Web resume(见第四节)。

## 三、数据流

### 发送(App → CC),headless 路径
```
App doSend()  ──WS send_message {sessionId|projectHash, text, clientId}──►
Server _handle_send_to_bridge(原样透传,去掉 device) ──►
Bridge handleSendMessage → pool.send(sessionId|新建, cwd, text, callbacks):
  ┌─ 进程已存在且空闲 → 直接往 stdin 写 user 消息
  ├─ 进程已存在且 busy → 入 queue,回合结束后喂
  └─ 进程不存在 → spawn 常驻进程(新建不带 --resume;已有带 --resume <id>),stdin 保持打开
  逐行解析 stdout(见第六节):
    system/init                → 校验 session_id + cwd
    content_block_delta/text   → onDelta(streamId, text) → WS stream_delta(打字机预览)
    assistant / user 完整行     → onMessage → extractForApp(归一 tool_use_result)
                                  → WS messages {noCache:true}(权威消息,含工具卡/tool_result)
    result                     → 本回合结束:busy=false,喂 queue 下一条;WS stream_end
    进程 exit/error            → 从池移除;WS stream_end {error?};只读回退
  回合受理后回 send_message_result {ok, sessionId, clientId}
```
**关键**:stream 完整行(有 uuid+ts+content)当**权威消息**,走和 jsonl 相同的 `messages`→`updateLastTurn`
渲染路径(工具卡/tool_result 免费复用)。`noCache:true` → server 转发给 app 但**不写 DDB**(DDB 由
jsonl watcher 独占写,避免同 uuid 双写)。

### 双路 messages,uuid 去重(实时走 stream,持久走 jsonl)
```
实时:stream 完整行 → WS messages{noCache} → App(先到,先渲染)
持久:CC 写 jsonl → watcher → WS messages(+DDB 写) → App(后到,uuid 命中 → 跳过,不重渲)
```
- 两路是**同一条消息**(uuid 相同),现有 `bufferAndFetch`/`onmessage` 的 `existing[uuid]` 去重天然合并。
- **stream 先到**:实时显示(含子 agent 过程);**jsonl 后到**:只补 DDB 持久化 + app 侧 uuid 命中跳过 → **零闪烁**。
- **DDB 只由 jsonl 写**(决策:streaming 只做实时显示,不写 DDB)→ 刷新/历史/reconnect 读 DDB(jsonl 内容)。

### 预览 ↔ 权威衔接
- `stream_delta` → App 按 `streamId` 累积全文 → marked 重渲打字机预览气泡(容错,见第五节)。
- **完整 assistant 行经 `messages` 到达 → `updateLastTurn` 渲染真实消息 + 移除同 streamId 预览气泡**
  (`clearStreamPreviews`)。因内容一致(实测),替换视觉无缝。
- headless 异常:`stream_end{error}` → 只读回退;reconnect 后走初始化(`bufferAndFetch` 从 DDB 重建)。

## 三·五、进程生命周期(按需启动 + idle 回收,实证自 litter ClaudePool)

**不预启动、不常驻一堆进程**。参数与机制照搬 litter `crates/claude-bridge/src/pool/` +
`bridge-core/src/pool.rs`(已读源码核对):

| 阶段 | 行为 |
|---|---|
| **启动** | 仅当有新消息且该会话无进程时才 spawn;`system/init` 就绪约 ≤30s(`initTimeout`),之后同会话复用 |
| **复用** | 同会话后续消息直接进已存在进程的 stdin(空闲直发 / busy 入 queue) |
| **保活** | 每次收发刷新 `lastActiveAt`;正在生成回合的进程标 `busy`(litter 的 `active`) |
| **回收** | 周期 `reapIdle()`:`now - lastActiveAt >= idleTTL(默认 10min)` 且非 busy → 关 stdin,进程干净退出,jsonl 保留 |
| **上限** | 默认最多 16 进程;新 acquire 超限时 LRU 淘汰最久未活跃的 idle 进程;**busy 进程永不被回收/淘汰** |
| **崩溃** | 进程意外 exit → 从池移除;下条消息按"无进程"重新 spawn(带 `--resume` 续上) |

要点:
- **回收 = 关 stdin**(不是 kill),CC 收到 EOF 干净退出,jsonl 完整落盘 → 下次 `--resume` 无缝续。
- idle 进程占用极小(等 stdin,无 CPU);10min TTL 保证"发一波消息→看完→自动散场"。
- 常量集中在 `headless.mjs`：`HEADLESS_IDLE_TTL_MS` / `HEADLESS_MAX_PROCS` /
  `HEADLESS_INIT_TIMEOUT_MS`，当前值为 10min / 16 / 30s。

## 四、状态所有权与接管

现有 session 的 Web 发送由 `bridge/ws.mjs` `handleHeadlessSend` 处理：

1. 若 session 在 daemon roster 中且尚未被 pool 接管，先执行 `claude stop <shortId>`，再以
   `--resume` 启动 headless。
2. roster 读取与 spawn 发生竞态时，Claude 会返回 background-agent lock；Bridge 再 stop daemon
   并重试一次。
3. Web 回合 busy 时 pool 拥有状态；回合完成后的 idle 进程不再阻断 JSONL/terminal 状态同步。
4. agent 身份来自 `claude agents --json --all`，只有 roster-active worker 的 daemon 状态具有权威；
   `jobs/<shortId>/state.json` 仅用于当前 `needs_input` 的问题文本。

这保证 `daemon needs_input → Web running/completed → terminal running/needs_input` 的状态切换不会被
旧 daemon 记录覆盖。

普通 terminal/VS Code session 没有等价的停止协议。用户在 terminal 正生成时又从 Web resume
同一常规 session，Claude 可能允许两个进程同时写同一 JSONL。该并发方式不受支持；应先让 terminal
回合结束或退出，再从 Web 接管。

## 五、预览渲染:完整 markdown 的容错做法

用户要求预览也跑完整 markdown。半截 `text_delta` 若逐片拼 HTML 会破版,做法定为:
- **每次都用「累积到目前的完整文本」整体调 marked 重渲预览气泡**(不是逐 delta 增量拼接)。
  marked 对未闭合语法是容错的(半个代码块/表格当普通文本处理),下一片补齐后重渲即自动纠正。
- 预览气泡复用现有 markdown 渲染(`web/js/components/markdown.js`),但**只渲文本**;
  工具卡/diff/图片等**不在预览做**,一律等**stream 完整行**(经 `messages`)由 `renderSingleMessage`
  全量渲染(工具卡/tool_result 都在完整行里,无需等 jsonl)。
- 代码块语法高亮在流式下可能闪一下——可接受(完整行到达即定稿);若明显,预览阶段关高亮、之后再上。

> UI 全部内容(markdown/diff/工具卡/图片)由 **stream 完整行**实时渲染(与 jsonl 同构);jsonl 只负责
> DDB 持久化 + reconnect 重建。"打字机预览 → 完整行替换"已由 frontend replay 覆盖。

## 六、headless.mjs stream-json 行分派表(实测)

| line `type` | 子类型 | 当前处理 |
|---|---|---|
| `system` | `init` | 记录 `session_id` 和实际 `cwd` |
| `system` | `status` | 忽略 |
| `stream_event` | `message_start` | 忽略(回合开始) |
| `stream_event` | `content_block_start` | flush 前一批并发送 `stream_block_start` |
| `stream_event` | `content_block_delta` + `text_delta/thinking_delta` | 合并后发送 `stream_delta` |
| `stream_event` | `content_block_delta` + `input_json_delta` | 合并后发送 `stream_tool_input` |
| `stream_event` | `content_block_stop` | flush 并发送 `stream_block_stop` |
| `stream_event` | `message_delta` / `message_stop` | 忽略(回合结束标记) |
| `assistant` / `user` 完整行 | — | **`onMessage`** → extractForApp → WS `messages{noCache}`(权威消息,有 uuid+ts+content) |
| `result` | — | **本回合结束**:标 `busy=false`,若 queue 非空喂下一条;发 `stream_end`。**进程不退出**(持久管道) |

spawn 参数(常驻进程,每会话一次):
```
claude -p
  [--resume <sessionId> | --session-id <sessionId>]
  --input-format stream-json    // ⭐ 持久 stdin,多轮喂 user 消息
  --output-format stream-json
  --include-partial-messages
  --verbose
cwd = 会话/项目目录(已有会话用 projectHashToPath();新建用用户选的项目路径)
stdin 保持打开 → 进程常驻;idle 回收时关闭 stdin → 进程退出
```
每条消息写一行 JSON 到 stdin:
```
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"<消息>"}]}}\n
```
> 权限:默认加 `--permission-prompt-tool stdio`(**不加** bypass),透传用户既有权限配置。
> control_request/response 处理见第六·五节。

## 六·五、状态判断 & 权限:字段来源 + litter 处理方式(实测 + 源码核对)

三个状态判断(running / 结束 / 权限),实测本机 wire 格式并核对了 litter `translate/events.rs` +
`approval.rs` + `pool/claude_protocol.rs` 的处理:

### running(回合进行中)
- **stream-json 里没有"running"字段**。running = 我们自己维护的进程 `busy` 标志:
  **发出 user 消息 → busy=true;收到本回合 `result` → busy=false**。litter 同法:回合由调用方
  发消息驱动("turn/start"),`result` 信封标志回合结束。
- 辅助进度信号(可选):`system/status`、`system/thinking_tokens{estimated_tokens}`(实测存在,
  是思考 token 计数)。**litter 直接丢弃 `system/status`**(`events.rs:225 → Vec::new()`),
  不用它判状态。当前实现忽略该字段,只用 busy 标志。
- Bridge 在发送时写 `running`，收到 `control_request` 时写 `needs_input`，收到 `result` 时写
  `completed`。这比只靠 JSONL `stop_reason` 更即时。

### CC 结束(回合完成 / 出错)
`result` 信封(每回合一条,实测字段):
```
{ type:"result", subtype:"success"|"error_max_turns"|..., is_error:bool,
  stop_reason:"end_turn"|..., num_turns, result:"<最终文本>", duration_ms,
  total_cost_usd, usage:{...}, terminal_reason }
```
- **成功判定(litter `events.rs:1006`)**:`is_error === false && subtype === "success"` → 正常结束。
  否则(`is_error` 或 `subtype !== "success"`,如 `error_max_turns`)→ 发一条错误提示。
- `result` 到达 → busy=false + `stream_end`;`is_error` 为真时 `stream_end{error}`,前端预览标错误态。
- **进程不退出**(持久管道),继续等下一条 stdin;进程真正退出只发生在 idle 回收(关 stdin)或崩溃。

### 权限:默认 stdio 透传用户配置(不 bypass)

**决策**:默认 `--permission-prompt-tool stdio` **不加** `--dangerously-skip-permissions`。理由:bypass
是用我们的意志覆盖用户的安全配置,违背零侵入定位。stdio 不 bypass = **用户配什么权限,我们就什么权限**
(allow 列表里的直接跑、需确认的发 control_request、`defaultMode:bypassPermissions` 则从不询问)。
额外好处:给出**精确权限信号**,替掉现在脆弱的"5 秒启发式"(false-positive)。

工具调用时 CC 发**入站 `control_request`**:
```
{ type:"control_request", request_id:"<uuid>",
  request:{ subtype:"can_use_tool", tool_name, display_name, input,
            tool_use_id?, blocked_path?, decision_reason?, requires_user_interaction? } }
```
bridge 回**出站 `control_response`**(wire-quirk:`request_id` 嵌在 `response` 里,不在顶层):
```
{ type:"control_response",
  response:{ request_id:"<uuid>", subtype:"success",
             response:{ behavior:"allow", updatedInput:<原样 input 不改> }
                     | { behavior:"deny", message?, interrupt? } } }
```

**两类工具,两条处理路径(均实测)**:

1. **普通工具(Bash/Write/Edit…)**:`can_use_tool` → 桥接现有 permission 弹窗 → allow/deny。
   allow 时 `updatedInput` 回**原样 input 不改**(litter `approval.rs:303` 证实)。

2. **`requires_user_interaction:true` 的工具(AskUserQuestion / ExitPlanMode)**:
   - **control_response 无法传答案**(实测 allow/answers/selectedOptions 三种变体全返回
     `"The user did not answer the questions."`);且官方文档明确:v2.1.199+ 对
     `requires_user_interaction` 的工具**把 allow 强制转成 deny**;`updatedInput.answers` 的答案
     回传格式**仅 Agent SDK `canUseTool` 支持,CLI `--permission-prompt-tool` 不支持**。
   - **✅ 当前方案(实测通过)**:`control_response{behavior:"deny", message:answerText}`。
     CC 将 message 作为该交互工具的 OUT 并继续当前回合；取消时使用
     `{behavior:"deny", interrupt:true}`。
   - `control_request` 主动把完整 `questions[]`(header/options/multiSelect)推给我们，
     headless 下不再需要 capture-pane / 两次采样 / Escape 抢救。

> litter 现状:把 AskUserQuestion 归类 `RequestUserInput` 但走的是统一 allow/deny 审批分支
> (`approval.rs:275-299`),**并未真正回传答案**;它定义了 `request_user_input`(→ 合成 tool_result
> on stdin)但主路径没接上。我们的 deny+普通消息方案已实测跑通,更简单可靠。

### 额外字段小结(相对 jsonl)
| 字段/行 | 来源 | 当前用途 |
|---|---|---|
| `system/init` | 每进程一次 | 记录 session_id + cwd |
| `system/status` | 流中偶发 | **忽略**(litter 也忽略) |
| `system/thinking_tokens` | 思考时 | 忽略(可选做"思考中"指示) |
| `result` | 每回合一条 | **判回合结束 + 成功/失败**;busy→false |
| `control_request{can_use_tool}` | 每工具调用 | 普通工具→弹窗 allow/deny;requires_user_interaction→deny+answerText |
| `control_response` | bridge 回 | allow(原样 input)/ deny |
| `assistant`/`user` 完整行 | 每消息 | **权威消息**(uuid+ts+content):`onMessage`→`messages{noCache}`→app 渲染;jsonl 后到 uuid 去重 |

## 七、WS 协议新增

```
Bridge → Server → App:  { action: "stream_block_start", sessionId, streamId, blockId, kind, name?, seq } // 块开始
Bridge → Server → App:  { action: "stream_delta",       sessionId, streamId, blockId, chunk, seq }        // 文本/思考增量
Bridge → Server → App:  { action: "stream_tool_input",  sessionId, streamId, blockId, chunk, seq }        // 工具入参增量
Bridge → Server → App:  { action: "stream_block_stop",  sessionId, streamId, blockId, seq }                // 块结束
Bridge → Server → App:  { action: "stream_end",         sessionId, streamId, finalSeq, error? }            // 回合结束(finalSeq=总帧数)
Bridge → Server → App:  { action: "messages", sessionId, messages:[msg], noCache:true }                     // stream 完整行(权威)
```

### ⭐ 乱序保序:回合级 seq + 客户端 reorder buffer(web/js/reorder.js)
链路 bridge→Lambda→API GW→app 中,**每个 WS 帧是一次独立、时长不定的 Lambda 调用**,
`post_to_connection` 落地顺序 ≠ 发送顺序。litter 是单条有序 TCP,天然无此问题;我们必须让接收端
不依赖到达顺序。做法(实测 2800 随机投递 + 33 条真实 CC prompt 全通过):
- **发送端**:bridge 对一个回合内**每一帧**(start/delta/input/stop)打**回合级单调 `seq`**(post-increment,
  `_writeTurn` 每回合归零);delta/input 只带**增量 chunk**(不再是累积全文 → 流量 O(n²)→O(n));
  `stream_end` 带 `finalSeq`(= 总帧数)。
- **接收端(reorder buffer)**:`nextSeq` 有序区 + `pending: Map<seq,frame>` 空档缓存。
  `seq < nextSeq` 丢弃(幂等,重复/迟到);`seq > nextSeq` 进 pending;`seq === nextSeq` 应用并把
  pending 里连续的一并排空(头部满足即出队)。`end(finalSeq)`:只有 `nextSeq >= finalSeq` 才 `ended`
  (有空洞则继续等缺帧)。消费侧(`tickStreams` 打字机)只读有序区的 `committed`/`inputJson`,逻辑不变;
  `hasGap()` 为真时不让块提前 finalize(观感=还在打字,而非打完又续)。
- **最终权威**:jsonl → watcher → 完整 assistant 行(带 uuid)按 uuid 去重替换预览(`clearStreamPreviews`)。
  即使某帧被彻底吞掉、pending 永远补不上,权威行一到即整块覆盖成正确内容 → 空洞最坏"预览短暂缺一截",
  永不脏最终态。
- **straggler 复活防护**:`_streamEnded[streamId]` 跨 `clearStreamPreviews` 保留(streamId 每回合唯一),
  仅在切会话时清空 → Lambda 迟到帧无法复活已结束的预览。
- `stream_delta`/`stream_end`:纯实时预览,`_handle_bridge_relay` 订阅式转发,**不写 DDB**。
- headless 的 `messages` 帧:带 `noCache:true` → server 转发给 app 但**不写 DDB**(DDB 由 jsonl watcher 独占写);
  app 侧靠 uuid 去重与 jsonl 后到的同 uuid 帧合并。
- `streamId` 让 app 把打字机预览气泡关联到本回合,完整行到达时移除预览。

## 八、涉及文件与改动

| 文件 | 改动 |
|---|---|
| `bridge/headless.mjs` | **ClaudePool**:`Map<sessionId, HeadlessProc>`;`send(sessionId,cwd,text,cb)`(spawn/复用/queue)、`reapIdle()`(周期回收)、LRU 上限、崩溃移除;readline 分派 stdout(含 `control_request`);stdin 写 user 消息 + `control_response` |
| `bridge/ws.mjs` | `handleSendMessage` 调 `pool.send(...)`;daemon agent 接管;`control_request` → permission_request;App 的 permission_reply → allow/deny(或 requires_user_interaction 的 deny+答案回);新建常规会话预生成 UUID 后用 `--session-id` 启动 |
| `server/src/bridge_ws.py` | 加 `stream_delta`/`stream_end` → `_handle_bridge_relay`,不写 DDB(permission_request/reply 已有) |
| `web/js/ws.js` | 处理 `stream_delta`/`stream_end`;按 streamId 重排并渲染预览;以 streamId→clientId 将回复放到对应问题下;权威 `messages` 到达时完成交接 |
| `web/js/permission.js` | 展示工具权限、AskUserQuestion 和 ExitPlanMode，并回传 permission_reply |
| `docs/api.md` | 补 `stream_delta`/`stream_end` 协议 |
| `CLAUDE.md` | 记录 headless 进程池架构 + 生命周期 + 分流规则 + 单写者约束 + symlink cwd 坑 |

## 九、实施状态

以下步骤均已完成，保留清单用于说明交付边界。

### 发送流程(已存在 headless session 时)
```
App doSend(text)
 └ WS send_message {sessionId, text, clientId, device}
   └ Server _handle_send_to_bridge(原样透传)
     └ Bridge handleSendMessage → pool.send(sessionId, cwd, text, cb)
        ├ 池里有该 sessionId 进程?
        │   ├ 空闲 → stdin.write({"type":"user",...})
        │   └ busy → 入 queue,本回合 result 后再喂
        └ 无 → spawn 常驻进程(--resume sessionId),init 就绪后 stdin.write
        stdout 分派:text_delta → WS stream_delta;result → WS stream_end + busy=false
 └ 并行(与 headless 无关):CC 写 jsonl → watcher → WS messages → App 渲染权威消息(替换预览)
```
入口仍是 WS `send_message`；Bridge 内部使用 `pool.send → stdin`，前端接收
`stream_delta`/`stream_end` 做预览。

### 多 session 路由
`ClaudePool = Map<sessionId, HeadlessProc>`,**按 sessionId 路由**,天然隔离:
- 每 session 一个独立进程,并行互不干扰。
- 多网页看**同一** session → 都订阅同一 sessionId → server broadcast → 都收到同一份 stream_delta(多端同步)。
- 池上限 16,超限 LRU 淘汰最久空闲;每进程 idle 10min 自动回收。
- 不需要为"多 session"写特殊逻辑——Map key 隔离,与现有按 sessionId 订阅模型一致。

### 已完成步骤

- [x] **Step 0 — `headless.mjs` 独立命令行验证**(不接 ws/前端)。
  spawn 持久进程 + 持久 stdin + readline 分派(delta/result/init/control_request)+ resume 已有 session +
  多轮喂消息。写一个命令行脚本喂 2-3 条消息,肉眼确认 delta 流、result 收尾、上下文保持。
- [x] **Step 1 — 最小闭环(核心)**:进 idle session → 发消息 → `pool.send` → `stream_delta` 经 WS →
  前端打字机预览 → jsonl 落地替换预览。端到端一条路走通(ws.mjs 分流 + server 转发 `stream_delta`/`stream_end` +
  web 预览 handler)。
- [x] **Step 2 — 权限 stdio**:`--permission-prompt-tool stdio`;control_request(普通工具)→ 现有 permission 弹窗
  → allow/deny;requires_user_interaction(AskUserQuestion/ExitPlanMode)→ deny + 答案走普通消息(实测方案)。
- [x] **Step 3 — 新建会话走 headless**:Bridge 预先生成 sessionId，以 `--session-id` spawn，
  先回 `send_message_result` 再开始 streaming。
- [x] **Step 4 — 生命周期 + 失败回退**:`reapIdle`(10min)+ LRU 上限(16)+ 崩溃重 spawn；
  CC 拒绝或异常时返回明确错误，会话仍可只读。
- [x] **Step 5 — tmux 退役**:`projectHashToPath` 移入 `session.mjs`，interrupt 走 headless，
  `tmux.mjs`、Stall Rescue、`streamMode` 和旧命令输出路径均已删除。

## 十、验证清单

- [x] 已有 idle 会话发消息 → 打字机预览逐字出现 → jsonl 落地后无重复气泡、无破版
- [x] daemon agent 的 Web 接管 → 停止 daemon 后由 headless 继续，状态不被旧 blocked 记录覆盖
- [x] 新建会话 → 先返回预生成 sessionId 并订阅 → 预览 + 落地一致
- [x] 富 markdown(代码块/表格/列表/链接/行内代码)流式重渲不破版,落地后与现网渲染一致
- [x] headless 中途失败 → 预览不卡死;发送气泡状态正确
- [x] stream_delta/stream_end 不进 DDB(缓存不被污染)
- [x] **同会话多端/连发** → 复用同一进程(单写者),消息串行,jsonl 不分叉
- [x] **idle 回收** → 会话闲置超 TTL 后进程自动退出,jsonl 完整
- [x] **回收后再发** → 自动 `--resume` 重启,上下文续上
- [x] **超上限** → LRU 淘汰 idle 进程;busy 进程不被淘汰
- [x] **普通工具权限** → control_request → 弹窗 → allow/deny 生效
- [x] **AskUserQuestion(含多问题)** → 完整问题推到 App → 用户答 → deny+答案回 → CC 收下继续
- [x] **ExitPlanMode** → 计划推到 App → 批准/拒绝正确
- [x] **defaultMode:bypassPermissions 的会话** → 普通工具不弹窗，AskUserQuestion 仍可交互

Bridge 状态交接和 frontend streaming/queue 场景有自动化回归。`ClaudePool` 的 idle reap/LRU
目前主要由实跑与实现审查覆盖，后续可补独立进程生命周期单测；这不影响 Phase 2E 功能完成状态。

## 十一、流式粒度 & 实时性基准测试(本机 CC 2.1.204 + EC2 2.1.206 实跑)

跑了 9 类覆盖全部 UI 节点的会话,带毫秒时间戳记录每行到达时刻。

### 11.1 UI 节点类型 × stream-json 兼容性(全部 ✅)

| UI 节点 | 测试 | stream-json 表现 | 与现有 UI 输入格式 |
|---|---|---|---|
| 纯文本/prose | t1 | `text_delta` 逐片 | ✅ 累积重渲 |
| 富 markdown(标题/列表/代码块/表格/链接/加粗/行内码) | t2 | `text_delta` 逐片,marked 容错重渲 | ✅ 落地由 renderSingleMessage 全量渲染 |
| Bash 执行 in/out | t3 | tool_use 经 `input_json_delta` 流式;tool_result 作为完整 `user` 行到达,含 `tool_use_result{stdout,stderr,interrupted}` | ✅ **结构与 extract.mjs 现读的完全一致** |
| 文件 Read | t4 | 同上 | ✅ |
| 文件 Edit(diff) | t5 | tool_use.input 流式,落地含完整 diff 数据 | ✅ |
| 多工具序列 | t6 | 多个 tool_use/tool_result 交替,块边界清晰 | ✅ |
| 扩展 thinking | t7 | `thinking` 块 + `thinking_delta`/`signature_delta` | ✅(可选流式) |
| TodoWrite(todo 列表) | t8 | tool_use.input 经 input_json_delta 流式,完整 assistant 行落地 | ✅ |
| 图片 Read | t9 | tool_use → tool_result(user 行) → 文本 | ✅(图片走 claude-bridge: → Read 路径不变) |

**关键**:stream-json 的 `assistant`/`user` 行的 `message.content[]` 与 jsonl **完全同构**,
tool_use/tool_result/toolUseResult 字段名一致 → **现有 extract.mjs / renderSingleMessage 零改动即可复用**。
理论上"json 格式兼容"得到实测证实。

### 11.2 流式粒度(text_delta)

| 测试 | #delta | char/delta 均值 | char 范围 | delta 间隔均值 | 间隔最大 |
|---|---|---|---|---|---|
| t1 prose | 66 | 15.4 | 1–40 | 55.6ms | 967ms |
| t2 rich md | 32 | 13.8 | 1–27 | 33.5ms | 771ms |
| t3 bash | 14 | 12.5 | 4–18 | 53.3ms | 657ms |
| t4 read | 20 | 14.1 | 2–25 | 56.7ms | 949ms |
| t7 think | 67 | 11.2 | 1–26 | 50.2ms | 945ms |
| t9 img | 16 | 8.2 | 1–17 | 295.9ms | 3678ms |
| EC2 prose | 63 | 14.4 | 1–37 | 59.1ms | 1325ms |

**结论 — 粒度是"几个词一片,不稳定"**:
- 不是逐字符,也不是逐句。**平均每片 8–15 字符(约 1–3 个词/token 组)**,单片 1–40 字符波动大。
- 间隔平均 30–60ms(顺滑打字机),但会有偶发 700ms–1s+ 的停顿(模型内部;工具前后停顿更长)。
- 本机与 EC2 粒度基本一致(avg ~14 char/delta,~59ms 间隔)→ 粒度由**模型侧**决定,与网络位置无关。

### 11.3 实时性:headless streaming vs 旧 tmux+jsonl(核心结论)

旧 tmux 方案的瓶颈已实测确认:**CC 只在一个 content block 完整生成后,才把整段 assistant 消息
一次性写入 jsonl**(实测 jsonl 文件大小是**一次性跳变** +2629B / +11089B,而非随生成增长)。
所以 tmux+watcher 方案下,app 必须等整段生成完才能看到文字。

| 场景 | headless 首字可见 | tmux+jsonl 最早可见 | **实时性提升** | 打字机时长 |
|---|---|---|---|---|
| 短回合(3 句) | 7813ms | 8979ms(jsonl 落地) | **早 1.2s** | 1.0s 逐字流动 |
| 长回合(500 字) | 6032ms | 21818ms(jsonl 落地) | **早 15.8s** | 15.6s 逐字流动 |
| 长回合(EC2) | ~6.9s | 整段生成后(>13.6s) | 数秒–十几秒 | 15.1s |

**结论**:
- headless 在 **firstDelta**(首字)就能显示,tmux 要等**整段 block 落盘**。回合越长差距越大:
  短回合领先 ~1s,500 字长回合**领先约 16 秒**。
- 更重要的是**体验差异**:tmux 是"空白等待十几秒 → 整段突现";headless 是"秒级出字 → 逐字流动"。
  这正是"更丝滑"的来源,长回合尤其明显。
- 一次性 headless `-p` 的 jsonl 甚至在**进程退出时**才落地(比 streaming 的 lastDelta 还晚),
  进一步说明:**实时性提升不是几百 ms 的边际优化,而是"能否边生成边看" vs "只能等结果"的本质差别。**

> 注:firstDelta 的绝对值(6–7s)主要是 Opus 的模型 TTFT,tmux 和 headless 都要等这段;
> 差距体现在 TTFT **之后**——headless 立即流出,tmux 还要再等整段生成完 + 落盘。

## 十二、running 中连发消息（已解决）

旧 tmux 路径依赖 CC 的 `queue-operation`，队列消息可能没有 `type:"user"` echo，导致乐观气泡
长期停在 sending。Phase 2E 不再解析该路径：

- `ClaudePool` 在 session 进程 busy 时把新消息放入自己的 FIFO queue，上一回合结束后调用
  `_writeTurn`，因此每条消息都会进入正常 headless 输入和权威消息链路。
- 每次发送都有独立 `clientId` 和 `streamId`。`send_message_result` 建立两者映射，预览及权威
  assistant 行按身份放在对应问题下，不依赖文本或时间戳猜测。
- 乐观 user 气泡原位升级并保留 `data-anchor`；真实 echo、后续确认 watermark 和 turn-end
  reconciliation 负责清理 pending，不会因缺失旧式 queue-operation echo 永久卡住。

该流程由 frontend replay 的 burst、乱序 delivery、多 block 和 interrupt 场景覆盖。

## 十三、tmux 退役后的当前架构

tmux、Stall Rescue、capture-pane 命令输出和 `streamMode` 已全部删除。当前保留三套职责：

| 职责 | 当前实现 |
|---|---|
| JSONL 监听与持久化 | `watcher.mjs` / `extract.mjs` / `sync.mjs` 负责历史、DDB 和断线恢复；headless 实时帧不写 DDB |
| 外部会话状态 | `session.mjs` 结合进程、daemon roster 和 JSONL 推导 terminal/VS Code/agent 状态 |
| Web 交互 | `headless.mjs` `ClaudePool` 负责发送、streaming、queue、interrupt、权限、idle reap 和 LRU |

状态所有权优先级为：busy pool-owned > roster-active daemon > external process/JSONL。空闲 pool
只保留可复用进程，不阻止 terminal 后续把状态更新为 running 或 `needs_input`；结构化
`AskUserQuestion`/`ExitPlanMode` 可精确识别，普通文本结尾提问仍属于外部状态的已知限制。

Slash command 主目录来自独立、无会话持久化的 headless `initialize` control request，直接复用
当前 CC 的命令、描述、参数、模型和账号过滤结果。Bridge 只维护手机端行为分类与过滤，不维护
内置命令数据。旧 CC 不支持该请求时，`commands.mjs` 仅扫描用户、项目和插件的自定义
command/Skill 作为回退。

`/model`、`/effort`、`/fast` 使用运行态返回的二级选项；同步本地命令继续写入同一 session 的
headless stdin，并以 `commandOutput` 结束乐观气泡和 loading。普通 prompt/Skill 仍走正常
streaming 与 JSONL。

headless 被 Claude 拒绝或进程异常时，Bridge 返回明确错误并保留只读 JSONL 监听，不再尝试
任何 tmux fallback。
