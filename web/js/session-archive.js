import { state } from './state.js';

const observations = new Map();
const pending = new Map();
let dialog = null;
let callbacks = {};

export function archiveOperationInProgress() {
  return !!dialog?.busy;
}

export function archiveReadOnly(thread, root) {
  return thread?.archiveState === 'archived' || thread?.rootArchiveState === 'archived'
    || root?.archiveState === 'archived';
}

export function archiveSelectionReason(items, capability, online, archived) {
  if (!items.length) return 'Select a session.';
  if (items.some((item) => !item?.sessionId?.startsWith('codex:'))) return 'Only Codex sessions support archiving.';
  if (!online) return 'Bridge offline — reconnect before changing archive state.';
  if (!(archived ? capability?.canArchive : capability?.canUnarchive)) return 'Update Codex and the Bridge to enable archiving.';
  if (archived && items.some((item) => ['running', 'needs_input'].includes(item.status))) {
    return 'A session or subagent is still active.';
  }
  return '';
}

export function mergeArchiveObservation(previous, next) {
  if (!next?.archiveState || (previous?.archiveVersion || 0) > (next.archiveVersion || 0)) return previous || {};
  return { archiveState: next.archiveState, archiveVersion: next.archiveVersion || 0 };
}

function key(sessionId, device = state.appState.device, project = state.appState.project?.hash) {
  return JSON.stringify([device, project, sessionId]);
}

export function archiveInfo(sessionId) {
  return observations.get(key(sessionId)) || {};
}

export function rememberArchiveMetadata(item, sessionId = item?.sessionId, device, project) {
  if (!sessionId || !item) return;
  const identity = key(sessionId, device, project);
  const previous = observations.get(identity);
  observations.delete(identity);
  observations.set(identity, {
    ...previous,
    ...mergeArchiveObservation(previous, item),
    ...(item.rootSessionId ? { rootSessionId: item.rootSessionId } : {}),
  });
  if (item.rootSessionId && item.rootSessionId !== sessionId && item.rootArchiveState) {
    rememberArchiveMetadata({
      archiveState: item.rootArchiveState, archiveVersion: item.rootArchiveVersion,
    }, item.rootSessionId, device, project);
  }
  const current = observations.get(identity);
  const rootId = current.rootSessionId || sessionId;
  const root = observations.get(key(rootId, device, project));
  const rootVersion = item.rootArchiveVersion ?? (rootId === sessionId ? item.archiveVersion : 0);
  // canSend includes archive restrictions, so both versions must be current.
  if (item.canSend !== undefined
    && (item.archiveVersion || 0) >= (current.archiveVersion || 0)
    && (rootVersion || 0) >= (root?.archiveVersion || 0)) {
    current.canSend = item.canSend !== false;
  }
  if (observations.size > 2000) observations.delete(observations.keys().next().value);
}

export function applyArchiveMetadata(item, sessionId) {
  rememberArchiveMetadata(item, sessionId);
  if (sessionId !== state.activeThreadId && sessionId !== state.wsSessionId) return;
  state.archiveMetadataReady = true;
  const canSend = archiveInfo(sessionId).canSend;
  if (canSend !== undefined) state.activeThreadCanSend = canSend;
  callbacks.refreshInput?.();
}

export function currentArchiveReadOnly() {
  const thread = archiveInfo(state.activeThreadId || state.appState.session);
  return archiveReadOnly(thread, archiveInfo(thread.rootSessionId || state.rootSessionId));
}

export function handleArchiveMessage(message) {
  if (message.action === 'set_session_archive_result') {
    const request = pending.get(message.requestId);
    if (!request || request.device !== message.deviceName || request.project !== message.projectHash) return;
    pending.delete(message.requestId);
    clearTimeout(request.timer);
    request.resolve(request.sessionIds.map((sessionId) => {
      const result = (message.results || []).find((item) => item.sessionId === sessionId);
      return result || { sessionId, ok: false, error: 'Result missing. Refresh before retrying.' };
    }));
    return;
  }
  if (message.action !== 'session_archives_changed') return;
  for (const change of message.changes || []) {
    rememberArchiveMetadata(change, change.sessionId, message.deviceName, change.projectHash);
  }
  callbacks.changed?.(message);
  if (message.deviceName === state.appState.device) callbacks.refreshInput?.();
}

