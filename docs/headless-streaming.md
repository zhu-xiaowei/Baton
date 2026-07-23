# Headless Stream-JSON 实时性 — 实现流程文档

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
   → **新建会话定位 jsonl / project,必须用 `system/init` 回传的 `cwd` 与 `session_id`,
   不能用我们自己拼的路径。** 现有 watcher 靠 fs.watch 整个 `CLAUDE_PROJECTS` 递归监听,
   落在哪个 hash 目录都能捕获,所以**落地不受影响**;受影响的只是"新建会话时我们怎么回报 sessionId"。

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
  sessionId,      // system/init 回传(新建会话在此拿到 id)
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
| 新建会话 | 走 headless,从 `system/init.session_id` 拿 id、`.cwd` 定位项目 |
| streamMode 开关 | **默认 true**;过渡期可切回 tmux 旧路径,旧路径删除后开关移除 |
| 分流判据 | **乐观 headless**:一律尝试,CC 拒绝(EXIT=1)/异常 → 只读+提示(见第四、十三节)|
| 权限 | **默认 `--permission-prompt-tool stdio` 不加 bypass** — 用户配什么权限就什么权限(零侵入)。见第六·五节 |
| 显示/落地 | stream 完整行=权威(渲染),`text_delta`=打字机预览,jsonl 后到 uuid 去重;DDB 只由 jsonl 写(见结论 2/8) |
| 预览渲染 | 完整 markdown 容错重渲(见第五节) |
| 按需启动 | **不预启动**;新消息到达且无进程时才 spawn(spawn→init 就绪约 ≤30s,之后同会话复用) |
| idle 回收 | 周期 `reap`:`lastActiveAt` 超 **idleTTL(默认 10min)** 且非 busy → 关 stdin,进程干净退出(jsonl 保留) |
| 数量上限 | **默认 16 个进程**,超限时 LRU 淘汰最久未活跃的 idle 进程;busy 进程永不回收/淘汰 |

### 单写者约束(两层)
1. **内部**:同会话只有一个 headless 进程(进程池保证)→ 消除"我们自己起多个"的双写。
2. **外部**:该会话不能已被**用户的活进程**(终端/VS Code/daemon agent)占用 → 靠分流判据规避
   (第四节)。这一层进程池解决不了(那是别人的进程),必须判断。

## 三、数据流

### 发送(App → CC),headless 路径
```
App doSend()  ──WS send_message {sessionId|projectHash, text, streamMode:true, clientId}──►
Server _handle_send_to_bridge(原样透传,去掉 device) ──►
Bridge handleSendMessage → pool.send(sessionId|新建, cwd, text, callbacks):
  ┌─ 进程已存在且空闲 → 直接往 stdin 写 user 消息
  ├─ 进程已存在且 busy → 入 queue,回合结束后喂
  └─ 进程不存在 → spawn 常驻进程(新建不带 --resume;已有带 --resume <id>),stdin 保持打开
  逐行解析 stdout(见第六节):
    system/init                → 拿/校验 session_id + cwd(新建会话据此回报 id)
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
- 常量集中一处(`HEADLESS_IDLE_TTL_MS` / `HEADLESS_MAX_PROCS` / `HEADLESS_INIT_TIMEOUT_MS`),
  MVP 可先取 litter 默认(10min / 16 / 30s)。

## 四、分流判断(bridge/ws.mjs `handleSendMessage`)

**策略:乐观 headless + 只读回退**(见十三节决策)。不预判进程/roster/running,一律尝试 headless:

```
pool.send(sessionId|新建, cwd, text) 尝试起/复用 headless
  ├─ 成功 → 流式 + 落地
  └─ CC 拒绝(EXIT=1,如活跃 bg agent)/ 进程异常
        → 不再尝试任何发送(无 tmux 兜底)
        → 回 App 明确提示("该会话正被别处占用,无法发送")
        → 会话内容仍可只读(jsonl 监听照常)
