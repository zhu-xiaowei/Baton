import { operationError, runGit } from './git-command.mjs';
import { withRepoMutation } from './git-mutations.mjs';
import { readGitSnapshot } from './git-status.mjs';

const MAX_COMMIT_MESSAGE_BYTES = 16 * 1024;
const WRITE_TIMEOUT_MS = 120_000;
const OUTPUT_TAIL = 4000;

function gitIn(context, args) {
  return ['-C', context.projectPath, ...args];
}

function outputOf(error) {
  return [error?.stderr, error?.stdout].filter(Boolean).join('\n').trim();
}

function tail(text) {
  return text.length > OUTPUT_TAIL ? text.slice(-OUTPUT_TAIL) : text;
}

async function failWithSnapshot(message, errorCode, text, options) {
  const error = operationError(errorCode, text);
  error.snapshot = await readGitSnapshot(message.projectHash, options);
  throw error;
}

function commitFailure(error) {
  const output = outputOf(error);
  if (error?.errorCode === 'request_timeout') {
    return ['commit_failed', 'Commit timed out. A hook or commit signing may be waiting for input.'];
  }
  if (/Please tell me who you are|unable to auto-detect email|empty ident/i.test(output)) {
    return ['git_identity', 'Git author identity is not configured on this computer. Run git config --global user.name and user.email.'];
  }
  if (/index\.lock/.test(output)) {
    return ['git_locked', 'Another Git process is running in this repository. Try again shortly.'];
  }
  return ['commit_failed', tail(output) || 'Commit failed.'];
}

function pushFailure(error, remote) {
  const output = outputOf(error);
  if (error?.errorCode === 'request_timeout') return ['push_failed', 'Push timed out.'];
  if (/\[rejected\]|rejected|non-fast-forward|fetch first|stale info/i.test(output)) {
    return ['push_rejected', 'The remote has new commits. Pull first, then push again.'];
  }
  if (/Permission denied|Authentication failed|could not read Username|Host key verification failed|terminal prompts disabled/i.test(output)) {
    return ['push_auth', `Authentication failed for ${remote}. Check the SSH key or credential helper on this computer.\n${tail(output)}`];
  }
  return ['push_failed', tail(output) || 'Push failed.'];
}

async function assertOnlyProjectStaged(context, run) {
  const out = (await run(['-C', context.repoRoot, 'diff', '--cached', '--name-only', '-z']))
    .stdout.toString('utf8').split('\0').filter(Boolean);
  if (out.some((file) => !file.startsWith(context.prefix))) {
    throw operationError('outside_staged', 'Files outside this project are staged. Commit them from the repository root.');
  }
}

export async function commitGit(message, options = {}) {
  const run = options.runGit || runGit;
  const text = typeof message.message === 'string' ? message.message.trim() : '';
  if (!text) throw operationError('invalid_request', 'Commit message is required.');
  if (Buffer.byteLength(text) > MAX_COMMIT_MESSAGE_BYTES) {
    throw operationError('invalid_request', 'Commit message is too long.');
  }
  const before = await readGitSnapshot(message.projectHash, options);
  return withRepoMutation(before.context.repoRoot, async () => {
    const current = await readGitSnapshot(message.projectHash, options);
    if (current.groups.conflicts.length) {
      await failWithSnapshot(message, 'conflicts', 'Resolve merge conflicts before committing.', options);
    }
    if (!current.groups.staged.length) {
      await failWithSnapshot(message, 'nothing_staged', 'Nothing is staged to commit.', options);
    }
    if (message.stagedId !== current.stagedId) {
      await failWithSnapshot(message, 'target_changed', 'Staged files changed. Review them and commit again.', options);
    }
    if (current.context.prefix) await assertOnlyProjectStaged(current.context, run);
    try {
      await run(gitIn(current.context, ['commit', '--cleanup=strip', '-F', '-']), {
        input: `${text}\n`,
        timeoutMs: WRITE_TIMEOUT_MS,
        env: { GIT_EDITOR: 'true' },
      });
    } catch (error) {
      const [errorCode, reason] = commitFailure(error);
      await failWithSnapshot(message, errorCode, reason, options);
    }
    const oid = (await run(gitIn(current.context, ['rev-parse', 'HEAD']))).stdout.toString('utf8').trim();
    const after = await readGitSnapshot(message.projectHash, options);
    return { ...after, commit: { oid, subject: text.split('\n')[0] } };
  });
}

async function configValue(context, key, run) {
  const result = await run(gitIn(context, ['config', '--get', key]), { allowedExitCodes: [0, 1] });
  return result.exitCode === 0 ? result.stdout.toString('utf8').trim() : '';
}

// Fail fast instead of hanging on an SSH passphrase prompt, unless the user configured their own SSH command.
async function pushEnv(context, run) {
  if (process.env.GIT_SSH_COMMAND || process.env.GIT_SSH) return {};
  return (await configValue(context, 'core.sshCommand', run)) ? {} : { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' };
}

async function pushTarget(context, repository, run) {
  if (repository.upstream) {
    const remote = await configValue(context, `branch.${repository.branch}.remote`, run);
    const merge = await configValue(context, `branch.${repository.branch}.merge`, run);
    if (!remote || remote === '.' || !merge.startsWith('refs/heads/')) {
      throw operationError('push_failed', 'The upstream of this branch is not a remote branch.');
    }
    return { remote, ref: merge, published: false };
  }
  const remotes = (await run(gitIn(context, ['remote']))).stdout.toString('utf8').split('\n');
  if (!remotes.includes('origin')) throw operationError('no_remote', 'No origin remote is configured.');
  return { remote: 'origin', ref: `refs/heads/${repository.branch}`, published: true };
}

export async function pushGit(message, options = {}) {
  const run = options.runGit || runGit;
  const before = await readGitSnapshot(message.projectHash, options);
  return withRepoMutation(before.context.repoRoot, async () => {
    const current = await readGitSnapshot(message.projectHash, options);
    const repository = current.repository;
    if (repository.detached || repository.unborn || !repository.branch) {
      await failWithSnapshot(message, 'invalid_request', 'Check out a branch with commits before pushing.', options);
    }
    const target = await pushTarget(current.context, repository, run);
    try {
      await run(gitIn(current.context, [
        'push',
        '--porcelain',
        ...(target.published ? ['-u'] : []),
        target.remote,
        `HEAD:${target.ref}`,
      ]), {
        timeoutMs: WRITE_TIMEOUT_MS,
        env: await pushEnv(current.context, run),
      });
    } catch (error) {
      const [errorCode, reason] = pushFailure(error, target.remote);
      await failWithSnapshot(message, errorCode, reason, options);
    }
    const after = await readGitSnapshot(message.projectHash, options);
    return {
      ...after,
      push: { remote: target.remote, branch: target.ref.slice('refs/heads/'.length), published: target.published },
    };
  });
}
