import { STALL_ARM_TIMEOUT_MS } from './config.mjs';

// NOTE: the tmux-backed stall detector (checkStalledSessions) was removed with
// tmux.mjs — it relied on capture-pane to spot a stuck AskUserQuestion wizard.
// Under headless, CC pushes the full AskUserQuestion via a control_request, so
// no pane sampling / Escape rescue is needed. The arm/rescue state below is kept
// as an inert stub so watcher.mjs / ws.mjs imports stay valid; it's dead until
// the headless permission path is wired, then removable.

// ---- Rescue state, shared with watcher.mjs ----
// watcher.mjs uses this to recognize + suppress the synthetic rejection
// tool_result and interrupt marker a rescue Escape produces, instead of
// treating them as real content.

const armedAt = new Map(); // sessionId → armedAt
const rescuedToolUseId = new Map(); // sessionId → the flushed tool_use's id

export function armStallRescue(sessionId) {
  armedAt.set(sessionId, Date.now());
}

export function isArmed(sessionId) {
  const t = armedAt.get(sessionId);
  if (t === undefined) return false;
  if (Date.now() - t > STALL_ARM_TIMEOUT_MS) {
    disarmStallRescue(sessionId);
    return false;
  }
  return true;
}

export function disarmStallRescue(sessionId) {
  armedAt.delete(sessionId);
  rescuedToolUseId.delete(sessionId);
}

export function setRescuedToolUseId(sessionId, id) {
  rescuedToolUseId.set(sessionId, id);
}

export function getRescuedToolUseId(sessionId) {
  return rescuedToolUseId.get(sessionId);
}
