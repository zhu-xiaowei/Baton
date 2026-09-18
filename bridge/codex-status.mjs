import { codexArchiveRecord } from './codex-archive-index.mjs';

export function nativeCodexStatus(status, managed) {
  if (status?.type === 'active') {
    if (!Array.isArray(status.activeFlags)) return '';
    return status.activeFlags.some((flag) => (
      flag === 'waitingOnApproval' || flag === 'waitingOnUserInput'
    )) ? 'needs_input' : 'running';
  }
  // An independent stdio reader cannot establish another client's inactivity.
  return managed && status?.type === 'idle' ? 'completed' : '';
}

export function observeCodexStatus(previous, status, managed, now = Date.now()) {
  const runtimeStatus = nativeCodexStatus(status, managed);
  if (!runtimeStatus) return {
    runtimeStatus: previous?.runtimeStatus,
    statusVersion: previous?.statusVersion,
    statusObservedAt: previous?.statusObservedAt,
  };
  return {
    runtimeStatus,
    statusVersion: previous?.runtimeStatus === runtimeStatus && !previous?.statusReobserve
      ? previous.statusVersion : Math.max(now, (previous?.statusVersion || 0) + 1),
    statusObservedAt: now,
  };
}

export function codexSessionStatus(id, fallback, filePath, terminalAt = 0) {
  const record = codexArchiveRecord(id, filePath);
  if (record?.runtimeStatus && record.status?.type === 'notLoaded'
    && terminalAt > record.statusObservedAt) {
    rememberCodexStatus(id, 'completed', filePath, terminalAt);
  }
  return record?.runtimeStatus && record.statusVersion
    ? { status: record.runtimeStatus, statusVersion: record.statusVersion }
    : { status: fallback };
}

export function rememberCodexStatus(id, status, filePath, observedAt = Date.now()) {
  const record = codexArchiveRecord(id, filePath);
  if (!record) return {};
  record.runtimeStatus = status;
  record.statusVersion = Math.max(Date.now(), (record.statusVersion || 0) + 1);
  record.statusObservedAt = observedAt;
  return { statusVersion: record.statusVersion };
}
