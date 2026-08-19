# Streaming 顺序与渲染设计

> 状态：已实现
> 日期：2026-08-17
> 范围：Claude Code、Codex、Bridge、WebSocket Server 与 Web 前端

## 1. 核心原则

一次用户问答由 `turnId` 唯一标识。Web 在发送问题前生成 `turnId`，并立即把它写入用户气泡：

```text
data-anchor="<turnId>"
```

Bridge 从该 turn 的第一条共享渲染事件开始分配连续 `seq`：

```text
stream_turn_start  seq=0
messages           seq=1
stream_block_start seq=2
stream_delta       seq=3
stream_block_stop  seq=4
messages           seq=5
stream_end         seq=6
```

一个 turn 只有一套序号。事件类型不参与排序判断。

Web 收到事件后的唯一排序规则是：

```text
turnId + seq
```

缺少 `seq=N` 时，所有 `seq>N` 的事件都保持缓存，不能产生 DOM 副作用。

## 2. 最小协议字段

所有 active-turn 共享事件必须包含：

| 字段 | 职责 |
|---|---|
| `action` | 决定事件消费后执行的行为 |
| `sessionId` | 决定事件属于哪个 Session |
| `turnId` | 关联用户问题、回答、权限和工具节点 |
| `seq` | turn 内唯一的传输与消费顺序 |

具体 action 再携带自己的 payload，例如 `chunk`、`kind`、`name`、`messages` 或 `error`。

协议不再包含：

- `clientId`
- `streamId`
- `bridgeEpoch`
- `turnSeq`
- `messageSeq`
- `finalSeq`
- `subscriptionEpoch`
- `blockIds`
- `send_message_binding`

`stream_block_start` 的 `seq` 同时作为该节点的内部 `blockId`。后续 delta、input 和 stop 按有序事件流作用于当前 block，不再传独立 `blockId`。

## 3. 事件边界

下列共享渲染事件必须进入 turn 序列：

- `stream_turn_start`
- `stream_block_start`
- `stream_delta`
- `stream_tool_input`
- `stream_block_stop`
- turn 内 `messages`
- turn 内 `permission_request`
- turn 内 `permission_resolved`
- `stream_end`

`stream_end` 是终止事件。它被发送后，该 turn 不能再产生带 seq 的事件。

下列单连接或控制事件不进入 turn 序列：

- `subscribe`
- `reveal_permission`
- `send_message`
- `send_message_result`
- `messages_ack`
- heartbeat
- session/project 状态同步

原因是这些事件可能只发给一个连接。若它们占用共享 seq，其他窗口会永久等待一个不会收到的号码。

## 4. Bridge

### 4.1 唯一发送出口

`LiveTurnStream` 是 active turn 的唯一共享事件出口：

```text
runtime callback
→ LiveTurnStream.emit(action, payload)
→ 分配 seq
→ 校验 sessionId + turnId + seq
→ 发送 WS
```

底层 Claude/Codex framer 只负责：

- 块边界
- delta 批处理
- UTF-8 安全分片

它不分配传输序号。

### 4.2 发送校验

Bridge `wsSend()` 对所有 active-turn action 做运行时校验：

- `sessionId` 必须非空
- `turnId` 必须非空
- `seq` 必须是非负整数

缺少任一字段时立即抛错，不发送半严格事件。

### 4.3 Bridge 重启

`seq` 只存在于 Bridge 内存，每个 turn 从 0 开始，因此不需要 `bridgeEpoch`。

Bridge 重启后：

- 旧 active turn 不再继续 streaming
- 新 turn 使用新的 `turnId`
- 新 turn 的 `seq` 从 0 开始
- 已持久化历史消息不受影响

## 5. Server

Server 对 Bridge 发来的 active-turn 事件重复执行相同校验。非法事件返回 `400`，不会转发给 Web。

Server 的职责只有：

1. 把共享事件广播给该 Session 的所有已订阅窗口。
2. 对普通 watcher `messages` 写入 DDB，并返回 `messages_ack`。
3. 对 runtime-owned `messages{noCache:true}` 只广播；对应 JSONL watcher 负责最终持久化。

DDB 不保存 streaming 传输字段：

- 不保存 `turnId`
- 不保存 `seq`
- 不恢复 active streaming 状态

历史记录只保存 `uuid/nativeId/type/content/timestamp` 等最终消息字段。

## 6. Web

前端 streaming 代码集中在 `web/js/streaming.js`，分为三层。

### 6.1 TurnEventQueue

只处理传输乱序：

```text
pending[seq] = event

while pending[nextSeq]:
    dispatch(pending[nextSeq])
    nextSeq += 1
```

不变量：

