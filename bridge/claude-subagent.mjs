import fs from 'fs';
import path from 'path';
import { CLAUDE_PROJECTS } from './config.mjs';
import { countJsonlLines } from './extract.mjs';
import { getSessionMetadata } from './session.mjs';

const MARKER = ':subagent:';
// A subagent transcript never records its closing turn (the summary is written to
// the parent), so its own tail stays non-terminal (user/tool_result) forever and
// only means "running" while the file is still being written. Same 5min staleness
// window getSessionStatus() applies to root sessions.
const SUBAGENT_FRESH_MS = 15_000;
const SUBAGENT_STALE_MS = 300_000;

export function claudeSubagentSessionId(parentSessionId, agentId) {
  return `${parentSessionId}${MARKER}${agentId}`;
}

export function claudeSubagentParentSessionId(rootSessionId, meta = {}) {
  const parentAgentId = String(meta.parentAgentId || '').trim();
  if (!parentAgentId) return rootSessionId;
  const normalizedParentId = parentAgentId.startsWith('agent-')
    ? parentAgentId
    : `agent-${parentAgentId}`;
  return claudeSubagentSessionId(rootSessionId, normalizedParentId);
}

export function parseClaudeSubagentSessionId(sessionId) {
  const value = String(sessionId || '');
  const index = value.indexOf(MARKER);
  if (index <= 0) return null;
  return {
    parentSessionId: value.slice(0, index),
    agentId: value.slice(index + MARKER.length),
  };
}

export function readClaudeSubagentMeta(filePath) {
  const metaPath = filePath.replace(/\.jsonl$/, '.meta.json');
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    return {};
  }
}

// `finished` is authoritative when the running CC version writes it: a long silent
// Bash/model request must stay running past both windows. Older versions omit it,
// so the windows remain the fallback.
export function claudeSubagentStatus(tailStatus, idleMs, parentActive, finished) {
  if (finished === true) return 'completed';
  if (finished === false) return tailStatus || 'running';
  const active = idleMs < SUBAGENT_FRESH_MS
    || (parentActive && idleMs < SUBAGENT_STALE_MS);
  if (active) return tailStatus || 'running';
  return tailStatus === 'needs_input' ? 'needs_input' : 'completed';
}

export function discoverClaudeSubagents(projectDir, parentSession, options = {}) {
  const subagentsDir = path.join(
    projectDir,
    parentSession.nativeSessionId,
    'subagents',
  );
  let files;
  try {
    files = fs.readdirSync(subagentsDir)
      .filter((file) => file.endsWith('.jsonl') && file.startsWith('agent-'));
  } catch {
    return [];
  }
  const now = options.now ?? Date.now();
  return files.flatMap((file) => {
    const filePath = path.join(subagentsDir, file);
    let stat;
    try {
      stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size === 0) return [];
    } catch {
      return [];
    }
    const agentId = file.slice(0, -'.jsonl'.length);
    const meta = readClaudeSubagentMeta(filePath);
    const metadata = getSessionMetadata(filePath, { includeStatus: true });
    return [{
      id: claudeSubagentSessionId(parentSession.nativeSessionId, agentId),
      nativeSessionId: claudeSubagentSessionId(
        parentSession.nativeSessionId,
        agentId,
      ),
      runtime: 'claude',
      project: parentSession.project,
      projectName: parentSession.projectName,
      lastActive: stat.mtime.toISOString(),
      size: stat.size,
      preview: meta.description || metadata.preview || agentId,
      model: metadata.model || parentSession.model,
      status: claudeSubagentStatus(
        metadata.status,
        now - stat.mtimeMs,
        options.parentRunning || parentSession.status === 'running',
        meta.finished,
      ),
      isAgent: true,
      threadKind: 'subagent',
      parentSessionId: claudeSubagentParentSessionId(
        parentSession.nativeSessionId,
        meta,
      ),
      agentName: meta.description || meta.agentType || agentId,
      agentPath: agentId,
      agentDepth: Number.isInteger(meta.spawnDepth) ? meta.spawnDepth : 1,
      canSend: false,
      _filePath: filePath,
      _lineCount: metadata.lineCount ?? countJsonlLines(filePath),
    }];
  });
}

export function findClaudeSubagentFile(sessionId, projectsRoot = CLAUDE_PROJECTS) {
  const parsed = parseClaudeSubagentSessionId(sessionId);
  if (!parsed || !fs.existsSync(projectsRoot)) return null;
  for (const project of fs.readdirSync(projectsRoot)) {
    const candidate = path.join(
      projectsRoot,
      project,
      parsed.parentSessionId,
      'subagents',
      `${parsed.agentId}.jsonl`,
    );
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}
