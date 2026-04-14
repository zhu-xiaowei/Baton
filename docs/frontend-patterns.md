# Frontend Patterns (Web Viewer / Mobile App)

Web viewer (`web/`) 中已验证的前端逻辑，mobile app 需实现相同流程。

---

## 1. Auth & Connection

```
localStorage: _ak (btoa API key), _as (server URL)
```

1. `initConnection()`: GET `/api/health` 验证连通性
2. GET `/api/bridge/config` 获取 `wsUrl`（WebSocket endpoint）
3. 所有 REST 请求带 `x-api-key` header

## 2. Navigation & State Restore

层级: **Devices → Projects → Sessions → Messages**

```
appState = { device, project: { hash, name }, session, sessionPreview }
```

- 每次导航更新 `appState` 并持久化到 `localStorage('agentpeek-nav')`
- 启动时读取持久化状态，直接跳转到上次页面（跳过中间层级加载）
- 切换 session 时先 `disconnectWs()`，再连接新 session

## 3. 进入 Session：初始消息加载

**关键设计：先订阅 WS，再从 DDB 拉历史，合并去重。** 这确保不丢失加载期间的实时消息。

```
loadMessages(sessionId):
  1. wsAllMessages = []，重置状态
  2. startWs(sessionId) → subscribe
  3. _wsBuffer = []          ← 开启缓冲模式，WS 消息暂存不渲染
  4. GET /api/bridge/messages?session=X  ← 从 DDB 拉历史
  5. merged = ddbMessages.concat(_wsBuffer)
  6. _wsBuffer = null         ← 关闭缓冲，后续 WS 消息直接渲染
  7. 按 uuid 去重（已有的不重复加入）
  8. 按 timestamp 排序
  9. renderMessages(wsAllMessages)  ← 全量渲染
  10. scrollToBottom
```

**`needSync` 处理**：如果 DDB 无消息且 `needSync=true`（bridge 正在同步），显示 loading，等待 `sync_complete` WS 事件后重新 loadMessages。

## 4. 实时消息处理（WS）

### 4.1 WS 消息类型

| action | 方向 | 处理 |
|--------|------|------|
| `messages` | Server → App | 新消息到达，增量渲染 |
| `permission_request` | Server → App | 权限确认弹窗（server-side 检测） |
| `send_message_result` | Server → App | 发送确认 + 新 session 的 sessionId |
| `sync_complete` | Server → App | bridge 同步完成，重新 loadMessages |

### 4.2 消息分类处理

每条消息按类型走不同路径：

```
新消息到达:
  ├── isToolResultOnly?  → 按 tool_use_id 就地更新对应 tool 节点
  ├── user + isInterrupt? → 渲染为中断消息
  ├── user (普通)       → 先 tryDedup（匹配已发送的乐观消息），再按 timestamp 插入
  ├── ai-title          → 更新面包屑标题，不渲染到消息列表
  └── assistant         → 按 timestamp 插入到正确位置（见下一节）
```

### 4.3 tool_result 就地更新

tool_result 消息不创建新 DOM 节点。通过 `tool_use_id` 找到已渲染的 tool_use 节点，替换其 innerHTML：

```
container.querySelector('[data-tool-id="' + tool_use_id + '"]')
  → node.innerHTML = renderToolNode(toolUseBlock, resultBlock)
```

## 5. 消息排序与插入

**核心原则：所有元素（tl-item、user-msg）都带 `data-ts`，插入时按 timestamp 扫描定位。**

WS 消息到达顺序 != timestamp 顺序（bridge 推送有延迟差异），必须按 timestamp 插入。

### 5.1 Assistant 消息插入

```
渲染出 html（可能含多个 tl-item，每个带 data-ts）
  │
  ▼
从后往前扫描所有 .tl-item[data-ts]
找第一个 data-ts > msg.timestamp → target
  │
  ├── 找到 → target.insertAdjacentHTML('beforebegin', html)
  │          （自动插入到 target 所在 assistant-turn 内部）
  │
  └── 没找到（最新消息）
       ├── 最后元素是 assistant-turn → 追加到末尾
       └── 否则 → 创建新 assistant-turn
```

### 5.2 User 消息插入

```
findInsertBefore(container, timestamp):
  从后往前扫描 container 直接子元素的 data-ts
  找第一个 > timestamp 的 → 插入到它前面
  没找到 → 追加到末尾（pending 消息之前）
```

### 5.3 DOM 结构

