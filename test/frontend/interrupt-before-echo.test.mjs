import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

test('quick stop keeps Interrupted below its prompt with the production renderer', async context => {
  const h = await makeHarness();
  const expose = (name, value) => { globalThis[name] = value; h.window[name] = value; };
  expose('renderAssistantText', text => `<div class="md">${text}</div>`);
  await import('../../web/js/components/message.js');
  for (const name of ['renderUserBubble', 'renderInterrupt', 'isToolResultOnly', 'isInterruptMsg']) {
    expose(name, h.window[name]);
  }
  await import('../../web/js/render.js');
  expose('renderMessages', h.window.renderMessages);
  expose('renderSingleMessage', h.window.renderSingleMessage);

  for (const runtime of ['claude', 'codex']) {
    for (const echoAfterEnd of [false, true]) {
      await context.test(`${runtime}: prompt echo ${echoAfterEnd ? 'after' : 'before'} end`, async t => {
        t.after(() => h.window.disconnectWs());
        const sessionId = `${runtime}:quick-stop`;
        resetSession(h, { sessionId });
        h.state.appState.runtime = runtime;
        h.state.activeThreadCanSend = true;
        const sent = [];
        h.state.ws = {
          readyState: WebSocket.OPEN,
          send(payload) { sent.push(JSON.parse(payload)); },
          close() {},
        };
        const history = [
          { uuid: 'old-user', type: 'user', content: 'previous question' },
          { uuid: 'old-answer', type: 'assistant', content: [{ type: 'text', text: 'previous answer' }] },
        ];
        h.hooks.handleWsMessage({ action: 'messages', sessionId, messages: history });
        h.document.getElementById('msg-input').value = 'new question';
        h.window.onSendBtnClick();
        const turnId = sent.at(-1).turnId;
        const bubble = h.document.getElementById(turnId);
        const event = (action, extra = {}) => h.hooks.handleWsMessage({ action, sessionId, turnId, ...extra });
        event('send_message_received');
        event('stream_turn_start', { seq: 0 });
        h.window.onSendBtnClick();
        assert.equal(sent.at(-1).action, 'interrupt');
        assert.equal(sent.at(-1).turnId, turnId);

        const interrupt = {
          uuid: `live_interrupt_${turnId}`, turnId, type: 'user',
          nativeId: `live:interrupt:${turnId}`,
          content: [{ type: 'text', text: '[Request interrupted by user]' }],
        };
        event('messages', { seq: 1, messages: [interrupt] });
        assert.equal(h.document.querySelector('.msg-interrupt')?.parentElement, bubble.nextElementSibling);
        assert.equal(h.state.pendingSentMessages.length, 1, 'an interrupt cannot confirm the prompt');

        const end = () => event('stream_end', { seq: 2, messages: [interrupt] });
        if (echoAfterEnd) end();
        const prompt = {
          uuid: 'new-prompt', turnId, type: 'user', content: 'new question',
          nativeId: `${runtime === 'claude' ? 'live' : 'codex'}:user:${turnId}`,
        };
        h.hooks.handleWsMessage({ action: 'messages', sessionId, messages: [prompt] });
        if (!echoAfterEnd) end();
        assert.equal(h.document.querySelector('.msg-interrupt')?.parentElement, bubble.nextElementSibling);
        assert.equal(h.document.querySelectorAll('.msg-interrupt').length, 1);
        assert.equal(bubble.dataset.messageId, prompt.uuid);
        assert.equal(h.state.pendingSentMessages.length, 0);
        assert.equal(h.state.wsRunning, false);
        assert.deepEqual(h.state.wsAllMessages.slice(-2).map(message => message.uuid), [prompt.uuid, interrupt.uuid]);

        if (runtime === 'claude' && echoAfterEnd) {
          const order = () => [...h.document.querySelector('.messages').children]
            .filter(node => !node.classList.contains('loading-older'))
            .map(node => node.classList.contains('msg-user')
              ? node.querySelector('.msg-text').textContent : node.textContent);
          const liveOrder = order();
          h.setApiResponse({ messages: [...history, prompt, interrupt], hasMore: false, status: 'completed' });
          await h.window.loadLatestMessages(sessionId);
          assert.deepEqual(order(), liveOrder, 'live ordering matches reloaded history');
        }
      });
    }
  }

  for (const runtime of ['claude', 'codex']) {
    await context.test(`${runtime}: interrupt stays with the partial REST answer`, async t => {
      t.after(() => h.window.disconnectWs());
      const sessionId = `${runtime}:rest-interrupt`;
      const turnId = 'running-elsewhere';
      resetSession(h, { sessionId });
      h.state.appState.runtime = runtime;
      h.state.ws = { readyState: WebSocket.OPEN, send() {}, close() {} };
      const history = [
        { uuid: 'rest-user', nativeId: `${runtime === 'claude' ? 'live' : 'codex'}:user:${turnId}`, type: 'user', content: 'current question' },
        { uuid: 'rest-answer', type: 'assistant', content: [{ type: 'text', text: 'partial answer' }] },
      ];
      h.setApiResponse({ messages: history, hasMore: false, status: 'running' });
      await h.window.loadLatestMessages(sessionId);
      h.hooks.handleWsMessage({ action: 'stream_turn_start', sessionId, turnId, seq: 0 });
      h.window.interruptSession();
      const interrupt = {
        uuid: 'live-interrupt', type: 'user',
        content: [{ type: 'text', text: '[Request interrupted by user]' }],
      };
      for (const event of [
        { action: 'messages', seq: 1 },
        { action: 'stream_end', seq: 2 },
      ]) {
        h.hooks.handleWsMessage({ ...event, sessionId, turnId, messages: [interrupt] });
        const answer = h.document.querySelector('[data-message-id="rest-answer"]');
        assert.equal(h.document.querySelector('.msg-interrupt')?.parentElement, answer.parentElement);
        assert.equal(answer.parentElement.textContent, 'partial answerInterrupted');
      }
      h.setApiResponse({ messages: [...history, interrupt], hasMore: false, status: 'completed' });
      await h.window.loadLatestMessages(sessionId);
      assert.equal(h.document.querySelector('.assistant-turn').textContent, 'partial answerInterrupted');
    });
  }
});
