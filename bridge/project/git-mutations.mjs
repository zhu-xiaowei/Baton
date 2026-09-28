import fs from 'fs';
import path from 'path';
import { operationError, runGit } from './git-command.mjs';
import { readGitSnapshot } from './git-status.mjs';

const mutationQueues = new Map();
const VALID_GROUPS = {
  stage: new Set(['changes', 'conflicts']),
  unstage: new Set(['staged']),
  discard: new Set(['changes']),
};

export function withRepoMutation(repoRoot, work) {
  const previous = mutationQueues.get(repoRoot) || Promise.resolve();
  const next = previous.catch(() => {}).then(work);
  mutationQueues.set(repoRoot, next);
  return next.finally(() => {
    if (mutationQueues.get(repoRoot) === next) mutationQueues.delete(repoRoot);
  });
}

function validateRequest(message) {
  const groups = VALID_GROUPS[message.operation];
  if (!groups?.has(message.group)) {
    throw operationError('invalid_request', 'Invalid Git operation group.');
  }
  const hasPath = typeof message.path === 'string' && message.path.length > 0;
  const all = message.all === true;
  if (hasPath === all) {
    throw operationError('invalid_request', 'Provide either path or all.');
  }
  if (all && !message.snapshotId) {
    throw operationError('invalid_request', 'snapshotId is required for all operations.');
  }
}

function targetsFor(message, snapshot) {
  const entries = snapshot.groups[message.group] || [];
  if (message.all) {
    if (message.snapshotId !== snapshot.snapshotId) {
      const error = operationError(
        'status_changed',
        'Project changes have changed. Review the latest status.',
      );
      error.snapshot = snapshot;
      throw error;
    }
    return entries;
  }
  const target = entries.find((entry) => entry.path === message.path);
  if (!target) {
    const error = operationError(
      'target_changed',
      'The selected file no longer has that Git status.',
    );
    error.snapshot = snapshot;
    throw error;
  }
  return [target];
}

function gitPaths(entries) {
  const paths = [];
  for (const entry of entries) {
    paths.push(entry.path);
    if (entry.status === 'renamed' && entry.previousPath) {
      paths.push(entry.previousPath);
    }
  }
  return [...new Set(paths)];
}

function pathspecInput(paths) {
  return Buffer.from(`${paths.join('\0')}\0`, 'utf8');
}

async function runPathMutation(context, args, paths, options = {}) {
  if (!paths.length) return;
  const run = options.runGit || runGit;
  await run([
    '--literal-pathspecs',
    '-C', context.projectPath,
    ...args,
    '--pathspec-from-file=-',
    '--pathspec-file-nul',
  ], {
    input: pathspecInput(paths),
    timeoutMs: 30_000,
  });
}

function inside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== ''
    && !relative.startsWith('..')
    && !path.isAbsolute(relative);
}

function validateUntrackedPath(context, relativePath) {
  if (path.isAbsolute(relativePath) || relativePath.includes('\0')) {
    throw operationError('invalid_request', 'Invalid Git path.');
  }
  const target = path.resolve(context.projectPath, relativePath);
  if (!inside(context.projectPath, target)) {
    throw operationError('invalid_request', 'Git path is outside the project.');
  }
  const stat = fs.lstatSync(target);
  if (stat.isDirectory()) {
    throw operationError('git_failed', 'Untracked directories cannot be discarded directly.');
  }
  return target;
}

async function discardEntries(context, entries, options) {
  if (entries.some((entry) => entry.submodule)) {
    throw operationError('submodule_not_supported', 'Discarding submodules is not supported.');
  }
  const restore = [];
  const remove = [];
  for (const entry of entries) {
    if (entry.status === 'untracked') {
      remove.push(validateUntrackedPath(context, entry.path));
    } else if (entry.status === 'renamed') {
      if (entry.previousPath) restore.push(entry.previousPath);
      remove.push(validateUntrackedPath(context, entry.path));
    } else if (entry.status === 'copied') {
      remove.push(validateUntrackedPath(context, entry.path));
    } else {
      restore.push(entry.path);
    }
  }
  await runPathMutation(context, ['restore', '--worktree'], restore, options);
  for (const target of remove) await fs.promises.unlink(target);
}

export async function mutateGit(message, options = {}) {
  validateRequest(message);
  const before = await readGitSnapshot(message.projectHash, options);
  return withRepoMutation(before.context.repoRoot, async () => {
    const current = await readGitSnapshot(message.projectHash, options);
    const entries = targetsFor(message, current);
    if (message.operation === 'stage') {
      await runPathMutation(current.context, ['add', '-A'], gitPaths(entries), options);
    } else if (message.operation === 'unstage') {
      await runPathMutation(current.context, ['reset', '-q'], gitPaths(entries), options);
    } else {
      await discardEntries(current.context, entries, options);
    }
    return readGitSnapshot(message.projectHash, options);
  });
}
