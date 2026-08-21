import { storageSessionId } from './session-identity.mjs';

const parentChildren = new Map();
const childParents = new Map();
const parentProjects = new Map();

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

function descendantCount(rootSessionId) {
  let count = 0;
  for (const childSessionId of childParents.keys()) {
    if (rootFor(childSessionId) === rootSessionId) count++;
  }
  return count;
}

function countUpdate(rootSessionId, fallbackProject = '') {
  return {
    sessionId: rootSessionId,
    project: parentProjects.get(rootSessionId) || fallbackProject,
    agentCount: descendantCount(rootSessionId),
  };
}

export function rebuildAgentCounts(sessions) {
  parentChildren.clear();
  childParents.clear();
  parentProjects.clear();

  for (const session of sessions) {
    if (session.parentSessionId) continue;
    parentProjects.set(sessionStorageId(session), session.project || '');
  }
  for (const session of sessions) {
    const parentSessionId = visibleParent(session);
    if (!parentSessionId) continue;
    const childSessionId = sessionStorageId(session);
    childrenFor(parentSessionId).add(childSessionId);
    childParents.set(childSessionId, parentSessionId);
  }
  for (const session of sessions) {
    const sessionId = sessionStorageId(session);
    if (!session.parentSessionId) {
      session.threadRootId = sessionId;
      session.agentCount = descendantCount(sessionId);
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
    session.threadRootId = sessionId;
    session.agentCount = descendantCount(sessionId);
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

  if (nextParent) {
    childrenFor(nextParent).add(sessionId);
    childParents.set(sessionId, nextParent);
  }

  const nextRoot = nextParent ? rootFor(sessionId) : '';
  session.threadRootId = nextRoot;
  return Array.from(new Set([previousRoot, nextRoot].filter((rootSessionId) =>
    rootSessionId && parentProjects.has(rootSessionId))))
    .map((rootSessionId) => countUpdate(rootSessionId, session.project || ''));
}
