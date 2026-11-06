# v2 第 1 阶段 · 第 1 步：首页改为直连 Bridge（实施方案，待确认）

状态：最终方案，尚未写代码。依据 `docs/v2-architecture.md` §3–§5、§9、§10、§14，以及 2026-11-05/06 在 `.scratch/v2-spike/` 中完成的离线验证。

## 0. 目标与边界

- 首页（设备区、Active、最近项目）的数据，改为实时向各台 Bridge 请求，不再读取 DDB 中的会话和设备统计。
- App ⇄ Bridge 采用**单连接双向直连**：
  - App 一侧只有建立连接时的鉴权会经过 Lambda；
  - 凭证随 `/devices` 下发，App 本地缓存；
  - 连接 ID 通过 MOCK 路由 `whoami` 获取。
- 最近项目采用新规则：**最近 5 个项目（展开后 15 个），每个项目显示最近 5 条根会话**。
- 本步不改动：
  - 列表页、详情页继续走 v1 REST；
  - DDB 写入、Bridge 启动时的全量扫描、`checkStopped` 全部保留；
  - v1 接口全部可用，便于对比。
- UI 不改。
- 连接旧服务器（`/devices` 中没有 `protocol: 2`）时，整个 App 走 v1；连接新服务器时，请求失败也不回退到 REST。
- 交付方式：在 `feat/v2-core` 上开一个子 PR，在 `BatonV2` 上验证，第一台测试设备是 `test-ec2-ap`。部署和切换 Bridge 前都需要单独确认。

### 已验证的数据
| 项目 | 结果 |
|---|---|
| 直连请求往返（东京 / 美国） | 53ms / 349ms；现有 Lambda 路径为 401ms / 721ms |
| 建连 / MOCK 往返（东京） | 53ms / 9ms |
| 按需计算 vs 全量扫描（test-ec2、test-ec2-ap） | 最近项目、活跃会话、项目数、运行中数、待输入数**完全一致** |
| 按需计算耗时（test-ec2，3264 个文件） | 冷启动约 1.1s，带缓存约 0.16s；全量扫描需 8.9s |
| 按 v1 规则合并三台设备（Mac 用 DDB 数据代替） | 和线上 v1 首页完全一致 |
| 首页回包大小 | 约 6.7KB，压缩后约 4KB，一帧即可发完 |

## 1. 连接与请求模型

### 1.1 一条连接，全程复用
- App 打开后建立一条 `app_data` 连接（`wss://<cf>/data`），v2 的所有请求共用它：本步是首页，后续是列表、历史，再往后是实时消息。
- App 进程存活期间，这条连接一直复用。只有在 App 重新打开，或切回前台时发现连接已断，才会重建，并重新执行一次 `whoami`。
- 过渡期内，详情页仍使用 v1 的控制连接和实时数据连接，所以第 1 阶段 App 会同时保持 3 条连接，详情页迁移完成后合并为 1 条。

### 1.2 连接层对外只提供一个接口
`request(device, method, params) → Promise<result>`。

以下细节全部在连接层内部处理，页面代码看不到：凭证、`whoami`、路由表、地址变化后补发、重试、超时、离线判断。

### 1.3 路由表与统一的 `reconcile()`
- `routes[device] = { online, dataId, credentials, version }`
  - 数据来源依次是：缓存、`/devices`、`bridges_changed` 推送，后到的覆盖先到的。
  - 内容有变化时，`version` 加 1。
- 每个未完成的请求记录：`{ routeVersion, firstSentAt, sentAt, retried, failed }`。
- 下列事件发生时都执行 `reconcile()`：
  - 连接就绪（`whoami` 返回）；
  - 路由表更新；
  - 收到回包；
  - 收到投递失败通知；
  - 计时器到期。
- `reconcile()` 对每个未完成的请求依次判断：
  1. 设备离线 → 以 `offline` 结束，调用方改用缓存；
  2. 距离首次发送已超过 6 秒 → 以 `timeout` 结束；
  3. 路由 `version` 已变化，或收到了投递失败 → 用新路由重新发送；
  4. 超过 2 秒未收到回包且尚未重试 → 重试一次。
