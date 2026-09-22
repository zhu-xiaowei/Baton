# Git Changes 完整设计

## 1. 目标

在 AgentPeek 手机端提供接近 VS Code Source Control 的 Git Changes 能力，方便用户在
Claude Code 或 Codex 修改项目后：

- 查看当前 `projectPath` 内的真实 Git 改动。
- 查看 `Merge Changes`、`Staged Changes` 和 `Changes`。
- 暂存单个文件或整个 Section。
- 取消暂存单个文件或整个 Section。
- 撤销单个文件或整个 `Changes` Section。
- 点击文件查看标准 unified diff。
- 在 Diff 和完整 Code 之间切换。
- 与现有 Project Files 页面互相访问。

本期不实现：

- Git Graph / Commit History。
- Commit、Push、Pull、Fetch。
- 多选文件批量操作。
- 分块暂存（stage hunk）。
- 完整代码中的行级 Diff 标记；仅记录为后续增强。

## 2. 已确定的核心原则

- Git 状态只覆盖当前 `projectPath`，不操作同仓库的其他目录。
- 使用一个 WS action：`git_status`。
- 使用五个 operation：
  - `status`
  - `stage`
  - `unstage`
  - `discard`
  - `diff`
- mutation 只支持：
  - 单文件：`path`
  - 整个 Section：`all: true`
- 不实现 `stage_all`、`unstage_all`、`discard_all` 等独立 operation。
- mutation 成功后直接返回最新 grouped snapshot。
- 前端不做乐观列表更新，也不再发送第二次 `status`。
- Bridge 不缓存 Git status，每次请求都执行真实 `git status`。
- 前端使用内存 + IndexedDB 保存最近一次成功结果；进入或返回页面时先显示缓存，
  同时始终请求最新数据，完整返回后再替换。
- Bridge 只缓存 `projectHash → projectPath/repoRoot/prefix` 映射。
- Server 只鉴权、校验和路由，不执行 Git。
- Git 命令只在指定设备的 Bridge 上执行。
- 所有 Git 命令使用参数数组，不拼接 shell。

## 3. 代码组织与文件大小

### 3.1 文件职责

Project Files 列表和 Git Changes 列表必须保持独立：

```text
web/js/project/browser.js
  只负责 Project Files 目录列表和目录导航。

web/js/git/status.js
  只负责 Git Changes 状态、刷新和 mutation 控制。

web/js/git/status-render.js
  只负责三个 Git Section 和文件行渲染。

web/js/cache/project-data-cache*.js
  Git snapshot 和 Project Files 的统一 IndexedDB、LRU 与事务封装。
```

它们只共享 Header/Back 组件、文件图标、edge-back 和 WS RPC，不共享列表业务代码。

### 3.2 单文件大小

- 新文件目标控制在 300 行左右。
- 单文件最好不超过 500 行。
- 接近 500 行时按职责拆分，不继续堆积。
- 现有大文件只增加必要 import、route、入口或分发。

### 3.3 Bridge 文件

```text
bridge/project/git.mjs
  git_status action dispatcher；不放具体 Git 业务。

bridge/project/git-context.mjs
  projectPath、repoRoot、prefix 解析和映射缓存。

bridge/project/git-status.mjs
  porcelain v2 执行、解析、分组和 snapshotId。

bridge/project/git-mutations.mjs
  stage、unstage、discard。

bridge/project/git-diff.mjs
  unified diff、Diff 分页和临时缓存。

bridge/project/ws-frames.mjs
  通用 31 KB 安全分帧；Project Files 和 Git 共用。
```

### 3.4 Server 文件

```text
server/src/project/git_ws.py
  请求校验、Bridge 定向路由、App connection 定向响应。
```

只在 `server/src/bridge_ws.py` 增加 action route。

### 3.5 前端文件