async function requestArchive(options) {
  if (navigator.onLine === false || state.deviceOnlineMap[options.device] !== true) throw new Error('Bridge offline — no operation was queued.');
  await window.loadViewerLibs();
  window.connectWs();
  const deadline = Date.now() + 10_000;
  while (state.ws?.readyState !== 1) {
    if (Date.now() >= deadline || navigator.onLine === false) throw new Error('Connection unavailable — no operation was queued.');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (state.deviceOnlineMap[options.device] !== true || navigator.onLine === false) {
    throw new Error('Bridge offline — no operation was queued.');
  }
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('Confirmation timed out. Refresh to check native state before retrying.'));
    }, 180_000);
    pending.set(requestId, { resolve, timer, device: options.device, project: options.projectHash, sessionIds: options.sessionIds });
    try {
      state.ws.send(JSON.stringify({ action: 'set_session_archive', requestId, ...options }));
    } catch (error) {
      pending.delete(requestId);
      clearTimeout(timer);
      reject(error);
    }
  });
}

export function openArchiveDialog(items, archived) {
  const device = state.appState.device;
  const capability = state.deviceRuntimeCapabilities?.[device]?.codex || {};
  const reason = archiveSelectionReason(items, capability, state.deviceOnlineMap[device] === true && navigator.onLine !== false, archived);
  if (reason) return;
  const modal = document.getElementById('archiveModal');
  if (!modal) return;
  dialog = {
    device, projectHash: state.appState.project.hash, sessionIds: items.map((item) => item.sessionId),
    archived, previousFocus: document.activeElement, busy: false,
  };
  document.getElementById('archiveModalTitle').textContent = `${archived ? 'Archive' : 'Restore'} ${items.length} session${items.length === 1 ? '' : 's'}?`;
  document.getElementById('archiveModalDesc').textContent = archived
    ? 'Archives the native Codex session and attempts to archive its subagents. History is kept. Active sessions cannot be archived.'
    : 'Restores only the selected threads. Archived subagents stay archived until restored separately.';
  document.getElementById('archiveError').textContent = '';
  const button = document.getElementById('archiveConfirmBtn');
  button.textContent = archived ? 'Archive' : 'Restore';
  button.disabled = false;
  modal.style.display = 'flex';
  button.focus();
}

export function closeArchiveDialog() {
  if (dialog?.busy) return;
  const modal = document.getElementById('archiveModal');
  if (modal) modal.style.display = 'none';
  dialog?.previousFocus?.focus?.();
  dialog = null;
}

export async function submitArchive() {
  if (!dialog || dialog.busy) return;
  const operation = dialog;
  operation.busy = true;
  const button = document.getElementById('archiveConfirmBtn');
  const error = document.getElementById('archiveError');
  button.disabled = true;
  button.textContent = 'Working…';
  error.textContent = '';
  const results = [];
  try {
    for (let index = 0; index < operation.sessionIds.length; index += 25) {
      results.push(...await requestArchive({
        device: operation.device, projectHash: operation.projectHash,
        sessionIds: operation.sessionIds.slice(index, index + 25), archived: operation.archived,
      }));
    }
  } catch (cause) {
    const completed = new Set(results.map((result) => result.sessionId));
    results.push(...operation.sessionIds.filter((id) => !completed.has(id)).map((id) => ({
      sessionId: id, ok: false, error: cause.message,
    })));
  }
  operation.busy = false;
  try {
    await callbacks.results?.(operation, results);
  } catch (cause) {
    error.textContent = `Native results received. Refresh failed: ${cause.message}`;
  }
  const failed = results.filter((result) => !result.ok);
  const partial = results.filter((result) => result.partial?.length);
  if (!failed.length && !partial.length) {
    closeArchiveDialog();
    return;
  }
  error.textContent = results.filter((result) => !result.ok || result.partial?.length)
    .map((result) => `${result.sessionId.slice(-8)}: ${result.error || `${result.partial.length} subagent(s) could not be archived.`}`).join('\n');
  operation.sessionIds = failed.map((result) => result.sessionId);
  button.disabled = !failed.length;
  button.textContent = failed.length ? 'Retry failed' : 'Completed';
}

export function initSessionArchive(options) {
  callbacks = options;
  Object.assign(window, { closeArchiveDialog, submitArchive, handleArchiveMessage, applyArchiveMetadata });
  document.addEventListener('keydown', (event) => {
    if (!dialog) return;
    if (event.key === 'Escape') closeArchiveDialog();
    if (event.key !== 'Tab') return;
    const buttons = [...document.querySelectorAll('#archiveModal button:not(:disabled)')];
    const next = buttons[(buttons.indexOf(document.activeElement) + (event.shiftKey ? buttons.length - 1 : 1)) % buttons.length];
    if (next) { event.preventDefault(); next.focus(); }
  });
}
