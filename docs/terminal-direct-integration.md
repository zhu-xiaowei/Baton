# Header 签名直转与项目共享终端

更新：2026-09-18。单项目多终端已实现；正式发布使用 `server/install.sh --region ap-northeast-1 --stack Baton`。
多终端仍复用已有 Header 签名直转，不需要新增云端 API 或常驻 EC2 / Fargate 中继。

## 启动与快速返回优化（待配套发布）

- 页面返回保留一个已同步终端实例与连接，最多 60 秒；隐藏页面仍处理输出和 ACK，但不接收输入、抢焦点或改变共享尺寸。
  同账号、服务器、项目且连接仍有效时直接恢复原实例。过期、应用进入后台、离线、切换账号或连接出错时释放，重新进入走完整恢复。
  正在连接、同步或执行管理操作时不缓存；释放连接仍不结束 Bridge 中的 Shell。
- 配置按服务器与 API Key 在内存中缓存，共享并发请求。若已有同账号应用控制 WS 则借用，不另建控制连接；
  终端关闭仅释放自己的 attachment，不关闭主应用 WS。收到服务端关闭确认前不再次借用同一控制连接。
- Bridge 通过 `terminalStartup=1` 声明支持启动参数。App 首次 `terminal_direct/open` 携带选中 sessionId 与尺寸，
  服务端验证并随 offer 下发；Bridge 在数据通道授权后直接 attach 和发送屏幕，App 不再发送第二次数据 open。
  任一旧服务端或旧 Bridge 不支持此能力时，保留原来的数据 open 流程，不提前创建 Shell。
- 服务端先完成四条连接记录的归属校验，再并行申请 App / Bridge 的两份 STS 凭据；全部成功且状态仍有效才激活。
  API Key、join token、数据 API 隔离、STS 权限范围、HMAC 与会话序号均不变；数据仍通过 HTTP integration 直转。
- 快照按最多四个未确认块发送；最后一块排入发送队列后，立即发送有序的 synced 和缓存增量。
  前端仍等待所有快照块实际写入 xterm 后才处理 synced。render_ack 继续释放在途字节并推进大快照窗口，
  不再额外阻塞小快照的输入解锁；超限与断线保护保留。

前端、Bridge 与服务端改动需配套发布才能获得完整的冷启动收益；仅更新前端即可验证快速返回、配置缓存与控制连接复用。
正式 Bridge 重启会结束已有 PTY，发布前应确认终端中的工作已保存。

### 本次验证（2026-09-18）

- 本地新版前端连接未更新的线上服务与正式 Bridge，确认旧协议回退可用。最终五轮快速返回均无配置请求、
  无新 WS；点击到输入状态恢复为 1.1–5.1ms，首个 requestAnimationFrame 回调为 41–79ms。
  客户端为 Chrome 移动视口，动画帧回调不是绘制完成或 iOS 键盘动画测量。
- 主应用控制连接复用的两轮旧协议启动为 3611ms、2971ms；关闭 terminal 后主连接仍可用于下一次打开。
  这不是新服务端 / Bridge 完整部署后的冷启动成绩。完整冷启动仍待配套发布后复测。
- 隔离验证使用真实 PTY 和当前 DirectDataChannel，确认新协议无第二次数据 open，旧协议正常回退；
  小快照无需等待渲染 ACK 才下发 synced，大快照仍受四块窗口约束，退出仅断开 attachment、不结束 Shell。
- 缓存验证覆盖隐藏期间输出与 ACK、隐藏输入拒绝、60 秒过期、断线、后台、离线、页面退出与账号变化。
  服务端验证覆盖先检查四条连接归属再并行 STS、拒绝跨账号连接、启动参数校验与能力协商。
- 账号 / 服务器边界复核通过：变化或退出登录会关闭主连接与终端缓存、清空内存和本地存储中的 WS 地址；
  迟到的旧配置不会恢复连接，控制连接地址、API Key 或角色不匹配时不借用。同身份设置不破坏已有连接。
- 提交前全量测试 806 项通过，生产构建通过；仅有既有警告，未新增仓库测试文件。
- iOS 模拟器存在并行页面操作，键盘回归结果不作为最终验收；原点击聚焦逻辑未改，缓存不额外切换 textarea 只读状态。