```text
web/js/ws-rpc.js
  通用 requestId、pending Promise、超时、多帧组装和错误处理。

web/js/project/page.js
  Project Files 全屏页面和 Header。

web/js/project/browser.js
  目录导航、内存缓存、IndexedDB 恢复和返回刷新。

web/js/git/rpc.js
  Git 请求字段和 Git snapshot/diff assembler。

web/js/git/status.js
  状态加载、刷新、单文件和全部操作。

web/js/git/status-render.js
  Section、文件行、折叠和操作按钮。

web/js/git/diff-viewer.js
  接入完整 Project File Viewer，提供 Git Diff 加载和刷新恢复状态。

web/js/project/file-viewer.js
  共用文件详情页、下载、Code/Preview 和可选 Diff 渲染。

web/js/git/discard-confirm.js
  Discard 单文件/全部确认。

web/js/git/view-state.js
  Git List、Diff/Code 刷新恢复状态。

web/js/project/source-view.js
  Project File Viewer 和 Git Code 共用的源码、行号和高亮渲染器。

web/js/cache/project-data-cache-core.js
  统一缓存记录、LRU、Quota 重试和可注入后端的业务核心。

web/js/cache/project-data-cache-idb.js
  原生 IndexedDB Object Store、索引、事务和 cursor 删除。

web/js/cache/project-data-cache.js
  生产环境薄封装。

web/css/git-status.css
  Git Changes 和 Diff/Code 样式。
```

## 4. UI 与 Project Files 联动

### 4.1 入口

- Project 的 Session 列表：
  - 保留 Folder icon。
  - 点击进入 Files。
- Session 详情：
  - 顶部按 `Git / Runtime / New Session` 显示三个入口。
  - Git 使用统一的 Source Control SVG。
  - Codex icon 与 Git、New Session 使用同组中性灰，桌面 hover 时变亮。
  - 点击进入 Changes。
- Files 页面右上角：
  - Git icon，切换到 Changes。
- Changes 页面右上角：
  - Folder icon，切换到 Files。

Git 页面 Header 不使用可点击面包屑：

```text
[Back] Git Changes [project-name] [Folder]
```

- `Git Changes` 是静态主标题。
- 项目名是后置胶囊，长名称省略。
- 点击项目胶囊手动刷新 Git status，不改变滚动位置或清空旧列表。
- status 加载时复用现有面包屑胶囊旋转边框动画。
- 不使用 Header 横线呼吸动画。

主页面不同时堆放 Folder 和 Git，保持移动端简洁。

### 4.2 Workspace 与返回链路

Files 和 Changes 使用职责独立的全屏页面，但共享：

- Back SVG 和点击区域逻辑。
- Header 高度、安全区和左右入口布局。
- edge-back 手势框架。
- Project Files / Git Changes 缓存和 stale-while-revalidate 体验。

- 两个页面的 DOM、路径和滚动位置分别保留。
- Back 关闭整个 Workspace，回到底层 Session 列表或详情。
- Git 文件 Diff/Code 的返回和左侧侧滑先回 Git Changes。
- Git Changes 的返回和左侧侧滑再回 Session 详情。
- 两层使用独立 edge-back layer，同一次手势不会连续退出两层。
- Session → Git → Files 时，Files Back/侧滑先回 Git，再由 Git 回 Session。
- Session list → Files → Git 时，Git Back/侧滑先回 Files。
- Files/Git 只保存一层来源，不形成循环返回栈。
- Files → Changes 时先显示 Git 缓存并实时请求 status。
- Changes → Files 时先显示目录缓存并刷新当前目录。
- 侧滑预览会克隆真实上一层页面，不露出错误的 Session 底层。

### 4.3 Section

固定顺序：

```text
Merge Changes
Staged Changes
Changes
```

显示规则：

- `Merge Changes`：有冲突时显示。
- `Staged Changes`：有 staged 文件时显示。
- `Changes`：始终显示。
- 数量大于 0 才显示右侧数字。
- 数量为 0 不显示 `0`。
- 不显示 `No changes` 或 `No unstaged changes`。
- 每个 Section 默认展开，点击标题可折叠。
- 每次进入 Git Changes 都恢复全部展开，不保存上次折叠状态。
- Section Header 支持顺序吸顶；下一个 Section 到达时替换上一个。
- 折叠 Section 之间使用明确的边界色，Header 使用独立亮色背景。

文件 staged 后又继续修改时，同一文件同时出现在：

- `Staged Changes`
- `Changes`

### 4.4 行操作

普通模式：

- `Changes` 文件：
  - Stage
  - Discard
- `Staged Changes` 文件：
  - Unstage
- `Merge Changes` 文件：
  - Stage，表示标记冲突已解决

Section Header：

- `Changes`：
  - Stage All
  - Discard All
- `Staged Changes`：
  - Unstage All
- `Merge Changes`：
  - Stage All Resolved

