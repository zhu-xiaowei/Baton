import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body></body>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;

await import('../../web/js/components/message.js');

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

test('only Baton image sends become image attachments', () => {
  const typed = '例如 ![](/Users/me/proj/shot.png) 会被拼错';
  document.body.innerHTML = window.renderUserBubble({
    type: 'user',
    content: typed + '\n![](baton-bridge:a1.jpg)\n![](/home/me/.baton-bridge/tmp/b2.png)',
  });

  assert.equal(document.querySelector('.msg-text').textContent, typed);
  assert.deepEqual(
    [...document.querySelectorAll('.img-placeholder')].map(el => el.dataset.key),
    ['a1.jpg', 'b2.png'],
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