- 每次发送都使用新的 `requestId`，以最先回来的那个为准，后到的丢弃。计时从请求真正发出时开始，而不是从打开 App 时开始。
- 只要缓存里有路由，就直接按缓存发送，不额外判断凭证是否过期。`/devices` 返回后，地址或凭证有变化的设备会自动补发。
- 凭证是 STS 临时凭证，最长 1 小时；Bridge 的连接 ID 最多每 2 小时变一次（API Gateway 的连接上限），睡眠、断网后也会变。

### 1.4 首页时序（东京实测数据）
```
A 缓存有效（最常见）
  0      显示缓存；建连 → whoami；同时 GET /devices
  ~60    按缓存的路由向在线 Bridge 发 home
  ~115   回包到达 → 合并 → 更新页面
  ~300   /devices 返回：没有变化，不做任何事

B 缓存失效（凭证过期，或 Bridge 已重连）
  ~60    按缓存发 home → 收到投递失败（路由响应），或一直没有回包
  ~300   /devices 返回：version 变化 → 用新路由补发
  ~355   回包到达 → 合并 → 更新页面

C 缓存显示在线、实际已离线     /devices 返回离线 → 不再等待，直接用缓存
D 缓存显示离线、现在已上线     缓存阶段不发请求；/devices 返回在线 → 发送
E 首次安装，没有缓存          显示骨架屏；/devices → 建连 → whoami → 向全部在线设备发送 → 全部回来或 6 秒后显示
网络差                       2 秒未回包重试一次，6 秒仍未回包就用这台设备的缓存
```

## 2. Server

### 2.1 `server/src/bridge_read.py`
- `/devices` 在 v1 原有字段之外新增：
  - `protocol: 2`、`maxFrameBytes: 28672`、`wsUrl`、`dataUrl`；
  - 每台设备增加 `bridgeProtocol`；
  - `rpc: { bridges:[{device, dataId, bridgeProtocol}], credentials, endpoint, region }`，只包含已完成 `bridge_join` 的在线 Bridge。
- `/config` 新增 `protocol`、`wsUrl`、`dataUrl`，供 Bridge 读取。
- CloudFront 尚未生效时，地址回退为 execute-api 的原始地址。

### 2.2 `server/src/bridge_ws.py`
- `$connect`：
  - 数据 API 允许新角色 `app_data`、`bridge_data`；
  - Bridge 控制连接带 `protocol=2` 时，在连接记录上写入 `bridgeProtocol`。
- `_handle_message`：遇到 `direct_rpc` 时交给 2.3 处理。
- `_handle_disconnect`：`bridge_data` 断开时，清除 `rpcDataId` 并推送 `bridges_changed`；Bridge 控制连接断开时，它的数据连接一并失效。

### 2.3 新增 `server/src/direct_rpc_ws.py`
| op | 来源 | 处理 |
|---|---|---|
| `bridge_token` | Bridge 控制连接 | 生成一次性 token（60 秒有效，存哈希），返回给 Bridge |
| `bridge_join` | `bridge_data` | 校验：token 正确且未过期、属于同一账号、对应控制连接确实是这台设备当前在用的连接。通过后写入 `rpcDataId`，回复 `joined`，并向本账号的所有 `app_data` 推送 `bridges_changed`（带新凭证） |

- `issue_app_credentials(account, dataIds)`：REST 和 WS 两个 Lambda 共用。
  - 通过 STS 签发 1 小时凭证，策略只允许 `…/POST/@connections/<dataId>`，逐个列出这些连接。
  - 在进程内按"账号 + 排序后的 dataId 列表"缓存，剩余有效期超过 10 分钟就直接复用。
- Bridge 自己的凭证继续使用现有的 realtime `hello`（15 分钟，自动续签），只在 Bridge 端使用。
- 已知限制，第 2 阶段（§12.8）处理：Bridge 凭证的范围仍是 `@connections/*`；Bridge 无法校验 `replyTo` 是否属于本账号。

