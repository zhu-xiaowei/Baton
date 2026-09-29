# Git Graph / History 移动端设计

状态：第一期（只读 Graph）与第二期（Commit/Push）已在 `git-graph` 分支端到端实现：前端、Bridge、Server 均完成，
本地用真实仓库跑通浏览 → 暂存 → 提交 → 推送；尚未部署。切换分支/Stash & Switch/Pull 仍为第三期。
记录日期：2026-09-27。已实现的 Changes 基线见 [git-status-plan.md](git-status-plan.md)。

## 1. 结论

补齐手机上的审阅闭环：

```text
看到当前工作分支和 ↑↓ → 展开 Graph → 看到分叉/合并 → 展开提交 → 文件列表 → 复用现有 Diff 页
```

- 只读浏览，不 checkout、不 fetch、不写仓库；分支选择只改变 Graph 的浏览范围。
- 继续使用 `git_status` action，新增 `refs / history / commit_files` 三个只读 operation，扩展 `diff` 的历史目标。
- 真实拓扑图第一版就做：数据只需要 `parents` + `--topo-order`，泳道布局在前端增量计算，无新依赖。
- 复用现有文件详情页；历史 diff 隐藏 Code/Preview/下载，不会误读当前工作区文件。

## 2. 页面结构

```text
┌──────────────────────────────────────────┐
│ ‹ (gitflow) › ⑂ develop ↑1            📁 │  ← 项目名 chip = 刷新；分支仅展示
├──────────────────────────────────────────┤
│ ▾ Staged Changes                  1   −  │
│ ▾ Changes                         2  ↶ + │
│ ▸ Graph                      [develop ⌄] │  ← 默认折叠；右侧为浏览范围选择器
│ ◉  WIP: local commit not yet pushed  10m │
│ │  [develop] demo · 0a30453              │
│ ●  Clean up README by removi…  2025-10-14│
│ │  [origin/develop] Vincent D… · d2eee63 │
│ ○╮ Merge pull request #235 fr… 2012-07-10│
│ │● Prevent error message on…   2012-07-10│
│ ○╯ Be git-describe friendly.   2012-07-09│
└──────────────────────────────────────────┘
```

### 2.1 Header

- 去掉固定标题 `Git Changes`；项目名 chip 保持“点击刷新”，同时刷新 Changes 和已展开的 Graph。
- 分支文本来自 status：`develop ↑1 ↓2`；detached 显示 `HEAD @ <sha7>`；没有 upstream 时不显示箭头。
- **分支文本不可点击**：它永远表示真实工作分支。浏览其他分支的入口放在 Graph Section 头，与 VS Code 一致，
  避免“Header 显示 main、下方却在看 xterm”的上下文误认，也不再需要额外的“仅查看历史”提示行。
- `↑/↓` 来自 porcelain 已有的 `# branch.upstream` / `# branch.ab`，不增加 Git 查询。

### 2.2 Graph Section

- 顺序：`Merge Changes → Staged Changes → Changes → Graph`；Graph 不依赖工作区是否干净。
- 首次进入折叠，不请求历史。展开状态、浏览范围、每个范围的第一页历史与分支列表复用 Changes 的 IndexedDB 项目缓存
  （`type: git-history / git-history-page / git-refs`，随项目删除一起清理，受同一 LRU 上限约束）。
- 进入页面或展开 Graph 时先显示缓存，同时请求第一页刷新（stale-while-revalidate）：标题右侧显示小 spinner，
  返回后替换列表并更新缓存，仍存在的已展开提交保持展开；无缓存时才在底部显示加载。刷新失败保留缓存内容，Retry 重试刷新。
- 分支选择器同样先显示缓存列表，标题旁显示 spinner，后台刷新有变化才重绘。
- 与 Changes 共用页面纵向滚动；不嵌套滚动框。每页 50 条，与 Session/Project 列表一致：距底部 < 1200px 自动加载下一页，
  追加后再检查一次以填满视口；加载中底部显示 spinner；失败时停止自动加载，显示错误与 `Retry`，不在后台重试。
- 滚动容器延伸到屏幕底部，不在容器上预留底部空白；与 Project List 一样，在内部列表末尾用 `--sab / safe-area-inset-bottom` 留出可随内容滚动的安全区。Graph 不额外添加底边框或末尾间距。
- 右侧范围 chip：`develop`（Auto）/ `All branches` / 单个分支短名；复用 `path-breadcrumb-item`，Web 与原生端高度都与顶部项目 chip 一致（23.8 / 29.4px），点击区 44px。

