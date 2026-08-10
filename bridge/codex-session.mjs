import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { CLAUDE_PROJECTS, CODEX_STATUS_STALE_MS } from './config.mjs';
import { scanJsonlLines } from './jsonl.mjs';
import { resolveCodexHomes } from './runtime-capabilities.mjs';
import { projectHashFromCwd } from './session-identity.mjs';
import { readableProjectName } from './session.mjs';

const UUID_AT_END = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const codexFileIndex = new Map();

export function codexSessionIdFromPath(filePath) {
  return UUID_AT_END.exec(path.basename(filePath))?.[1] || '';
}

function walkJsonl(dir, files, errors) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') errors.push({ path: dir, error: error.message });
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJsonl(fullPath, files, errors);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(fullPath);
  }
}

function previewText(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > 200 ? `${text.slice(0, 200).trim()}...` : text;
}

function isInternalUserContext(text) {
  return /^<(?:environment_context|turn_aborted)>[\s\S]*<\/(?:environment_context|turn_aborted)>$/i
    .test(text.trim());
}

export function codexResponseUserText(payload) {
  if (payload?.type !== 'message' || payload.role !== 'user' || !Array.isArray(payload.content)) {
    return '';
  }
  return payload.content
    .filter((block) => block?.type === 'input_text' && typeof block.text === 'string')
    .map((block) => block.text.trim())
    .filter((text) => text && !isInternalUserContext(text))
    .join('\n');
}

function metadataId(payload) {
  return String(payload?.id || payload?.session_id || '');
}

export function getCodexRunningInfo() {
  const projects = new Set();
  const sessions = new Set();
  if (process.platform === 'win32') return { projects, sessions };
  try {
    const lines = execSync('ps -axo pid=,command= 2>/dev/null', { encoding: 'utf-8' }).split('\n');
    for (const line of lines) {
      if (!/(?:^|[ /])codex(?:\s|$)/i.test(line) || line.includes('grep')) continue;
      const match = line.trim().match(/^(\d+)\s+([\s\S]+)$/);
      if (!match) continue;
      const pid = match[1];
      const command = match[2];
      const resume = command.match(/(?:resume|--resume)\s+([0-9a-f-]{36})/i);
      if (resume) sessions.add(resume[1]);
      try {
        const cwd = process.platform === 'darwin'
          ? execSync(`lsof -a -p ${pid} -d cwd -Fn 2>/dev/null`, { encoding: 'utf-8' })
            .split('\n').find((value) => value.startsWith('n'))?.slice(1)
          : fs.readlinkSync(`/proc/${pid}/cwd`);
        if (cwd) projects.add(projectHashFromCwd(cwd, CLAUDE_PROJECTS));
      } catch {}
    }
  } catch {}
  return { projects, sessions };
}