### 2.4 `server/template/Baton.template`
- CloudFront：
  - 新增 WsApi、TerminalDirectApi 两个源，origin path 为 `/v1`；
  - 新增 `/ws`、`/data` 两条路由，使用 CachingDisabled 和 AllViewerExceptHostHeader；
  - 新增一个 CloudFront Function，把路径改写为 `/`；
  - 默认路由开启 Compress。
- 数据 API：
  - 新增 `whoami` MOCK 路由，返回 `{"action":"whoami","connectionId":"$context.connectionId"}`；
  - `terminal_direct_data` 路由开启路由响应，投递失败时直接通知发送方。
- WsHandler 内存调到 512MB，部署后观察效果。
- IAM：REST 的 LambdaExecutionRole 增加 AssumeRole TerminalDirectRole 的权限，并加入该角色的信任策略。

### 2.5 测试 `test/server/test_direct_rpc.py`
- `/devices` 的 `rpc` 只包含同账号的 Bridge，凭证策略只列出这些连接。
- `bridge_join` 在以下情况都会被拒绝：token 错误、token 过期、跨账号、连接已被替换。
- 加入和断开时推送 `bridges_changed`。
- 新角色只能连接数据 API。

## 3. Bridge

### 3.1 新增 `bridge/home-index.mjs`
- **索引**
  - Claude：遍历 `~/.claude/projects/*/*.jsonl`，跳过以 `.` 开头和大小为 0 的文件，项目名用 `normalizeProjectHash` 处理。
  - Codex：遍历所有 `CODEX_HOME/sessions`，读取每个文件的前 8KB，取出 `cwd`（得到项目）和 `parent_thread_id` / `forked_from_id`（判断是否为子线程）；同一个 ID 只保留最新的文件。
- **内存缓存**（键为"路径 + 大小 + 修改时间"，不落盘）
  - 文件头；
  - 预览和模型：Claude 用 `getSessionMetadata`（带 history 的首条提问），Codex 用 `scanCodexRollout`（带线程名）；
  - 有效性：Claude 需要有预览或子 Agent，Codex 需要能解析出会话；
  - 子 Agent 的解析结果。
- **状态**
  - 优先读取 `lastKnownStatus`，它由进程池、watcher、`checkStopped`、Agent 轮询共同维护；
  - 没有记录时现场计算：Claude 用 `getSessionStatus`，并叠加守护 Agent 的状态；Codex 直接用扫描结果；
  - 有效状态还要合并子 Agent 的运行中数和待输入数。
- **活跃候选**：只检查以下几类会话，其余一律视为已完成：
  - 有对应进程的会话；
  - 守护 Agent；
  - Claude 5 分钟内、Codex 15 分钟内修改过的文件；
  - 有新鲜子 Agent 的根会话。
- **变化处理**：任何变化都立即更新内存中这一个会话的数据，并把首页结果标记为"需要重算"，不做延迟合并：
  - JSONL 变化：stat 一次，更新最后活跃时间和大小；
  - 新会话、新标题：使用 watcher 上报时已解析好的预览；
  - 状态变化：`lastKnownStatus` 改为可通知变化的 Map；
  - 通过 Baton 删除会话：移除对应缓存。
- **请求时**：没有"需要重算"标记时，直接返回现成的回包；有标记时，当场完成排序、组装、压缩（约 2~3ms），同时 `revision` 加 1。
- **启动时**：Bridge 连上之后，在后台分批预热（每批之间用 `setImmediate` 让出主线程），子 Agent 也一并预热。
- 不做定时检查：和 v1 一样，依靠 watcher 实时更新，Bridge 重启时重建。

### 3.2 新增 `bridge/direct-rpc.mjs`
- 控制连接拿到 realtime 凭证后，依次执行：`bridge_token` → 打开 `dataUrl?role=bridge_data` → `bridge_join`。
- 断线后加随机延迟重连；控制连接重连后，需要重新加入。
- 只接受 `kind:'rpc'` 的帧，同时最多处理 4 个请求：
  - `home`：如果请求带的 `revision` 和当前一致，回复 `{revision, notModified:true}`；否则发送回包。
  - `ping`：返回版本号和 runtime。
