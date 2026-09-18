import { storageSessionId } from './session-identity.mjs';

const parentChildren = new Map();
const childParents = new Map();
const childStatuses = new Map();
const parentProjects = new Map();
const rootStatuses = new Map();
const statusVersions = new Map();
const archiveStates = new Map();
const summaries = new Map();

function sessionStorageId(session) {
  return storageSessionId(
    session.runtime || 'claude',
    session.nativeSessionId || session.id,
  );
}

function visibleParent(session) {
  return session.threadKind === 'subagent' && session.parentSessionId
    ? session.parentSessionId
    : '';
}

function childrenFor(parentSessionId) {
  let children = parentChildren.get(parentSessionId);
  if (!children) {
    children = new Set();
    parentChildren.set(parentSessionId, children);
  }
  return children;
}

function rootFor(sessionId) {
  let current = sessionId;
  const seen = new Set();
  while (childParents.has(current) && !seen.has(current)) {
    seen.add(current);
    current = childParents.get(current);
  }
  return current;
}

function normalizedStatus(status) {
  return status === 'running' || status === 'needs_input' ? status : 'completed';
}

function archivedAncestor(sessionId) {
  const seen = new Set();
  while (sessionId && !seen.has(sessionId)) {
    if (archiveStates.get(sessionId)?.state === 'archived') return true;
    seen.add(sessionId);
    sessionId = childParents.get(sessionId);
  }
  return false;
}

function trackObservations(session, id) {
  const version = statusVersions.get(id) || 0;
  if (version > (session.statusVersion || 0)) {
    session.status = childStatuses.get(id) || rootStatuses.get(id) || session.status;
    session.statusVersion = version;
  } else if (session.statusVersion) statusVersions.set(id, session.statusVersion);
  const previous = archiveStates.get(id);
  if (!previous || (session.archiveVersion || 0) >= previous.version) {
    archiveStates.set(id, { state: session.archiveState, version: session.archiveVersion || 0 });
  }
}

function summaryForRoot(rootSessionId) {
  let observedVersion = Math.max(statusVersions.get(rootSessionId) || 0, archiveStates.get(rootSessionId)?.version || 0);
  let agentCount = 0;
  let runningAgentCount = 0;
  let needsInputAgentCount = 0;
  for (const childSessionId of childParents.keys()) {
    if (rootFor(childSessionId) !== rootSessionId) continue;
    agentCount++;
    observedVersion = Math.max(observedVersion, statusVersions.get(childSessionId) || 0, archiveStates.get(childSessionId)?.version || 0);
    if (archivedAncestor(childSessionId)) continue;
    const status = childStatuses.get(childSessionId);
    if (status === 'running') runningAgentCount++;
    else if (status === 'needs_input') needsInputAgentCount++;
  }
  const mainStatus = normalizedStatus(rootStatuses.get(rootSessionId));
  const activeStatus = mainStatus === 'needs_input' || needsInputAgentCount > 0
    ? 'needs_input'
    : (mainStatus === 'running' || runningAgentCount > 0 ? 'running' : 'completed');
  const summary = {
    agentCount,
    runningAgentCount,
    needsInputAgentCount,
    activeStatus,
  };
  if (observedVersion) {
    const signature = JSON.stringify(summary);
    const previous = summaries.get(rootSessionId);
    const version = previous?.signature === signature
      ? Math.max(previous.version, observedVersion)
      : Math.max(Date.now(), observedVersion, (previous?.version || 0) + 1);
    summaries.set(rootSessionId, { signature, version });
    summary.agentSummaryVersion = version;
  }
  return summary;
}

function countUpdate(rootSessionId, fallbackProject = '') {
  const summary = summaryForRoot(rootSessionId);
  return {
    sessionId: rootSessionId,
    project: parentProjects.get(rootSessionId) || fallbackProject,
    ...summary,
  };
}

export function rebuildAgentCounts(sessions) {
  parentChildren.clear();
  childParents.clear();
  childStatuses.clear();
  parentProjects.clear();
  rootStatuses.clear();
  statusVersions.clear();
  archiveStates.clear();
  summaries.clear();

  for (const session of sessions) {
    trackObservations(session, sessionStorageId(session));
    if (session.parentSessionId) continue;
    const sessionId = sessionStorageId(session);
    parentProjects.set(sessionId, session.project || '');
    rootStatuses.set(sessionId, normalizedStatus(session.status));
  }
  for (const session of sessions) {
    const parentSessionId = visibleParent(session);
    if (!parentSessionId) continue;
    const childSessionId = sessionStorageId(session);
    childrenFor(parentSessionId).add(childSessionId);
    childParents.set(childSessionId, parentSessionId);
    childStatuses.set(childSessionId, normalizedStatus(session.status));
  }
  for (const session of sessions) {
    const sessionId = sessionStorageId(session);
    if (!session.parentSessionId) {
      session.threadRootId = sessionId;
      Object.assign(session, summaryForRoot(sessionId));
    } else {
      session.threadRootId = visibleParent(session) ? rootFor(sessionId) : '';
    }
  }
  return sessions;
}

export function trackAgentSession(session) {
  const sessionId = sessionStorageId(session);
  trackObservations(session, sessionId);
  if (!session.parentSessionId) {
    parentProjects.set(sessionId, session.project || '');
    rootStatuses.set(sessionId, normalizedStatus(session.status));
    session.threadRootId = sessionId;
    Object.assign(session, summaryForRoot(sessionId));
    return [];
  }

  const previousParent = childParents.get(sessionId) || '';
  const previousRoot = previousParent ? rootFor(sessionId) : '';
  const nextParent = visibleParent(session);
  if (previousParent) {
    const children = parentChildren.get(previousParent);
    children?.delete(sessionId);
    if (children && !children.size) parentChildren.delete(previousParent);
  }
  childParents.delete(sessionId);
  childStatuses.delete(sessionId);

  if (nextParent) {
    childrenFor(nextParent).add(sessionId);
    childParents.set(sessionId, nextParent);
    childStatuses.set(sessionId, normalizedStatus(session.status));
  }

  const nextRoot = nextParent ? rootFor(sessionId) : '';
  session.threadRootId = nextRoot;
  return Array.from(new Set([previousRoot, nextRoot].filter((rootSessionId) =>
    rootSessionId && parentProjects.has(rootSessionId))))
    .map((rootSessionId) => countUpdate(rootSessionId, session.project || ''));
}
