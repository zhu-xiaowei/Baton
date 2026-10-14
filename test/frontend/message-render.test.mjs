import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import hljs from 'highlight.js';
import { Marked } from 'marked';

const dom = new JSDOM('<!doctype html><body></body>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;

await import('../../web/js/components/message.js');

test('local command summaries render Markdown and escape embedded HTML', async () => {
  globalThis.marked = new Marked();
  globalThis.hljs = hljs;
  await import('../../web/js/components/markdown.js');
  globalThis.renderAssistantText = window.renderAssistantText;
  const timestamp = '2026-10-14T02:08:01.781Z';
  document.body.innerHTML = window.renderLocalCommandStdout({
    type: 'user',
    timestamp,
    content: '<local-command-stdout>\u001b[1mReview result\u001b[0m\n\n'
      + '1. **Bug** in `bridge/watcher.mjs`\n\n'
      + '```js\nconst result = 1;\n```\n\n'
      + '<style>body{display:none}</style></local-command-stdout>',
  });
  assert.equal(document.querySelector('.assistant-text').dataset.ts, timestamp);
  assert.equal(document.querySelector('li strong').textContent, 'Bug');
  assert.equal(document.querySelector('li code').textContent, 'bridge/watcher.mjs');
  assert.match(document.querySelector('pre code').textContent, /const result = 1;/);
  assert.equal(document.querySelector('style'), null);
  assert.ok(!document.body.textContent.includes('\u001b'));
  assert.ok(!document.body.textContent.includes('local-command-stdout'));
});

test('user bubbles preserve and wrap long unbroken text', () => {
  const text = `PHASE3_EXISTING_${'X'.repeat(240)}`;
  document.body.innerHTML = window.renderUserBubble({
    type: 'user',
    content: text,
    timestamp: '2026-08-11T00:00:00.000Z',
  });

  assert.equal(document.querySelector('.msg-text').textContent, text);

  const css = fs.readFileSync(new URL('../../web/css/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.msg-user \.msg-text \{[\s\S]*overflow-wrap: anywhere;/);
  assert.match(css, /\.msg-user \.msg-text \{[\s\S]*word-break: break-word;/);
});

test('REST user identity restores the live turn anchor', () => {
  document.body.innerHTML = window.renderUserBubble({
    uuid: 'rest-user',
    nativeId: 'codex:user:client-turn-1',
    type: 'user',
    content: 'continue',
  });

  assert.equal(
    document.querySelector('.msg-user').dataset.anchor,
    'client-turn-1',
  );
});

test('Codex subagent notifications stay hidden from the user timeline', () => {
  const message = {
    type: 'user',
    content: '<subagent_notification>\n'
      + '{"agent_path":"child-id","status":{"completed":"/tmp/result"}}\n'
      + '</subagent_notification>',
    timestamp: '2026-08-21T13:12:08.665Z',
  };

  assert.equal(window.isSubagentNotificationMsg(message), true);
  assert.equal(window.renderUserBubble(message), '');
});