- 回包：JSON 超过 1KB 且对方接受 deflate 时，压缩后转 base64；按约 24KB 分块，连续发出，用签名器投递到 `replyTo`。
- 只记录聚合指标（耗时、字节数、帧数），不记录内容。

### 3.3 新增 `bridge/direct-rpc-protocol.mjs`（Bridge 和 Web 共用）
- 请求：`{v:2, kind:'rpc', requestId, method, params, replyTo, accept}`
- 回包分块：`{v:2, kind:'rpc_result', requestId, ok, error?, chunk:{index,count}, enc:'json'|'deflate-b64', data}`
- 提供编码、分块、按 `index` 乱序重组的功能；解压在 Node 端用 zlib，在浏览器端用 fflate。

### 3.4 首页回包（沿用 v1 字段名）
```
{
  revision, notModified?,
  device:   { projectCount, runningCount, needsInputCount, lastActive },
  sessions: [ { sessionId, preview, status, lastActive, agentCount, projectHash, projectName, isAgent?, agentName?, agentDetail? } ],
  recentProjects: [ { projectHash, projectName, lastActive, sessions: [ { sessionId, preview, status, lastActive, agentCount, isAgent?, agentName? } ×≤5 ] } ×≤15 ]
}
```
- `sessions`：全部活跃根会话，包括 `running` 和 7 天内的 `needs_input`。
- `recentProjects`：按项目内最新根会话的时间倒序排列。
- 预览沿用 Bridge 现有的 200 字符截断（`previewText`），不额外截断；不返回 `deviceName` 和 `recentSessions`。

### 3.5 已有文件的改动
- `ws.mjs`：连接参数加 `protocol=2`；连上后启动 `direct-rpc`；删除会话成功后通知 `home-index`。
- `watcher.mjs`、`codex-watcher.mjs`：在文件变化入口和元数据上报函数中各加一行，通知 `home-index`。
- `sync.mjs`：`lastKnownStatus` 改为可通知变化的 Map。
- `bridge.mjs`：初始化完成后启动预热。

### 3.6 测试 `test/bridge/`
- `home-index.test.mjs`（使用临时目录）：
  - 规则：15×5、只计根会话、7 天待输入、无效会话不计数、子 Agent 合并、Codex 子线程；
  - 缓存失效；
  - 状态变化后 `revision` 增加；
  - `notModified`。
- `direct-rpc-protocol.test.mjs`：压缩、分块、乱序重组的往返测试；签名后的帧不超出大小限制。

## 4. Web

### 4.1 新增 `web/js/v2/direct-transport.js`
- 管理 `app_data` 连接：
  - 建连、`whoami`、处理 `bridges_changed`、处理投递失败通知；
  - 断线后加随机延迟重连；
  - 页面可见时每 25 秒 ping 一次（CloudFront 空闲 10 分钟会断开）。
- 维护路由表：`/devices` 的 `rpc` 同时保存在内存和 localStorage 中（按服务器和账号区分）。
- 实现 `request()` 和 1.3 节中的 `reconcile()`，包括 2 秒重试和 6 秒上限。

### 4.2 新增 `web/js/v2/home.js`
- `loadHomeV2({onDevices, onComplete})`：
  1. 立即用缓存的路由，对上次在线的设备调用 `request(device, 'home', {revision})`；
  2. `/devices` 返回后，先用"设备名、系统、在线状态 + 缓存的计数"调用 `onDevices`，并把新路由交给连接层（地址有变化的设备由连接层自动补发；新上线的设备由这里补发）；
  3. 所有设备都结束后合并：
     - 离线、超时的设备使用缓存，缓存位置是 `localStorage['apeek_v2_home_devices']`，每台设备单独存储，包括 `revision`；
     - 收到 `notModified` 的设备也使用缓存；
     - 合并结果调用 `onComplete(active, devices)`，输出格式和 v1 的两个接口一致：设备上的数字来自 Bridge；`sessions` 只包含在线设备的会话，按时间倒序；`recentProjects` 补上 `deviceName` 后按 `lastActive` 排序，取前 15 个；`hasMoreProjects` 表示合并后是否超过 5 个。
