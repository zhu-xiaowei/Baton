# 运行中继续发送消息

普通消息由 Bridge 立即交给运行时，不再等待上一轮生成完成。用户仍可主动停止任务，但不需要先按 Esc 才能追加输入。

## 最小闭环

- Codex 空闲时 `turn/start`，活动时带真实 `expectedTurnId` 调用 `turn/steer`。只串行初始化、恢复和提交 RPC，不串行生成。明确的 no-active 拒绝可重查后提交；不对超时等未知投递结果盲目重发。
- Claude Code 向同一个 stream-json stdin 直接写入带 UUID 的输入，并开启 `--replay-user-messages`。运行中追加输入不替换输出回调、不重置 framer。`user_message_uuids` 结算实际消费的输入；`queued_turn_count=0` 不代表所有已写入消息都完成。
- 发送 ID、原生执行 ID、显示段 ID 分离。规范用户消息决定显示段边界，复用现有 `LiveTurnStream`、coordinator 和 DOM renderer。显示段结束不等于执行结束。
- 规范消息、delta、block 边界和结束在同一发布队列里保序。`executionSeq` 保证跨显示段的网络乱序不会改变原生顺序；原有每段 `seq`、fetch barrier、late-join 和历史恢复继续保留。

## 身份和顺序

Codex 的同一原生 turn 可以有多条不同 user item，不能用原生 turn ID 去重。显示锚点从 client ID 或 item UUID 确定性导出。

Codex 在原生 `item/started` 时即发布带稳定身份的工具输入，将工具绑定到开始时的显示段。插话后才到达的工具完成记录按同一身份更新原位置，不挪到新用户消息后，也不遗留运行中卡片。

CC 工具执行期间插入的消息可以持久化为 `attachment.queued_command`，使用 `source_uuid` 和 `prompt` 归一化。文本输出阶段也可能合并多次发送，只保存一条规范 user 行。无时间戳的输入回放只确认消费，不制造额外聊天气泡。

发送成功 ACK 只代表提交，不代表生成完成。相同发送 ID 的进程内重试只提交一次；同样文字、不同 ID 是两条不同输入。这不是跨 Bridge 重启的 exactly-once 保证。

## 历史缓存升级

JSONL 文件顺序是权威，时间戳仅用于显示。提取器使用行号和片段序号生成 `O2#…` 排序键，WS 持久化与 HTTP 持久化使用同一个键构造器。

新缓存写入独立的 `native-order-v2` 分区；完整同步所有批次成功后才发布版本指针。发布前继续读取旧缓存并请求全量同步，不把新旧 sort key 混在同一分页查询里。发布后旧游标返回 `historyReset`，页面重新加载最新历史。

旧消息不删除，继续按原 TTL 过期。Bridge 保存的 watermark 带 `historyVersion: 2`；升级时旧 watermark 不跳过必须重建的原生历史。完整同步和后续增量写入均为确定性 upsert。

## 保留的边界

`ClientTurnOrder`、短提交锁、持久化 ACK 队列、单 writer 检查、权限回复和主动 interrupt 均保留。活动期间的 CC 本地 slash command 不混入普通消息流；无需运行时执行的状态/统计面板仍可使用。

Steer 是原生调度，不保证立即抢占正在运行的工具。网页顺序以运行时实际接收并持久化的位置为准，而不是按钮点击时间。
