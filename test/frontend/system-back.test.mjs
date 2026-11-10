import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { createTestServer } from './helpers/vite.mjs';

async function setup(t, markup = '') {
  const dom = new JSDOM(markup, {
    url: 'https://test/', pretendToBeVisual: true,
  });
  const { window } = dom;
  Object.assign(globalThis, {
    window, document: window.document, Element: window.Element, Event: window.Event,
    getComputedStyle: window.getComputedStyle.bind(window),
  });
  const vite = await createTestServer({
    root: path.resolve(import.meta.dirname, '../../web'), logLevel: 'silent',
    appType: 'custom', server: { middlewareMode: true },
  });
  const module = await vite.ssrLoadModule('/js/system-back.js');
  const edge = await vite.ssrLoadModule('/js/edge-back.js');
  t.after(async () => { await vite.close(); window.close(); });
  return { ...module, ...edge, window };
}

test('Back closes dialog, modal, slash popup and preview layer before navigating', async t => {
  const ui = await setup(t, '<dialog open></dialog><div class="modal-overlay"><button class="cancel">Cancel</button></div><div id="slash-popup"></div>');
  const calls = [];
  const dialog = document.querySelector('dialog');
  dialog.addEventListener('cancel', event => { event.preventDefault(); calls.push('dialog'); dialog.open = false; });
  const overlay = document.querySelector('.modal-overlay');
  overlay.querySelector('.cancel').onclick = () => { calls.push('modal'); overlay.hidden = true; };
  window.closeSlashPopup = () => { calls.push('slash'); document.getElementById('slash-popup').hidden = true; };
  const layer = ui.registerEdgeBackLayer({ navigateBack: () => { calls.push('layer'); layer.deactivate(); } });
  layer.activate();
  for (let i = 0; i < 5; i++) assert.equal(ui.handleSystemBack(() => { calls.push('navigate'); return true; }), true);
  assert.deepEqual(calls, ['dialog', 'modal', 'slash', 'layer', 'navigate']);
});

test('Android Back goes through onBackButtonPress and backgrounds the app only at the root', async t => {
  const ui = await setup(t);
  let listener;
  ui.window.__TAURI_INTERNALS__ = { transformCallback: cb => { listener = cb; return 1; }, invoke: async () => {} };
  let backgrounded = 0, depth = 1;
  ui.window.BatonAndroid = { moveTaskToBack: () => { backgrounded++; } };
  await ui.initSystemBack({ navigate: () => depth-- > 0 });
  listener({ index: 0, message: {} });
  assert.equal(backgrounded, 0);
  listener({ index: 1, message: {} });
  assert.equal(backgrounded, 1);
});

test('HarmonyOS Back runs the page hook, which reports false only at the root', async t => {
  const ui = await setup(t);
  let depth = 1;
  ui.window.harmonyBridge = {};
  await ui.initSystemBack({ navigate: () => depth-- > 0 });
  assert.equal(ui.window.__batonSystemBack(), true);
  assert.equal(ui.window.__batonSystemBack(), false);
});