```
- 双轨过渡期:`streamMode` 开关(默认 on)控制走 headless 还是旧 tmux;旧路径删除后开关一并移除。
- 为什么不预判:活跃占用罕见(用户不两地同跑);CC 对活跃 bg agent 有 EXIT=1 保护;普通活跃会话
  双写风险与现状 tmux auto-launch 等同(现状本就不查,见十三节)。乐观尝试 + 失败只读,代码最简。

### Agent 会话(实测支持,且更简单)
**`claude -p --resume <agentSessionId>` 可直接 resume 一个 daemon agent 会话**,实测(本机 CC 2.1.204):
- EXIT=0,stream-json 结构与普通会话完全一致;sessionId 不变;对话行追加进同一 jsonl(20→31 行)。
- **不触碰 `jobs/<id>/state.json`**(`backend:daemon`/`state` 原封未动)→ resume 后 bridge 仍把它
  识别为 agent(`getDaemonSessions()` 读 state.json),[Agent] badge 不丢。
- agent 会话磁盘结构 = 普通 CC jsonl + 额外 `agent-name`/`agent-setting` 元数据行,`-p` 当普通会话处理。

→ **headless 大幅简化 agent 发送**:现状要 `launchAgentsSession()` 开 tmux + `claude agents` TUI 导航 +
Right 箭头 + sendKeys(依赖 TUI 布局,易碎);headless 一行 `claude -p --resume <id>` 搞定 + 白拿流式。

**⚠️ 活跃 agent 双写边界**:daemon 正在跑的 agent(roster active workers)若被 `-p --resume` 就是双写。
但**不需要预查 roster**:CC 对活跃 bg agent 有内置保护,`-p --resume` 直接 **EXIT=1**
(`Session is currently running as a background agent (bg)`)→ 命中"只读+提示"回退。乐观尝试即可,
CC 的 EXIT=1 就是最可靠的信号(比预查 roster 更准,roster 有时序延迟)。

### ⚠️ 关键实测:resume 一个「正在运行」的会话会怎样(双写边界的铁证)

真机跑了三个场景(CC 2.1.204),锁死了分流规则的必要性:

| 场景 | headless `--resume` 结果 | 是否损坏 |
|---|---|---|
| 普通会话 idle/done(无活进程) | ✅ EXIT=0,正常 | 安全 |
| 普通会话 **活进程正在生成中** | ⚠️ EXIT=0,**静默双写** | **jsonl 损坏** |
| agent **done**(非活跃) | ✅ EXIT=0,身份保留 | 安全 |
| agent **daemon 活跃运行中** | 🛡️ **EXIT=1,CC 主动拒绝** | **CC 保护,不损坏** |

**普通活跃会话双写的证据**:在 tmux 里开交互 CC 跑"数数到40",生成中用 headless resume 同一 sessionId
发"BANANA"。结果:两个进程都 EXIT 成功,同一 jsonl(9→24 行)里**混进两条对话**,parentUuid 链断裂
分叉(`assistant→d0151717`、`assistant(BANANA)→fa02e66a`,parent 均指向对方内存里从未落盘的节点)。
→ 矛盾的本质是**内存态**:两个进程各按自己内存的 uuid/行号往同一文件追加,合到一起就是乱麻。
"先 SIGSTOP 挂起再 resume"无用——SIGCONT 后活进程仍按自己内存续写,照样分叉。

**关键不对称性**:**CC 对活跃 bg agent 有内置双写保护(EXIT=1),对普通交互会话没有(静默双写损坏)。**
影响:
- agent 会话:CC 兜底 → 误对活跃 agent 起 headless 最坏 EXIT=1,数据不坏 → 命中只读回退。
- 普通会话:CC 不兜底 → 理论上活进程占用时起 headless 会静默双写。但**现状 tmux auto-launch 本就不查
  活进程、照样双写**(见十三节 `ws.mjs:261`),headless 不比现状差;活跃占用罕见,接受此风险,失败只读。
- `--fork-session` 会分叉出**新 sessionId**、不碰原文件 → 安全但对我们无用(我们要 resume 同一会话)。

## 五、预览渲染:完整 markdown 的容错做法

用户要求预览也跑完整 markdown。半截 `text_delta` 若逐片拼 HTML 会破版,做法定为:
- **每次都用「累积到目前的完整文本」整体调 marked 重渲预览气泡**(不是逐 delta 增量拼接)。
  marked 对未闭合语法是容错的(半个代码块/表格当普通文本处理),下一片补齐后重渲即自动纠正。
- 预览气泡复用现有 markdown 渲染(`web/js/components/markdown.js`),但**只渲文本**;
  工具卡/diff/图片等**不在预览做**,一律等**stream 完整行**(经 `messages`)由 `renderSingleMessage`
  全量渲染(工具卡/tool_result 都在完整行里,无需等 jsonl)。
- 代码块语法高亮在流式下可能闪一下——可接受(完整行到达即定稿);若明显,预览阶段关高亮、之后再上。

> UI 全部内容(markdown/diff/工具卡/图片)由 **stream 完整行**实时渲染(与 jsonl 同构);jsonl 只负责
> DDB 持久化 + reconnect 重建。需验证的是"打字机预览 → 完整行替换"的无缝、无重复、无闪烁。

## 六、headless.mjs stream-json 行分派表(实测)

| line `type` | 子类型 | MVP 处理 |
|---|---|---|
| `system` | `init` | 拿 `session_id` + `cwd`(新建会话据此回报 id) |
| `system` | `status` | 忽略 |
| `stream_event` | `message_start` | 忽略(回合开始) |
| `stream_event` | `content_block_start` + `content_block.type==='text'` | 开一个文本预览块 |
| `stream_event` | `content_block_start` + `content_block.type==='tool_use'` | 忽略(完整 assistant 行会带 tool_use) |
| `stream_event` | `content_block_delta` + `delta.type==='text_delta'` | **`onDelta(streamId, delta.text)`**(打字机预览) |
| `stream_event` | `content_block_delta` + `delta.type==='input_json_delta'` | 忽略(工具入参分片) |
| `stream_event` | `content_block_stop` | 忽略 |
| `stream_event` | `message_delta` / `message_stop` | 忽略(回合结束标记) |
| `assistant` / `user` 完整行 | — | **`onMessage`** → extractForApp → WS `messages{noCache}`(权威消息,有 uuid+ts+content) |
| `result` | — | **本回合结束**:标 `busy=false`,若 queue 非空喂下一条;发 `stream_end`。**进程不退出**(持久管道) |

spawn 参数(常驻进程,每会话一次):
```
claude -p
  [--resume <sessionId>]        // 已有会话才带;新建不带(从 system/init 拿 id)
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
  不用它判状态。MVP 同样忽略,只用 busy 标志。