第一版不做长按多选。

## 5. 通用 WS RPC

Project Files 和 Git 的公共请求逻辑统一到：

```text
web/js/ws-rpc.js
```

`web/js/project/rpc.js` 和 `web/js/git/rpc.js` 只负责业务字段及 assembler。
调用方只关心最终结果：

```js
const snapshot = await requestGitStatus(projectHash);
renderGitSnapshot(snapshot);
```

调用方不处理：

- requestId。
- WS 事件。
- sequence。
- chunkCount。
- complete。
- 乱序和重复帧。
- timeout。

公共层接收完整帧后调用业务 assembler：

```js
assembleTextFrames(frames)
assembleGitSnapshotFrames(frames)
assembleSingleFrame(frames)
```

`web/js/ws.js` 统一调用：

```js
if (handleWsRpcMessage(message)) return;
```

不再为 Project Files 和 Git 各写一套 pending/sequence 逻辑。

## 6. Git Context

App 请求只传 `projectHash`，Bridge 转换为完整 `projectPath`。

项目可能是 monorepo 子目录：

```text
repoRoot:    /workspace/monorepo
projectPath: /workspace/monorepo/packages/app
prefix:      packages/app/
```

Git porcelain 路径相对 repoRoot：

```text
packages/app/src/index.js
```

前端和 Project Files 使用 project-relative 路径：

```text
src/index.js
```

Bridge 首次请求并行执行：

```bash
git -C <projectPath> rev-parse --show-toplevel --show-prefix
```

```bash
git --no-optional-locks \
  -C <projectPath> \
  status \
  --porcelain=v2 \
  -z \
  --branch \
  --untracked-files=all \
  -- .
```

Bridge 只缓存：

```js
projectHash → {
  projectPath,
  repoRoot,
  prefix
}
```

后续只执行 `git status`。

不缓存：

- Git status 原始输出。
- groups。
- snapshotId。

简单失效规则：

- Git 命令失败时删除 context cache。
- Bridge 重启后内存 cache 自然清空。
- `not_git_repository` 不缓存。

## 7. Status 接口

### 7.1 App 请求

真实 `test4` 请求示例：

```json
{
  "action": "git_status",
  "operation": "status",
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "projectHash": "-Users-xiaoweii-workspace-demo-test4",
  "device": "MacBook-Pro"
}
```

不发送：

- sessionId
- projectPath
- repoRoot
- path

### 7.2 Server → Bridge

Server 使用 `device` 选择 Bridge，并增加：

```json
{
  "replyConnectionId": "<app-connection-id>"
}
```

`replyConnectionId`：

- 只在 Server 和 Bridge 之间传递。
- Bridge 原样带回。
- Server 转发 App 前删除。

### 7.3 成功响应

```json
{
  "action": "git_status",
  "operation": "status",
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "ok": true,
  "sequence": 0,
  "chunkCount": 1,
  "complete": true,
  "snapshotId": "e0b54455dbe1862e9942d877eab1ba7111e6a60a97101107544d1f6574f44811",
  "repository": {
    "branch": "main",
    "detached": false,
    "unborn": false
  },
  "groups": {
    "conflicts": [
      {
        "path": "git-fixture/conflict.txt",
        "status": "conflicted",
        "conflictCode": "UU"
      }
    ],
    "staged": [
      {
        "path": "git-fixture/added-staged.txt",
        "status": "added"
      },
      {
        "path": "git-fixture/both.txt",
        "status": "modified"
      },
      {
        "path": "git-fixture/renamed.txt",
        "previousPath": "git-fixture/rename-old.txt",
        "status": "renamed"
      }
    ],
    "changes": [
      {
        "path": "git-fixture/both.txt",
        "status": "modified"
      },
      {
        "path": "git-fixture/deleted.txt",
        "status": "deleted"
      },
      {
        "path": "git-fixture/untracked.txt",
        "status": "untracked"
      }
    ]
  }
}
```

### 7.4 状态值

```text
added
modified
deleted
renamed
copied
type_changed
untracked
conflicted
```

UI 字母：

```text
A M D R C T U !
```

### 7.5 分帧

响应不超过 31 KB 时：

```json
{
  "sequence": 0,
  "chunkCount": 1,
  "complete": true
}
```

超过 31 KB 时，同一个逻辑请求返回多个 WS 事件：