### 2.3 提交行（收起 34px 单行，展开自适应多行）

| 区域 | 内容 |
| --- | --- |
| 左侧 graph 列 | 泳道线 + 节点；宽度按已加载行的最大泳道数自适应，上限约 84px；节点固定对齐第一行 |
| 标题区（始终） | 收起时标题单行省略 + 灰色作者名 + 1 个 ref 徽标（其余折叠为 `+N`）+ 右侧日期（7 天内 `m/h/d`，否则 `MM-DD` / `YYYY-MM-DD`）；展开时标题自然换行，日期固定右上角；手机上作者和徽标不占标题区域，桌面端仍在标题右侧显示 |
| 作者与引用区（仅展开） | 显示作者和全部分支、标签的完整名称，不显示 `+N`；仅移动端在标题下方独立显示，桌面浏览器保留标题左、作者与引用右的布局，不因展开强制另起一行；空间不足时胶囊自动换行，超长名称在胶囊内换行，不省略名称 |
| 统计区（仅展开） | sha7（点击复制）· `N files +31 −8`（+ 绿、− 红，与 A/D 状态色一致）+ 右侧本地时间 `HH:MM:SS` |

- 展开行的 sha7 为复制目标：点击（手机与桌面一致）复制完整 OID，原位闪示 `Copied` 约 1.2s，不触发展开/收起；
  整行是按钮、不支持文本选择，所以用单击复制替代选择；沿用项目已有的 `navigator.clipboard.writeText`。
- 收起态第一行空间分配优先级：日期完整 > 作者名（不收缩，最宽 100px，约 16 字符）> 标题至少 52px > 徽标可收缩到 24px。
  实测 gitflow（51 位作者）与本仓库全部提交在 390/360px 下均无溢出；仅 17 字符以上的姓名被省略（gitflow 425 行中 11 行）。
- 收起态的 `+N` 表示指向同一提交的其余 N 个分支或标签，不是提交数量或新增行数；展开后逐个显示这些引用。
- 已加载全部历史（无 `hasMore`）时最后一个节点收尾，不再向下延伸；分支尖端节点上方无线（有头）。
- 收起时只有一行，列表密度接近 VS Code；34px 仍保留可点区域，不再缩小。展开行自动加高，下半段泳道线随之延长。
- 统计来自同一次 `git log --shortstat --diff-merges=first-parent`，merge 与展开文件列表同样以第一父提交为基线；
  gitflow 与本仓库共 945 个提交实测，统计文件数与 `commit_files` 数量全部一致。
- 节点：普通提交实心；merge 空心；当前 HEAD 为带内点的圆环。
- ref 徽标：本地蓝、当前 HEAD 分支蓝底加粗、远端紫、tag 黄；来自同一次 `git log` 的 `%D`，零额外查询。
  本地 `develop` 与 `origin/develop` 分处两行，一眼看出未 push 的提交。
- 固定行高保证每行 SVG 可以独立绘制且上下严格对齐。

### 2.4 展开提交

- 可同时展开多个提交（与 VS Code 一致），再次点击收起；首次展开时才请求 `commit_files`，结果按 commit 内存缓存。
- 与 VS Code 一致，通过**高亮当前提交行**区分展开对象（蓝色选中底色，标题与元信息提亮），不另加详情条；
  完整提交信息、merge 比较口径等低价值信息不展示，时间已在行内第二行。
- 展开区左侧画“贯穿泳道”（rail），图形不断开；右侧直接是文件列表。
- 文件行直接复用 Changes 的 `gitFileRowHtml()`（同一图标、文件名 + 目录、状态字母），行高与收起的提交行一致为 34px（Changes 保持 40px），
  只是不传 stage/discard 按钮，文件图标与提交标题左对齐；仓库根目录下的文件与 Changes 一样不显示目录；rename 显示 `old → dir`。
- 点击文件进入现有全屏 Diff：标题 `name @ sha7`，隐藏 Code/Preview 标签与下载（`diffOnly + canRead:false`）。

### 2.5 范围选择器

复用 `modal-viewport.js` 居中弹层，单选、点击即关闭；标题 15px，关闭按钮复用文件详情页的 × 按钮（`CLOSE_ICON_SVG` + `file-modal-close`），
选项行 36px，选中项使用 SVG 对勾：

