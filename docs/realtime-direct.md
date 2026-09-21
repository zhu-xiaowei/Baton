# 实时消息 Header 签名直转

2026-09-20：代码实现完成；此文不表示已经部署上线或测得新的聊天端到端时延。

## 改造边界

只替换 Bridge → App 的实时传输。保留现有事件结构、turnId/seq、前端 TurnEventQueue、历史屏障、渲染和 JSONL 持久化。
不创建新的常驻服务、DynamoDB 表或 WebSocket API；复用终端现有独立数据 API 和签名角色。

直转范围：

- 六种 `stream_*` turn 事件。
- 带有效 turnId/seq 的 `permission_request`、`permission_resolved`。
- 带有效 turnId/seq 且 `noCache: true` 的实时完整 `messages`。

需要存储及 `messages_ack` 的普通 `messages`、JSONL 同步、用户命令、文件/Git RPC、会话状态通知仍走原链路。
没有修改 watcher、HTTP 历史上传、DDB 写入或前端排序算法。

## 数据与控制

```text
实时：Bridge 原控制 WS → realtime_direct_data HTTP integration
                     → 独立数据 API 的 POST @connections → App 数据 WS

控制：原控制 WS → WsHandler Lambda
      open/join、STS hello、resolve、订阅失效通知

历史：原 JSONL/watcher → 原 WS 存储路径或 HTTP 上传 → 原 Lambda/DDB
```

Bridge 不增加第二条 WS；每个新版 App 控制连接增加一条只用于接收的数据 WS。多个 tab 各自绑定数据连接。
主 API 新增 `realtime_direct_data` HTTP route，但其目标是独立数据 API，STS 权限没有扩展到原控制 API。

1. Bridge 在原控制连接声明 `realtime=1`，通过 `hello` 获取 900 秒短期凭据，在到期前 60 秒申请刷新。
2. App 经可信控制连接申请 `open`，收到 bindingId、一次性 join token 和数据 endpoint。
3. 数据连接 `$connect` 使用 `realtime_data` 角色，`join` 校验同账号、真实 endpoint、绑定、45 秒期限及 token hash。
4. Lambda 通过条件更新消费 token，HMAC key 只通过可信控制 WS 发给 App。App 不获得 STS 凭据。
5. Bridge 首次发送某个 session/发起者组合时请求 `resolve`。服务端复用现有订阅查询和 replyConnectionId 归属检查，
   返回同账号接收者及其数据绑定；未就绪或旧客户端只返回控制连接 ID。
6. 路由缓存最多 128 项、30 秒。订阅、退订、数据绑定变化和断线通过控制面通知 Bridge 失效。
7. Bridge 按原事件顺序排队签名，经 HTTP integration 下发。接收端验证 MAC、bindingId 和事件类型，再交回原 `handleWsMessage()`。

初次路由发现、授权及绑定需要控制面往返，因此本改造不承诺冷启动首帧一定更快。
稳定状态下，接收者均支持直转时，正常大小的上述实时事件不触发转发 Lambda。

## 回退与恢复

- 老服务端不响应新协议，或返回 unsupported：Bridge/App 的原控制 WS 继续工作。
- 老 Bridge：仍通过原 Lambda 给所有 App 下发；新 App 的额外数据连接不影响原消息入口。
- 新旧 App 混用：新版目标直转，旧版目标继续通过 Lambda。
- 未授权、路由解析超时、凭据过期、本地排队过多或签名后的帧超过 28 KiB：回退到原发送路径。
- 混合回退携带内部 `directDeliveredTo`，Lambda 跳过已经排队直转的目标，并在下发前移除此字段，保持 seq 去重的 payload 一致。
- 控制连接重建会清空旧授权、路由和待解析请求；不把旧连接队列自动重放到新连接。
- 数据连接断开会清理绑定并重建，新的 bindingId/key 拒绝旧绑定的延迟帧。前端原有历史恢复机制保持不变。

发送成功仍不是“浏览器已消费”或“DDB 已持久化”的确认。本次没有新增逐事件 ACK、无限重传或 exactly-once 机制。
HTTP integration 仍可能失败或乱序；现有 seq/gap/checkpoint/历史恢复仍然必要。

## 安全边界

数据 API 禁止 app/bridge 控制角色连接；`realtime_data` 连接不能执行聊天命令或申请 Bridge 凭据。
客户端只接受通过会话 HMAC 验证的实时事件，不接受数据通道中的裸控制消息。
同一个 API 中的终端和聊天数据使用不同的消息类型及独立绑定 key，不能把未验证帧交给聊天入口。

与既有 Terminal Direct 一样，ManageConnections 权限是独立数据 API 范围，不是严格的单 connection ID IAM ACL。
HMAC 防内容注入，不消除持有该 API 权限者造成的带宽或资源滥用；不能据此宣称支持不可信多租户。
密钥不写日志或前端持久化存储。

## 文件与部署

- `bridge/realtime-direct.mjs`：Bridge 路由缓存、签名队列、直接发送和兼容回退。
- `bridge/realtime-direct-protocol.mjs`：事件契约及 App 接收/绑定状态机。
- `server/src/realtime_direct_ws.py`：低频控制面；使用已有 ConnectionsTable。
- `server/src/bridge_ws.py`：控制面接入、订阅失效和混合客户端回退。
- `server/template/Baton.template`：新增主 API 的 HTTP integration/route，并设置 `REALTIME_DIRECT_ENABLED=1`。
- `server/install.sh`：WS Lambda ZIP 包含新控制模块。

先按原发布流程更新服务端模板和 Lambda ZIP，等待 route 部署完成，再更新 Bridge 和前端。
仅更新 Python 文件不够；仅更新前端/Bridge 也不能启用新的 HTTP route。
不要使用旧的 `deploy-terminal-direct.py` 代替此次完整模板更新，它只负责历史终端增量部署。
Bridge 启动和 WebSocket 重连后检查一次更新；现有 4 分钟心跳回应携带 `bridgeVersion`，仅版本不一致时再次检查，不设置独立更新定时器。服务端 API 和 WS Lambda 必须同步传入 `AppVersion`。新包校验通过后自动重启，不因已有进程/终端延后更新，运行中的会话可能被中断。

回滚可关闭 WsHandler 的 `REALTIME_DIRECT_ENABLED` 并重连 Bridge/页面，或回退 Bridge/前端版本。
保留原消息路由和历史存储接口，不需要迁移数据。

## 验证

```bash
npm test
npm run build
```

新增测试覆盖真实签名帧、多接收端/旧端混用、原始到达顺序、原 seq 排序和渲染、凭据过期、大帧回退、
解析超时、发送时快照、订阅失效、断线、跨账号/过期/重放 join 拒绝及原控制 API 隔离。
部署模板另外通过 AWS CloudFormation validate-template 校验。

本轮未自动部署到线上。上线后应确认 Bridge WS 的高频帧 action 为 `realtime_direct_data`，
App 经独立数据 WS 收到已认证实时帧，同时核对 WsHandler 的调用量。
再使用相同 streaming 负载 A/B 比较旧/新链路时延与 seq 队列等待时间；不能把终端历史测量的 30 多 ms
直接当成本机聊天端到端验收结果。
