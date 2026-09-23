# Message History Snapshot and Live Updates

> 状态：已实现，2026-09-23 更新
> 范围：Web 前端历史加载、后台恢复、WS 重连、请求期事件缓冲与实时消息更新

## 1. 统一最新 200 条加载

初次进入、后台到前台、WS 重连、bridge 同步和 compact stream-end 补请求，共用
`loadLatestMessages(sessionId)`。初次进入先展示骨架屏；其他刷新保留当前页面直到请求完成。

```text
建立请求屏障 → 订阅 WS → GET /api/bridge/messages?limit=200
  请求中：按到达顺序暂存原始 WS 事件，不修改当前消息 DOM
  成功：替换历史尾部 → 显示快照 → 应用状态 → 回放 WS 事件
  失败：保留原页面 → 回放 WS 事件
```

同一 Session 的重叠加载复用当前请求。切换 Session 会使旧屏障失效，迟到响应不能影响新页面。
屏障只缓冲消息/strict 生命周期事件；发送接收回执仍走原来的发送逻辑。

新建会话接管和 compact stream-end 补请求使用 `{ preserveLive: true }`：仍共用最新 200 条
请求及屏障，但成功后按 ID 增量合并，不替换历史尾部、不清理 pending 或重置流式状态，
保留已有分页游标。旧回合（包括 Esc 中断）的延迟补拉不能删除随后发送的问题或回答。
若复用的是尚未完成的普通刷新，该屏障也升级为保留实时状态模式。

## 2. 尾部替换规则

设当前消息列表为 `local`，REST 返回最近最多 200 条为 `snapshot`：

1. 取 `snapshot[0]` 的 UUID；必要时使用稳定 native ID，在旧列表中找同类型唯一匹配。
2. 找到边界：保留边界前的全部旧消息，边界及其后整体替换为 `snapshot`。
3. 找不到唯一边界：直接使用 `snapshot`。空快照同样整体替换。
4. 保留旧前缀时保留原分页游标；否则使用 REST 返回的 `hasMore` / `oldestTimestamp`。

```text
旧列表：     [较早历史] [边界] [旧尾部]
REST：                 [边界] [新尾部]
结果：       [较早历史] [完整 REST 快照]
```

这里只匹配一个边界，不逐条 patch、不做双向拼接、不计算恢复游标，也不保留请求前尚未
进入 REST 的尾部内容。正常实时更新仍需按 ID 合并，不能用尾部替换代替。

## 3. 实时消息与发送顺序

普通快照刷新成功时清理请求开始前的 optimistic 消息和 stream preview。请求失败不清理。
请求过程中用户新发送的消息仍保留原位置和 turn-ID 锚点，REST 如果已经包含对应 echo，
则按 ID 确认，不增加重复用户节点。连续发送 1、2、3、4、5，即使完成事件反序到达，
回答也必须留在对应用户消息后面；相同文本不能作为确认依据。

屏障结束后，把暂存事件逐个交回正常 WS 入口：

- 带 `turnId + seq` 的事件由 `TurnEventQueue` 排序、去重、检查冲突；
- 普通 watcher 消息走实时消息提交，不走专用恢复提交层；
- checkpoint / late-join / stream-end 权威消息仍按原协议处理；
- 完整消息更新实时数据与 DOM 时，保留仍在播放的 stream block 和用户锚点。

发送超时和手动重试复用最新 200 条 fetch，但只确认该发送的 echo，不触发整页刷新。

## 4. 渲染和滚动

- 快照数据相同、没有待清理的临时节点时，不替换现有 DOM。
- 快照变化时一次渲染；阅读历史时按首个可见消息/工具 ID 及像素偏移恢复位置。
- 已开启跟随时，在下一帧滚到新内容底部；刷新本身不重新开启跟随。
- 下箭头消失只恢复跟随意图，不立刻吸附到底部；后续可见内容变化才跟随。
- 工具在实时和历史中都默认折叠，Edit 的 diff 在展开时才生成。
- 实时更新保留必要的局部 DOM 匹配；REST 刷新不调用这套局部匹配。

## 5. 模块职责

| 文件 | 职责 |
| --- | --- |
| `web/js/ws.js` | 统一 REST 加载、实时提交、发送与生命周期调度 |
| `web/js/history-snapshot.js` | 单边界尾部替换、视口锚点保存和恢复 |
| `web/js/fetch-barrier.js` | 请求去重、失效检查、原始 WS 事件缓冲 |
| `web/js/message-state.js` | 实时/分页 ID 去重合并、消息索引、pending 精确确认 |
| `web/js/message-dom.js` | 实时 DOM 更新、保留用户锚点及 stream block |
| `web/js/runtime-status.js` | REST / 消息 / outstanding turn 的运行状态判定 |
| `web/js/streaming.js` | turn 事件排序、checkpoint、流式块播放 |

旧恢复专用的三层模块、通用 commit adapter、时间戳增量游标、DOM 重绑定和无人消费的
late-join 更新缓存已删除，不保留兼容包装。旧消息分页仍是独立 `before` 请求；响应提交
前校验 Session 和 generation，不与最新快照屏障混用。

## 6. 验证

```bash
npm run test:frontend
npm run build
node test/browser/history-snapshot-chrome.mjs --headed
```

单元和集成测试覆盖边界匹配/缺失/歧义、旧分页保留、请求失败/失效、原始 WS 缓冲回放、
连续相同文本发送、反序完成、运行状态和实时 DOM 稳定性。

Chrome 测试使用隔离 profile 和可控 REST/WS，加载真实前端，验证骨架屏、默认折叠、
阅读位置、不变快照、真实标签页前后台、断线恢复、连续五次发送、compact 恢复及点击展开
Edit diff；不会向真实 Session 发送测试消息。

## 7. Codex Updated Plan

已兼容两种 app-server 计划协议：

- `item/plan/delta`
  - 保留为旧版/实验性计划文本流；
  - 官方协议明确不保证拼接 delta 等于最终结构化计划，因此不转换为 checklist。
- `turn/plan/updated`
  - 归一化为与 JSONL `update_plan` 相同的 `TodoWrite` 模型；
  - `inProgress` 转换为前端状态 `in_progress`；
  - 相同的连续 snapshot 去重；
  - 通过 strict turn 的 tool block 和 authority messages 实时渲染；请求期间统一缓冲原始 WS 事件。

本机 Codex 0.150.1 的 schema 与实际 app-server turn 均验证了
`turn/plan/updated { threadId, turnId, explanation, plan }`。真实 turn 不再发送
`item/plan/delta`，修改后的 Bridge 能输出一个完整 `TodoWrite` 节点，并在 reload 后继续与
JSONL `update_plan` 使用相同 UI。