```
.messages (container)
  ├── .msg-user [data-ts]          ← user 消息（container 直接子元素）
  ├── .assistant-turn [data-ts]    ← assistant 回复分组
  │     ├── .tl-item [data-ts]     ← thinking / text / tool
  │     ├── .tl-item [data-ts]
  │     └── .tl-item [data-ts]
  ├── .msg-user [data-ts]
  └── .assistant-turn [data-ts]
        └── .tl-item [data-ts]
```

## 6. Auto-scroll

**在 DOM 插入前检查**是否 near-bottom，插入后根据结果决定是否滚动：

```javascript
// 插入前
var wasNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 300;

// ... DOM 插入 ...

// 插入后
if (wasNearBottom) {
  el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  setTimeout(() => el.scrollTo({ top: el.scrollHeight }), 150); // clampOverflow 后补偿
}
```

**为什么不在插入后检查**：大消息（如 CC 最终结果 10+ 行）会让 scrollHeight 增加超过阈值，导致判定"用户不在底部"而不滚动。

## 7. WS 断开重连

```
ws.onclose:
  1. 状态改为 'reconnecting'
  2. 3 秒后重连 connectWs()

ws.onopen（重连时）:
  1. 重新 subscribe 当前 sessionId
  2. 如果有 wsLastTimestamp → recoverMissing()

recoverMissing():
  1. bufferAndFetch(sessionId, after=wsLastTimestamp)  ← 只拉断线期间的增量
  2. 合并去重到 wsAllMessages
  3. 如果有新消息 → 全量重新渲染（container.innerHTML = renderMessages）
```

**`wsLastTimestamp`**：每次收到新消息时更新为最新 timestamp，重连时用它作为增量查询的起点。

## 8. New Session 创建

```
startNewSession(projectHash):
  1. appState.session = '__new__'
  2. 重置所有消息状态
  3. connectWs(null, projectHash)  ← WS 连接带 projectHash
  4. 显示空消息页 + 输入框

用户发送消息:
  1. wsSend({ action: 'send_message', projectHash, requestId, text, device })
     （注意：没有 sessionId，用 projectHash 告诉 bridge 创建新 session）
  2. 乐观渲染用户消息

Bridge 处理:
  → 创建 tmux + claude --resume → 等待 CC ready → sendKeys
  → 返回 send_message_result { ok: true, sessionId: 新ID }

收到 sessionId:
  1. appState.session = msg.sessionId（替换 '__new__'）
  2. loadMessages(sessionId)  ← 正常加载流程
```

## 9. 发送消息 & 乐观渲染

```
sendMessage():
  1. WS 发送 { action: 'send_message', sessionId, text, device }
  2. 在 pendingSentMessages 记录 { id, text }
  3. DOM 末尾插入乐观消息（带 data-pending，显示 "sending..."）

WS 返回 send_message_result { ok: true }:
  → 找到第一个未确认的 pending → 标记 delivered，更新状态为 ✓ + 时间

WS 收到真实 user 消息:
  → tryDedup：匹配 pendingSentMessages 中的文本
  → 匹配到 → 删除乐观 DOM 节点，插入真实消息（带正确 timestamp）
```

## 10. 权限确认 (Permission Prompt)

两种来源，同一个 UI：

### 10.1 Server-side (permission_request action)
Bridge 直接通过 WS 发 permission_request（较少使用）。

### 10.2 Client-side (checkPendingPrompts)
**每次消息更新后**扫描最后一条 assistant 消息的 tool_use：

```
tool_use 类型判断:
  ├── AskUserQuestion / ExitPlanMode → 立即弹窗（CC 在等用户回答）
  └── Bash / Edit / Write           → 延迟判断（5 秒）
       ├── 5秒内 tool_result 到达 → auto-approved 模式，不弹窗
       └── 5秒后无 result        → manual 模式，弹窗确认
```

**模式缓存**：`_toolApproveMode` 首次检测后缓存（`auto` / `manual`），后续同类 tool 立即判断。刷新页面重置。

### 10.3 用户操作

```
wsSend({ action: 'permission_reply', sessionId, device, approved: value })

value 格式:
  - 'arrow:N'     → 选择第 N 个选项（bridge 发送方向键导航）
  - 'type:N:text' → 导航到第 N 个选项，输入文本，回车
  - 'escape'      → 发送 Escape 取消
```

## 11. 图片处理

### 发送图片
```
选择/粘贴图片 → 压缩(720p JPEG) → 上传 S3 → 获得 key
发送时: text + '\n![](claude-bridge:key)'
Bridge 收到 → 下载 S3 → 替换为本地路径 → CC Read tool 读取
```

### 显示图片
```
消息中 image block { type: 'image', key } → 渲染为 .img-placeholder[data-key]
IntersectionObserver (rootMargin 200px) → 进入视口时 GET /api/bridge/image/:key
LRU 缓存 (max 200)
```