- requestId 相同。
- snapshotId 相同。
- chunkCount 相同。
- 每帧 groups 可以只包含部分数组项。
- 前端按 sequence 组装。
- 所有帧到齐后一次性渲染。

已用 1200 个状态项本地验证：

```text
frameCount: 4
largestFrameBytes: 30991
reconstructed: true
```

## 8. snapshotId

`snapshotId` 不是 Git 命令返回值。

Bridge 对排序、规范化后的完整状态计算 SHA-256：

```js
sha256(JSON.stringify({
  conflicts,
  staged,
  changes
}));
```

用途：

- 防止用户确认 All 后，Codex 又产生新文件。
- All 操作执行前验证用户看到的状态仍然有效。
- 不用于缓存。
- 单文件操作不要求完整 snapshot 一致，只验证目标当前状态。

## 9. Mutation 接口

### 9.1 三个 operation

```text
stage
unstage
discard
```

### 9.2 单文件

```json
{
  "action": "git_status",
  "operation": "stage",
  "requestId": "uuid",
  "projectHash": "-Users-xiaoweii-workspace-demo-test4",
  "device": "MacBook-Pro",
  "group": "changes",
  "path": "git-fixture/modified.txt"
}
```

Bridge 从实时状态中获得 rename/copy 的 previousPath，前端不传。

### 9.3 整个 Section

```json
{
  "action": "git_status",
  "operation": "stage",
  "requestId": "uuid",
  "projectHash": "-Users-xiaoweii-workspace-demo-test4",
  "device": "MacBook-Pro",
  "group": "changes",
  "all": true,
  "snapshotId": "current-snapshot-id"
}
```

`path` 与 `all` 必须二选一。

### 9.4 Operation/Group 组合

| operation | group | 行为 |
|---|---|---|
| `stage` | `changes` | 暂存文件 |
| `stage` | `conflicts` | 标记冲突已解决并暂存 |
| `unstage` | `staged` | 取消暂存，保留工作区 |
| `discard` | `changes` | 撤销工作区改动 |

其他组合返回 `invalid_request`。

### 9.5 Git 命令

Stage：

```text
git --literal-pathspecs add -A
```

Unstage：

```text
git --literal-pathspecs reset -q
```

Discard tracked：

```text
git --literal-pathspecs restore --worktree
```

路径通过 NUL 分隔 stdin 传输：

```text
--pathspec-from-file=-
--pathspec-file-nul
```

已验证支持：

- 空格
- Unicode
- 换行
- `*`
- `[`
- `-` 开头

### 9.6 Discard

- tracked modified：恢复为 index 内容。
- tracked deleted：从 index 恢复。
- staged 后继续修改：仅丢弃后续修改，保留 staged 内容。
- untracked：精确删除当前文件。
- conflicted：禁止 discard。
- submodule：第一版禁止 discard。
- 不执行 `git clean`。
- untracked 删除前必须显示确认。
- Discard All 显示文件数和 untracked 数量并强确认。

### 9.7 Mutation 响应

成功后立即读取最新 Git 状态，返回和 `status` 相同的 grouped snapshot：

```json
{
  "action": "git_status",
  "operation": "stage",
  "requestId": "uuid",
  "ok": true,
  "sequence": 0,
  "chunkCount": 1,
  "complete": true,
  "snapshotId": "new-snapshot-id",
  "repository": {
    "branch": "main",
    "detached": false,
    "unborn": false
  },
  "groups": {
    "conflicts": [],
    "staged": [],
    "changes": []
  }
}
```

operation 保留原 mutation 名称，但 snapshot 结构相同。

## 10. Diff 接口

### 10.1 请求

```json
{
  "action": "git_status",
  "operation": "diff",
  "requestId": "uuid",
  "projectHash": "-Users-xiaoweii-workspace-demo-test4",
  "device": "MacBook-Pro",
  "group": "changes",
  "path": "git-fixture/modified.txt"
}
```

允许 group：

```text
changes
staged
conflicts
```

### 10.2 Git 命令

```text
changes:
  git diff --no-ext-diff --no-color -- <path>

staged:
  git diff --cached --no-ext-diff --no-color -- <path>

conflicts:
  git diff --cc --no-ext-diff --no-color -- <path>
```

未跟踪文件使用跨平台临时空文件：

```text
git diff --no-index --no-ext-diff --no-color -- <empty-file> <path>
```