- 对现有 UI:`busy` → `wsRunning=true`(spinner);`result` → false。比现在靠 jsonl `stop_reason`
  推断更**即时准确**(不用等落盘)。

### CC 结束(回合完成 / 出错)
`result` 信封(每回合一条,实测字段):
```
{ type:"result", subtype:"success"|"error_max_turns"|..., is_error:bool,
  stop_reason:"end_turn"|..., num_turns, result:"<最终文本>", duration_ms,
  total_cost_usd, usage:{...}, terminal_reason }
```
- **成功判定(litter `events.rs:1006`)**:`is_error === false && subtype === "success"` → 正常结束。
  否则(`is_error` 或 `subtype !== "success"`,如 `error_max_turns`)→ 发一条错误提示。
- MVP:`result` 到达 → busy=false + `stream_end`;`is_error` 为真时 `stream_end{error}`,前端预览标错误态。
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
   - **✅ 可行方案(实测通过)**:`control_response{behavior:"deny", message:"answered out of band"}`
     中止工具调用,然后把用户的选择作为**普通 user 文本消息**写进 stdin
     (`{"content":[{"type":"text","text":"I choose Spaces."}]}`)→ CC 收下并继续
     ("You chose spaces for indentation.")。
   - 这与现有 tmux **stall-rescue 收尾一致**(答案当普通 chat message 回)。**且 control_request
     主动把完整 `questions[]`(header/options/multiSelect)推给我们** → headless 下
     **彻底不需要 capture-pane / 两次采样 / Escape 抢救那套 Stall Rescue 机制**。