### 两个终端切换复测（2026-09-18）

- Chrome 移动视口通过现有线上数据通道连接同一个正式 Bridge，交替测试旧版线上页面与本地新版页面，
  各切换九次。旧版平均 944ms、中位数 942ms；新版平均 949ms、中位数 920ms，均未新建 WebSocket。
  此处测量选择终端到输入控件解锁，不包含软键盘动画；本轮未复现持续的前端切换性能回退。
- 新版平均分布：点击到发出选择请求 2ms、请求到快照到达 491ms、快照处理到 ACK 4ms、
  ACK 到 synced 448ms、最后解锁 5ms。首轮非交替采样还出现过 6410ms / 8841ms 长尾，
  主要落在请求响应与确认等待阶段，未进一步定位到网络或远端处理的具体环节。
- 正式 Bridge 当时仍运行 `snapshot.acked === snapshot.chunks` 的旧结束条件；本地源码已改为全部块
  排入发送队列即发送有序 synced。60 秒页面缓存只优化退出再进入，不缓存每个未选中终端的实时屏幕。
- 隔离真实 PTY 验证对比两种结束条件，模拟 App 与 Bridge 间每方向 200ms 数据延迟，各切换六次：
  旧条件 809–820ms，新条件 407–413ms；Bridge 处理约 0.6–6.1ms。两种条件均正确恢复各自屏幕，
  保持原来的两个 Shell，切换不新建连接。这是受控延迟验证，不是新版 Bridge 的线上实测。
- 本轮未更新或重启正式 Bridge；实际切换收益仍需保存终端工作、更新 Bridge 后复测。

## 项目共享终端（当前实现）

用户选择所有页面都能输入，不增加单写入者锁、接管按钮或输入预测。通常只有一个人在操作；
如果两个页面同时敲键，Bridge 按各自连续序号排序后，将输入按处理顺序写入同一 PTY，
不承诺将整条命令作为跨设备互斥事务。

### 页面与会话

- 每个项目会话列表右上角新增 Terminal 图标，按需加载 `web/js/terminal.js` 与 xterm。
- 同一 Bridge 上相同规范化真实目录最多保留 5 个 Shell；不同终端的进程、目录与屏幕隔离，选中同一个
  `sessionId` 的所有页面仍可以同时输入并同步输出。列表由 Bridge 维护，不由各浏览器自行编号。
- 名称为 Terminal 1～5，使用最小空闲编号；关闭后复用名字但绝不复用 `sessionId` 或 `epoch`。
- 初次进入没有终端时原子地创建一个；已有终端时优先恢复页面 sessionStorage 中的选择，否则选择第一个。
  首次进入或 Bridge 重启后重连没有终端时也会创建默认终端，列表同步后显示 1/5。
- 返回页面短期保留有效连接；关闭页面、缓存过期或网络断线只 detach，不结束 Shell；后加入页面先恢复屏幕，再接收实时输出。
- 移除页面 Reset，右侧使用当前终端名称的下拉按钮；浮层顶部显示数量和新建按钮，每行支持选择和关闭。
  关闭复用确认弹窗，会终止选中终端并让其所有查看者切到剩余的第一个；其他终端和查看者不受影响。
  只剩一个时，关闭改为重新启动：先成功启动替代 Shell，再停止旧进程，重新从 1 分配最小空闲编号并更换 ID / epoch，
  所有查看者恢复新屏幕。新 Shell 启动失败则保留原终端，不会进入 0/5 空状态。
- 浮层宽度限制在视口内、支持缩短高度滚动，每个操作行/关闭/新建按钮至少 44px；支持 Escape、Tab 和方向键。
- 输入同时绑定 `sessionId` / `epoch`；切换、关闭后的旧输入不会进入另一个 Shell。管理操作结果不确定时
  只重连恢复列表，不自动重发新建/关闭操作，避免重复执行。
- 暂时移除底部 Esc、Tab、Ctrl、方向键等快捷键栏，保留正常键盘输入；手机交互后续统一适配。
- 标题栏复用 Git Changes / Project Files 的单行高度和项目胶囊；不显示 Connected、连接人数或绿点。
  连接、同步和自动重试期间复用胶囊边框 loading，成功后恢复普通胶囊；仅错误或 Shell 退出等情况显示提示。
