// Mobile alerts, decided here from the Session rows this Bridge reports (`reportSessions`). The
// server only stores the event for Android and the iOS extension and pushes it through the relay.
import { createHash, randomUUID } from 'crypto';
import { parseStorageSessionId, storageSessionId } from './session-identity.mjs';

const LOCAL_IDLE_ALERT_SEC = 120;
const QUEUE_LIMIT = 10;
const QUEUE_TTL_MS = 10 * 60_000;
const RETRY_MS = 30_000;

let deps = {
  post: async () => null,                 // (endpoint, body) → Response | null
  history: async () => ({ messages: [] }), // ({ sessionId, limit }) → newest rows, oldest first
  viewed: async () => false,              // (rootSessionId, eventId) → a page shows it now (waits up to 3 s)
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
const rows = new Map();  // `device|project|sessionId` → the last reported row
const queue = new Map(); // sessionId → { alert, at }: alerts the server did not take yet
let retryTimer = null;

// Sessions whose turn a takeover ended: that turn's Done is not alerted, until the next turn runs.
const takenOver = new Set();
export const noteTakeover = (sessionId) => takenOver.add(sessionId);

export function configureNotifier(next) {
  deps = { ...deps, ...next };
}

// By characters, not UTF-16 units: half an emoji is rejected by the server and the alert is lost.
const clip = (text, length) => Array.from(text).slice(0, length).join('');

const storageId = (s) => storageSessionId(s.runtime, s.nativeSessionId || s.id);

function effectiveStatus(row) {
  if (row.status === 'needs_input' || row.needsInputAgentCount > 0) return 'needs_input';
  if (row.status === 'running' || row.runningAgentCount > 0) return 'running';
  return 'completed';
}

// A `reportSessions` body: every row replaces the known one; child counts and the thread root carry
// over when omitted, and count updates change a known root only.
export function observeSessions(body) {
  const device = body?.deviceName || '';
  const changes = [];
  for (const s of body?.sessions || []) {
    const sessionId = storageId(s);
    const key = `${device}|${s.project}|${sessionId}`;
    const old = rows.get(key);
    const row = { ...s, sessionId, deviceName: device };
    for (const field of ['agentCount', 'runningAgentCount', 'needsInputAgentCount', 'threadRootId']) {
      row[field] ??= old?.[field] ?? (field === 'threadRootId' ? undefined : 0);
    }
    rows.set(key, row);
    changes.push([old, row]);
  }
  for (const update of body?.agentCountUpdates || []) {
    const key = `${device}|${update.project}|${update.sessionId}`;
    const old = rows.get(key);
    if (!old) continue;
    const row = { ...old, agentCount: update.agentCount ?? old.agentCount,
      runningAgentCount: update.runningAgentCount ?? old.runningAgentCount,
      needsInputAgentCount: update.needsInputAgentCount ?? old.needsInputAgentCount };
    delete row.localIdleSec; // it describes the root's own turn end, not this change
    rows.set(key, row);
    changes.push([old, row]);
  }
  for (const [old, row] of changes) {
    void alertFor(old, row).then((alert) => alert && deliver(alert)).catch((error) => {
      console.error(`[notify] ${error.message}`);
    });
  }
}

function textSummary(content) {
  if (typeof content === 'string') {
    try { content = JSON.parse(content); } catch {}
  }
  if (Array.isArray(content)) {
    content = content.filter((block) => block?.type === 'text').map((block) => String(block.text ?? '')).join(' ');
  }
  if (typeof content !== 'string') return '';
  return clip(content.replace(/^#{1,6}\s+|`|\*\*/gm, '').replace(/\s+/g, ' ').trim(), 240);
}

const hasBlocks = (content) => {
  if (typeof content === 'string') {
    try { content = JSON.parse(content); } catch { return !!content; }
  }
  return Array.isArray(content) ? content.length > 0 : !!content;
};

// The finished turn's last reply, or null when no alert should follow it.
export async function completionSummary(sessionId, attempts = 3) {
  let summary = '';
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt) await deps.sleep(1000); // the final reply can land after the status
    summary = '';
    let done = false;
    let replied = false;
    let messages = [];
    try { messages = (await deps.history({ sessionId, limit: 20 })).messages || []; } catch {}
    for (const message of messages.slice().reverse()) {
      if (message.noAlert) return null; // a turn a takeover, its process's exit or its parent ended
      const text = textSummary(message.content ?? '');
      if (message.type === 'user') {
        if (text.startsWith('[Request interrupted')) return null;
        // CC already started a report-back turn; its own end alerts.
        if (text.startsWith('<task-notification>') && !replied) return null;
        // A slash command or Skill answers with its output, not an assistant row.
        if (text.startsWith('<local-command-stdout>')) return text.replace(/<\/?local-command-stdout>/g, '').trim();
        break; // never show a previous turn's answer
      }
      if (message.type === 'assistant') {
        replied = true;
        summary ||= text;
        // Claude marks its final reply end_turn; Codex appends an empty end_turn row.
        if (message.stopReason === 'end_turn' && (text || !hasBlocks(message.content))) done = true;
      }
    }
    if (done && summary) return summary;
  }
  return summary;
}

export async function alertFor(old, row) {
  const after = effectiveStatus(row);
  if (takenOver.has(row.sessionId)) {
    if (after === 'running') takenOver.delete(row.sessionId);
    else if (after === 'completed') return null;
  }
  if (!old || row.parentSessionId) return null; // subagent threads surface through their root
  if (row.localIdleSec != null && row.localIdleSec < LOCAL_IDLE_ALERT_SEC) return null; // the user is at that computer
  const before = effectiveStatus(old);
  let action;
  let detail;
  if (after === 'needs_input') {
    // A queued next approval changes the question without leaving needs_input.
    if (before === after && (old.agentDetail || '') === (row.agentDetail || '')) return null;
    action = 'Needs input';
    detail = textSummary(row.agentDetail || '');
  } else if (after === 'completed' && (before === 'running' || (old.backgroundAgents && before === after))) {
    // A held Done is due once its agents are gone; CC reports back as each one ends.
    if (row.backgroundAgents) return null;
    action = 'Done';
    detail = await completionSummary(row.sessionId);
    if (detail == null) return null; // the user stopped it, or CC's next turn will alert
  } else {
    return null;
  }
  const folder = String(row.projectName || '').replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop();
  const project = clip(folder || row.project, 80);
  const title = clip(String(row.preview || row.agentName || '').split(/\s+/).filter(Boolean).join(' '), 120)
    || `Session ${parseStorageSessionId(row.sessionId).nativeSessionId.slice(0, 8)}`;
  return {
    eventId: createHash('sha256').update(randomUUID()).digest('hex'),
    device: row.deviceName,
    projectHash: row.project,
    projectName: project,
    sessionId: row.sessionId,
    sessionTitle: title,
    rootSessionId: row.threadRootId || row.sessionId,
    // Apps lay out projectName / sessionTitle themselves; title is for builds that predate it.
    title: `${project} · ${title}`,
    body: (after === 'completed' ? '✅ ' : '🟡 ') + action + (detail ? ` · ${detail}` : ''),
  };
}

async function deliver(alert) {
  if (await deps.viewed(alert.rootSessionId, alert.eventId)) return;
  if (!await send(alert)) enqueue(alert);
}

async function send(alert) {
  const response = await deps.post('/api/notifications/events', alert);
  return !!response && response.status < 500; // a 4xx would only fail again
}

// The server unreachable: the newest alert per Session, at most QUEUE_LIMIT, for QUEUE_TTL_MS.
function enqueue(alert) {
  queue.delete(alert.sessionId);
  queue.set(alert.sessionId, { alert, at: Date.now() });
  while (queue.size > QUEUE_LIMIT) queue.delete(queue.keys().next().value);
  retryTimer ||= setInterval(flushQueue, RETRY_MS);
  retryTimer.unref?.();
}

export async function flushQueue() {
  for (const [sessionId, { alert, at }] of [...queue]) {
    if (Date.now() - at > QUEUE_TTL_MS) { queue.delete(sessionId); continue; }
    if (!await send(alert)) return;
    if (queue.get(sessionId)?.alert === alert) queue.delete(sessionId);
  }
  if (!queue.size) { clearInterval(retryTimer); retryTimer = null; }
}