`git diff --no-index` 返回码 `1` 表示发现差异，不是错误。

Diff 返回标准 unified diff，可直接交给现有 Diff2Html。

### 10.3 大 Diff

- 不走 S3。
- 每批目标约 256 KB。
- 每批内部继续拆成不超过 31 KB 的 WS frame。
- 最多自动拉取 20 批，约 5 MB。
- 首批生成 `diffToken`，后续请求带 token 和 cursor。
- Bridge 缓存该次 Diff 内容，保证多批内容稳定。
- Diff cache TTL 2 分钟。
- 最多 4 个 Diff、总计约 20 MB。
- 超过限制返回 `truncated: true`。

Bridge 侧只有 Diff 需要临时内容缓存；Git status 每次都执行真实命令。
前端另外保存最近一次成功的 Git snapshot，用于页面即时恢复，不改变 Bridge 的实时语义。

### 10.4 Diff/Code Viewer

从 Git Changes 点击文件：

```text
打开完整文件 Viewer
→ 默认显示 Diff
→ 共用文件详情页 Header、下载、Code/Preview 和返回逻辑，额外提供 Diff 选项
```

- Diff：标准 unified diff + Diff2Html line-by-line。
- Code/Preview：直接使用完整 Project File Viewer，通过 `project_files.read` 获取
  当前工作区文件，共用行号、语法高亮、截断提示及 HTML/Markdown 预览。
- 下载：复用文件详情页下载按钮和原生/浏览器下载流程，下载当前工作区文件而非 patch。
- staged 文件的 Code 第一版显示当前 working-tree 内容。
- deleted 文件无当前正文时禁用 Code/Preview 和下载，仍可查看 Diff。
- 第一版不在 Viewer 重复放 stage/unstage。
- Git 入口不再创建独立详情页，共用同一个文件详情页 DOM 和侧滑返回层。
- Diff 和 Code 加载都使用统一居中 loading spinner。
- Diff 双行号支持四位数；行号和代码使用一个整体滚动容器。
- Diff2Html 内层 overflow 被关闭，避免一次横滑被两个容器竞争。
- 浏览器刷新会恢复当前文件及 Diff/Code 模式。

后续增强：

```text
Full-file Diff
```

展示完整代码，并在完整文件中标记新增、删除和修改行。

## 11. 错误格式

```json
{
  "action": "git_status",
  "operation": "status",
  "requestId": "uuid",
  "ok": false,
  "sequence": 0,
  "chunkCount": 1,
  "complete": true,
  "errorCode": "not_git_repository",
  "error": "This project is not inside a Git repository."
}
```

错误码：

```text
invalid_request
bridge_offline
project_not_found
not_git_repository
git_unavailable
status_changed
target_changed
conflict_not_supported
submodule_not_supported
diff_expired
git_failed
partial_failure
request_timeout
```

All 因 snapshotId 变化失败时，可以同时返回最新 grouped snapshot，前端刷新后提示重新确认。

## 12. 生命周期

- 打开 Changes：先显示内存或 IndexedDB snapshot，再实时请求 status。
- Files → Changes：先显示缓存，再实时请求 status。
- Diff/Code 返回 Changes：保留现有列表并后台刷新 status。
- File Viewer 返回 Files：保留当前目录和滚动位置，完整请求返回后整体替换。
- 面包屑返回父目录：优先显示访问过的目录缓存，再后台刷新。
- App 回前台且 Changes 可见：重新请求 status。
- WS 重连且 Changes 可见：重新请求 status。
- mutation 成功：使用 mutation 返回 snapshot，不再次请求。
- 不轮询。
- 刷新时保留旧列表，收到完整 snapshot 后整体替换。
- Git List、Diff/Code 和 Project Files 的浏览器刷新状态都可恢复。
- 每次进入和返回都刷新，不使用 TTL。

WS 保持条件：

```js
state.appState.session || state.projectFilesOpen || state.gitStatusOpen
```

关闭 Files/Git 且没有 Session 使用 WS 时允许断开。

### 12.1 前端持久化缓存

Project/Session List 继续使用原有 localStorage 逻辑，不做迁移。

Git snapshot 和 Project Files 使用一个原生 IndexedDB：

```text
Database: agentpeek-project-data-v1
Object Store: project-data
Indexes:
  byLastAccess
  byProject
```

统一 key：

