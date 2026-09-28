import { operationError, runGit } from './git-command.mjs';
import { getGitContext } from './git-context.mjs';

const OID_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_SKIP = 2000;
const MAX_HEADS = 256;
const MAX_FILES = 3000;
const MAX_SUBJECT = 300;
const STATS_TIMEOUT_MS = 8_000;
const LOG_FORMAT = '%x1e%H%x1f%P%x1f%an%x1f%at%x1f%D%x1f%s%x1f';
const STATUS_NAMES = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'type_changed' };
const ALL_REVISIONS = ['--branches', '--remotes', '--tags'];

function gitIn(context, args) {
  return ['--no-optional-locks', '-C', context.projectPath, ...args];
}

function projectPathspec(context) {
  return context.prefix ? ['--', '.'] : ['--'];
}

async function readRefs(context, run = runGit) {
  const out = (await run(gitIn(context, [
    'for-each-ref',
    '--format=%(refname)%00%(objectname)%00%(symref)',
    'refs/heads',
    'refs/remotes',
  ]))).stdout.toString('utf8');
  return out.split('\n').filter(Boolean).map((line) => line.split('\0'))
    .filter(([, , symref]) => !symref)
    .map(([ref, oid]) => ({
      ref,
      name: ref.replace(/^refs\/(heads|remotes)\//, ''),
      kind: ref.startsWith('refs/heads/') ? 'local' : 'remote',
      oid,
    }));
}

async function revParse(context, revision, run) {
  const result = await run(gitIn(context, ['rev-parse', '--verify', '-q', revision]), {
    allowedExitCodes: [0, 1],
  });
  return result.exitCode === 0 ? result.stdout.toString('utf8').trim() : '';
}

async function allHeads(context, run) {
  const out = (await run(gitIn(context, [
    'for-each-ref',
    '--format=%(objectname) %(*objectname)',
    'refs/heads',
    'refs/remotes',
    'refs/tags',
  ]))).stdout.toString('utf8');
  const heads = out.split('\n').filter(Boolean).map((line) => {
    const [object, peeled] = line.split(' ');
    return peeled || object;
  });
  return [...new Set(heads)];
}

// Pages after the first reuse fixed OIDs so new commits never shift the offset.
async function resolveRevisions(message, context, run) {
  if (Array.isArray(message.heads) && message.heads.length) {
    if (message.heads.length > MAX_HEADS || !message.heads.every((oid) => OID_PATTERN.test(oid))) {
      throw operationError('invalid_request', 'Invalid history cursor.');
    }
    return { heads: message.heads, revisions: message.heads };
  }
  if (message.scope === 'ref') {
    const ref = (await readRefs(context, run)).find((item) => item.ref === message.ref);
    if (!ref) throw operationError('target_changed', 'That branch no longer exists.');
    return { heads: [ref.oid], revisions: [ref.oid] };
  }
  if (message.scope === 'all') {
    const heads = await allHeads(context, run);
    return heads.length <= MAX_HEADS
      ? { heads, revisions: heads }
      : { heads: [], revisions: ALL_REVISIONS };
  }
  if (message.scope !== 'auto') throw operationError('invalid_request', 'Invalid history scope.');
  const head = await revParse(context, 'HEAD', run);
  const upstream = head ? await revParse(context, '@{upstream}', run) : '';
  const heads = [...new Set([head, upstream].filter(Boolean))];
  return { heads, revisions: heads };
}

function parseDecorations(value) {
  return String(value || '').split(', ').filter(Boolean).flatMap((item) => {
    let head = false;
    if (item.startsWith('HEAD -> ')) {
      head = true;
      item = item.slice('HEAD -> '.length);
    }
    if (item.startsWith('tag: refs/tags/')) return [{ name: item.slice('tag: refs/tags/'.length), kind: 'tag' }];
    if (item.startsWith('refs/heads/')) {
      return [{ name: item.slice('refs/heads/'.length), kind: 'local', ...(head ? { head } : {}) }];
    }
    if (item.startsWith('refs/remotes/') && !item.endsWith('/HEAD')) {
      return [{ name: item.slice('refs/remotes/'.length), kind: 'remote' }];
    }
    return [];
  });
}

function parseShortstat(text) {
  const match = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(text || '');
  return match
    ? { files: Number(match[1]), insertions: Number(match[2] || 0), deletions: Number(match[3] || 0) }
    : { files: 0, insertions: 0, deletions: 0 };
}

function parseLog(output, withStats) {
  return output.toString('utf8').split('\x1e').filter(Boolean).map((record) => {
    const [oid, parents, authorName, authorTime, decorations, subject, stat] = record.split('\x1f');
    return {
      oid,
      parents: parents ? parents.split(' ') : [],
      subject: (subject || '').slice(0, MAX_SUBJECT),
      authorName,
      authorTime: Number(authorTime) || 0,
      refs: parseDecorations(decorations),
      ...(withStats ? { stats: parseShortstat(stat) } : {}),
    };
  });
}

function logArgs(context, revisions, skip, limit, withStats) {
  return gitIn(context, [
    'log',
    '--topo-order',
    '--decorate=full',
    '--no-color',
    '--no-show-signature',
    ...(withStats ? ['--shortstat', '--diff-merges=first-parent'] : []),
    `--format=${LOG_FORMAT}`,
    `-n${limit + 1}`,
    `--skip=${skip}`,
    ...revisions,
    ...projectPathspec(context),
  ]);
}

// Stats are best-effort: a slow or unsupported --shortstat falls back to a plain page.
async function readLog(context, revisions, skip, limit, run) {
  try {
    const result = await run(logArgs(context, revisions, skip, limit, true), { timeoutMs: STATS_TIMEOUT_MS });
    return parseLog(result.stdout, true);
  } catch (error) {
    if (error?.errorCode !== 'request_timeout' && error?.errorCode !== 'git_failed') throw error;
    try {
      return parseLog((await run(logArgs(context, revisions, skip, limit, false))).stdout, false);
    } catch (fallback) {
      if (fallback?.errorCode === 'git_failed') {
        throw operationError('target_changed', 'History changed. Refresh to reload it.');
      }
      throw fallback;
    }
  }
}

export async function readHistory(message, options = {}) {
  const run = options.runGit || runGit;
  const context = await getGitContext(message.projectHash, options);
  const skip = Number.isInteger(message.skip) ? message.skip : 0;
  const limit = Number.isInteger(message.limit) ? message.limit : DEFAULT_LIMIT;
  if (skip < 0 || skip > MAX_SKIP || limit < 1 || limit > MAX_LIMIT) {
    throw operationError('invalid_request', 'Invalid history page.');
  }
  const { heads, revisions } = await resolveRevisions(message, context, run);
  if (!revisions.length) return { heads, commits: [], hasMore: false };
  const commits = await readLog(context, revisions, skip, limit, run);
  return {
    heads,
    commits: commits.slice(0, limit),
    hasMore: commits.length > limit && skip + limit < MAX_SKIP,
  };
}

async function readCommitTarget(context, commitOid, run = runGit) {
  if (!OID_PATTERN.test(commitOid || '')) throw operationError('invalid_request', 'Invalid commit.');
  try {
    const out = (await run(gitIn(context, ['rev-list', '--parents', '-n', '1', `${commitOid}^{commit}`, '--'])))
      .stdout.toString('utf8').trim().split(' ');
    return { oid: out[0], baseOid: out[1] || '', merge: out.length > 2 };
  } catch (error) {
    if (error?.errorCode === 'git_failed') throw operationError('target_changed', 'Commit is not available locally.');
    throw error;
  }
}

// File list and single-file diff share this base: the first parent, or the empty tree for a root commit.
export function commitRange(target) {
  return target.baseOid ? [target.baseOid, target.oid] : ['--root', target.oid];
}

export async function readCommitFiles(message, options = {}) {
  const run = options.runGit || runGit;
  const context = options.context || await getGitContext(message.projectHash, options);
  const target = await readCommitTarget(context, message.commitOid, run);
  const out = (await run(gitIn(context, [
    'diff-tree', '-r', '-M', '-z', '--name-status', '--no-commit-id', '--relative',
    ...commitRange(target),
    '--',
  ]))).stdout.toString('utf8').split('\0');
  const files = [];
  for (let index = 0; index < out.length - 1;) {
    const code = out[index++];
    if (!code) continue;
    const status = STATUS_NAMES[code[0]] || 'modified';
    if (code[0] === 'R' || code[0] === 'C') {
      const previousPath = out[index++];
      files.push({ path: out[index++], previousPath, status });
    } else {
      files.push({ path: out[index++], status });
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    context,
    target,
    commitOid: target.oid,
    baseOid: target.baseOid,
    merge: target.merge,
    truncated: files.length > MAX_FILES,
    files: files.slice(0, MAX_FILES),
  };
}

export async function readRefList(message, options = {}) {
  const context = await getGitContext(message.projectHash, options);
  return readRefs(context, options.runGit || runGit);
}
