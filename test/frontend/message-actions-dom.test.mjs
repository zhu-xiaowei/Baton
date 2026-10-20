import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createMessageDom } from '../../web/js/message-dom.js';
import { commitMessageState } from '../../web/js/message-state.js';

for (const identified of [true, false]) {
  test(`history reconciliation preserves decorated message nodes (${identified ? 'stable ID' : 'anonymous'})`, t => {
    const dom = new JSDOM('<div class="messages"></div>');
    t.after(() => dom.window.close());
    const container = dom.window.document.querySelector('.messages');
    const messages = [{ uuid: 'first', type: 'assistant', content: 'First' }];
    const renderMessages = list => list.map(message =>
      `<div class="tl-item assistant-text"${identified ? ` data-message-id="${message.uuid}"` : ''}>`
      + `<p>${message.content}</p><pre><code>code</code></pre></div>`).join('');
    container.innerHTML = renderMessages(messages);
    const first = container.firstElementChild;
    const paragraph = first.querySelector('p');
    first.insertAdjacentHTML('beforeend', '<button class="message-action">Copied</button>');
    first.querySelector('pre').insertAdjacentHTML('afterbegin', '<button class="message-action">Copy code</button>');
    const buttons = [...first.querySelectorAll('.message-action')];
    const state = {
      wsAllMessages: messages, wsMessageUuids: new Set(['first']),
      wsMessageCount: 1, wsRenderedCount: 1, pendingSentMessages: [], wsRunning: false,
    };
    const updater = createMessageDom({
      state, document: dom.window.document, runtime: () => 'codex', renderMessages,
    });
    const next = { uuid: 'second', type: 'assistant', content: 'Second' };
    commitMessageState(state, [...messages, next]);
    updater.applyChanges({ messages: [next], inserted: [{ index: 1, message: next }] });
    assert.equal(container.firstElementChild, first);
    assert.equal(first.querySelector('p'), paragraph);
    assert.deepEqual([...first.querySelectorAll('.message-action')], buttons);
    assert.equal(container.children.length, 2);
    // A content update still replaces the stale body and removes its action feedback.
    const changed = { ...messages[0], content: 'Updated' };
    commitMessageState(state, [changed, next]);
    updater.applyChanges({ messages: [changed, next], patched: [{ index: 0, before: messages[0], after: changed }] });
    assert.equal(container.firstElementChild.querySelector('p').textContent, 'Updated');
  });
}
