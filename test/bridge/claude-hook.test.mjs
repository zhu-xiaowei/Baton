import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'node:test';
import {
  ClaudeHookServer,
  formatClaudeHookResponse,
  runClaudeHookRelay,
} from '../../bridge/claude-hook.mjs';

test('Claude hook relay carries one request and returns an AskUserQuestion answer', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentpeek-claude-hook-'));
  const endpoint = path.join(dir, 'hook.sock');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  let received;
  const server = new ClaudeHookServer({
    endpoint,
    onRequest(input, reply) {
      received = input;
      setImmediate(() => reply({
        action: 'answer',
        answerText: 'Choose environment → staging\nDeploy now? → no',
      }));
    },
  });
  await server.start();
  t.after(() => server.close());

  const input = {
    session_id: 'session-1',
    tool_use_id: 'tool-1',
    tool_name: 'AskUserQuestion',
    tool_input: {
      questions: [{ question: 'Choose environment' }, { question: 'Deploy now?' }],
    },
  };
  const output = await runClaudeHookRelay({
    endpoint,
    inputText: JSON.stringify(input),
  });

  assert.deepEqual(received, input);
  assert.deepEqual(output, {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'Choose environment → staging\nDeploy now? → no',
    },
  });
});

test('Claude hook allow uses the documented PreToolUse response', () => {
  assert.deepEqual(formatClaudeHookResponse({ action: 'allow' }), {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'Approved through AgentPeek.',
    },
  });
});