- 新页面加入不立即改变共享尺寸；实际输入、聚焦或活动页面尺寸变化时采用该页面尺寸，广播给其他端。
- 暂支持 macOS / Linux。Bridge 重启或退出会结束 PTY，不宣称具备 tmux 式跨进程恢复。

### 连接、认证与事件

1. 主 Bridge 控制 WS 通过 `terminal=2` 声明能力，服务端保存 `terminalProtocol=2`。
2. 每个页面借用可用 app 控制连接或创建专用连接发送 `terminal_direct/open`，包含 device、projectHash、随机 terminalId。
3. Lambda 校验同账号、设备唯一且在线、主 Bridge 能力。Bridge 控制连接保存多个 attachment ID；
   每个 attachment 独占自己的两条数据端连接，一个 app 控制连接同时最多绑定一个 attachment。每个 attachment 都有独立 join token、STS 和 HMAC key。
4. 数据业务 action 为 `terminal_shared, v1`，外层仍是 `terminal_direct_frame`，继续 Header 签名 HTTP integration。
   `terminalId` 是页面 attachment ID；Bridge 下发的 `sessionId` 才是共享 PTY 标识。
5. 输入事件：open、input、resize、heartbeat、render_ack、detach、create_session、select_session、close_session；
   输出事件：ready、snapshot、synced、output、resized、peers、exit、error、ack、sessions、session_result。
   业务帧绑定 device、projectHash、terminalId；Shell 输入还绑定 sessionId 和 epoch。
6. 每页拥有独立 `clientSeq` / `eventSeq`。ACK 的 eventSeq 为 0，不参与输出排序；输入发送不等待逐字 ACK。
   ready / snapshot / synced 构成一次快照事务；output 在快照完成之后按序应用。
7. 服务端关闭一个 attachment 只从 Bridge 的集合释放该 ID，不清理其他页面。Bridge 控制断开会关闭这些
   数据连接，但本地 PTY 与屏幕镜像保留；主控制连接恢复后，页面重新 attach 同一项目。
8. 独立 `terminal_poc` 验证入口未改动，项目页面不使用它的“断线杀 PTY”语义。
9. `open` 可传 `sessionId`；管理事件携带 `requestId`，选择/关闭携带目标 `sessionId`，
   新建携带 cols/rows。Bridge 仅允许访问已认证项目规范化目录下的会话，并按页面 clientSeq 顺序处理。
   同一项目的创建/容量检查同步完成，多个页面竞态也不能创建第 6 个。
10. `sessions` 广播 `{limit:5,sessions:[{id,name,exited}]}`；`session_result` 返回
    `{requestId,error?}`。切换复用原数据通道并重新发送快照；项目至少保留一个终端。
    不做新旧版本兼容或能力协商，前端与 Bridge 需配套更新；移除项目共享终端的 reset 事件。
    云端鉴权、数据集成、IAM 和逐帧签名均未改变。

凭据仍沿用原账号 API Key。IAM 的 API 级限制与 HMAC 安全边界没有变化，见后文；
共享终端不构成独立的多租户安全升级，也不应直接开放给不可信租户。

### Bridge 屏幕、限制与流控

`bridge/terminal-shared.mjs` 使用 node-pty 1.1.0、@xterm/headless 6.0.0、@xterm/addon-serialize 0.14.0。
主 Bridge 仍保留现有消息与项目处理逻辑；共享终端按需初始化，有活跃 Shell 时推迟自动升级。