```text
Show history                           ⊗
✓ Auto              develop + origin/develop
  All branches
  LOCAL BRANCHES
    develop                          current
    feature/implement-hooks
  REMOTE BRANCHES
    origin/develop …
```

- `Auto` = 当前 HEAD + 其 upstream（VS Code 默认口径），能看到本地与远端的分叉。
- `All branches` = `--branches --remotes --tags`，用于查看多分支合并全貌。
- 单个本地/远端分支；ref 超过 10 个才显示筛选框，避免手机键盘弹出。
- 不列 tags、不做多选；`refs/remotes/*/HEAD` 这类 symref 去重。
- 分支列表按项目缓存在内存：再次打开立即显示缓存，同时后台请求 `refs`，有变化才重绘；只有首次打开显示 loading。
- 不加“不会切换工作区”之类的提示：标题 `Show history` 与 Header 中不变的工作分支已表达只读语义。

## 3. 泳道布局（`web/js/git/graph-layout.js`）

输入为 `--topo-order` 的提交序列（保证子提交先于父提交），逐行增量计算，`layout` 状态跨分页延续：

1. 当前提交若已被某条泳道等待，占用第一条等待它的泳道；否则分配新泳道（新颜色）。
2. 其余等待同一提交的泳道在本行汇入节点（converging）。
3. 第一父提交：若已被其他泳道等待，节点直接连过去并释放本泳道；否则本泳道继续等待它（颜色继承）。
4. 其他父提交（merge）：已被等待则连到该泳道，否则分配新泳道。
5. 每行结束压缩空位，位移用下半行的贝塞尔曲线表达。

第 3 步是关键：gitflow 仓库实测，未合并等待泳道时 All 视图最宽 11 条，合并后降到 6 条（Auto 同为 6，master 为 5）。
每行只输出 `col / converging / through / bottom / after`，渲染为一个 52px 高的小 SVG；新页宽度不变时直接 append，
否则整段重绘（纯字符串拼接，数百行为毫秒级）。

子目录项目：`git log -- <prefix>` 会改写 parents（实测 `9612a11` 的 parent 从 `6a68f66` 变为 `3acd70e`），
这时的图是简化历史，只作为列表展示依据；diff 基线仍取提交对象的真实第一父提交。

## 4. 协议（`git_status` action）

| operation | 请求字段 | 响应字段 |
| --- | --- | --- |
| `status` | 原有 | `repository` 增加 `headOid, upstream, ahead, behind`；顶层 `capabilities: { history: 1 }` |
| `refs` | — | `refs[]: { ref, name, kind: local\|remote, oid }`（多帧拼接） |
| `history` | `scope: auto\|all\|ref`, `ref?`, `heads?`, `skip?`, `limit?` | `heads[]`, `commits[]`, `hasMore`（多帧拼接 commits） |
| `commit_files` | `commitOid` | `commitOid, baseOid, merge, files[]: { path, status, previousPath? }`（多帧拼接 files） |
| `diff` | 原有 `group + path`，或 `commitOid + path` | 不变：文本分帧 + `diffToken/cursor` 分页 |

提交项：`{ oid, parents[], subject（≤ 300 字符）, authorName, authorTime, refs[]: { name, kind: local|remote|tag|head, head? }, stats?: { files, insertions, deletions } }`。
`stats` 为尽力而为：单页统计超过时间预算（约 3s）时 Bridge 去掉 `--shortstat` 重跑并省略该字段，前端不显示统计。

分页：首页把范围解析为固定的 `heads[]`（OID）；之后请求携带 `heads + skip`，Bridge 执行
`git log --topo-order <heads...> --skip=N -n limit`。基于固定 OID 翻页，期间新增提交不会造成重复或遗漏；
刷新即重新解析首页。不需要不透明 cursor，Server 可直接用正则校验。

`commit_files` 不分页：一次返回全部文件（上限 3000，超出带 `truncated`），交给现有多帧组装。

## 5. Bridge 实现要点（`bridge/project/git-history.mjs`，新增）

以下为 Bridge 实际执行的命令（`bridge/project/git-history.mjs`、`git-diff.mjs`）：

