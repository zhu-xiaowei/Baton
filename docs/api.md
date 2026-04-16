# AgentPeek API Specification

## 通用

**Base URL**: `https://{api-id}.execute-api.{region}.amazonaws.com/v1`

**认证**: 所有接口（REST + WS）均需 API Key
- REST: `x-api-key` header
- WS: 连接时 query string `?apiKey=xxx`

**accountId 派生**: `SHA256(apiKey)[:16]`，用于 DDB 查询，原始 key 不存储

---

## REST API — Bridge → Server (已实现 ✅)

### POST /api/bridge/sync-sessions

Bridge 上传 session 元数据到 DDB。

**Request**
```json
{
  "deviceName": "MacBook-Pro",
  "os": "darwin",
  "sessions": [
    {
      "id": "a1ca0870-xxxx-xxxx-xxxx",
      "project": "-Users-xiaoweii-workspace-rn-agentpeek",
      "projectName": "agentpeek",
      "lastActive": "2026-03-27T10:30:00.000Z",
      "size": 102400,
      "preview": "帮我实现 Phase 2 的接口",
      "model": "claude-sonnet-4-5-20250514",
      "status": "running"
    }
  ]
}
```

**Response** `200`
```json
{ "synced": 1 }
```

**DDB 写入**: BridgeSessions 表
- PK: `accountId`
- SK: `{deviceName}#{project}#{id}`

---

### POST /api/bridge/sync-messages

Bridge 批量上传消息到 DDB。用于启动时初始同步（top 2 sessions per project）。运行时实时消息改由 WS 推送，Lambda 写 DDB。

**Request**
```json
{
  "sessionId": "a1ca0870-xxxx-xxxx-xxxx",
  "messages": [
    {
      "uuid": "msg_abc123",
      "type": "user",
      "content": [{ "type": "text", "text": "hello" }],
      "timestamp": "2026-03-27T10:30:00.000Z"
    },
    {
      "uuid": "msg_def456",
      "type": "assistant",
      "content": [{ "type": "text", "text": "Hi! How can I help?" }],
      "timestamp": "2026-03-27T10:30:01.000Z"
    }
  ]
}
```

**Response** `200`
```json
{ "written": 2 }
```

**DDB 写入**: BridgeMessages 表
- PK: `sessionId`
- SK: `{timestamp}#{uuid}`
- content 存为 JSON 字符串

---

### POST /api/bridge/upload-image

Bridge 上传压缩后的图片到 S3。

**Request**
```json
{
  "key": "903158ab6d09b5657c3529f3e4c9e5f8.jpg",
  "data": "<base64 encoded JPEG>"
}
```

**Response** `200`
```json
{ "key": "903158ab6d09b5657c3529f3e4c9e5f8.jpg", "size": 45321 }
```

**S3 存储路径**: `images/{key}`（如 `images/903158ab6d09b5657c3529f3e4c9e5f8.jpg`）

---

## REST API — 通用

### GET /api/health

连通性检查，app 启动时首先调用。

**Query**: 无

**Response** `200`
```json
{ "status": "ok", "version": "dev" }
```

---

### GET /api/bridge/config

返回服务端配置，供 bridge/app 自动发现 WS URL 等。

**Query**: 无

**Response** `200`
```json
{
  "wsUrl": "wss://xxx.execute-api.xxx.amazonaws.com/v1"
}
```

---

### GET /api/bridge/install

生成 bridge 安装脚本（shell），setup 页面使用。自动配置 launchd (macOS) 或 systemd (Linux) 自启动服务。

**Query**:
| 参数 | 必填 | 说明 |
|------|------|------|
| `name` | ❌ | 设备名（省略则脚本中交互式询问，默认 hostname） |

**别名**: `GET /api/install`（同一 handler）

**Response** `200`: `text/plain` shell 脚本

**脚本逻辑**:
1. 下载 bridge.tar.gz（S3 presigned URL，1h 有效）
2. npm install
3. 写入 launchd plist / systemd service（含 server URL + API key + device name）
4. 启动服务

---

## REST API — App → Server

### GET /api/bridge/devices

获取当前账号下所有设备列表。

**Query**: 无

**逻辑**: 扫描 BridgeSessions 表 (PK=accountId)，按 `deviceName` 去重聚合

