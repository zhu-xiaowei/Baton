import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { operationError, runGit } from './git-command.mjs';
import { commitRange, readCommitFiles } from './git-history.mjs';
import { readGitSnapshot } from './git-status.mjs';
import { splitTextToFrames } from './ws-frames.mjs';

const FRAMES_PER_PAGE = 8;
const MAX_PAGES = 20;
const MAX_DIFF_BYTES = 5 * 1024 * 1024;
const CACHE_TTL_MS = 2 * 60_000;
const CACHE_LIMIT = 4;
const diffCache = new Map();

function pruneCache(now = Date.now()) {
  for (const [token, entry] of diffCache) {
    if (now - entry.createdAt > CACHE_TTL_MS) diffCache.delete(token);
  }
  while (diffCache.size > CACHE_LIMIT) {
    diffCache.delete(diffCache.keys().next().value);
  }
}

function targetFor(message, snapshot) {
  const entry = snapshot.groups[message.group]
    ?.find((item) => item.path === message.path);
  if (!entry) {
    throw operationError('target_changed', 'The selected file no longer has that Git status.');
  }
  return entry;
}

function pathspecs(entry) {
  return entry.status === 'renamed' && entry.previousPath
    ? [entry.path, entry.previousPath]
    : [entry.path];
}

async function untrackedDiff(context, entry, options) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentpeek-diff-'));
  const emptyPath = path.join(tempDir, 'empty');
  fs.writeFileSync(emptyPath, '');
  try {
    const result = await (options.runGit || runGit)([
      '--no-optional-locks',
      '-C', context.projectPath,
      'diff',
      '--no-index',
      '--no-ext-diff',
      '--no-color',
      '--',
      emptyPath,
      entry.path,
    ], {
      allowedExitCodes: [0, 1],
      maxStdoutBytes: 10 * 1024 * 1024,
      timeoutMs: 30_000,
    });
    const lines = result.stdout.toString('utf8').split('\n');
    const diffLine = lines.findIndex((line) => line.startsWith('diff --git '));
    if (diffLine >= 0) {
      lines[diffLine] = `diff --git a/${entry.path} b/${entry.path}`;
      if (!lines[diffLine + 1]?.startsWith('new file mode ')) {
        lines.splice(diffLine + 1, 0, 'new file mode 100644');
      }
    }
    const oldHeader = lines.findIndex((line) => line.startsWith('--- '));
    const newHeader = lines.findIndex((line) => line.startsWith('+++ '));
    if (oldHeader >= 0) lines[oldHeader] = '--- /dev/null';
    if (newHeader >= 0) lines[newHeader] = `+++ b/${entry.path}`;
    return limitedDiff(Buffer.from(lines.join('\n'), 'utf8'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function trackedDiff(context, entry, group, options) {
  const groupArgs = group === 'staged'
    ? ['--cached']
    : (group === 'conflicts' ? ['--cc'] : []);
  const result = await (options.runGit || runGit)([
    '--no-optional-locks',
    '-C', context.projectPath,
    'diff',
    ...groupArgs,
    '--no-ext-diff',
    '--no-color',
    '--',
    ...pathspecs(entry),
  ], {
    maxStdoutBytes: 10 * 1024 * 1024,
    timeoutMs: 30_000,
  });
  return limitedDiff(result.stdout);
}

async function commitDiff(message, options) {
  const listing = await readCommitFiles(message, options);
  const entry = listing.files.find((file) => file.path === message.path);
  if (!entry) throw operationError('target_changed', 'That file is not part of this commit.');
  const result = await (options.runGit || runGit)([
    '--no-optional-locks',
    '--literal-pathspecs',
    '-C', listing.context.projectPath,
    'diff-tree',
    '-p',
    '-M',
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    '--no-commit-id',
    '--relative',
    ...commitRange(listing.target),
    '--',
    ...(entry.previousPath ? [entry.path, entry.previousPath] : [entry.path]),
  ], {
    maxStdoutBytes: 10 * 1024 * 1024,
    timeoutMs: 30_000,
  });
  return limitedDiff(result.stdout);
}

function limitedDiff(buffer) {
  if (buffer.length <= MAX_DIFF_BYTES) {
    return { text: buffer.toString('utf8'), truncated: false };
  }
  let limited = buffer.subarray(0, MAX_DIFF_BYTES).toString('utf8');
  const newline = limited.lastIndexOf('\n');
  if (newline > 0) limited = limited.slice(0, newline + 1);
  return { text: limited, truncated: true };
}

function createEntry(message, diff) {
  const base = {
    action: 'git_status',
    operation: 'diff',
    requestId: message.requestId,
    ok: true,
    diffToken: 'x'.repeat(36),
    cursor: '19',
    chunkCount: 8,
    complete: false,
    nextCursor: '20',
    diffComplete: false,
    truncated: false,
    ...(message.replyConnectionId
      ? { replyConnectionId: message.replyConnectionId }
      : {}),
  };
  const chunks = splitTextToFrames(diff.text, base);
  const maxFrames = FRAMES_PER_PAGE * MAX_PAGES;
  const truncated = diff.truncated || chunks.length > maxFrames;
  const retained = chunks.slice(0, maxFrames);
  const pages = [];
  for (let offset = 0; offset < retained.length; offset += FRAMES_PER_PAGE) {
    pages.push(retained.slice(offset, offset + FRAMES_PER_PAGE));
  }
  if (!pages.length) pages.push(['']);
  const token = crypto.randomUUID();
  return {
    token,
    projectHash: message.projectHash,
    path: message.path,
    group: message.group,
    commitOid: message.commitOid || '',
    pages,
    truncated,
    createdAt: Date.now(),
  };
}

function pageFrames(message, entry, cursor) {
  const page = entry.pages[cursor];
  if (!page) throw operationError('diff_expired', 'Diff page is unavailable.');
  const lastPage = cursor === entry.pages.length - 1;
  return page.map((content, sequence) => ({
    action: 'git_status',
    operation: 'diff',
    requestId: message.requestId,
    ok: true,
    sequence,
    chunkCount: page.length,
    complete: sequence === page.length - 1,
    diffToken: entry.token,
    cursor: String(cursor),
    nextCursor: lastPage ? '' : String(cursor + 1),
    diffComplete: lastPage,
    truncated: entry.truncated,
    content,
    ...(message.replyConnectionId
      ? { replyConnectionId: message.replyConnectionId }
      : {}),
  }));
}

export async function gitDiffFrames(message, options = {}) {
  pruneCache();
  if (message.diffToken) {
    const cached = diffCache.get(message.diffToken);
    if (!cached
      || cached.projectHash !== message.projectHash
      || cached.path !== message.path
      || cached.group !== message.group
      || cached.commitOid !== (message.commitOid || '')) {
      throw operationError('diff_expired', 'Diff has expired. Reload the file.');
    }
    return pageFrames(message, cached, Number.parseInt(message.cursor || '0', 10));
  }
  let diff;
  if (message.commitOid) {
    diff = await commitDiff(message, options);
  } else {
    const snapshot = await readGitSnapshot(message.projectHash, options);
    const entry = targetFor(message, snapshot);
    diff = entry.status === 'untracked'
      ? await untrackedDiff(snapshot.context, entry, options)
      : await trackedDiff(snapshot.context, entry, message.group, options);
  }
  const cached = createEntry(message, diff);
  diffCache.set(cached.token, cached);
  pruneCache();
  return pageFrames(message, cached, 0);
}

export function clearDiffCache() {
  diffCache.clear();
}