```bash
git for-each-ref --format=%(refname)%00%(objectname)%00%(symref) refs/heads refs/remotes
git log --topo-order --decorate=full --shortstat --diff-merges=first-parent -n<limit> [--skip=N] \
  --format=%x1e%H%x1f%P%x1f%an%x1f%at%x1f%D%x1f%s%x1f <heads...> -- [.]   # shortstat 位于最后一个 %x1f 之后
git diff-tree -r -M -z --name-status --no-commit-id <firstParent> <oid>   # 根提交用 --root <oid>
git diff-tree -p -M --no-ext-diff --no-color --no-commit-id <firstParent> <oid> -- <path> [<oldPath>]
```

- **merge 必须显式传第一父提交**：`git diff-tree <merge>` 默认输出 0 行（实测 `4c380be`）。
- 文件列表与单文件 diff 使用同一对 `<base> <oid>` 和同一 `-M` 策略，rename 同时传新旧路径。
- `--decorate=full` 以完整引用名区分本地/远端/tag，丢弃 `refs/remotes/*/HEAD`。
- `status` 解析补 `branch.oid / branch.upstream / branch.ab`，与现有 porcelain 同一次调用。
- 继续使用 `runGit` 参数数组、`GIT_TERMINAL_PROMPT=0`、超时与输出上限；不接受任意 revision 表达式，
  `ref` 必须是 `for-each-ref` 列出的完整名，`heads/commitOid` 必须是本仓库的 commit 对象。
- 历史 diff token 身份扩展为 `projectHash + commitOid + path`；工作区 diff 保持 `projectHash + group + path`。
- 历史 diff 不经过 `readGitSnapshot → targetFor`，改为校验 path 属于该提交的文件列表。
- 性能：`--topo-order -n 30 --all` 本仓库 0.16s；带 `--shortstat` 时 50 条约 0.05s、300 条约 1.2s（约 4ms/提交，只统计输出的提交）；有 commit-graph 时大仓库也是增量输出。
  `skip` 翻页每页重走前缀，历史总量上限 2000 行，超出提示使用单分支范围。

## 6. Server（`server/src/project/git_ws.py`）

- `ALLOWED_OPERATIONS` 增加 `refs / history / commit_files`；转发字段增加 `commitOid, scope, ref, heads, skip, limit`。
- `history`：`scope ∈ {auto, all, ref}`；`ref` 以 `refs/heads/` 或 `refs/remotes/` 开头且无 `..`/空字节；
  `heads` 为 ≤ 256 个 `^[0-9a-f]{40}([0-9a-f]{24})?$`；`skip ≤ 2000`，`limit ≤ 100`。
  All 视图的引用超过 256 个时 Bridge 返回空 `heads`，后续页改用 `--branches --remotes --tags` 重新解析（极少数仓库牺牲翻页稳定性）。
- `diff`：`group + path` 与 `commitOid + path` 二选一，不可混用；`commitOid` 不接受 mutation。
- 其余鉴权、device 路由和定向回包不变。web 与 Server 在同一镜像中发布；旧 Bridge 对未知 operation 已返回
  `invalid_request`，前端另以 `capabilities.history` 判断，旧 Bridge 时 Graph 显示“Update the Bridge…”。

## 7. 前端文件

| 文件 | 改动 |
| --- | --- |
| `web/js/git/page.js` | 去掉固定标题；项目 chip › 分支 ↑↓；`git-status-groups` 与 `git-history` 两个独立容器 |
| `web/js/git/status.js` | 每个 snapshot 更新 Header 与 history；项目 chip/重连同时刷新 history；mutation 不触发 history |
| `web/js/git/graph-layout.js`（新） | 增量泳道布局 |
| `web/js/git/history-render.js`（新） | Section、提交行 SVG、展开区 rail、复用 Changes 文件行 |
| `web/js/git/status-render.js` | 抽出 `gitFileRowHtml(entry, attrs, actions)` 供 Changes 与历史共用 |
| `web/js/git/history.js`（新） | 范围、分页、展开、文件缓存、generation 防旧响应覆盖 |
| `web/js/git/ref-picker.js`（新） | 范围选择弹层 |
| `web/js/git/rpc.js` | 新字段与 refs/commits/files 数组拼接 |
| `web/js/git/diff-viewer.js` | `openGitCommitDiff(commitOid, file)` |
| `web/js/git/commit-bar.js`（新） | 第二期提交栏：Commit / Push / Publish 主按钮与推送确认 |
| `web/js/project/file-viewer.js` | `diffOnly` 时隐藏标签栏（一行） |
| `web/css/git-status.css` | Header 分支、Graph 行、徽标、选择器样式 |

