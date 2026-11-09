import { state } from './state.js';
import { request as requestBridge } from './v2/direct-transport.js';

let sessionId = null;
let deviceName = null;
const entries = new Map();
let send = requestBridge; // (device, method, params) → Promise; tests replace it

export function configureToolDetails(next) {
  send = next || requestBridge;
}

function currentEntries() {
  if (sessionId !== state.wsSessionId || deviceName !== state.appState.device) {
    sessionId = state.wsSessionId;
    deviceName = state.appState.device;
    entries.clear();
  }
  return entries;
}

export function observeToolDetails(toolUse, toolResult) {
  const cache = currentEntries();
  if (!toolUse?.id) return { toolUse, toolResult };
  if (!toolUse.truncated && !toolResult?.truncated) {
    cache.delete(toolUse.id);
    return { toolUse, toolResult };
  }
  const existing = cache.get(toolUse.id);
  if (existing?.toolUse === toolUse && existing.toolResult === toolResult) {
    return existing.full || existing.preview || { toolUse, toolResult };
  }
  const key = JSON.stringify([toolUse, toolResult]);
  let entry = existing;
  if (!entry || entry.key !== key) {
    entry = { key, toolUse, toolResult, full: null, preview: null, pending: null };
    cache.set(toolUse.id, entry);
  }
  return entry.full || entry.preview || { toolUse, toolResult };
}

export function toolDetailsSource(toolId) {
  return currentEntries().get(toolId);
}

export async function loadToolDetails(toolId) {
  const entry = currentEntries().get(toolId);
  if (!entry) throw new Error('Tool details are no longer available.');
  if (entry.full) return entry.full;
  if (entry.pending) return entry.pending;
  const requestedSession = sessionId;
  const requestedDevice = deviceName;
  entry.pending = send(requestedDevice, 'tool_details', {
    sessionId: requestedSession,
    toolUseIds: [toolId],
  }).then((response) => {
    const full = response.details?.find((item) => item.toolUse?.id === toolId);
    if (!full) throw new Error('Incomplete tool details response.');
    if (entry.toolResult && !full.toolResult) {
      throw new Error('Tool output is not available yet. Click to retry.');
    }
    if (state.wsSessionId === requestedSession && state.appState.device === requestedDevice) {
      if (entries.get(toolId) !== entry) throw new Error('Tool changed while loading. Click to retry.');
      entry.full = full;
    }
    return full;
  }).finally(() => { entry.pending = null; });
  return entry.pending;
}

// The 500-character previews of tools whose body the history page left out, in one request.
export async function loadToolPreviews(toolIds) {
  const cache = currentEntries();
  const requestedSession = sessionId;
  const requestedDevice = deviceName;
  const missing = toolIds.filter((id) => cache.get(id) && !cache.get(id).full && !cache.get(id).preview);
  if (!missing.length) return;
  const response = await send(requestedDevice, 'tool_details', { sessionId: requestedSession, toolUseIds: missing, preview: true });
  if (state.wsSessionId !== requestedSession || state.appState.device !== requestedDevice) return;
  for (const item of response.details || []) {
    const entry = item.toolUse?.id && entries.get(item.toolUse.id);
    if (entry) entry.preview = item;
  }
}

// Thinking text is left out of history pages; it comes through the same request, under the id
// `thinking:<message uuid>:<block index>` (bridge/tool-details.mjs).
export async function loadThinking(id) {
  const cache = currentEntries();
  if (!cache.has(id)) cache.set(id, { key: id, toolUse: { id }, toolResult: null, full: null, preview: null, pending: null });
  return (await loadToolDetails(id)).toolUse.thinking || '';
}