> litter 现状:把 AskUserQuestion 归类 `RequestUserInput` 但走的是统一 allow/deny 审批分支
> (`approval.rs:275-299`),**并未真正回传答案**;它定义了 `request_user_input`(→ 合成 tool_result
> on stdin)但主路径没接上。我们的 deny+普通消息方案已实测跑通,更简单可靠。

### 新增/额外字段小结(相对 jsonl)
| 字段/行 | 来源 | MVP 用途 |
|---|---|---|
| `system/init` | 每进程一次 | 拿 session_id + cwd |
| `system/status` | 流中偶发 | **忽略**(litter 也忽略) |
| `system/thinking_tokens` | 思考时 | 忽略(可选做"思考中"指示) |
| `result` | 每回合一条 | **判回合结束 + 成功/失败**;busy→false |
| `control_request{can_use_tool}` | 每工具调用 | 普通工具→弹窗 allow/deny;requires_user_interaction→deny+答案走普通消息 |
| `control_response` | bridge 回 | allow(原样 input)/ deny |
| `assistant`/`user` 完整行 | 每消息 | **权威消息**(uuid+ts+content):`onMessage`→`messages{noCache}`→app 渲染;jsonl 后到 uuid 去重 |

## 七、WS 协议新增

```
Bridge → Server → App:  { action: "stream_delta", sessionId, streamId, text }   // 打字机增量
Bridge → Server → App:  { action: "stream_end",   sessionId, streamId, error? } // 回合结束
Bridge → Server → App:  { action: "messages", sessionId, messages:[msg], streamId, noCache:true } // stream 完整行(权威)
```
- `stream_delta`/`stream_end`:纯实时预览,`_handle_bridge_relay` 订阅式转发,**不写 DDB**。
- headless 的 `messages` 帧:带 `noCache:true` → server 转发给 app 但**不写 DDB**(DDB 由 jsonl watcher 独占写);
  app 侧靠 uuid 去重与 jsonl 后到的同 uuid 帧合并。
- `streamId` 让 app 把打字机预览气泡关联到本回合,完整行到达时移除预览。

## 八、涉及文件与改动

| 文件 | 改动 |
|---|---|
| `bridge/headless.mjs`(新增) | **ClaudePool**:`Map<sessionId, HeadlessProc>`;`send(sessionId,cwd,text,cb)`(spawn/复用/queue)、`reapIdle()`(周期回收)、LRU 上限、崩溃移除;readline 分派 stdout(含 `control_request`);stdin 写 user 消息 + `control_response` |
| `bridge/ws.mjs` | `handleSendMessage` 加分流;命中调 `pool.send(...)`;`control_request` → permission_request 推 App;App 的 permission_reply → allow/deny(或 requires_user_interaction 的 deny+答案回);新建会话从 `system/init` 拿 sessionId 后回 `send_message_result` |
| `server/src/bridge_ws.py` | 加 `stream_delta`/`stream_end` → `_handle_bridge_relay`,不写 DDB(permission_request/reply 已有) |
| `web/js/ws.js` | `onmessage` 加 `stream_delta`/`stream_end`;按 streamId 累积 + marked 重渲预览;`messages` 落地时移除同 streamId 预览;`doSend` 带 `streamMode`;permission 弹窗复用现有 |
| `web/setup.html` | 全局开关 `localStorage._streammode`,默认 on |
| `docs/api.md` | 补 `stream_delta`/`stream_end` 协议 |
| `CLAUDE.md` | 记录 headless 进程池架构 + 生命周期 + 分流规则 + 单写者约束 + symlink cwd 坑 |

## 九、分步实施

分支:`headless`(独立于 main,可放手改)。原则:**先跑通最小闭环,再逐步完善**。