Changes 的 renderer、mutation、IndexedDB 缓存与 diff 行为不变。历史 Diff 的刷新恢复（view-state）留到正式实现时补。

## 8. 验证记录

- UI 阶段使用真实 `git` 命令生成的 fixture（nvie/gitflow：424 提交 / 72 merge / 多分支，及本仓库）驱动真实前端模块；
  确认后 mock 页面、fixture 与生成脚本均已删除，不进入仓库。
- 端到端：真实前端 → 真实 `handleGitStatusMessage` → 真实仓库（origin 为本地 bare 仓库），
  390px / 360px 手机视口跑通浏览 → 展开 merge → Diff → 暂存 → 提交 → 推送，远端 HEAD 与本地一致。
- 自动化：`test/bridge/git-history.test.mjs`（分页稳定、merge/root/rename、子目录、提交、推送/发布/被拒）与
  `test/server/test_git_status_ws.py`（新 operation 字段白名单与格式校验）。

## 9. 第二期：Commit 与 Push

### 9.1 交互：一个随状态变化的主按钮

```text
┌──────────────────────────────────────────┐
│ ‹ (gitflow) › ⑂ develop ↑1            📁 │ ← ↑N 仅显示
├──────────────────────────────────────────┤
│ [Message (commit to develop)          ]  │ ← 有暂存才出现；16px 防 iOS 缩放
│ [          Commit 1 file             ]   │ ← 提交后变为 [↑ Push 2 commits]
│ ▾ Staged Changes / Changes / Graph …     │
└──────────────────────────────────────────┘
```

| 状态 | 提交栏 |
| --- | --- |
| 有暂存 | 输入框 + 绿色 `Commit N files`（有冲突或信息为空时禁用） |
| 无暂存且 `↑N` | 蓝色 `↑ Push N commits` |
| 无暂存且无 upstream | 蓝色 `Publish <branch>` |
| 其他 / detached / 旧 Bridge | 隐藏 |

- 只提交已暂存文件；回车换行，只能点按钮提交；草稿按项目保存在内存，提交成功后清空。
- Commit 不确认；Push/Publish 是对外操作，弹一次确认框，失败信息留在确认框内。
- 提交栏是独立常驻容器（`git-commit-bar`），不随 Changes 的 innerHTML 重绘，输入内容与焦点不丢失。
- 成功后用返回的 snapshot 刷新 Changes、Header 与提交栏；HEAD 变化时已展开的 Graph 自动重载，Push 后主动刷新 Graph。

### 9.2 协议

| operation | 请求 | 响应 |
| --- | --- | --- |
| `commit` | `message`（非空，≤ 64KB）, `stagedId` | snapshot + `commit: { oid, subject }` |
| `push` | 无 | snapshot + `push: { remote, branch, published }` |

- `status` 新增 `stagedId`（仅已暂存列表的摘要）与 `capabilities: { commit: 1, push: 1 }`。
- 失败统一返回 `ok:false + errorCode + error`，并附最新 snapshot，前端据此刷新。

### 9.3 Bridge 要点

- Commit：`git commit -F -`（信息走 stdin），`GIT_EDITOR=true`，不加 `--no-verify`，超时 120s；
  先比对 `stagedId`，不一致返回 `target_changed`。
- Push：有 upstream 执行 `git push --porcelain`；无 upstream 执行 `git push --porcelain -u origin HEAD:refs/heads/<branch>`；
  永不 `--force`；未自定义 ssh 命令时加 `ssh -o BatchMode=yes`，保留 `GIT_TERMINAL_PROMPT=0`；超时 120s。
- 错误码：`commit_failed`（含 hook 输出末尾约 4KB）、`git_identity`、`git_locked`、`conflicts`、`nothing_staged`、
  `target_changed`、`outside_staged`（子目录项目外有已暂存文件）、`no_remote`、`push_auth`、`push_rejected`、`push_failed`。

## 10. 明确延后

- checkout / 创建删除分支（第三期，含 Stash & Switch）、pull（第三期，仅 `--ff-only`）、fetch、reset、rebase、cherry-pick、revert。
- tags 与多选范围、任意两提交比较、merge 各 parent 分别比较、文件跨 rename 长期历史。
- 历史版本 Code/Preview/下载、图片 diff、提交统计、历史常驻 watcher。
