import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

test('Codex child views distinguish only the inherited Main Agent prompt', async () => {
  const h = await makeHarness();
  resetSession(h, { sessionId: 'codex:child' });
  h.state.appState.runtime = 'codex';
  h.state.rootSessionId = 'codex:root';
  h.state.activeThreadId = 'codex:child';
  const inherited = { type: 'user', content: 'parent task' };
  const child = { type: 'user', content: 'child task' };
  const messages = [inherited, child];

  assert.equal(h.window.isInheritedAgentContext(inherited, messages), true);
  assert.equal(h.window.isInheritedAgentContext(child, messages), false);

  h.state.appState.runtime = 'claude';
  assert.equal(h.window.isInheritedAgentContext(inherited, messages), false);

  const css = fs.readFileSync(
    new URL('../../web/css/style.css', import.meta.url),
    'utf8',
  );
  assert.match(css, /\.msg-user\.agent-context \{[\s\S]*box-shadow: inset 2px 0/);
});