### 发送流程(已存在 headless session 时)
```
App doSend(text)
 └ WS send_message {sessionId, text, streamMode:true, clientId, device}
   └ Server _handle_send_to_bridge(原样透传)
     └ Bridge handleSendMessage → pool.send(sessionId, cwd, text, cb)
        ├ 池里有该 sessionId 进程?
        │   ├ 空闲 → stdin.write({"type":"user",...})
        │   └ busy → 入 queue,本回合 result 后再喂
        └ 无 → spawn 常驻进程(--resume sessionId),init 就绪后 stdin.write
        stdout 分派:text_delta → WS stream_delta;result → WS stream_end + busy=false
 └ 并行(与 headless 无关):CC 写 jsonl → watcher → WS messages → App 渲染权威消息(替换预览)
```
**入口不变**(仍是 WS `send_message`),只是 bridge 内部从 tmux send-keys 换成 `pool.send → stdin`。
前端发送逻辑几乎不改,只新增接收 `stream_delta`/`stream_end` 做预览。

### 多 session 路由
`ClaudePool = Map<sessionId, HeadlessProc>`,**按 sessionId 路由**,天然隔离:
- 每 session 一个独立进程,并行互不干扰。
- 多网页看**同一** session → 都订阅同一 sessionId → server broadcast → 都收到同一份 stream_delta(多端同步)。
- 池上限 16,超限 LRU 淘汰最久空闲;每进程 idle 10min 自动回收。
- 不需要为"多 session"写特殊逻辑——Map key 隔离,与现有按 sessionId 订阅模型一致。

### 步骤

- **Step 0 — `headless.mjs` 独立命令行验证**(不接 ws/前端)。**先做,风险最高的一环先固化。**
  spawn 持久进程 + 持久 stdin + readline 分派(delta/result/init/control_request)+ resume 已有 session +
  多轮喂消息。写一个命令行脚本喂 2-3 条消息,肉眼确认 delta 流、result 收尾、上下文保持。
- **Step 1 — 最小闭环(核心)**:进 idle session → 发消息 → `pool.send` → `stream_delta` 经 WS →
  前端打字机预览 → jsonl 落地替换预览。端到端一条路走通(ws.mjs 分流 + server 转发 `stream_delta`/`stream_end` +
  web 预览 handler)。**只做 bypass/allow 会话、已有 idle session,不碰权限/新建/回收。**
- **Step 2 — 权限 stdio**:`--permission-prompt-tool stdio`;control_request(普通工具)→ 现有 permission 弹窗
  → allow/deny;requires_user_interaction(AskUserQuestion/ExitPlanMode)→ deny + 答案走普通消息(实测方案)。
- **Step 3 — 新建会话走 headless**:不带 `--resume` spawn,从 `system/init` 拿 sessionId + cwd(注意 symlink),
  回 `send_message_result`,前端 subscribe。
- **Step 4 — 生命周期 + 只读回退**:`reapIdle`(10min)+ LRU 上限(16)+ 崩溃重 spawn;
  CC EXIT=1/异常 → 只读+提示(前端显示"该会话正被别处占用")。`_streammode` 开关默认 on,双轨并存。
- **Step 5 — 退役(稳定后)**:搬走 `projectHashToPath`/`getClaudeProcesses`,`interruptSession` 重实现 →
  **删 `tmux.mjs`** + Stall Rescue + 命令适配层 → 移除 `streamMode` 开关(headless 成唯一发送路径)。见十三节。

## 十、验证清单

- [ ] 已有 idle 会话发消息 → 打字机预览逐字出现 → jsonl 落地后无重复气泡、无破版
- [ ] 活跃 bg agent 发消息 → CC EXIT=1 → **只读+提示**(不双写、不卡死)
- [ ] 新建会话发消息 → 从 system/init 拿 sessionId(注意 symlink cwd)→ 订阅 → 预览 + 落地一致
- [ ] 富 markdown(代码块/表格/列表/链接/行内代码)流式重渲不破版,落地后与现网渲染一致
- [ ] headless 中途失败 → 预览不卡死;发送气泡状态正确
- [ ] 过渡期关闭 streamMode → 走旧 tmux 路径(零回归);旧路径删除后此项移除
- [ ] stream_delta/stream_end 不进 DDB(缓存不被污染)
- [ ] **同会话多端/连发** → 复用同一进程(单写者),消息串行,jsonl 不分叉
- [ ] **idle 回收** → 会话闲置超 TTL 后进程自动退出(`ps` 无残留),jsonl 完整
- [ ] **回收后再发** → 自动 `--resume` 重启,上下文续上
- [ ] **超上限** → LRU 淘汰 idle 进程;busy 进程不被淘汰
- [ ] **普通工具权限** → 用户 allow 列表内直接跑;需确认的 control_request → 弹窗 → allow/deny 生效
- [ ] **AskUserQuestion(含多问题)** → 完整问题推到 App → 用户答 → deny+答案回 → CC 收下继续
- [ ] **ExitPlanMode** → 计划推到 App → 批准/拒绝正确
- [ ] **defaultMode:bypassPermissions 的会话** → 全自动不弹窗(仍能处理 AskUserQuestion)

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

