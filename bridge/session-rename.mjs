import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ClaudePool } from './headless.mjs';
import { CodexAppServerClient } from './codex-app-server.mjs';
import { findCodexSessionFile, inspectCodexSession } from './codex-session.mjs';
import { resolveCodexHomes } from './runtime-capabilities.mjs';
import { parseStorageSessionId } from './session-identity.mjs';
import { findSessionFile, normalizeProjectHash, projectHashToPath } from './session.mjs';

const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function renameNativeSession(message, options = {}) {
  const identity = parseStorageSessionId(message.sessionId);
  const name = typeof message.name === 'string' ? message.name.trim() : '';
  if (!SESSION_UUID.test(identity.nativeSessionId)) throw new Error('Invalid session ID.');
  if (!name || name.length > 200 || /[\r\n\x00-\x1f\x7f]/.test(name)) {
    throw new Error('Enter a session name between 1 and 200 characters on one line.');
  }
  if (!message.projectHash) throw new Error('Project is required.');

  if (identity.runtime === 'claude') {
    const filePath = (options.findClaudeSessionFile || findSessionFile)(identity.nativeSessionId);
    if (!filePath || !fs.existsSync(filePath)) throw new Error('Session not found on this device.');
    if (normalizeProjectHash(path.basename(path.dirname(filePath))) !== message.projectHash) {
      throw new Error('Session does not belong to this project.');
    }
    const projectCwd = projectHashToPath(path.basename(path.dirname(filePath)));
    const cwd = projectCwd && fs.existsSync(projectCwd) ? projectCwd : os.homedir();
    const pool = options.claudePool || new ClaudePool();
    try {
      await pool.renameSession(identity.nativeSessionId, cwd, name);
    } finally {
      if (!options.claudePool) pool.shutdownAll();
    }
  } else if (identity.runtime === 'codex') {
    const homes = options.codexHomes || resolveCodexHomes();
    const filePath = findCodexSessionFile(identity.nativeSessionId, { codexHomes: homes });
    const session = filePath && inspectCodexSession(identity.nativeSessionId, { filePath, codexHomes: homes });
    if (!session) throw new Error('Session not found on this device.');
    if (session.project !== message.projectHash) throw new Error('Session does not belong to this project.');
    const home = homes.find((candidate) => {
      const relative = path.relative(path.join(candidate, 'sessions'), filePath);
      return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    });
    if (!home) throw new Error('Codex session home is unavailable.');
    const client = (options.createCodexClient || ((config) => new CodexAppServerClient(config)))({
      codexHomes: [home],
      env: { ...process.env, CODEX_HOME: home },
      requestTimeout: 15000,
    });
    try {
      await client.request('thread/name/set', { threadId: identity.nativeSessionId, name });
    } finally {
      await client.stop();
    }
  } else {
    throw new Error('This runtime does not support session renaming.');
  }
  return { sessionId: identity.sessionId, runtime: identity.runtime, name };
}

export async function handleSessionRename(message, { deviceName, post, send, rename = renameNativeSession }) {
  const reply = {
    action: 'rename_session',
    requestId: message.requestId,
    replyConnectionId: message.replyConnectionId,
    projectHash: message.projectHash,
    sessionId: message.sessionId,
    device: deviceName,
  };
  try {
    const result = await rename(message);
    let synced = false;
    try {
      const response = await post('/api/bridge/session-title', {
        deviceName, projectHash: message.projectHash, sessionId: result.sessionId, name: result.name,
      });
      synced = !!response?.ok;
    } catch {}
    send({ ...reply, ...result, ok: true, synced });
  } catch (error) {
    send({ ...reply, ok: false, error: error.message || 'Could not rename session.' });
  }
}