export function scanCodexRollout(filePath, options = {}) {
  const nativeSessionId = options.nativeSessionId || codexSessionIdFromPath(filePath);
  if (!nativeSessionId) return { session: null, malformedLines: 0, reason: 'invalid_filename' };

  let stat;
  try {
    stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return { session: null, malformedLines: 0, reason: 'empty' };
  } catch (error) {
    return { session: null, malformedLines: 0, reason: 'unreadable', error };
  }

  let metadataCount = 0;
  let onlyMetadata = null;
  let matchingMetadata = null;
  const openTurns = new Set();
  let eventPreview = '';
  let responsePreview = '';
  let model = '';
  let malformedLines = 0;
  let lastMalformedLine = -1;
  let lineCount = 0;

  try {
    lineCount = scanJsonlLines(filePath, (raw, index) => {
      if (!raw.trim()) return;
      let entry;
      try {
        entry = JSON.parse(raw);
      } catch {
        malformedLines++;
        lastMalformedLine = index;
        return;
      }
      const payload = entry.payload || {};
      if (entry.type === 'session_meta') {
        metadataCount++;
        onlyMetadata = payload;
        if (metadataId(payload) === nativeSessionId) matchingMetadata = payload;
      }
      if (entry.type === 'turn_context' && payload.model) model = String(payload.model);
      if (!responsePreview && entry.type === 'response_item') {
        responsePreview = previewText(codexResponseUserText(payload));
      }
      if (entry.type !== 'event_msg') return;
      if (!eventPreview && payload.type === 'user_message') {
        eventPreview = previewText(payload.message);
      }
      if (payload.type === 'task_started' && payload.turn_id) openTurns.add(payload.turn_id);
      if ((payload.type === 'task_complete' || payload.type === 'turn_aborted') && payload.turn_id) {
        openTurns.delete(payload.turn_id);
      }
    });
  } catch (error) {
    return { session: null, malformedLines, reason: 'unreadable', error };
  }

  const trailingMalformed = lastMalformedLine === lineCount - 1;
  const preview = eventPreview || responsePreview;
  if (!preview) return { session: null, malformedLines, trailingMalformed, reason: 'no_user_message' };
  const meta = matchingMetadata || (metadataCount === 1 ? onlyMetadata : null);
  if (!meta?.cwd) {
    return { session: null, malformedLines, trailingMalformed, reason: 'missing_metadata' };
  }

  const project = projectHashFromCwd(String(meta.cwd), options.claudeProjectsRoot || CLAUDE_PROJECTS);
  if (!project) return { session: null, malformedLines, trailingMalformed, reason: 'missing_project' };

  const runningInfo = options.runningInfo || { projects: new Set(), sessions: new Set() };
  const now = options.now ?? Date.now();
  const staleMs = options.staleMs ?? CODEX_STATUS_STALE_MS;
  const isFresh = now - stat.mtimeMs <= staleMs;
  const isRunning = openTurns.size > 0 && (
    isFresh
    || runningInfo.sessions.has(nativeSessionId)
    || runningInfo.projects.has(project)
  );

  return {
    session: {
      id: nativeSessionId,
      nativeSessionId,
      runtime: 'codex',
      project,
      projectName: readableProjectName(project),
      lastActive: stat.mtime.toISOString(),
      size: stat.size,
      preview,
      model,
      modelProvider: String(meta.model_provider || ''),
      clientSource: String(meta.originator || meta.source || meta.thread_source || ''),
      cliVersion: String(meta.cli_version || ''),
      status: isRunning ? 'running' : 'completed',
      _filePath: filePath,
      _lineCount: lineCount,
    },
    malformedLines,
    trailingMalformed,
    reason: '',
  };
}

export function discoverCodexSessions(options = {}) {
  const homes = options.codexHomes || resolveCodexHomes();
  const files = [];
  const errors = [];
  for (const home of homes) walkJsonl(path.join(home, 'sessions'), files, errors);

  const runningInfo = options.runningInfo || getCodexRunningInfo();
  const byId = new Map();
  const diagnostics = {
    homes: homes.length,
    files: files.length,
    malformedLines: 0,
    trailingMalformedFiles: 0,
    skipped: {},
    errors,
  };
  let complete = errors.length === 0;

  for (const filePath of files) {
    const result = scanCodexRollout(filePath, {
      ...options,
      runningInfo,
      nativeSessionId: codexSessionIdFromPath(filePath),
    });
    diagnostics.malformedLines += result.malformedLines || 0;
    if (result.trailingMalformed) diagnostics.trailingMalformedFiles++;
    if (!result.session) {
      const reason = result.reason || 'unknown';
      diagnostics.skipped[reason] = (diagnostics.skipped[reason] || 0) + 1;
      if (reason === 'unreadable' || reason === 'missing_metadata') complete = false;
      continue;
    }
    const existing = byId.get(result.session.nativeSessionId);
    if (!existing || result.session.lastActive > existing.lastActive) {
      byId.set(result.session.nativeSessionId, result.session);
    }
  }
  if (!options.codexHomes) {
    for (const session of byId.values()) {
      codexFileIndex.set(session.nativeSessionId, session._filePath);
    }
  }

  return {
    sessions: Array.from(byId.values()),
    complete,
    diagnostics,
  };
}

export function findCodexSessionFile(nativeSessionId, options = {}) {
  if (!nativeSessionId) return null;
  if (!options.codexHomes) {
    const indexed = codexFileIndex.get(nativeSessionId);
    if (indexed && fs.existsSync(indexed)) return indexed;
    codexFileIndex.delete(nativeSessionId);
  }
  const homes = options.codexHomes || resolveCodexHomes();
  const files = [];
  const errors = [];
  for (const home of homes) walkJsonl(path.join(home, 'sessions'), files, errors);
  let best = null;
  let bestMtime = -1;
  for (const filePath of files) {
    if (codexSessionIdFromPath(filePath) !== nativeSessionId) continue;
    try {
      const mtime = fs.statSync(filePath).mtimeMs;
      if (mtime > bestMtime) {
        best = filePath;
        bestMtime = mtime;
      }
    } catch {}
  }
  if (best && !options.codexHomes) codexFileIndex.set(nativeSessionId, best);
  return best;
}