### 11.3 实时性:headless streaming vs 现有 tmux+jsonl(核心结论)

现有 tmux 方案的瓶颈已实测确认:**CC 只在一个 content block 完整生成后,才把整段 assistant 消息
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

## 十二、TODO:running 中发送的消息 echo 缺失(queue-operation)

**问题**(实测确认,CC 2.1.206):CC 正在生成回合(running)时,App 发的消息会进入
CC 的**消息队列**(TUI 显示 `Press up to edit queued messages`),而**队列消息从不以
`type:"user"` 落盘** —— 它只记录为 `queue-operation` 条目:

```json
{ "type": "queue-operation", "operation": "enqueue"|"remove",
  "timestamp": "...", "sessionId": "...", "content": "<原始消息文本>" }
```

CC 处理该队列消息时(enqueue→remove→并入下一个 assistant turn),依然**不写对应的
`user` 条目**(实测:queue 消息只出现在 `queue-operation` / `attachment` /
assistant 回应文本里,全程无 `type:user`)。

**后果**:App 的乐观气泡靠"echo 匹配"消除(`messageEchoed` 只找 `type:"user"`),
队列消息的 echo **永远不来** → 气泡永久卡在 "sending"。现有两条 orphan 规则
(`seq < lastDeliveredSeq`、echo 出现)都救不了**最后一条**(无更晚 send 抬高 watermark、
echo 永不来)。

**方案(headless 阶段一并实现)**:以 `queue-operation` 作为 echo 信号。
- **bridge**:`VALID_TYPES` 目前不含 `queue-operation`,被 watcher 过滤。放行(或转换)
  `enqueue` 事件,推给 App —— 它带 `sessionId` + `content`,足以关联到对应 pending。
- **App**:收到 enqueue → 按 `content` 匹配 pending → 气泡从 "sending" 改为**"排队中"**
  状态(区别于普通已发送:告诉用户"CC 已接收、正在排队",不是失败也不是丢失)。
  收到 `remove` 或后续 assistant turn 时正常收尾。
- 这样队列消息有明确的生命周期显示(排队中 → 处理中 → 完成),不再永久卡死。

**为何放到 headless 阶段**:headless streaming 路径下消息直接进常驻进程 stdin,
running 时是"空闲直发 / busy 入 queue"(见"三·五 进程生命周期"),队列语义由我们
自己的 ClaudePool 掌控,可直接给出准确的 queued/processing 状态,比事后解析
tmux+jsonl 的 `queue-operation` 更干净。当前 tmux 路径先用"session 结束即清理未处理
气泡"的兜底(见下)止血。

### 已实现的兜底:session idle 时清理残留 pending

在 tmux 路径下,作为 queue-operation 方案落地前的止血(见 `web/js/ws.js`
`reconcileEchoedPending` 规则 3):当**新到的消息批把 CC 带回 idle**
(`hasTurnFrame && !deriveRunning()` —— 真实回合帧、非开场快照)时,仍无 echo 的
pending 气泡判定为"CC 未落盘的队列消息",清理掉。CC 已结束回合回到 idle 却没有该消息的
`type:user` echo → 它不可能还在处理中 → 安全清理。