| 项目 | 当前限制 / 行为 |
|---|---|
| 每个项目 | 最多 5 个终端（包括已退出但尚未关闭的终端），由 Bridge 强制执行 |
| 同一 Bridge | 总量保护上限 20 个终端、16 个页面 attachment；总量不足时仅清理其他无人查看项目中已退出的记录 |
| 输入 | 每帧原始 bytes ≤4 KiB；单次页面输入 / 粘贴 ≤64 KiB，超限整次拒绝 |
| 输出 | 每块原始 bytes ≤16 KiB；签名后最终 WS frame ≤28 KiB |
| 镜像 | 1000 行 scrollback；进入 xterm 镜像后立即广播，无人为输出合并等待 |
| 快照 | 最多 4 MiB、16 KiB 分块、4 块窗口；超限先舍弃 scrollback，并明确告知历史截断 |
| 消费确认 | 快照逐块解析后确认；实时输出每 16 KiB 或最多 100ms 确认，只影响流控，不延迟显示 |
| 慢页面 | 每页未确认 / 待发输出上限 512 KiB，超限只断该页；不阻塞其他设备或杀 Shell |
| Mirror 背压 | 排队 >256 KiB 暂停读取 PTY，<64 KiB 恢复，1 MiB 硬上限 |
| 生命周期 | 页面 heartbeat 10 秒，Bridge 超过 45 秒无消息释放 attachment；PTY 保留 |
| 输入 / 输出缺口 | 有界排序队列；缺口 10 秒仍未补齐则断开并明确提示，再用快照恢复 |

终端查询统一由 Bridge 的权威镜像回复。浏览器屏蔽 DA、DSR、DECRQM 和 DECRQSS 自动回复，
避免多个页面向 Vim 重复回复模式查询、被 Vim 当作普通按键。颜色查询由 Bridge 按默认终端主题回复。
这不等于覆盖所有可选 VT 扩展；完整窗口操作、调色板查询等仍须单独评估，不能宣称完全兼容。

### 验证记录

- 本次五终端验证：真实 PTY 覆盖默认终端并发创建、五个上限竞态、会话/项目隔离、切换屏幕恢复、
  跨页面关闭、名字复用但 ID 不复用、旧输入拦截、自然退出与列表同步、断线保留进程。
- 真实浏览器经过已部署 Header 直转连接独立测试 Bridge，验证双端输入、创建/选择/关闭、关闭取消、
  页面返回恢复选择、第五个上限和空状态重新创建；未改动云端接口或运行中的主 Bridge。
- 手机布局检查包含 320px、390px、横屏、缩短视口和 native safe-area；标题栏保持 44px（24px inset 下
  68px），浮层不超出视口，菜单操作至少 44px。桌面切换后恢复输入焦点，手机不主动弹出软键盘。
- 无换行 read 提示与跨端 Enter 正常；手机切换离开 Vim 再返回，可编辑、保存文件并让双方回到 Shell。
  验收基于文件内容与后续 Shell 输出，不依赖 Vim 短暂的 written 提示；完整 HAR/WS 保留在仓库外，
  对该提示的检查还用实际前端重放 527 帧确认了保存后屏幕恢复。
- 本次前端 371 项、打包 5 项检查通过，生产构建通过；未添加新的仓库测试文件。

以下为此前单终端阶段的历史验证记录（其中 Reset 和快捷键现已从新 UI 移除）：

- 私有临时验证覆盖真实 PTY：双端输入、共享环境、目录隔离、关闭一端保留进程、全端 Reset、旧 epoch
  输入拒绝、同步 resize、Vim alternate screen 恢复与保存、大快照分块、Bridge 控制断线后重新 attach。
- 已通过真实 Chromium → 已部署 API Gateway Header integration → 隔离本机 Bridge 的双端与手机尺寸验证。
  验证项目入口、无换行 read 提示、另一端 Enter、返回后恢复、Reset 确认 / 取消、第三端 Vim 保存及快捷键。
- 多页面 Vim 检查发现 DECRQM 重复回复；保留完整 HAR、全部 WS 帧并用实际前端重放后修复，复测通过。
- 前后台切换曾触发项目列表刷新而关闭终端覆盖层；同样保留记录、重放后修复，切回前台保留终端页面。
- 原有前端 / 打包测试 350 项通过，原直转及服务端兼容检查 37 项通过，生产构建和全新 Bridge 依赖安装通过。
- 验证程序和包含短期凭据的原始记录只在仓库外私有目录；未新增仓库测试文件。
- 手机尺寸的 Chromium 不等于 iOS / Android 软键盘真机；中文 IME、后台切换和虚拟键盘仍需用户实机测试。

### 部署范围（2026-09-17）