- gap 关闭前零副作用
- 相同重复事件幂等
- 同一 seq 的不同内容是协议错误
- stop、authority、permission 和 end 都不能跨过缺失 delta
- 不同 turn 使用独立队列

### 6.2 StreamCoordinator

只处理 turn/block 状态：

- block-start 的 seq 是节点 ID
- 一个 block 完成输入且 UI reveal 完成后，才能显示下一个 block
- 一个 turn 完成后，才能开始显示下一个已缓存 turn
- authority 只确认或局部修正现有节点

它不处理 WS 到达顺序。

### 6.3 StreamingDomRenderer

只执行声明式 DOM operation：

- 创建 turn 容器
- 创建文本、thinking 或工具节点
- 追加已经排序的文本
- 更新工具 input/result
- 局部 reconcile 权威消息
- 保留展开状态和 DOM 身份

它不读取 WS 事件，也不决定排序。

## 7. 用户消息关联

Web 发送时：

```json
{
  "action": "send_message",
  "sessionId": "...",
  "turnId": "sent-uuid",
  "text": "..."
}
```

同一时刻创建：

```html
<div class="user-message" data-anchor="sent-uuid">...</div>
```

Bridge 和 Server 原样使用该 `turnId`。Streaming renderer 只通过精确选择器定位：

```text
[data-anchor="<turnId>"]
```

因此不需要：

- clientId 到 streamId 的绑定事件
- 文本内容匹配
- “最近一个问题”推断
- timestamp 归属

快速发送相同文本的多个问题时，每个问题仍有不同 `turnId`，回复不会串位。

## 8. 多窗口与 late join

订阅是 fire-and-forget。Server 只写入订阅关系，不发送 ack；Bridge 不保存或回放 active turn。

新窗口进入正在运行的 turn 时使用以下最小规则：

1. 收到 `seq=0`：正常从 turn start 开始严格 streaming。
2. 首个有效事件是 `seq=1 messages(user)`：Web 在本地补一个无 payload 的
   `stream_turn_start(seq=0)`，然后从 `seq=1` 继续 streaming。
3. 缺少当前节点的 `stream_block_start`：丢弃该节点的残缺 delta/stop。
4. 收到完整 `messages`：立即用 authority 渲染已完成但缺少 start 的节点。
5. 收到后续 `stream_block_start`：从这个完整节点边界恢复严格 streaming。
6. `stream_end` 到达：使用整轮去重 authority 补齐仍缺失的节点并结束 turn。
7. 后续新 turn 收到 `seq=0/1` 后自动恢复正常 streaming。

`stream_end` 携带该 turn 已产生的完整去重 authority。它只补缺失 UUID/nativeId，
不会复制已由实时事件确认的节点。恢复逻辑不使用时间窗口。

### 8.1 连接恢复

后台回前台和意外 WS 断线使用同一条恢复链：

1. 立即废弃旧连接的 turn seq 缓冲，但不修改现有 DOM。
2. 新 WS 订阅后请求增量 REST 历史；同一响应并行强一致读取 Session status。
3. REST 完成前，新连接的 strict turn 事件只缓存，不渲染。
4. REST 历史先按 UUID/nativeId 合并，再按统一队列释放缓存的 WS 事件。
5. `completed` 收口重连前的 turn；`running` 保留 outstanding turn；`needs_input`
   保留 turn 但关闭 spinner。
6. 从下一个完整 block/permission checkpoint 恢复 streaming。
7. 重连前的残缺 block 收到完整 authority 后原位替换；重连后新建的 block 仍按正常逐步 reveal。

离开详情页仍会完全断开并清理 Session 状态；只有同一详情页的连接恢复使用上述增量流程。
恢复链不再发送 `reveal_turn_state`，也没有在线静默超时探针。正常连接只信任严格有序的
WS 生命周期事件；前台/重连边界复用本来就必须执行的 messages 请求完成状态校准。

`stream_block_stop` 只表示该 block 不会再有 delta，不携带完整内容。完整覆盖只能由
对应的 authority `messages` 或 `stream_end.messages` 触发。

## 9. 权威消息

turn 内 authority `messages` 也有 seq，不能绕过 gap。

处理规则：

1. 流式内容与 authority 一致：只标记 committed，不替换 DOM。
2. 内容不同：局部 patch 对应节点。
3. tool result：按工具自身原生 ID 更新 OUT。
4. 不执行整个 `.messages` 的重建。
5. runtime-owned JSONL 消息只持久化，不广播；外部 TUI/IDE 的无 seq watcher 消息作为
   普通历史消息处理，不重新打开已结束 turn。