时序安全:正常 idle 发送的消息,其 `user` echo 会在 CC 的 end_turn **之前**到达
(FIFO:先收 user、再回复、最后 end_turn),规则 1(echoed)先命中;规则 3 只清"CC 回到
idle 时仍无 echo"的队列消息。额外用 3s grace(`sentAt`)兜底一个边角:刚发出、echo 还没回
时若恰好来了一批无关的 idle 回合帧,不误清尚可能 echo 的气泡。

## 十三、tmux 退役清单 & headless 生态对照(架构决策)

全面分析"headless 能否替代 tmux 整套"的结论:**不能全删,但能大幅瘦身**。关键是把系统拆成
**三套独立机制**,分别判断——最容易犯的错是把它们当一整块。

### 三套机制拆分

| 机制 | 组成 | 与 tmux 关系 | 结论 |
|---|---|---|---|
| ① **jsonl 监听 → 提取 → WS/DDB 同步** | `watcher.mjs` / `extract.mjs` / `sync.mjs` | **无关** | **永远保留**。DDB 持久化的唯一写者;历史/刷新/reconnect 数据源;补 ai-title 等元数据。实时显示走 stream,jsonl 后到 uuid 去重 |
| ② **状态检测** | `session.mjs` `getRunningInfo`(ps aux)/ `checkStopped` / capture-pane 判 busy | 部分依赖 | **保留**(观测用户自己开的会话);bridge 自己的 headless 会话状态由进程 `busy` 标志直接给,更准 |
| ③ **发送消息** | tmux send-keys / launch / TUI 导航 / Stall Rescue | 全依赖 tmux | **headless 替代主路径**,大幅退役(见下) |

### 场景决策(用户判断 + 实测)

采用 **"乐观 headless + 失败回退"** —— 不预判进程/roster/running,一律直接起 headless,CC 拒绝
(EXIT=1)或异常再回退。理由:

- **用户 tmux 终端正用**:不考虑(用户不会两地同跑;tmux 慢、无 streaming)。落到 running 分支,headless 不介入。
- **用户 VS Code/裸终端开着**:现状 tmux auto-launch **本就不检查活进程、照样双写**(pre-existing bug,见
  `ws.mjs:261` no_tmux_target 分支)→ headless 不比现状差,且能靠状态判据挡掉一部分,反而更安全。
- **done agent**:headless resume 正常(实测 EXIT=0,身份保留)。
- **活跃 agent**:CC 主动拒绝(EXIT=1)→ 回退。不需预查 roster。

### 可退役的 tmux 逻辑(③ 发送)

- `launchClaudeSession`(auto-launch tmux + `claude --resume`)→ headless 取代
- `launchAgentsSession`(agents TUI 导航 + Right + sendKeys)→ headless resume agent 取代
- `sendArrowSelect` / `sendTypeInput` / `sendKey`(权限箭头导航)→ control_request/response + deny+消息 取代
- `sendMessageToSession` / `sendKeys` 发送主路径 → stdin 写 user 消息取代
- `newTmuxSession` / `waitForCCReady` / trust dialog 自动确认 → headless 新建取代
- **整套 Stall Rescue**(`stall.mjs` / `stallState.mjs` / `stallprompt.js` + wizard 的 capture-pane 检测)
  → headless 的 `control_request` 主动推 AskUserQuestion(带完整 questions),**不再需要**

### 必须保留(但都不是 tmux)

1. **① jsonl 监听/DDB/WS 同步** — 地基,一行不动(`watcher.mjs`/`extract.mjs`/`sync.mjs`)
2. **② 状态观测** — 观测外部会话(用户在 VS Code/终端自己开的):`getRunningInfo`(`ps aux` 抓 `--resume`)
   / `checkStopped` / mtime 启发式。headless 够不着别人的进程,必留。自己的 headless 会话状态用进程 `busy` 标志。
3. **两个"住在 tmux.mjs 但不是 tmux"的函数** — 见下方文件重构,搬走不删:
   - `projectHashToPath`(纯路径工具,hash→真实目录;watcher/sync/ws 4 处依赖)
   - `getClaudeProcesses`(`ps aux`/proc 抓进程;`getRunningInfo` 的唯一依赖)

