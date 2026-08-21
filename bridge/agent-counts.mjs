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

function countUpdate(parentSessionId, fallbackProject = '') {
  return {
    sessionId: parentSessionId,
    project: parentProjects.get(parentSessionId) || fallbackProject,
    agentCount: parentChildren.get(parentSessionId)?.size || 0,
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
    if (!parentProjects.has(parentSessionId)) {
      parentProjects.set(parentSessionId, session.project || '');
    }
  }
  for (const session of sessions) {
    if (session.parentSessionId) continue;
    session.agentCount = parentChildren.get(sessionStorageId(session))?.size || 0;
  }
  return sessions;
}

export function trackAgentSession(session) {
  const sessionId = sessionStorageId(session);
  if (!session.parentSessionId) {
    parentProjects.set(sessionId, session.project || '');
    session.agentCount = parentChildren.get(sessionId)?.size || 0;
    return [];
  }

  const previousParent = childParents.get(sessionId) || '';
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
    if (!parentProjects.has(nextParent)) {
      parentProjects.set(nextParent, session.project || '');
    }
  }

  return Array.from(new Set([previousParent, nextParent].filter(Boolean)))
    .map((parentSessionId) => countUpdate(parentSessionId, session.project || ''));
}