```text
[server, device, projectHash, type, path]
```

缓存范围：

- 每个 Project 最近一次 Git snapshot。
- 每个 Project 根目录完整列表。
- 所有实际访问过的子目录完整分页结果。
- 不做目录预加载。

读取策略：

1. 内存命中时立即显示。
2. 内存未命中时读取 IndexedDB。
3. 每次进入或返回都请求最新数据。
4. 成功后更新页面、内存和 IndexedDB。
5. 请求失败保留旧内容。

LRU：

- 总记录超过 2048 时，按 `lastAccessAt` 删除最旧 512 条。
- 首次 2049 条触发后保留 1537 条。
- 相同 key 使用 `put` 覆盖，不增加记录数。
- QuotaExceeded 时清理一批并只重试一次。
- 删除 Project 时按 `byProject` 清理。
- 账号或 Server 变化时清理该缓存。
- 不引入第三方 IndexedDB 库。

## 13. 安全

- projectHash 只允许映射到存在的 projectPath。
- 确认 projectPath 位于 Git worktree。
- Git 状态和操作都限制在当前 projectPath。
- 路径必须来自 Bridge 重新读取的实时状态。
- 拒绝绝对路径、NUL 和项目外路径。
- 使用 literal pathspec。
- untracked 删除使用 `lstat`，不跟随符号链接。
- 不执行 `git clean`。
- 不执行会覆盖 staged 内容的通用 reset/checkout。
- Server 对 operation、group、UUID 和字段组合做白名单校验。
- Server 只将 Bridge 响应发回原 App connection。
- 不向前端返回设备绝对路径或完整 Git stderr。

## 14. 两阶段实施状态

### 阶段一：Bridge、Server 和五个接口（已完成）

实现：

- context。
- status parser。
- grouped snapshot。
- snapshotId。
- stage。
- unstage。
- discard。
- standard unified diff。
- WS 分帧。
- Server 定向路由。

主要测试文件：

```text
test/bridge/git-status.test.mjs
test/server/test_git_status_ws.py
```

自动测试使用临时 Git 仓库，不修改固定 fixture。

手动真实 fixture：

```text
/Users/xiaoweii/workspace/demo/test4
```

当前已验证：

```text
Merge Changes:  1
Staged Changes: 5
Changes:        5
GROUPED_STATUS_REAL_REPO=PASS
DIFF_COMMANDS=PASS
```

完成结果：

- 五个 operation 单元测试通过。
- Server 路由测试通过。
- 31 KB 分帧和乱序组装数据测试通过。
- `test4` 真实结果符合预期。

### 阶段二：前端（已完成）

实现：

- 通用 `ws-rpc.js`。
- 独立 Files / Git 全屏页面及共享 Header。
- Session 详情 Git 入口。
- Files/Changes 相互切换。
- 三个 Section。
- 折叠。
- 单文件和全部操作。
- Discard 确认。
- mutation snapshot 自动刷新。
- Diff/Code Viewer。
- 前后台和重连刷新。
- 安全区、横屏和侧滑返回。
- IndexedDB 缓存和 LRU。
- 页面刷新恢复。
- 返回页面 stale-while-revalidate。
- Section 默认展开、折叠和吸顶。

主要测试文件：

```text
test/frontend/git-status.test.mjs
test/frontend/project-files-refresh.test.mjs
test/frontend/project-data-cache.test.mjs
test/frontend/source-view.test.mjs
test/frontend/edge-back-click.test.mjs
test/frontend/edge-back-layers.test.mjs
test/browser/fixtures/project-data-cache.html
```

完成结果：

- Frontend 全量测试通过。
- Packaging 边界测试通过。
- 生产构建通过。
- 真实 Chrome IndexedDB 插入、覆盖、关闭重开读取、单条删除、按 Project 删除、
  清空和 cursor LRU smoke test 通过。
- 所有新增职责文件低于 500 行。

最终本地验证（2026-09-07）：

```text
Frontend:   330 passed
Packaging:  5 passed
Build:      PASS
IndexedDB:  CRUD / reopen / project delete / clear / LRU PASS
```

## 15. Git Graph

Git Graph / Commit History 对开发有价值，但明确延后：

- 不进入本期 status 响应。
- 不进入这两个实施阶段。
- 后续使用独立 `git_history` action。
- 后续再设计 commit list、parent graph、commit files 和 commit diff。
