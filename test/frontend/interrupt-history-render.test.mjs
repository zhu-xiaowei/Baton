import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body></body>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;

globalThis.renderAssistantText = (text) => text;
globalThis.renderThinking = () => '';
globalThis.renderToolNode = () => '';
globalThis.renderSystemEvent = () => '';
globalThis.renderSummary = () => '';
globalThis.renderLocalCommandStdout = () => '';
globalThis.isLocalCommandStdout = () => false;

await import('../../web/js/components/message.js');
for (const name of [
  'renderUserBubble',
  'renderInterrupt',
  'isInterruptMsg',
  'isToolResultOnly',
]) {
  globalThis[name] = window[name];
}
await import('../../web/js/render.js');

test('history keeps Interrupted with the first answer before the next question', () => {
  const html = window.renderMessages([
    {
      uuid: 'user-one',
      type: 'user',
      content: 'question one',
      timestamp: '2026-08-18T14:00:00.000Z',
    },
    {
      uuid: 'assistant-one',
      type: 'assistant',
      content: [{ type: 'text', text: 'partial answer' }],
      timestamp: '2026-08-18T14:00:01.000Z',
    },
    {
      uuid: 'interrupt-one',
      type: 'user',
      content: [{
        type: 'text',
        text: '[Request interrupted by user]',
      }],
      timestamp: '2026-08-18T14:00:02.000Z',
    },
    {
      uuid: 'user-two',
      type: 'user',
      content: 'question two',
      timestamp: '2026-08-18T14:00:03.000Z',
    },
  ], 'claude');

  document.body.innerHTML = `<div class="messages">${html}</div>`;
  const children = [...document.querySelector('.messages').children];

  assert.deepEqual(children.map((node) => node.className), [
    'msg-user',
    'assistant-turn',
    'msg-user',
  ]);
  assert.equal(children[1].textContent, 'partial answerInterrupted');
  assert.equal(children[1].querySelectorAll('.msg-interrupt').length, 1);
  assert.equal(children[2].textContent.includes('question two'), true);
});
