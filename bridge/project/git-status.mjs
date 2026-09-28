import crypto from 'crypto';
import { WS_FRAME_LIMIT } from '../config.mjs';
import { runGit } from './git-command.mjs';
import {
  cachedGitContext,
  clearGitContext,
  resolveGitContext,
  resolveProjectPath,
} from './git-context.mjs';
import { fitsWsFrame } from './ws-frames.mjs';

const STATUS_NAMES = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'type_changed',
};
const GROUP_ORDER = ['conflicts', 'staged', 'changes'];
const GIT_CAPABILITIES = { history: 1, commit: 1, push: 1 };

function fixedFields(record, count) {
  const fields = [];
  let offset = 0;
  for (let index = 0; index < count; index++) {
    const separator = record.indexOf(' ', offset);
    if (separator < 0) throw new Error(`Invalid porcelain record: ${record}`);
    fields.push(record.slice(offset, separator));
    offset = separator + 1;
  }
  return { fields, path: record.slice(offset) };
}

function submoduleFields(value) {
  if (!value || value === 'N...') return {};
  return {
    submodule: true,
    submoduleState: {
      headChanged: value[1] === 'C',
      modifiedContent: value[2] === 'M',
      untrackedContent: value[3] === 'U',
    },
  };
}

function projectRelativePath(repoPath, prefix) {
  const normalized = String(repoPath || '').replaceAll('\\', '/');
  if (!prefix) return normalized;
  if (!normalized.startsWith(prefix)) {
    const error = new Error('Git context prefix changed.');
    error.errorCode = 'target_changed';
    throw error;
  }
  return normalized.slice(prefix.length);
}

function addTracked(groups, xy, repoPath, previousRepoPath, submodule, prefix) {
  const path = projectRelativePath(repoPath, prefix);
  let previousPath = previousRepoPath
    ? projectRelativePath(previousRepoPath, prefix)
    : '';
  const extra = submoduleFields(submodule);
  const add = (group, code) => {
    let status = STATUS_NAMES[code];
    if (!status) return;
    if ((code === 'R' || code === 'C') && !previousPath) status = 'added';
    groups[group].push({
      path,
      ...(previousPath ? { previousPath } : {}),
      status,
      ...extra,
    });
  };
  if (xy[0] !== '.') add('staged', xy[0]);
  if (xy[1] !== '.') add('changes', xy[1]);
}

export function parseGitStatus(raw, context) {
  const records = Buffer.isBuffer(raw)
    ? raw.toString('utf8').split('\0')
    : String(raw || '').split('\0');
  const groups = { conflicts: [], staged: [], changes: [] };
  const repository = {
    branch: '',
    detached: false,
    unborn: false,
    headOid: '',
    upstream: '',
    ahead: 0,
    behind: 0,
  };
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record) continue;
    if (record.startsWith('# branch.head ')) {
      const head = record.slice('# branch.head '.length);
      repository.detached = head === '(detached)';
      repository.branch = repository.detached ? '' : head;
      continue;
    }
    if (record.startsWith('# branch.oid ')) {
      const oid = record.slice('# branch.oid '.length);
      repository.unborn = oid === '(initial)';
      repository.headOid = repository.unborn ? '' : oid;
      continue;
    }
    if (record.startsWith('# branch.upstream ')) {
      repository.upstream = record.slice('# branch.upstream '.length);
      continue;
    }
    if (record.startsWith('# branch.ab ')) {
      const [ahead, behind] = record.slice('# branch.ab '.length).split(' ');
      repository.ahead = Math.abs(Number.parseInt(ahead, 10)) || 0;
      repository.behind = Math.abs(Number.parseInt(behind, 10)) || 0;
      continue;
    }
    if (record[0] === '#') continue;
    if (record.startsWith('? ')) {
      groups.changes.push({
        path: projectRelativePath(record.slice(2), context.prefix),
        status: 'untracked',
      });
      continue;
    }
    if (record.startsWith('1 ')) {
      const parsed = fixedFields(record, 8);
      addTracked(
        groups,
        parsed.fields[1],
        parsed.path,
        '',
        parsed.fields[2],
        context.prefix,
      );
      continue;
    }
    if (record.startsWith('2 ')) {
      const parsed = fixedFields(record, 9);
      addTracked(
        groups,
        parsed.fields[1],
        parsed.path,
        records[++index] || '',
        parsed.fields[2],
        context.prefix,
      );
      continue;
    }
    if (record.startsWith('u ')) {
      const parsed = fixedFields(record, 10);
      groups.conflicts.push({
        path: projectRelativePath(parsed.path, context.prefix),
        status: 'conflicted',
        conflictCode: parsed.fields[1],
        ...submoduleFields(parsed.fields[2]),
      });
    }
  }
  for (const group of GROUP_ORDER) {
    groups[group].sort((left, right) => left.path.localeCompare(right.path));
  }
  const snapshotId = crypto.createHash('sha256')
    .update(JSON.stringify(groups))
    .digest('hex');
  const stagedId = crypto.createHash('sha256')
    .update(JSON.stringify(groups.staged))
    .digest('hex');
  return { repository, groups, snapshotId, stagedId };
}

export async function readRawGitStatus(projectPath, options = {}) {
  const run = options.runGit || runGit;
  return (await run([
    '--no-optional-locks',
    '-C', projectPath,
    'status',
    '--porcelain=v2',
    '-z',
    '--branch',
    '--untracked-files=all',
    '--',
    '.',
  ])).stdout;
}

export async function readGitSnapshot(projectHash, options = {}) {
  const projectPath = options.projectPath
    || resolveProjectPath(projectHash, options.resolveProjectPath);
  const cached = cachedGitContext(projectHash, projectPath);
  try {
    if (cached) {
      const raw = await readRawGitStatus(projectPath, options);
      return { context: cached, ...parseGitStatus(raw, cached) };
    }
    const [context, raw] = await Promise.all([
      resolveGitContext(projectHash, projectPath, options),
      readRawGitStatus(projectPath, options),
    ]);
    return { context, ...parseGitStatus(raw, context) };
  } catch (error) {
    clearGitContext(projectHash);
    throw error;
  }
}

function responseFrame(envelope, snapshot, groups, sequence, chunkCount) {
  return {
    ...envelope,
    sequence,
    chunkCount,
    complete: sequence === chunkCount - 1,
    snapshotId: snapshot.snapshotId,
    stagedId: snapshot.stagedId,
    capabilities: GIT_CAPABILITIES,
    repository: snapshot.repository,
    groups,
  };
}

export function snapshotFrames(snapshot, envelope, frameLimit = WS_FRAME_LIMIT) {
  const entries = GROUP_ORDER.flatMap((group) => (
    snapshot.groups[group].map((entry) => ({ group, entry }))
  ));
  const partials = [];
  let groups = { conflicts: [], staged: [], changes: [] };
  for (const item of entries) {
    const candidate = {
      ...groups,
      [item.group]: groups[item.group].concat(item.entry),
    };
    const probe = responseFrame(envelope, snapshot, candidate, 9999, 9999);
    if (!fitsWsFrame(probe, frameLimit)
      && GROUP_ORDER.some((group) => groups[group].length)) {
      partials.push(groups);
      groups = { conflicts: [], staged: [], changes: [] };
      groups[item.group].push(item.entry);
    } else {
      groups = candidate;
    }
  }
  partials.push(groups);
  return partials.map((partial, sequence) => (
    responseFrame(envelope, snapshot, partial, sequence, partials.length)
  ));
}
