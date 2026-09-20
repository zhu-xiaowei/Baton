import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deriveActivityFromMessages,
  resolveActivityState,
  resolveControlActivity,
} from '../../web/js/runtime-status.js';
function assistant(uuid, stopReason = '') {
  return {
    uuid,
    type: 'assistant',
    content: [{ type: 'text', text: uuid }],
    timestamp: '2026-08-27T03:00:00.000Z',
    ...(stopReason ? { stopReason } : {}),
  };
}

test('resolveActivityState gives newer live activity priority over REST status', () => {
  assert.equal(resolveActivityState({
    liveStateChanged: true,
    liveActivity: 'running',
    restStatus: 'completed',
  }), 'running');

  assert.equal(resolveActivityState({
    liveStateChanged: true,
    liveActivity: 'completed',
    restStatus: 'running',
  }), 'completed');

  assert.equal(resolveActivityState({
    liveStateChanged: true,
    liveActivity: 'needs_input',
    restStatus: 'running',
  }), 'needs_input');

  assert.equal(resolveActivityState({
    liveStateChanged: true,
    liveActivity: 'running',
    restStatus: 'needs_input',
  }), 'running');
});

test('resolveActivityState uses REST status and terminal-tail fallback', () => {
  assert.equal(resolveActivityState({
    restStatus: 'needs_input',
  }), 'needs_input');
  assert.equal(resolveActivityState({
    restStatus: 'completed',
  }), 'completed');
  assert.equal(resolveActivityState({
    restStatus: 'running',
    messages: [assistant('done', 'end_turn')],
  }), 'completed');
  assert.equal(resolveActivityState({
    restStatus: 'running',
    messages: [
      assistant('previous', 'end_turn'),
      {
        uuid: 'new-user',
        type: 'user',
        content: 'continue',
        timestamp: '2026-08-27T03:00:01.000Z',
      },
    ],
    runtime: 'codex',
  }), 'running');
});

test('resolveActivityState preserves the existing summary-tail decision supplied by the caller', () => {
  assert.equal(resolveActivityState({
    restStatus: 'running',
    messages: [
      assistant('done', 'end_turn'),
      {
        uuid: 'summary',
        type: 'summary',
        content: 'context compacted',
        timestamp: '2026-08-27T03:00:01.000Z',
      },
    ],
  }), 'running');
});

test('resolveActivityState falls back to outstanding turns and runtime activity', () => {
  assert.equal(resolveActivityState({
    hasOutstandingTurns: true,
    messages: [],
  }), 'running');
  assert.equal(resolveActivityState({
    runtime: 'codex',
    messages: [{
      uuid: 'user',
      type: 'user',
      content: 'continue',
    }],
  }), 'running');
  assert.equal(resolveActivityState(), 'completed');
});

test('resolveControlActivity honors an explicit lifecycle hint before turn tracking catches up', () => {
  assert.equal(resolveControlActivity({
    activityHint: 'running',
    hasOutstandingTurns: false,
  }), 'running');
  assert.equal(resolveControlActivity({
    hasOutstandingTurns: true,
  }), 'running');
  assert.equal(resolveControlActivity({
    hasOutstandingTurns: false,
  }), 'completed');
});

test('deriveActivityFromMessages preserves Claude and Codex runtime rules', () => {
  assert.equal(deriveActivityFromMessages({
    runtime: 'claude',
    messages: [assistant('tool', 'tool_use')],
  }), 'running');
  assert.equal(deriveActivityFromMessages({
    runtime: 'claude',
    messages: [assistant('done', 'end_turn')],
  }), 'completed');
  assert.equal(deriveActivityFromMessages({
    runtime: 'codex',
    messages: [{
      uuid: 'user',
      type: 'user',
      content: 'continue',
    }],
  }), 'running');
  assert.equal(deriveActivityFromMessages({
    runtime: 'codex',
    messages: [assistant('done', 'end_turn')],
  }), 'completed');
});
