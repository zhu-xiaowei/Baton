import fs from 'fs';
import path from 'path';
import { CLAUDE_PROJECTS } from './config.mjs';
import { countJsonlLines } from './extract.mjs';
import { getSessionMetadata } from './session.mjs';

const MARKER = ':subagent:';
// CC reports every background agent's end to its spawner as a <task-notification>
// (completed/failed/killed/stopped), and a later SendMessage resume as resumedAgentId.
// A stopped agent never gets `finished:true`, and its tail can end on an unrun tool_use.
const TASK_EVENT = /<task-id>([0-9a-z]+)<\/task-id>|resumedAgentId\\*"\s*:\s*\\*"([0-9a-z]+)/g;
export const TASK_ID = /<task-id>([0-9a-z]+)<\/task-id>/g;
const taskScans = new Map(); // spawner transcript → { ino, offset, ended: taskId → bool }

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

function spawnerFile(filePath, meta) {
  const dir = path.dirname(filePath);
  const parentAgentId = String(meta.parentAgentId || '').trim();
  if (!parentAgentId) return `${path.dirname(dir)}.jsonl`;
  return path.join(dir, `${parentAgentId.startsWith('agent-') ? '' : 'agent-'}${parentAgentId}.jsonl`);
}

// Scans only bytes appended since the last call, up to the last complete line.
export function claudeSubagentEnded(filePath, meta = {}) {
  const file = spawnerFile(filePath, meta);
  const taskId = path.basename(filePath, '.jsonl').replace(/^agent-/, '');
  let stat;
  try { stat = fs.statSync(file); } catch { return false; }
  let scan = taskScans.get(file);
  if (!scan || scan.ino !== stat.ino || stat.size < scan.offset) {
    scan = { ino: stat.ino, offset: 0, ended: new Map() };
    taskScans.set(file, scan);
  }
  if (stat.size > scan.offset) {
    const buffer = Buffer.alloc(stat.size - scan.offset);
    let fd;
    let read = 0;
    try {
      fd = fs.openSync(file, 'r');
      read = fs.readSync(fd, buffer, 0, buffer.length, scan.offset);
    } catch {
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    const end = buffer.subarray(0, read).lastIndexOf(0x0a) + 1;
    for (const match of buffer.toString('utf8', 0, end).matchAll(TASK_EVENT)) {
      scan.ended.set(match[1] || match[2], !!match[1]);
    }
    scan.offset += end;
  }
  return scan.ended.get(taskId) === true;
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
    const fresh = now - stat.mtimeMs < 15_000;
    const status = meta.finished === true ? 'completed'
      : (parentSession.status === 'running' || fresh)
      ? (metadata.status || 'running')
      : 'completed';
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
      status: status !== 'completed' && claudeSubagentEnded(filePath, meta)
        ? 'completed'
        : status,
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
