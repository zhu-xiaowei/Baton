import { operationError } from './git-command.mjs';
import { gitDiffFrames } from './git-diff.mjs';
import { readCommitFiles, readHistory, readRefList } from './git-history.mjs';
import { mutateGit } from './git-mutations.mjs';
import { readGitSnapshot, snapshotFrames } from './git-status.mjs';
import { commitGit, pushGit } from './git-write.mjs';
import { listFrames } from './ws-frames.mjs';

const OPERATIONS = new Set([
  'status', 'stage', 'unstage', 'discard', 'diff',
  'refs', 'history', 'commit_files', 'commit', 'push',
]);

function envelope(message, extra = {}) {
  return {
    action: 'git_status',
    operation: message.operation,
    requestId: message.requestId,
    ...(message.replyConnectionId
      ? { replyConnectionId: message.replyConnectionId }
      : {}),
    ...extra,
  };
}

function errorEnvelope(message, error) {
  return envelope(message, {
    ok: false,
    sequence: 0,
    chunkCount: 1,
    complete: true,
    errorCode: error?.errorCode || 'git_failed',
    error: error?.message || 'Git operation failed.',
  });
}

function sendSnapshot(message, snapshot, send, extra = {}) {
  const frames = snapshotFrames(snapshot, envelope(message, {
    ...(snapshot.commit ? { commit: snapshot.commit } : {}),
    ...(snapshot.push ? { push: snapshot.push } : {}),
    ok: extra.ok !== false,
    ...(extra.errorCode ? {
      errorCode: extra.errorCode,
      error: extra.error,
    } : {}),
  }));
  frames.forEach(send);
}

export async function handleGitStatusMessage(message, options = {}) {
  const send = options.send;
  if (typeof send !== 'function') throw new TypeError('send is required');
  try {
    if (!OPERATIONS.has(message.operation)) {
      throw operationError('invalid_request', 'Unsupported Git operation.');
    }
    if (message.operation === 'status') {
      sendSnapshot(
        message,
        await readGitSnapshot(message.projectHash, options),
        send,
      );
      return;
    }
    if (message.operation === 'diff') {
      const frames = await gitDiffFrames(message, options);
      frames.forEach(send);
      return;
    }
    if (message.operation === 'refs') {
      listFrames(envelope(message, { ok: true }), 'refs', await readRefList(message, options)).forEach(send);
      return;
    }
    if (message.operation === 'history') {
      const page = await readHistory(message, options);
      listFrames(envelope(message, { ok: true, heads: page.heads, hasMore: page.hasMore }), 'commits', page.commits)
        .forEach(send);
      return;
    }
    if (message.operation === 'commit_files') {
      const entry = await readCommitFiles(message, options);
      listFrames(envelope(message, {
        ok: true,
        commitOid: entry.commitOid,
        baseOid: entry.baseOid,
        merge: entry.merge,
        truncated: entry.truncated,
      }), 'files', entry.files).forEach(send);
      return;
    }
    if (message.operation === 'commit') {
      sendSnapshot(message, await commitGit(message, options), send);
      return;
    }
    if (message.operation === 'push') {
      sendSnapshot(message, await pushGit(message, options), send);
      return;
    }
    sendSnapshot(message, await mutateGit(message, options), send);
  } catch (error) {
    if (error?.snapshot) {
      sendSnapshot(message, error.snapshot, send, {
        ok: false,
        errorCode: error.errorCode,
        error: error.message,
      });
      return;
    }
    send(errorEnvelope(message, error));
  }
}