前端与 Bridge 需要配套更新，不兼容旧的单终端协议。安装脚本将共享协议文件加入前端构建上下文，
同时打包 API 运行时需要的终端模块；WS 代码以唯一 S3 key 交给 CloudFormation 更新和回滚，避免
将运行中的 handler 暂时覆盖为占位代码。CloudFormation 更新失败会直接报错，不再误报成功。
下列为此前共享单终端的部署记录；本次发布结果见提交和部署日志。

- 云端控制接口已增量部署，保留旧 Lambda 文件和原业务路由；终端数据继续走 Header HTTP integration。
- 正式首页项目入口及终端资源已部署到 CloudFront，刷新首页缓存；只叠加静态资源，不替换原 API 业务代码，
  landing / setup、API 集成与 IAM 策略均检查为未变。
- 本机 `MacBook-Pro` 主 Bridge 已更新依赖并重启，控制记录已声明 `terminalProtocol=2`。安装目录保留原配置
  与旧管道路由兼容层，终端核心文件与本分支一致；独立旧 POC Bridge 未重启。
- 本机安装标记为 `TERMINAL_BUILD=shared-20260917`。本次没有发布全局 Bridge 自动升级包，保留已发布
  `BRIDGE_VERSION=1.0.0-term2`，不会让其他机器未经验证自动升级。
- 正式 CloudFront 页面连接本机主 Bridge，实际 `pwd` 为本项目目录；桌面和手机尺寸的独立浏览器上下文
  共用同一 sessionId，两端均可输入并收到输出，全部页面退出后再进入仍恢复同一 Shell 和屏幕。
- 真实 Shell 可能先加载用户登录配置；`Connected` 表示通道与屏幕已同步，不代表 Shell 已显示命令提示符。
  自动化命令验收在初始提示符出现后输入，不把输入 ACK 当作命令已执行的证明。

以下章节保留 2026-09-16 的独占 POC 设计和历史测量；会话生命周期以本节为准。

## 实测纠正的假设

**API Gateway ManageConnections 无法用实际 connection ID 做 IAM Resource 隔离。**
给 STS session policy 写 `/POST/@connections/<具体ID>` 实测返回 403，AWS 的鉴权资源是
`/POST/@connections/{connectionId}`。同一 API 内分开控制 / 数据 WS 仍不够安全：不能把原 Baton API
的通配 POST 权限交给浏览器，否则它能向聊天 / Bridge 控制连接注入事件。

固定目标 Header 签名 + `UNSIGNED-PAYLOAD` 也实测失败：改变 body 后返回 InvalidSignatureException。
先前延迟测试仅证明 Header 转发可行，没有证明每连接 IAM 隔离可行；此文修正这个设计假设。

## 当前架构

```text
控制面：Web ── 原 Baton WS / Lambda ── Bridge
                 身份、配对、STS、续期、关闭

数据面：Web xterm ── 独立 Terminal Data API ── Bridge PTY
                        Header SigV4 HTTP integration
                        POST @connections
                        无逐消息 Lambda
```

- 新增一个 AWS 托管 WebSocket API，只允许 terminal_data 角色，不承载任何聊天、工具或控制连接。
- 每端有一条原 API 控制 WS、一条新 API 数据 WS；旧实验直转 route 从原 API 迁走。
- STS 900 秒有效，仅允许独立数据 API 的 `POST /v1/@connections/*`，不允许 GET / DELETE 或原 API。
  **这是 API 级权限，不是单连接权限。**
- 每个终端另有 256 位随机 frameKey，只从可信控制面下发。数据 body 必须通过会话 HMAC-SHA256，
  再检查 terminal ID、device、方向、类型和序号，最后才交给 PTY / xterm。
- 错误 MAC、未签名、其他会话的数据直接忽略；不能执行 Shell，也不能以假 ready / closed 改变控制状态。
- 继续沿用原 API Key / account hash 账号模型；不声称已重构整个产品身份系统。

### 安全边界

有效 STS 仍能向独立数据 API 的其他 connection ID 发送垃圾流量。MAC 防止跨会话命令 / 输出注入，
**不能消除带宽滥用、资源消耗或拒绝服务风险**。有界队列 / 丢帧超时保护内存，不保证攻击下可用性。

