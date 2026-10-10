# Codex worktree project merging

Bridge adopts the repository identity rules from Codex `rust-v0.156.0`:

- `commonDir + relativeCwd` identifies the same workspace.
- The original project directory is `primaryRoot / relativeCwd` and keeps using the existing Claude-compatible hash.
- The session's actual `cwd` is unchanged; sending messages and running commands use the worktree, without reverse-resolving the project hash.
- Validate `.git → gitdir → commondir`, the registration location, and the back pointer; missing, corrupted, or unsupported structures are never associated by guessing.
- Ordinary non-Git directories keep the original rules; independent clones are not merged based on repository name or remote URL.

Source references:
[repository_identity](https://github.com/openai/codex/blob/rust-v0.156.0/codex-rs/git-utils/src/worktree.rs),
[AgentsOverviewProjectGroup](https://github.com/openai/codex/blob/rust-v0.156.0/codex-rs/tui/src/app/agents_overview_view.rs).

## One-time migration, no compatibility layer for old hashes

`server/migrate-codex-worktrees.py` only migrates session metadata with a confirmed mapping; it does not deploy the service, restart the bridge, or modify Codex files.
Server queries need no changes. The messages table, message TTL, session IDs, parent/child relationships, and custom fields stay unchanged.

Requires Node.js, Python 3, `boto3`, and DynamoDB read/transactional-write permissions on the target AWS account.
The account is derived from the API key in the local `~/.baton-bridge/config.json`; the API key is never printed or backed up.
Use `--config` to specify another bridge config for the same account, and `--profile` to specify the AWS profile.

### 1. Confirm the mapping on the machine hosting the worktree

Run from the root of a repository containing the new bridge source; the last argument is the actual worktree cwd. A remote worktree must be checked on the machine where it lives.

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

Cross-check the old hashes against DDB/the project list, especially the two drive-letter encodings on Windows. The target must be an existing original project.
Worktrees that no longer exist or have been cleaned up are not migrated automatically; restore the directory and validate first. No persisted inference cache is introduced here; when the directory is unavailable, Codex's original-cwd fallback rule applies.

### 2. Preview

By default it performs only consistent reads, with **no writes at all**. Hashes in the arguments usually start with `-`, so use `--arg=value`.
One run handles one or more old projects for the same device and the same target project.

```bash
python3 server/migrate-codex-worktrees.py \
  --table Baton-bridge-sessions --region ap-northeast-1 \
  --device test-ec2 \
  --from-project=-home-ec2-user--codex-worktrees-94912ffc-c1ee-426e-86e0-bd83fb8f9ee8-agentpeek \
  --from-project=-home-ec2-user--codex-worktrees-c6a0e49e-bfd9-40f5-bdfc-e63a0ae69764-agentpeek \
  --to-project=-home-ec2-user-workspace-github-agentpeek
```

The output includes the session IDs to migrate, source/target, post-migration counts, and the number of transaction operations.
The script reads the device's session/project metadata to recompute counts, but only writes affected rows; other empty projects and device attributes are preserved.
It refuses to proceed when there are non-Codex sessions, source projects explicitly created by the user, a missing target project, or target sessions with different content.
A target that already exists with exactly identical content can be deduplicated; other conflicts require manual confirmation, and the script never overwrites newer records.

### 3. Switch over and apply

1. Pause the bridge on the affected device and wait for in-flight syncs to finish; do not stop or delete the user's Codex sessions.
2. Update the bridge files, including the new `repository-identity.mjs`, but do not start it yet; do not restore the old version after migration.
3. Append `--apply --bridges-stopped --backup /absolute/path/to/new-backup.json` to the preview command.
4. Run once more without `--apply` and confirm `moves` is empty and `transactionWrites` is 0.
5. Start the new bridge, refresh the device and project lists in the App/Web, leave old project URLs, and clear old project caches.

`--bridges-stopped` is an operator confirmation; it does not automatically stop or detect processes.
The backup uses native DynamoDB JSON types and contains before/after for every affected key; new files get 0600 permissions, and existing backups are never overwritten.
Changes are committed in a single DynamoDB transaction with snapshot conditions; if a concurrent update is detected the whole transaction fails, so re-run the preview and retry with a new backup file.
After a network timeout, first re-run the dry-run to determine whether it was already committed; do not manually overwrite the target.
At most 100 transaction operations per run, with a conservative check against the 4 MiB request budget; split source projects when exceeding the limits. If a single source project is too large, stop; partial migration must not be used to bypass the safety checks.
The GSI is eventually consistent, so list indexes may lag briefly after commit; the verification re-run reads the base table and is unaffected by this lag.

The migration covers root sessions and their same-project child threads, rewrites `SESS#`, `projectHash`, `projectName`, `listPk/listSk`, `threadRootPk/threadRootSk`, removes the old `PROJ#`, and updates target project and device counts.
Old URLs are not redirected, and a delete request for an old project is never widened into deleting the original project.
To roll back, first stop the bridge, verify that the backup's after matches the current records, then restore before (before = null means deleting that new key); do not blindly overwrite new session activity that occurred after the bridge resumed.

## Verification

```bash
node --test test/bridge/repository-identity.test.mjs test/bridge/session-identity.test.mjs test/codex/phase1/session.test.mjs
python3 -m pytest -q test/server/test_migrate_codex_worktrees.py
```

Rollout acceptance: the original project contains both the original and worktree sessions, and the old worktree projects disappear; history messages are intact; running `/diff` from a worktree session still shows that worktree, not the main checkout. Do not automatically send messages to the user's sessions for acceptance.
