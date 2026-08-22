import { storageSessionId } from './session-identity.mjs';

const parentChildren = new Map();
const childParents = new Map();
const childStatuses = new Map();
const parentProjects = new Map();
const rootStatuses = new Map();

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

function summaryForRoot(rootSessionId) {
  let agentCount = 0;
  let runningAgentCount = 0;
  let needsInputAgentCount = 0;
  for (const childSessionId of childParents.keys()) {
    if (rootFor(childSessionId) !== rootSessionId) continue;
    agentCount++;
    const status = childStatuses.get(childSessionId);
    if (status === 'running') runningAgentCount++;
    else if (status === 'needs_input') needsInputAgentCount++;
  }
  const mainStatus = normalizedStatus(rootStatuses.get(rootSessionId));
  const activeStatus = mainStatus === 'needs_input' || needsInputAgentCount > 0
    ? 'needs_input'
    : (mainStatus === 'running' || runningAgentCount > 0 ? 'running' : 'completed');
  return {
    agentCount,
    runningAgentCount,
    needsInputAgentCount,
    activeStatus,
  };
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

  for (const session of sessions) {
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
