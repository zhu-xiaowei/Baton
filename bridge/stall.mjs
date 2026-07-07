import fs from 'fs';
import path from 'path';
import { STALL_JSONL_SILENCE_MS, STALL_CONFIRM_INTERVAL_MS, STALL_ARM_TIMEOUT_MS } from './config.mjs';
import { lastKnownStatus, updateSessionStatus } from './sync.mjs';
import { findSessionFile, hasNoDanglingTurn } from './session.mjs';
import { findTmuxTargetForSession, interruptSession, paneRunState } from './tmux.mjs';

/**
 * Detect sessions stuck showing "running" because an AskUserQuestion with a
 * header-tab UI is sitting in CC's memory, never written to jsonl until the
 * user answers (see CLAUDE.md's "Stall Rescue" section).
 *
 * Two independent signals, both required — neither is sufficient alone:
 *
 * 1. Structural safety gate (hasNoDanglingTurn): the wizard's UI looks
 *    IDENTICAL on screen whether its tool_use has already flushed to jsonl
 *    (in which case it's a normal live prompt the user may already be
 *    answering via the app's needsPermission path — must never be
 *    interrupted) or is still stuck in memory (the real stall). Only jsonl
 *    content can tell those apart: if the last turn is a closed `user` entry
 *    (no dangling `assistant` tool_use), nothing has flushed yet.
 * 2. Pane content match, confirmed stable across two captures a couple
 *    seconds apart. jsonl silence alone can't stand in for this — the file
 *    stops changing for as long as CC is generating a turn (thinking + text
 *    + tool_use flush together once the turn ends), which is completely
 *    normal and can take much longer than any poll interval. A wizard that
 *    only just rendered fails the stability check and is left alone.
 *
 * Rescue: send Escape, which forces CC to flush the pending tool_use (with
 * its real question data) + a synthetic rejection to jsonl. watcher.mjs then
 * recognizes and hides that synthetic pair, and the app renders the real
 * questions from the flushed tool_use.
 */
export async function checkStalledSessions(config) {
  const now = Date.now();
  // kind: 'wizard' (stuck AskUserQuestion → rescue) | 'idle' (quiescent pane,
  // e.g. reverted prompt → mark idle). Both share the same silence pre-filter
  // and trailing-lone-`user` gate; only the pane content differs.
  const candidates = [];
  for (const [sessionId, status] of lastKnownStatus) {
    if (status !== 'running') continue;

    const filePath = findSessionFile(sessionId);
    if (!filePath) continue;
    let mtimeMs;
    try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch { continue; }
    if (now - mtimeMs < STALL_JSONL_SILENCE_MS) continue; // jsonl still active — cheap skip, no capture-pane
    if (!hasNoDanglingTurn(filePath)) continue; // a tool_use already flushed — normal live prompt, never touch it

    if (!findTmuxTargetForSession(sessionId)) continue; // not a tmux-backed session
    const run = paneRunState(sessionId);
    if (run === 'wizard') candidates.push({ sessionId, filePath, kind: 'wizard' });
    else if (run === 'idle') candidates.push({ sessionId, filePath, kind: 'idle' });
    // 'busy' / 'no-pane' → genuinely running or can't tell, leave alone
  }
  if (!candidates.length) return;

  // Confirm each candidate is still in the same state after a short delay — rules
  // out a wizard/idle screen that only just rendered (which would otherwise look
  // identical to one that's been sitting there for a while). A real 'running'
  // session shows the busy marker on this second capture and drops out.
  await new Promise((r) => setTimeout(r, STALL_CONFIRM_INTERVAL_MS));

  for (const { sessionId, filePath, kind } of candidates) {
    if (lastKnownStatus.get(sessionId) !== 'running') continue; // resolved on its own in the meantime
    const fp = findSessionFile(sessionId);
    if (!fp || !hasNoDanglingTurn(fp)) continue; // flushed for real between the two captures
    if (paneRunState(sessionId) !== kind) continue; // state changed → not stable

    if (kind === 'wizard') {
      console.log(`[stall] rescuing ${sessionId.slice(0, 8)} (AskUserQuestion wizard confirmed stuck across 2 captures)`);
      armStallRescue(sessionId);
      interruptSession(sessionId);
    } else {
      console.log(`[stall] ${sessionId.slice(0, 8)} → idle (trailing user prompt reverted, pane quiescent across 2 captures)`);
      await updateSessionStatus(config, sessionId, fp, path.basename(path.dirname(fp)), 'idle');
    }
  }
}

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
