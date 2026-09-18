import fs from 'fs';
import path from 'path';
import { codexSessionStatus } from './codex-status.mjs';
import { execSync } from 'child_process';
import { CLAUDE_PROJECTS, CODEX_STATUS_STALE_MS } from './config.mjs';
import { scanJsonlLines } from './jsonl.mjs';
import { resolveCodexHomes } from './runtime-capabilities.mjs';
import { projectHashFromCwd, storageSessionId } from './session-identity.mjs';
import { readableProjectName } from './session.mjs';
import { codexArchiveRecord, codexArchiveRecords, safeCodexArchivePath } from './codex-archive-index.mjs';

const UUID_AT_END = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const codexFileIndex = new Map();
export const CODEX_SESSION_INDEX = 'session_index.jsonl';

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

export function readCodexThreadNames(codexHome) {
  const names = new Map();
  const filePath = path.join(codexHome, CODEX_SESSION_INDEX);
  try {
    scanJsonlLines(filePath, (raw) => {
      if (!raw.trim()) return;
      let entry;
      try {
        entry = JSON.parse(raw);
      } catch {
        return;
      }
      const id = String(entry?.id || '');
      if (!id) return;
      const name = previewText(entry.thread_name);
      if (name) names.set(id, name);
      else names.delete(id);
    });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return names;
}

function isInside(filePath, root) {
  const relative = path.relative(root, filePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function codexHomeForSessionFile(filePath, homes) {
  return homes.find((home) => isInside(filePath, path.join(home, 'sessions'))) || '';
}

export function isCodexInternalUserContext(text) {
  const value = text.trim();
  const externalContext = /^<external_([^>]+)>[\s\S]*<\/external_\1>$/.test(value);
  return /^# AGENTS\.md instructions[\s\S]*<\/INSTRUCTIONS>$/i.test(value)
    || /^<environment_context>[\s\S]*<\/environment_context>$/i.test(value)
    || externalContext
    || /^<skill>[\s\S]*<\/skill>$/i.test(value)
    || /^<user_shell_command>[\s\S]*<\/user_shell_command>$/i.test(value)
    || /^<turn_aborted>[\s\S]*<\/turn_aborted>$/i.test(value)
    || /^<subagent_notification>[\s\S]*<\/subagent_notification>$/i.test(value)
    || /^<codex_internal_context source="[a-z][a-z0-9_]*">[\s\S]*<\/codex_internal_context>$/i
      .test(value)
    || /^<goal_context>[\s\S]*<\/goal_context>$/i.test(value)
    || /^<recommended_plugins>[\s\S]*<\/recommended_plugins>$/i.test(value)
    || value.startsWith(
      'Warning: The maximum number of unified exec processes you can keep open is',
    )
    || (
      value.startsWith('Warning: apply_patch was requested via ')
      && value.endsWith('Use the apply_patch tool instead of exec_command.')
    )
    || value.startsWith(
      'Warning: Your account was flagged for potentially high-risk cyber activity',
    );
}

function decodeXmlText(value) {
  return value.replace(
    /&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi,
    (entity, code) => {
      const named = {
        amp: '&',
        lt: '<',
        gt: '>',
        quot: '"',
        apos: "'",
      };
      const lower = code.toLowerCase();
      if (named[lower]) return named[lower];
      const radix = lower.startsWith('#x') ? 16 : 10;
      const digits = lower.slice(radix === 16 ? 2 : 1);
      const point = Number.parseInt(digits, radix);
      return Number.isFinite(point) && point >= 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : entity;
    },
  );
}

export function parseCodexHookPromptFragment(text) {
  const match = /^<hook_prompt hook_run_id="([^"]+)">([\s\S]*)<\/hook_prompt>$/
    .exec(String(text || '').trim());
  if (!match) return null;
  const hookRunId = decodeXmlText(match[1]).trim();
  if (!hookRunId) return null;
  return {
    text: decodeXmlText(match[2]),
    hookRunId,
  };
}

export function codexResponseHookPromptFragments(payload) {
  if (payload?.type !== 'message' || payload.role !== 'user' || !Array.isArray(payload.content)) {
    return [];
  }
  const fragments = [];
  for (const block of payload.content) {
    if (block?.type !== 'input_text' || typeof block.text !== 'string') return [];
    const fragment = parseCodexHookPromptFragment(block.text);
    if (fragment) {
      fragments.push(fragment);
      continue;
    }
    if (!isCodexInternalUserContext(block.text)) return [];
  }
  return fragments;
}

export function isCodexContextualUserText(text) {
  return isCodexInternalUserContext(text) || !!parseCodexHookPromptFragment(text);
}

export function codexResponseUserText(payload) {
  if (payload?.type !== 'message' || payload.role !== 'user' || !Array.isArray(payload.content)) {
    return '';
  }
  const texts = payload.content
    .filter((block) => block?.type === 'input_text' && typeof block.text === 'string')
    .map((block) => block.text.trim());
  if (texts.some(isCodexContextualUserText)) return '';
  return texts
    .filter(Boolean)
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
  let activeTurnId = '';
  let terminalAt = 0;
  const eventPreviews = [];
  const responsePreviews = [];
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
      if (entry.type === 'response_item') {
        const candidate = previewText(codexResponseUserText(payload));
        if (candidate && !responsePreviews.includes(candidate)) responsePreviews.push(candidate);
      }
      if (entry.type !== 'event_msg') return;
      if (payload.type === 'user_message') {
        const candidate = previewText(payload.message);
        if (candidate && !eventPreviews.includes(candidate)) eventPreviews.push(candidate);
      }
      if (payload.type === 'task_started' && payload.turn_id) {
        activeTurnId = payload.turn_id;
      }
      if ((payload.type === 'task_complete' || payload.type === 'turn_aborted')
        && payload.turn_id === activeTurnId) {
        activeTurnId = '';
        terminalAt = Date.parse(entry.timestamp) || 0;
      }
    });
  } catch (error) {
    return { session: null, malformedLines, reason: 'unreadable', error };
  }

  const trailingMalformed = lastMalformedLine === lineCount - 1;
  const meta = matchingMetadata || (metadataCount === 1 ? onlyMetadata : null);
  if (!meta?.cwd) {
    return { session: null, malformedLines, trailingMalformed, reason: 'missing_metadata' };
  }

  const project = projectHashFromCwd(String(meta.cwd), options.claudeProjectsRoot || CLAUDE_PROJECTS);
  if (!project) return { session: null, malformedLines, trailingMalformed, reason: 'missing_project' };
  const parentNativeSessionId = String(
    meta.parent_thread_id || meta.forked_from_id || '',
  );
  const structuredSubagent = meta.source && typeof meta.source === 'object'
    ? meta.source.subagent
    : undefined;
  const spawn = structuredSubagent?.thread_spawn || {};
  // Structured non-spawn sources (guardian/review/compact/etc.) are Codex
  // implementation threads, not user-switchable agents. Legacy rollouts did
  // not have a structured source, so keep their parented threads visible.
  const visibleSubagent = !!parentNativeSessionId
    && (structuredSubagent === undefined || !!structuredSubagent?.thread_spawn);
  const agentPath = String(meta.agent_path || spawn.agent_path || '');
  const agentName = String(
    meta.agent_nickname
    || spawn.agent_nickname
    || '',
  );
  const agentRole = String(
    meta.agent_role
    || meta.agent_type
    || spawn.agent_role
    || spawn.agent_type
    || '',
  );
  const prompts = [...eventPreviews];
  for (const candidate of responsePreviews) {
    if (!prompts.includes(candidate)) prompts.push(candidate);
  }
  const pathTitle = previewText(
    agentPath.split('/').filter(Boolean).pop()?.replace(/[_-]+/g, ' ') || '',
  );
  const threadName = previewText(options.threadName);
  const preview = threadName || (visibleSubagent
    ? (prompts[1] || pathTitle || prompts[0] || '')
    : (prompts[0] || ''));
  if (!preview) return { session: null, malformedLines, trailingMalformed, reason: 'no_user_message' };

  const processInfoKnown = options.runningInfo !== undefined;
  const runningInfo = options.runningInfo || { projects: new Set(), sessions: new Set() };
  const now = options.now ?? Date.now();
  const staleMs = options.staleMs ?? CODEX_STATUS_STALE_MS;
  const isFresh = now - stat.mtimeMs <= staleMs;
  const exactProcess = runningInfo.sessions.has(nativeSessionId);
  const sameProjectProcess = runningInfo.projects.has(project);
  const isRunning = !!activeTurnId && (
    options.runtimeOwned === true
    || exactProcess
    // Normal watcher appends intentionally avoid a ps/lsof scan. When process
    // info is available (startup + stale recheck), project-level evidence is
    // only valid while the rollout is fresh.
    || (isFresh && (!processInfoKnown || sameProjectProcess))
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
      clientSource: String(
        meta.originator
        || (typeof meta.source === 'string' ? meta.source : '')
        || meta.thread_source
        || '',
      ),
      cliVersion: String(meta.cli_version || ''),
      ...codexSessionStatus(nativeSessionId, isRunning ? 'running' : 'completed', filePath, activeTurnId ? 0 : terminalAt),
      archiveState: codexArchiveRecord(nativeSessionId, filePath)?.archiveState || 'unknown',
      archiveVersion: codexArchiveRecord(nativeSessionId, filePath)?.archiveVersion || 0,
      ...(parentNativeSessionId ? {
        isAgent: visibleSubagent,
        threadKind: visibleSubagent ? 'subagent' : 'internal',
        parentSessionId: storageSessionId('codex', parentNativeSessionId),
        agentName,
        agentRole,
        agentPath,
        agentDepth: Number.isInteger(spawn.depth) ? spawn.depth : 1,
        canSend: visibleSubagent,
      } : {}),
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
  const threadNames = new Map();
  for (const home of homes) {
    const homeFiles = [];
    walkJsonl(path.join(home, 'sessions'), homeFiles, errors);
    for (const record of codexArchiveRecords()) {
      if (record.home !== path.resolve(home)) continue;
      const filePath = safeCodexArchivePath(home, record.path);
      if (filePath && !homeFiles.includes(filePath)) homeFiles.push(filePath);
    }
    for (const filePath of homeFiles) files.push({ filePath, home });
    try {
      threadNames.set(home, readCodexThreadNames(home));
    } catch (error) {
      errors.push({ path: path.join(home, CODEX_SESSION_INDEX), error: error.message });
    }
  }

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

  for (const { filePath, home } of files) {
    const nativeSessionId = codexSessionIdFromPath(filePath);
    const result = scanCodexRollout(filePath, {
      ...options,
      runningInfo,
      nativeSessionId,
      threadName: threadNames.get(home)?.get(nativeSessionId),
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
  const records = codexArchiveRecords().filter((record) => record.id === nativeSessionId
    && (!options.codexHomes || options.codexHomes.some((home) => path.resolve(home) === record.home)));
  if (records.length > 1) return null;
  const record = records[0];
  if (record) {
    const archivedPath = safeCodexArchivePath(record.home, record.path);
    if (archivedPath) return archivedPath;
  }
  if (!options.codexHomes) {
    const indexed = codexFileIndex.get(nativeSessionId);
    if (indexed && (!record || safeCodexArchivePath(record.home, indexed)) && fs.existsSync(indexed)) return indexed;
    codexFileIndex.delete(nativeSessionId);
  }
  const homes = record ? [record.home] : (options.codexHomes || resolveCodexHomes());
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

export function inspectCodexSession(nativeSessionId, options = {}) {
  const filePath = options.filePath || findCodexSessionFile(nativeSessionId, options);
  if (!filePath) return null;
  let threadName = options.threadName;
  if (threadName === undefined) {
    const homes = options.codexHomes || resolveCodexHomes();
    const home = codexHomeForSessionFile(filePath, homes);
    if (home) {
      try {
        threadName = readCodexThreadNames(home).get(nativeSessionId);
      } catch {}
    }
  }
  return scanCodexRollout(filePath, {
    ...options,
    nativeSessionId,
    threadName,
  }).session;
}