当前适合受控本地 POC，不应直接开放给不可信多租户。若需要服务端逐会话发送 ACL、租户级配额和
抗滥用，需选择支持 topic / channel ACL 的托管服务，或保留服务端逐消息授权。
禁止将此角色扩权至原 Baton API，也不能将 HMAC 描述成 IAM 单连接权限。

## 初始化与回收

1. Web 经原 API 的 app 控制连接发送 terminal_direct/open，明确选择测试 Bridge。
2. Lambda 校验同 account、唯一设备、xterm-direct-1 版本，并对双方控制记录做条件锁，一 Bridge 一个 POC。
3. 创建 UUID、两个不同 join token 和 frameKey；DDB 只存 token hash。frameKey 作为短期会话秘密存入
   已有加密 DDB，关闭时删除，TTL 兜底；不写日志。STS secret 不存 DDB / localStorage。
4. 两端从可信控制面收到 offer / data endpoint，连接新 API 后 join。Lambda 检查真实 API endpoint、
   角色、账号、token、45 秒期限，并条件绑定 data connection ID。
5. 两端加入后，仅从原控制连接下发 STS、frameKey、自己和对端 data ID；Web 发 open 后才创建本机 PTY。
6. Web 最迟每 5 分钟经控制面续期，核验全部绑定，保留同一 peer / frameKey；Bridge 控制 heartbeat 60 秒。
7. 任意连接关闭时销毁 PTY、释放条件锁、关闭数据 WS、删除 frameKey；凭据过期前客户端主动停止。
   不恢复断线 PTY、不重放输入、不自动切回 Lambda。

## 协议与限制

- 控制：terminal_direct, v1, open / join / renew / close。
- 数据 route：terminal_direct_data，HTTP POST integration，无 CredentialsArn。
- 外层 JSON：target、body、authorization、date、token。
- body：`{payload: "准确的 JSON 字符串", mac: "HMAC-SHA256 hex"}`，整个 body 同时参与 SigV4。
- payload：terminal_direct_frame, v1, terminalId, device, message；message 保留 terminal_poc 序号 / ACK0。
- Bridge 覆盖客户端 replyConnectionId，使用控制面绑定的 peer data ID。
- 单次输入 4KiB，输出块 16KiB，含 MAC / 签名的最终 WS frame 不超过 28KiB；控制请求 8KiB。
- 预授权缓存和接收验签队列各 256KiB，签名发送队列 1MiB，PTY 待输出 1MiB，总输出上限 16MiB。
- 数据 heartbeat 10 秒，ACK deadline 30 秒，Bridge lease 45 秒；不是无限输出 / 长连接恢复成品。
- 签名及验 MAC 使用有界顺序 Promise 队列；没有新增固定 flush 等待。
- Web / Node 共用 WebCrypto；SigV4 使用 Gateway 实际 raw callback path，保留 botocore 固定向量测试，
  避免 connection ID 末尾 `=` / `%3D` 重复编码。

## 使用入口

通过正式 App 的项目文件页面或 Session 顶部的 Terminal 按钮打开项目共享终端。
早期独立 POC 页面及其测试 Bridge 启动脚本已移除，构建不再包含单独的自测入口。

## 输入回显与移动端

2026-09-16 按要求移除输入预览组件、开关和覆盖层，桌面和手机统一使用真实 PTY 回显。
输入立即发送，不等待 Enter；只有远端 PTY 返回的数据才能写入 xterm，ACK 不控制字符显示。
不再预测普通文字、退格或回车，不用本地显示掩盖公网延迟。

移动端后续先验证 composition / beforeinput、软键盘退格和粘贴，再处理 viewport / fit、焦点保持，
以及 Esc / Ctrl / Tab / 方向键工具条。本轮没有新增移动端易用性功能。

## EC2 真实 PTY 回显测量（2026-09-16）

在现有 `test-ec2-ap` 的临时 Docker 容器内运行 Node v20.20.2 / Linux x64，以及与项目相同的
`node-pty@1.1.0`。没有安装系统编译工具或增加常驻服务。客户端与 Bridge 均位于该 EC2，
使用已部署的 Header 签名 WS / HTTP integration 和真实前端传输排序代码；PTY 运行关闭行缓冲、
关闭内核 echo 的 `cat`，按收到的真实字节计时。计时不包含 SSH 启动、浏览器绘制或本机 VPN。