**Response** `200`
```json
{
  "devices": [
    {
      "deviceName": "MacBook-Pro",
      "os": "darwin",
      "projectCount": 12,
      "sessionCount": 522,
      "runningCount": 2,
      "idleCount": 1,
      "lastActive": "2026-03-27T10:30:00.000Z",
      "online": true
    },
    {
      "deviceName": "Ubuntu-Server",
      "os": "linux",
      "projectCount": 3,
      "sessionCount": 38,
      "runningCount": 0,
      "idleCount": 0,
      "lastActive": "2026-03-26T08:00:00.000Z",
      "online": false
    }
  ]
}
```

**说明**:
- `projectCount`: 该设备下的项目数（按 `projectHash` 去重）
- `sessionCount`: 该设备下的 session 总数
- `runningCount`: `status="running"` 的 session 数
- `idleCount`: `status="idle"` 的 session 数
- `lastActive`: 该设备下最新 session 的 lastActive
- `online`: bridge WS 是否在线（查 Connections 表 role=bridge 且 deviceName 匹配）
- 按 `lastActive` 降序排列

---

### GET /api/bridge/projects

获取指定设备下的项目列表。

**Query**:
| 参数 | 必填 | 说明 |
|------|------|------|
| `device` | ✅ | 设备名 |

**示例**: `GET /api/bridge/projects?device=MacBook-Pro`

**逻辑**: 扫描 BridgeSessions (PK=accountId, SK begins_with `{device}#`)，按 `projectHash` 聚合

**Response** `200`
```json
{
  "projects": [
    {
      "projectHash": "-Users-xiaoweii-workspace-rn-agentpeek",
      "projectName": "agentpeek",
      "projectPath": "workspace/rn/agentpeek",
      "sessionCount": 15,
      "runningCount": 1,
      "idleCount": 1,
      "lastActive": "2026-03-27T10:30:00.000Z"
    }
  ]
}
```

**说明**:
- `projectName`: 路径最后一段（目录名），用于 UI 主标题
- `projectPath`: 相对 home 的完整路径，用于 UI 副标题
- `projectHash`: App 调 sessions 接口时需要传回
- `runningCount`: `status="running"` 的 session 数
- `idleCount`: `status="idle"` 的 session 数
- 按 `lastActive` 降序排列

---

### GET /api/bridge/sessions

获取指定设备+项目下的 session 列表。

**Query**:
| 参数 | 必填 | 说明 |
|------|------|------|
| `device` | ✅ | 设备名 |
| `project` | ✅ | projectHash |

**示例**: `GET /api/bridge/sessions?device=MacBook-Pro&project=-Users-xiaoweii-workspace-rn-agentpeek`

**逻辑**: 查询 BridgeSessions (PK=accountId, SK begins_with `{device}#{project}#`)

**Response** `200`
```json
{
  "sessions": [
    {
      "sessionId": "a1ca0870-xxxx-xxxx-xxxx",
      "preview": "帮我实现 Phase 2 的接口",
      "lastActive": "2026-03-27T10:30:00.000Z",
      "size": 102400,
      "model": "claude-sonnet-4-5-20250514",
      "status": "running"
    },
    {
      "sessionId": "b880a5db-xxxx-xxxx-xxxx",
      "preview": "Fix the login bug",
      "lastActive": "2026-03-26T15:00:00.000Z",
      "size": 8192,
      "model": "claude-opus-4-6-20250610",
      "status": "stopped"
    }
  ]
}
```

**说明**:
- 按 `lastActive` 降序排列
- `status`: session 状态 (`running`/`idle`/`stopped`)

---

### GET /api/bridge/messages

获取指定 session 的消息列表，支持增量加载。

**Query**:
| 参数 | 必填 | 说明 |
|------|------|------|
| `session` | ✅ | sessionId |
| `after` | ❌ | ISO 8601 timestamp，返回此时间之后的消息 |

**示例**:
- 全量: `GET /api/bridge/messages?session=a1ca0870-xxxx`
- 增量: `GET /api/bridge/messages?session=a1ca0870-xxxx&after=2026-03-27T10:30:01.000Z`

