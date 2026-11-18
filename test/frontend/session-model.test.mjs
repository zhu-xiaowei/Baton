import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { state } from '../../web/js/state.js';
import { refreshSessionModel } from '../../web/js/components/session-model.js';
import { handleWsRpcMessage } from '../../web/js/ws-rpc.js';

test('model status rejects stale session replies and clears unavailable values', async () => {
  const dom = new JSDOM('<div id="input-bar" style="display:flex"></div>', { pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const requests = [];
  window.wsSendReliable = msg => requests.push(msg);
  state.ws = { readyState: 1 };
  state.appState = { device: 'test', project: { hash: 'project' }, session: 'a', runtime: 'codex' };
  state.activeThreadId = 'a';
  const first = refreshSessionModel();
  state.activeThreadId = 'b';
  state.appState.session = 'b';
  const second = refreshSessionModel();
  handleWsRpcMessage({ ...requests[1], modelStatus: { model: 'model-b', reasoningEffort: 'high', source: 'live' } });
  await second;
  handleWsRpcMessage({ ...requests[0], modelStatus: { model: 'model-a', source: 'live' } });
  await first;
  assert.equal(document.getElementById('session-model').textContent, 'model-b · high');
  state.appState.session = state.activeThreadId = 'c';
  const third = refreshSessionModel();
  assert.equal(document.getElementById('session-model'), null);
  handleWsRpcMessage({ ...requests[2], options: [] }); // Older Bridge.
  await third;
  assert.equal(document.getElementById('session-model'), null);
  state.ws.readyState = 3;
  await refreshSessionModel();
  dom.window.close();
});