| 场景 | 样本 | p50 | p95 | 最大值 |
| --- | ---: | ---: | ---: | ---: |
| EC2 进程内直接写入 / 读取真实 PTY 对照 | 60 | 0.064ms | 0.103ms | 0.248ms |
| EC2 → 云端 Header 转发 → EC2 PTY → 云端转发 → EC2 | 180 | 34.10ms | 56.59ms | 142.76ms |
| 同上，每 8ms 连续输入一个字符 | 186 | 38.13ms | 133.68ms | 157.04ms |

云端数据来自同一会话中的三轮采样，每轮先预热 8 次，再进行 60 次逐字符往返和 62 次连续输入。
表中分位数从合并后的原始样本计算，不平均各轮分位数；超长样本未剔除。
连续输入中仍有约 100–157ms 的长尾，不能将 34ms 中位数当作无卡顿保证。
该结果隔离了本机代理网络，但不等于用户关 VPN 后的浏览器端到端延迟，也不是本机 SSH 的对照。
用户侧网络的实际效果需通过上述 CloudFront 页面关闭 VPN 后验证。

原始报告及完整 WS 帧保存在仓库外私有验收目录，原始帧含凭据，不应提交或分享。

## 部署边界

`python3 scripts/deploy-terminal-direct.py --run` 显式增量部署，默认不执行。
以线上模板 / ZIP 为基底，保留旧 pipe 模块及其他路由。只新增终端相关资源并补丁 WsHandler；
WsIntegration 仅允许模板内容不变的引用更新。允许将三个实验 HTTP integration / route 迁至新 API。

代码包放入现有私有桶的唯一加密对象，由 CloudFormation 更新 Code 和环境变量，部署后校验 SHA-256。
不新建桶、不放开权限、不运行整个 install.sh。代码对象保留供模板引用。
首次旧模板为 placeholder ZIP 时禁止自动回滚，避免覆盖线上代码；后续真实 S3 代码版本支持安全回滚。

## 验证与文件清理

2026-09-16 按要求删除这批改动新增的 23 个测试、单元测试和临时测量脚本，撤销对原有打包测试的
新增断言；项目原有测试不在本次清理范围。历史测量结果保留在设计文档中，不再保留实验执行器。
本轮构建检查使用 `npm run build`；一次性云端和 EC2 验收工具仅放在仓库外的私有临时目录。

浏览器检查保存原始完整 HAR / WS 帧及截图到私有临时目录。原始记录含 API Key / 短期凭据，
不能打印、提交仓库或作为公开附件。报告只列行为和统计数据。

覆盖真实 xterm → HTTP integration → Bridge PTY、无换行 read 提示、ANSI、中文、Enter、Ctrl-C、resize、
Vim 保存、第二页面占用保护、刷新回收、按键回显延迟，以及控制 API 的 IAM 拒绝与数据 MAC 防注入。

### 先前已完成的验证（历史记录）

- CloudFormation `UPDATE_COMPLETE`；原 API 无 terminal_direct_data route，新数据 route 的 integration 为 HTTP。
- 线上旧 Lambda ZIP 的既有文件除必要 bridge_ws.py 补丁外逐字节保留；新模块加入，内存仍为 128MB。
- 本机测试 Bridge 已重启到新实现；真实 Chromium / localhost 完成上述 12 项检查，截图确认红色 ANSI
  及无换行的 `Enter your email (default: demo):` 提示可见，Vim 修改真实临时文件并成功保存。
- 真实浏览器按键 → 本机 PTY 回显 20 次：p50 **430.37ms**、p95 **435.36ms**、max **437.69ms**。
  包含浏览器自动化 / 25ms 轮询观察误差和本机公网链路，不是纯 Gateway RTT，也不代表 EC2 延迟。
- `npm test`、`npm run build` 通过；保留原有 1 个跳过测试、日期弃用及 bundle 大小告警。
- 原始成功验收目录：`terminal-direct-browser-4gnt2yg7`（系统私有临时目录），HAR / WS 记录权限 0600。