### headless 生态:命令体系(实测 + litter 源码)

**决策:用 headless 原生命令,丢弃 tmux 命令适配层。**

- **命令 = 以 `/` 开头的普通文本消息**。litter `translate/input.rs` 注释:"claude's slash-command parser
  dispatches on a leading `/`"。发 `{"content":[{"type":"text","text":"/context"}]}` 进 stdin,CC 自己分派。
- **结果作为普通 assistant/result 流回**(实测 `/context`→完整 markdown;`/usage`/`/config`/`/stats`/`/goal`
  全有输出),走正常 stream + jsonl 落地。**不需要 capture-pane / DIALOG_COMMANDS Esc / SYNTHETIC_COMMANDS 导航**。
- **命令列表来源改用 `system/init.slash_commands`**(CC 权威回传,还含 `tools`/`skills`/`agents`)→
  替掉 `commands.mjs` 扫磁盘 + 手维护 `BUILTIN_COMMANDS` 静态表,更准、零维护。
- **纯 TUI 命令(`/status`/`/config` 全屏交互类)headless 下不可用**(实测返回 "isn't available")→
  **不暴露**(init.slash_commands 自然不含,用户看不到)。取舍:丢掉几个手机上意义不大的配置界面,
  换来命令输入零特殊逻辑 + 结果原生流式 + 命令列表权威。

→ 可退役:`commands.mjs` 的 `LOCAL_COMMANDS` / `DIALOG_COMMANDS` / `SYNTHETIC_COMMANDS` / `captureCommandOutput`。

### 失败回退:只读 + 提示(已定)

**决策:回退走"只读 + 提示",不保留任何 tmux 发送兜底。** 乐观起 headless,若 CC 拒绝
(EXIT=1,如活跃 agent)或进程异常 → **不再尝试任何发送**,给 App 回一个明确提示
(如"该会话正被别处占用/无法发送,请在原处继续或稍后重试"),会话内容仍可只读(jsonl 监听照常)。

理由:活跃占用本就罕见(用户一般不两地同跑),为这个边角保留整套 tmux send-keys/auto-launch
不值得。只读+提示让 **tmux 发送逻辑可彻底删除**,架构最干净。

### 文件级重构:删除 tmux.mjs

真·tmux(含 tmux 命令)的函数**全部删除**;文件里两个非 tmux 函数各归其位,`tmux.mjs` 整个文件删掉:

| tmux.mjs 函数 | 处置 |
|---|---|
| `sendKeys` `sendMessageToSession` `sendArrowSelect` `sendTypeInput` `sendKey` `capturePane` `captureCommandOutput` `findTmuxPane` `findTmuxTargetForSession` `newTmuxSession` `cleanStaleSessions` `launchClaudeSession` `launchAgentsSession` `hasTmux` `isAskUserQuestionWizard` `isTerminalBusy` `paneRunState` | **删除**(headless 取代 / 不再需要) |
| `projectHashToPath` | **搬到** `session.mjs`(与 findSessionFile/getPreview 等路径工具同域)|
| `getClaudeProcesses` | **搬到** `session.mjs`(`getRunningInfo` 就在那,是其唯一消费者)|
| `interruptSession` | **重实现**进 `headless.mjs`:中断 = SIGINT / 关 stdin 那个 headless 进程(不再是 tmux Esc)|

→ 搬完后 **`tmux.mjs` 删除**。连带删除:`stall.mjs` / `stallState.mjs` / `web/js/components/stallprompt.js`
(Stall Rescue),`commands.mjs` 的 `LOCAL_COMMANDS`/`DIALOG_COMMANDS`/`SYNTHETIC_COMMANDS`/`captureCommandOutput`。

### 退役顺序(headless 验证稳定后再删)

① 永不删。顺序:headless 上线(`streamMode` 开关,双轨并存)→ 观察稳定 →
搬走 `projectHashToPath`/`getClaudeProcesses` + `interruptSession` 重实现 →
删 `tmux.mjs` + Stall Rescue + 命令适配层 → 移除 `streamMode` 开关(headless 成唯一发送路径)。