- 首次打开时一直显示骨架屏，全部结束后再显示内容。之后打开时，先显示缓存，再依次更新设备行和会话。
- 展开全部时复用同一份数据，不再发请求。
- 接入现有页面：`index.html`、`app.js` 中加载首页的两处，在 v2 下调用 `loadHomeV2`，结果交给现有的 `loadHome` 渲染。`index.html` 中直接 `fetch` 的预加载只在 v1 下保留。

### 4.3 其他
- `api.js`：缓存 `/devices` 返回的 `protocol` 和 `dataUrl`，提供 `serverProtocol()`。
- 开发期开关 `localStorage['baton-force-v1']='1'`，用于强制走 v1，合并进 main 前删除。
- 调试工具：
  - `window.__v2Timings`：记录 `/devices`、建连、`whoami`、每台设备的往返时间、首屏总耗时；
  - `window.compareHomeV1V2()`：对比活跃会话和设备数量（最近项目的规则已经和 v1 不同，不参与对比）。
- 新增依赖 `fflate`（只用解压）。前端不加测试，提供 5173 预览。

## 5. 改动清单与行数估计（不计空行和注释）

| 模块 | 文件 | 行数 |
|---|---|---|
| **Server** | `direct_rpc_ws.py`（新增：绑定、凭证签发与缓存、推送） | ~120 |
| | `bridge_read.py`（`/devices`、`/config` 新增字段） | ~40 |
| | `bridge_ws.py`（新角色、分发、断开处理） | ~30 |
| | `Baton.template`（CloudFront、MOCK、路由响应、512MB、IAM） | ~120（JSON） |
| | `test_direct_rpc.py` | ~150 |
| **Bridge** | `home-index.mjs`（索引、缓存、状态、首页结果、预热） | ~250 |
| | `direct-rpc.mjs`（数据连接、加入、分发、回包） | ~140 |
| | `direct-rpc-protocol.mjs`（与 Web 共用） | ~80 |
| | `ws.mjs`、`watcher.mjs`、`codex-watcher.mjs`、`sync.mjs`、`bridge.mjs` | ~35 |
| | `home-index.test.mjs`、`direct-rpc-protocol.test.mjs` | ~180 |
| **Web** | `v2/direct-transport.js`（连接、路由表、`request`、`reconcile`） | ~180 |
| | `v2/home.js`（发起请求、缓存、合并、两段式回调） | ~110 |
| | `api.js`、`index.html`、`app.js`（分流、接入） | ~60 |
| | 调试工具 | ~50 |
| **合计** | | **业务代码约 1,095 行，模板约 120 行，测试约 330 行** |

按模块：Server 约 190 行，Bridge 约 505 行，Web 约 400 行。

## 6. 验证步骤（部署和切换前都需要单独确认）
0. 部署后先确认 `whoami` MOCK 能否拿到连接 ID，以及路由响应能否返回投递失败。
1. 本地运行 `npm run test:bridge`、`npm run test:codex`、`npm run test:server`（Node 20）。
2. 部署 `BatonV2`：`cd server && ./install.sh --region ap-northeast-1 --stack BatonV2`。
3. 通过 SSM 在 `test-ec2-ap` 上运行 `BatonV2` 的安装命令，确认 `bridge_join` 成功。
4. 浏览器测试：覆盖 1.4 节中的 A–E 及网络差的情况，验证 `notModified`，运行 `compareHomeV1V2()`。
5. 测量：在东京、美国 EC2、手机上分别采集 `__v2Timings`，对比 CloudFront 和 execute-api 原始地址，测试大帧能否通过、空闲连接是否会被断开、512MB 带来的效果。

## 7. 与 EC2 中继（方案 B）的对应关系
| 本步（API Gateway） | EC2 中继 |
|---|---|
| `/devices` 下发凭证、`whoami`、路由表、地址变化后补发 | 中继在建连时完成鉴权，按设备名转发；这些逻辑全部去掉，`direct-transport.js` 预计缩减到约 50 行 |
| `request()` 接口、帧格式、分块、压缩、`revision` | **完全相同** |
| `home-index`、App 端合并 | **完全相同** |