**逻辑**:
- 无 `after`: 查询 BridgeMessages (PK=sessionId)，返回全部
- 有 `after`: 查询 BridgeMessages (PK=sessionId, SK > after#\xff)，一次查询
- DDB 为空时: 返回 `needSync: true`，同时通过 WS 通知 bridge 同步该 session

**Response** `200` — 有消息:
```json
{
  "messages": [...],
  "needSync": false
}
```

**Response** `200` — DDB 无缓存（需要 bridge 同步）:
```json
{
  "messages": [],
  "needSync": true
}
```

**needSync 触发的后续流程**:
```
1. Server 返回 needSync: true，同时通过 WS 通知 bridge:
   → { action: "sync_session", sessionId: "abc" }
2. Bridge 收到后读 .jsonl → POST /sync-messages 写 DDB
3. Bridge 完成后 WS 通知 server:
   → { action: "sync_complete", sessionId: "abc" }
4. Server 转发给订阅该 session 的 app:
   → { action: "sync_complete", sessionId: "abc" }
5. App 收到后重新 GET /messages → 有数据了 → 渲染
```

**说明**:
- `content` 是 JSON 数组（从 DDB 中 JSON string 反序列化）
- `type`: `user` | `assistant` | `system` | `summary` | `ai-title`
- Content block types: `text`, `image`, `document`, `thinking`, `tool_use`, `tool_result`
- `document` block: `{ type: "document", source: { type: "text", media_type: "text/plain", data: "..." }, title: "filename.txt" }`
- 按 `timestamp` 升序排列（对话顺序）

**DDB 未存储的字段**（仅通过 WS 实时传递，REST 返回中不含）:
- `stopReason`: assistant 消息的停止原因（`end_turn` / `tool_use` / null），前端用于判断 wsRunning 状态
- `toolUseResult`: Agent 工具执行元数据 `{ status, totalDurationMs, totalToolUseCount, totalTokens, agentId }`，附在 tool_result 消息上
- 影响：页面刷新后从 DDB 加载的消息不含这些字段。wsRunning 可从 session status 降级获取，Agent stats 丢失

---

### GET /api/bridge/image/{key}

获取图片（代理 S3）。

**Path 参数**:
| 参数 | 说明 |
|------|------|
| `key` | 图片文件名，如 `903158ab.jpg` |

**逻辑**: 从 S3 `images/{key}` 读取并返回

**Response** `200`: JPEG binary, `Content-Type: image/jpeg`

**说明**: App 通过此接口加载图片，避免直接暴露 S3

---

## WebSocket API

**连接地址**: `wss://{ws-api-id}.execute-api.{region}.amazonaws.com/v1?apiKey=xxx&role=app`

**Query 参数**:
| 参数 | 必填 | 说明 |
|------|------|------|
| `apiKey` | ✅ | API Key |
| `role` | ✅ | `app`（手机/web）或 `bridge` |
| `device` | ❌ | 设备名（bridge 必传，用于 device 路由） |

### 连接管理

**$connect**: 验证 apiKey → 存 connectionId 到 DDB Connections 表
```
DDB Connections:
  PK: connectionId
  Attributes: accountId, role (app|bridge), deviceName?, connectedAt
  TTL: 24h
```

`deviceName` 仅 bridge 连接携带，用于：
- `send_message` / `permission_reply` / `interrupt` 的 device 路由（只转发到匹配的 bridge）
- `GET /devices` 的 online 状态判断

**$disconnect**: 删除 connectionId + 清理相关订阅记录

---

### App → Server

#### subscribe

订阅某个 session 的实时消息。

```json
{ "action": "subscribe", "sessionId": "a1ca0870-xxxx" }
```

**Server 处理**:
1. 记录订阅关系到 DDB Subscriptions 表
2. 查找该 accountId 下的 bridge 连接
3. 通知 bridge 开始推送该 session

**Subscriptions 表**:
```
PK: sessionId
SK: connectionId
Attributes: accountId, subscribedAt
TTL: 24h
```

---

#### unsubscribe

取消订阅。

```json
{ "action": "unsubscribe", "sessionId": "a1ca0870-xxxx" }
```

**Server 处理**: 删除 Subscriptions 表中对应记录

---

#### heartbeat

保持连接。

```json
{ "action": "heartbeat" }
```

**Server 处理**: 更新 Connections 表 TTL，返回 `{ "action": "heartbeat", "ts": "..." }`

---

#### send_message

发送消息到 Claude Code（通过 tmux）。支持两种模式：

**已有 session:**
```json
{ "action": "send_message", "sessionId": "a1ca0870-xxxx", "text": "help me fix this bug", "device": "MacBook-Pro" }
```

**新建 session（无 sessionId，带 projectHash）:**
```json
{ "action": "send_message", "projectHash": "-Users-xxx-workspace-project", "text": "hello", "device": "MacBook-Pro" }
```

**Server 处理**: 按 `device` 转发给对应 bridge。Bridge 处理逻辑：
1. 有 sessionId → 找到对应 tmux pane → sendKeys
2. 有 sessionId 但无 tmux target → 自动创建 tmux + `claude --resume` → 等 ready → sendKeys
3. 无 sessionId 有 projectHash → 创建 tmux + `claude` → 等 ready → sendKeys → poll .jsonl 获取新 sessionId

**返回**: Bridge 发 `send_message_result`（含 sessionId）→ Server 广播给所有 app 连接。

---

#### permission_reply

回复权限确认或用户选择。

```json
{ "action": "permission_reply", "sessionId": "a1ca0870-xxxx", "approved": "arrow:1", "device": "MacBook-Pro" }
```

**approved 值**:
| 值 | 说明 |
|------|------|
| `arrow:N` | 选择第 N 个选项（0-based，适用于所有选择 UI） |
| `type:N:text` | 导航到第 N 个选项（Type something），输入文本 |
| `escape` | 取消/关闭提示 |

**Server 处理**: 按 `device` 转发给对应 bridge。

**权限检测机制**: App 从 WS 实时消息中的 `tool_use` block 检测需要用户确认的工具：
- AskUserQuestion / ExitPlanMode → 立即弹窗
- Bash / Edit / Write → 延迟判断，若 tool_result 先到则不弹（auto-approved）

---

#### interrupt

中断 Claude Code 当前运行（等同 Ctrl+C）。

```json
{ "action": "interrupt", "sessionId": "a1ca0870-xxxx", "device": "MacBook-Pro" }
```

**Server 处理**: 按 `device` 转发给对应 bridge。Bridge 向匹配的 tmux pane 发送中断信号。

---

### Bridge → Server

#### messages

Bridge 推送新消息到 Server。

```json
{
  "action": "messages",
  "sessionId": "a1ca0870-xxxx",
  "messages": [
    {
      "uuid": "msg_new789",
      "type": "assistant",
      "content": [{ "type": "text", "text": "Here's the fix..." }],
      "timestamp": "2026-03-27T10:31:00.000Z"
    }
  ]
}
```

**Server (Lambda) 处理**:
1. 查 Subscriptions 表 (PK=sessionId) → 获取所有订阅的 app connectionId
2. 并行执行：
   - **有订阅** → `post_to_connection` 推给所有 app（优先，延迟敏感）
   - **写 DDB** → BridgeMessages 表（兜底缓存，不阻塞推送）

推送给 app 的消息格式：
```json
{
  "action": "messages",
  "sessionId": "a1ca0870-xxxx",
  "messages": [...]
}
```

**说明**:
- Bridge 只通过 WS 发送消息，不再直接 HTTP POST 写 DDB
- DDB 写入由 Lambda 负责，与 app 推送并行
- 无 app 订阅时只写 DDB，不浪费转发

---

#### permission_request

Bridge 检测到权限确认需求，推送给订阅该 session 的所有 app。

```json
{
  "action": "permission_request",
  "sessionId": "a1ca0870-xxxx",
  "title": "Run command?",
  "description": "npm install",
  "options": [
    { "label": "Yes", "value": "arrow:0", "key": "1" },
    { "label": "No", "value": "arrow:2", "key": "3" }
  ]
}
```

**Server 处理**: `_handle_bridge_relay` — 按 sessionId 查 Subscriptions 表，转发给所有订阅的 app 连接（排除 bridge 自身）。

---

#### send_message_result

Bridge 处理完 send_message 后返回结果。

```json
{ "action": "send_message_result", "ok": true, "sessionId": "新创建的sessionId（仅新session时）" }
```

**Server 处理**: `_handle_bridge_broadcast` — 广播给该 accountId 下**所有** app 连接（不限于订阅者）。

---

#### heartbeat

```json
{ "action": "heartbeat" }
```

同 App heartbeat。

---

#### sync_complete

Bridge 完成按需同步后通知 server。

```json
{ "action": "sync_complete", "sessionId": "a1ca0870-xxxx" }
```

**Server 处理**: 转发给所有订阅该 session 的 app。

---

### Server → Bridge (推送)

#### messages_ack

Server 收到 bridge 的 messages 并处理后，回复 ack 让 bridge 推进 synced 指针。

```json
{ "action": "messages_ack", "sessionId": "a1ca0870-xxxx" }
```

**Bridge 处理**: `wsSendWithAck` 等待此消息（5s 超时）。收到 → resolve(true)，bridge 推进行号。超时 → resolve(false)，bridge fallback HTTP POST 写 DDB。

---

#### sync_session

Server 通知 bridge 同步指定 session 的消息到 DDB（由 GET /messages 的 needSync 触发）。

```json
{ "action": "sync_session", "sessionId": "a1ca0870-xxxx" }
```

**Bridge 处理**:
1. 根据 sessionId 找到对应的 .jsonl 文件
2. 读取并提取消息 → POST /sync-messages 写 DDB
3. 完成后 WS 发送 `sync_complete`

---

### Server → App (推送)

#### messages

Server 转发 bridge 的消息给 app（仅推给订阅了该 sessionId 的 app 连接）。

```json
{
  "action": "messages",
  "sessionId": "a1ca0870-xxxx",
  "messages": [...]
}
```

---

#### permission_request

Server 转发 bridge 的权限确认请求（仅推给订阅了该 sessionId 的 app 连接）。

```json
{
  "action": "permission_request",
  "sessionId": "a1ca0870-xxxx",
  "title": "...",
  "description": "...",
  "options": [...]
}
```

---

#### send_message_result

Server 转发 bridge 的发送结果（广播给该 account 下**所有** app 连接）。

```json
{ "action": "send_message_result", "ok": true, "sessionId": "新sessionId（仅新session时）" }
```

---

#### sync_complete

通知 app 某个 session 的历史消息已同步到 DDB，app 可以重新 GET /messages。

```json
{ "action": "sync_complete", "sessionId": "a1ca0870-xxxx" }
```

---

## 错误响应

所有接口统一错误格式：

```json
{
  "error": "error_code",
  "message": "Human readable description"
}
```

| HTTP Status | error_code | 场景 |
|-------------|------------|------|
| 401 | `unauthorized` | 缺少或无效的 API Key |
| 400 | `bad_request` | 缺少必填参数 |
| 404 | `not_found` | 资源不存在 |
| 500 | `internal_error` | 服务端异常 |

---

## DynamoDB 表总览

| 表名 | PK | SK | 用途 | TTL |
|------|----|----|------|-----|
| BridgeSessions | accountId | deviceName#projectHash#sessionId | Session 元数据 | 90 天 |
| BridgeMessages | sessionId | timestamp#uuid | 消息缓存（仅 uuid/type/content/timestamp） | 30 天 |
| Connections | connectionId | — | WS 连接记录（含 role, deviceName?） | 24h |
| Subscriptions | sessionId | connectionId | WS 订阅关系 | 24h |

---

## 已知限制 & 设计备注

### DDB 消息字段丢失

DDB 仅存 `uuid`, `type`, `content`, `timestamp` 四个字段。以下字段仅在 WS 实时路径传递，DDB/REST 不含：
- `stopReason` — 页面刷新后无法从消息判断 wsRunning，需降级到 session 级 `status`
- `toolUseResult` — Agent 子任务统计信息刷新后丢失
- `parentUuid` — 消息父子关系

### Connections 表 scan

`send_message` / `permission_reply` / `interrupt` 转发给 bridge 时，按 `accountId + role` 做 DDB scan（Connections 表无 GSI）。当前连接量小无影响，大规模需加 GSI on accountId。`_handle_disconnect` 清理 Subscriptions 也是 scan（PK=sessionId 无法反向按 connectionId 查询）。

### send_message_result 广播范围

`send_message_result` 使用 `_handle_bridge_broadcast` 广播给 account 下**所有** app 连接，而非仅请求方。多设备/多标签页同时打开时，所有 app 都会收到新 session 的 `sessionId`。当前前端通过 `appState.session === '__new__'` 判断是否处理，不影响功能。

### body.pop("device") 原地修改

`_handle_send_to_bridge` 中 `body.pop("device")` 直接修改传入的 dict，strip 掉 device 再转发给 bridge。当前所有调用方（send_message / permission_reply / interrupt）调用后立即 return，不复用 body，因此无实际 bug。但如果将来有复用 body 的场景需注意。

### 图片接口无 account 隔离

`GET /api/bridge/image/{key}` 不校验 accountId，任何有效 API key 可访问任意图片。依赖 key 为 hash 值不可猜测。`POST /upload-image` 同理不关联 account。
