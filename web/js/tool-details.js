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
  const key = JSON.stringify([toolUse, toolResult]);
  let entry = cache.get(toolUse.id);
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
    if (state.wsSessionId === requestedSession && state.appState.device === requestedDevice) {
      if (entries.get(toolId) !== entry) throw new Error('Tool changed while loading. Click to retry.');
      entry.full = full;
    }
    return full;
  }).finally(() => { entry.pending = null; });
  return entry.pending;
}
