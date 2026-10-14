import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body></body>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;

globalThis.renderAssistantText = (text) => `<p>${text}</p>`;
globalThis.renderThinking = () => '';
globalThis.renderToolNode = () => '';
globalThis.renderSystemEvent = () => '';
globalThis.renderSummary = () => '';

await import('../../web/js/components/message.js');
for (const name of [
  'renderUserBubble',
  'renderInterrupt',
  'isInterruptMsg',
  'isToolResultOnly',
  'isLocalCommandStdout',
  'renderLocalCommandStdout',
]) {
  globalThis[name] = window[name];
}
await import('../../web/js/render.js');

test('a forked-skill result renders as an assistant timeline reply', () => {
  const root = document.createElement('div');
  root.innerHTML = window.renderMessages([
    { uuid: 'u1', type: 'user', content: '/code-review PR #57' },
    { uuid: 'u2', type: 'user', content: '<local-command-stdout>10 findings</local-command-stdout>' },
    { uuid: 'u3', type: 'user', content: '<command-name>/compact</command-name>' },
    { uuid: 'u4', type: 'user', content: '<local-command-stdout>Compacted</local-command-stdout>' },
  ], 'claude');
  const reply = root.querySelector('.assistant-turn > .tl-item.assistant-text');
  assert.equal(reply?.dataset.messageId, 'u2');
  assert.equal(reply.textContent, '10 findings');
  assert.equal(root.querySelector('.cmd-output pre')?.textContent, 'Compacted');
});

test('a title row between the skill echo and its result keeps the timeline reply', () => {
  const root = document.createElement('div');
  root.innerHTML = window.renderMessages([
    { uuid: 'u1', type: 'user', content: '/code-review PR #57' },
    { uuid: 't1', type: 'ai-title', content: 'Review PR 57' },
    { uuid: 'u2', type: 'user', content: '<local-command-stdout>10 findings</local-command-stdout>' },
  ], 'claude');
  assert.equal(root.querySelector('.assistant-turn > .tl-item.assistant-text')?.dataset.messageId, 'u2');
});

test('a forked-skill reply does not absorb a following summary row', () => {
  globalThis.renderSummary = () => 'compacted';
  const root = document.createElement('div');
  root.innerHTML = window.renderMessages([
    { uuid: 'u1', type: 'user', content: '/code-review PR #57' },
    { uuid: 'u2', type: 'user', content: '<local-command-stdout>10 findings</local-command-stdout>' },
    { uuid: 's1', type: 'summary', content: 'compacted' },
  ], 'claude');
  globalThis.renderSummary = () => '';
  const turns = root.querySelectorAll('.assistant-turn');
  assert.equal(turns.length, 2);
  assert.equal(turns[0].children.length, 1);
});
