import { state } from './state.js';
import { requestWsRpc, assembleTextFrames } from './ws-rpc.js';

let sessionId = null;
let deviceName = null;
const entries = new Map();

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
    return existing.full || { toolUse, toolResult };
  }
  const key = JSON.stringify([toolUse, toolResult]);
  let entry = existing;
  if (!entry || entry.key !== key) {
    entry = { key, toolUse, toolResult, full: null, pending: null };
    cache.set(toolUse.id, entry);
  }
  return entry.full || { toolUse, toolResult };
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
  entry.pending = requestWsRpc({
    action: 'tool_details',
    sessionId: requestedSession,
    device: requestedDevice,
    toolUseIds: [toolId],
  }, { assemble: assembleTextFrames }).then((response) => {
    const full = JSON.parse(response.content).details?.find((item) => item.toolUse?.id === toolId);
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

// Thinking text is left out of history pages; it comes through the same request, under the id
// `thinking:<message uuid>:<block index>` (bridge/tool-details.mjs).
export async function loadThinking(id) {
  const cache = currentEntries();
  const known = cache.get(id);
  if (known?.full) return known.full.toolUse.thinking;
  const response = await requestWsRpc({
    action: 'tool_details',
    sessionId: state.wsSessionId,
    device: state.appState.device,
    toolUseIds: [id],
  }, { assemble: assembleTextFrames });
  const full = JSON.parse(response.content).details?.find((item) => item.toolUse?.id === id);
  if (!full) throw new Error('Thinking is not available.');
  cache.set(id, { full });
  return full.toolUse.thinking || '';
}
