# Codex worktree 项目归并

Bridge 采用 Codex `rust-v0.156.0` 的仓库身份规则：

- `commonDir + relativeCwd` 标识同一工作区。
- 原项目目录是 `primaryRoot / relativeCwd`，继续使用现有 Claude 兼容 hash。
- session 的实际 `cwd` 不变；发送消息和执行命令使用 worktree，不反解项目 hash。
- 校验 `.git → gitdir → commondir`、注册位置和反向指针；缺失、损坏或不支持的结构不猜测关联。
- 普通非 Git 目录沿用原规则，不根据仓库名称或 remote URL 合并独立 clone。

源码依据：
[repository_identity](https://github.com/openai/codex/blob/rust-v0.156.0/codex-rs/git-utils/src/worktree.rs)、
[AgentsOverviewProjectGroup](https://github.com/openai/codex/blob/rust-v0.156.0/codex-rs/tui/src/app/agents_overview_view.rs)。

## 一次性迁移，不增加旧 hash 兼容层

`server/migrate-codex-worktrees.py` 仅迁移已确认映射的 session 元数据，不部署服务、不重启 bridge，也不修改 Codex 文件。
服务端查询无需改动。消息表、消息 TTL、session ID、父子关系和自定义字段保持不变。

需要 Node.js、Python 3、`boto3` 以及目标 AWS 账号的 DynamoDB 读取/事务写入权限。
账号由本机 `~/.baton-bridge/config.json` 的 API key 推导；不会打印或备份 API key。
可用 `--config` 指定同一账号的其他 bridge 配置，`--profile` 指定 AWS profile。

### 1. 在 worktree 所在机器确认映射

在包含新版 bridge 源码的仓库根目录执行，最后一个参数是实际 worktree cwd；远程 worktree 必须在其所在机器执行。

```bash
node --input-type=module - /absolute/path/to/worktree/repo <<'JS'
import { repositoryIdentity, projectCwdFromCwd } from './bridge/repository-identity.mjs';
import { projectHashCandidatesFromCwd, projectHashFromCwd } from './bridge/session-identity.mjs';
import { CLAUDE_PROJECTS } from './bridge/config.mjs';
const cwd = process.argv[2];
const identity = repositoryIdentity(cwd);
if (!identity) throw new Error('Cannot verify repository identity; do not migrate by name');
console.log(JSON.stringify({
  cwd, ...identity,
  projectRoot: projectCwdFromCwd(cwd),
  oldHashCandidates: projectHashCandidatesFromCwd(cwd),
  projectHash: projectHashFromCwd(cwd, CLAUDE_PROJECTS),
}, null, 2));
JS
```

从 DDB/项目列表核对旧 hash，尤其是 Windows 的两种盘符编码。目标必须是已存在的原项目。
不存在或已被清理的 worktree 不自动迁移；先恢复目录并校验。这里不引入持久化推断缓存，目录不可用时遵循 Codex 的原 cwd 回退规则。

### 2. 预览

默认只有一致性读取，**没有任何写入**。参数中的 hash 通常以 `-` 开头，使用 `--参数=值`。
一次处理同一设备、同一目标项目的一个或多个旧项目。

```bash
python3 server/migrate-codex-worktrees.py \
  --table Baton-bridge-sessions --region ap-northeast-1 \
  --device test-ec2 \
  --from-project=-home-ec2-user--codex-worktrees-94912ffc-c1ee-426e-86e0-bd83fb8f9ee8-agentpeek \
  --from-project=-home-ec2-user--codex-worktrees-c6a0e49e-bfd9-40f5-bdfc-e63a0ae69764-agentpeek \
  --to-project=-home-ec2-user-workspace-github-agentpeek
```

输出包含待迁移的 session ID、来源/目标、迁移后的计数和事务操作数。
脚本读取该设备的 session/project 元数据以重算计数，但只写受影响行；其他空项目及设备属性保留。
包含非 Codex session、用户显式创建的源项目、缺失目标项目或不同内容的目标 session 时拒绝操作。
同一目标已存在且内容完全相同可以去重；其他冲突须人工确认，脚本不会覆盖较新记录。

### 3. 切换并执行

1. 暂停受影响设备的 bridge，等在途同步结束；不要停止或删除用户的 Codex session。
2. 更新 bridge 文件，包括新增的 `repository-identity.mjs`，暂不启动；不要在迁移后恢复旧版本。
3. 在预览命令后加 `--apply --bridges-stopped --backup /absolute/path/to/new-backup.json`。
4. 不带 `--apply` 再执行一次，确认 `moves` 为空、`transactionWrites` 为 0。
5. 启动新版 bridge，刷新 App/Web 的设备和项目列表，并退出旧项目地址、清理旧项目缓存。

`--bridges-stopped` 是操作者确认，不会自动停止或检测进程。
备份使用原生 DynamoDB JSON 类型，包含所有受影响键的 before/after；新文件权限为 0600，不覆盖已有备份。
修改在单个带快照条件的 DynamoDB 事务中提交；检测到并发更新则整个事务失败，重新预览后使用新备份文件重试。
网络超时后先重新 dry-run 判断是否已经提交，不要手工覆盖目标。
一次最多 100 个事务操作，并保守检查 4 MiB 请求预算；超过限制时拆分源项目。单个源项目过大则停止，不能用部分迁移绕开安全检查。
GSI 是最终一致的，提交后列表索引可能短暂延迟；重跑验证读取基表，不受此延迟影响。

迁移包含根 session 和其同项目子线程，重写 `SESS#`、`projectHash`、`projectName`、`listPk/listSk`、`threadRootPk/threadRootSk`，清理旧 `PROJ#` 并更新目标项目和设备计数。
旧地址不重定向，旧项目删除请求也不会被扩大为原项目删除。
需要回滚时先停 bridge，核对备份 after 与当前记录一致，再恢复 before（before 为 null 表示删除该新键）；不要盲目覆盖恢复后的新会话活动。

## 验证

```bash
node --test test/bridge/repository-identity.test.mjs test/bridge/session-identity.test.mjs test/codex/phase1/session.test.mjs
python3 -m pytest -q test/server/test_migrate_codex_worktrees.py
```

上线验收：原项目包含原有及 worktree sessions，旧 worktree 项目消失；历史消息正常；从 worktree session 执行 `/diff` 仍查看该 worktree，而不是主 checkout。不要为验收向用户的 session 自动发送消息。