6. Codex runtime ownership 从本轮 `task_started` 持续到下一轮 `task_started`。中间的
   `turn_aborted/task_complete` 不是释放边界，确保其后的尾部工具结果仍只持久化。
7. 中断由 runtime 在 `stream_end` 前发送唯一 authority；Web 不根据错误码或显示文案合成节点。

## 10. 初次进入 Session

Web 先发送 `subscribe`，同时拉取 REST 历史。两类 WS 消息分别处理：

紧接 `subscribe` 的 `reveal_permission` 只恢复当前权限状态。它不会请求或回放 streaming
snapshot。CC 使用 Bridge 已保存的 hook/runtime pending request；Codex TUI 使用
permission-only app-server observation 发现尚未回答的审批。仍属于未结束 live turn 的请求
会分配新的统一 seq；没有 live turn 的 hook/TUI 请求作为 standalone control event，不带 seq。

权限是控制面 UI：若 sequenced permission 被缺失的前序渲染事件阻塞，Web 会做一次短延迟、
幂等的 fallback dispatch，只负责显示/关闭弹窗，不推进 `TurnEventQueue`。之后严格队列消费
到同一 `turnId + seq` 时会被去重。普通 delta、工具节点和 authority 不使用此旁路。

### 10.1 带 `turnId + seq` 的 live turn

- 立即进入 `TurnEventQueue`，不进入历史 buffer。
- REST 首次渲染后，把仍活跃的 preview 重新挂回对应 `data-anchor=turnId`。
- 权威 `messages` 与 REST 历史按 `uuid/nativeId` 去重。
- late-join authority 若在 REST 完成前到达，进入历史 buffer，参与第一次合并渲染。

### 10.2 无 seq 的 JSONL/TUI 消息

- 仅来自没有 runtime ownership 的外部 TUI/IDE turn；Web 发起的 runtime turn 不走此路径。
- REST 完成前进入 `_wsBuffer`。
- REST 返回后按 `uuid/nativeId` 合并去重，再执行第一次历史渲染。
- REST 完成后到达的无 seq 消息走普通历史增量渲染。
- 无 seq 消息不进入 turn queue，也不能关闭或改变 active streaming turn。

REST 与 WS 谁先到达都不能导致重复节点、覆盖 preview 或改变工具展开状态。

### 10.3 初次加载的状态权威

`bufferAndFetch` 记录 REST 请求期间是否实际应用过以下生命周期事件：

- `stream_turn_start`：running
- `stream_end`：按剩余 outstanding turns 计算
- `permission_request`：保留 turn，但 spinner 关闭
- `permission_resolved`：按剩余 outstanding turns 计算

有生命周期事件时，WS 状态比 REST 快照更新；没有时使用 `/messages.status`。普通 delta、
tool input、block start/stop 或 authority 消息片段不能独立证明 turn 是否结束，因此不会覆盖
REST status。只有接口未返回 status 时，才按合并后的消息尾部做兼容推导。

## 11. 测试不变量

必须长期保留：

- 完整 turn 所有排列都按 seq 恰好消费一次。
- 重复投递不重复渲染。
- 冲突 seq 被拒绝。
- stop/messages/end 不能跨 gap。
- 大 chunk 与单字符乱序不会重复文本。
- 多 block 按创建顺序显示。
- 后一 block 必须等待前一 block reveal 完成。
- 多 turn 快速发送仍精确关联各自用户 anchor。
- `seq=1 messages(user)` 可以恢复正常 streaming。
- late join 不显示缺少 block start 的残缺 preview。
- 后续 block start 能从节点边界恢复 streaming。
- end 抢先时使用整轮 authority 一次性完成，迟到 frame 不重新打开 turn。
- REST 与 strict WS 任意先后都只生成一个节点。
- REST 与无 seq JSONL WS 任意先后都只生成一条历史消息。
- Bridge 所有 active-turn action 都带合法 seq。
- runtime-owned JSONL user/text/tool-use/tool-result/end 全部只持久化，不产生第二套 WS。
- 外部 TUI/IDE JSONL 在没有 runtime ownership 时仍发送无 seq 完整消息。
- runtime 中断 turn 的尾部工具结果在终止记录之后到达时仍属于同一 ownership。
- 中断请求失败不显示 Interrupted；最终中断按 `OUT → Interrupted → stream_end` 严格排序。
- Server 拒绝缺少 turnId/seq 的 active-turn 事件。
- DDB 不保存 live 传输字段。

当前核心乱序覆盖包括：

- 6 个事件的全部 720 种排列
- 500 轮包含重复投递的随机乱序
- stop、authority、end 抢先
- 多 block、多 turn、REST/WS 并发和 late join
- 真实 Codex 大 chunk 乱序回放
