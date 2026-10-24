import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { installHarmonyBridges } from '../../web/js/harmony-bridge.js';
import {
  openExternalLink, previewInvoke, previewListen, previewNativeAvailable,
} from '../../web/js/preview-native.js';
import { nativeDownloads } from '../../web/js/project/download.js';

// HarmonyOS has no Tauri commands, so Remote preview reaches its native loopback
// proxy through the injected window.harmonyPreviewBridge
// (harmony/.../bridge/PreviewBridge.ets). The adapter keeps the Tauri command and
// event names, which is what lets preview-transport.js stay platform-agnostic.
function installBridge() {
  const calls = [];
  globalThis.window = {
    harmonyPreviewBridge: {
      start: json => calls.push(['start', JSON.parse(json)]),
      stop: json => calls.push(['stop', JSON.parse(json)]),
      reset: json => calls.push(['reset', JSON.parse(json)]),
      write: json => calls.push(['write', JSON.parse(json)]),
      shutdownWrite: json => calls.push(['shutdownWrite', JSON.parse(json)]),
      credit: json => calls.push(['credit', JSON.parse(json)]),
      closeSocket: json => calls.push(['closeSocket', JSON.parse(json)]),
    },
    harmonyOpenBridge: { open: json => calls.push(['open', JSON.parse(json)]) },
    navigator: { userAgent: 'Mozilla/5.0 (Phone; OpenHarmony 5.0) ArkWeb/5.0 Mobile' },
  };
  return calls;
}

test.afterEach(() => { delete globalThis.window; });

test('a preview command reaches the bridge under its Tauri name and resolves with the origin', async () => {
  const calls = installBridge();
  const tunnelId = crypto.randomUUID();
  const started = previewInvoke('preview_start', { tunnelId, preferredPort: 5173 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'start');
  assert.equal(calls[0][1].tunnelId, tunnelId);
  assert.equal(calls[0][1].preferredPort, 5173);
  window.__onHarmonyPreview({ event: 'result', id: calls[0][1].id, origin: 'http://127.0.0.1:5174' });

  assert.equal(await started, 'http://127.0.0.1:5174');
});

test('a native failure rejects the command that asked, whatever order replies arrive in', async () => {
  const calls = installBridge();
  const first = previewInvoke('preview_write', { streamId: 'a', data: 'AAA=' });
  const second = previewInvoke('preview_write', { streamId: 'b', data: 'BBB=' });
  assert.notEqual(calls[0][1].id, calls[1][1].id);

  window.__onHarmonyPreview({ event: 'result', id: calls[1][1].id });
  window.__onHarmonyPreview({ event: 'result', id: calls[0][1].id, error: 'Preview socket closed' });
  window.__onHarmonyPreview({ event: 'result', id: calls[0][1].id }); // stale repeat is ignored

  assert.equal(await second, undefined);
  await assert.rejects(first, /Preview socket closed/);
});

test('credit and close are fire-and-forget, so they carry no reply id', async () => {
  const calls = installBridge();
  await previewInvoke('preview_credit', { streamId: 'a', bytes: 131072 });
  await previewInvoke('preview_close_socket', { streamId: 'a' });

  assert.deepEqual(calls.map(call => call[0]), ['credit', 'closeSocket']);
  assert.deepEqual(calls[0][1], { streamId: 'a', bytes: 131072 });
  assert.equal(calls[1][1].id, undefined);
});

test('socket events are delivered as Tauri-shaped payloads until the listener is removed', async () => {
  installBridge();
  const bytes = [];
  const opens = [];
  const stopBytes = await previewListen('preview-socket-bytes', event => bytes.push(event.payload));
  await previewListen('preview-socket-open', event => opens.push(event.payload));

  window.__onHarmonyPreview({ event: 'open', tunnelId: 't', streamId: 's' });
  window.__onHarmonyPreview({ event: 'bytes', tunnelId: 't', streamId: 's', seq: 1, data: 'AAA=' });
  stopBytes();
  window.__onHarmonyPreview({ event: 'bytes', tunnelId: 't', streamId: 's', seq: 2, data: 'BBB=' });
  window.__onHarmonyPreview({ event: 'unknown', tunnelId: 't', streamId: 's' });

  assert.equal(opens.length, 1);
  assert.equal(opens[0].streamId, 's');
  assert.deepEqual(bytes.map(payload => payload.seq), [1]);
  assert.equal(bytes[0].data, 'AAA=');
});

test('the bridge counts as a native preview shell and owns external links', async () => {
  const calls = installBridge();
  assert.equal(previewNativeAvailable(), true);

  const opening = openExternalLink('https://example.test/page');
  assert.equal(calls[0][0], 'open');
  assert.equal(calls[0][1].url, 'https://example.test/page');
  window.__onHarmonyOpen(calls[0][1].id, {});
  assert.equal(await opening, undefined);

  const failing = openExternalLink('https://example.test/other');
  window.__onHarmonyOpen(calls[1][1].id, { error: 'No browser is installed' });
  await assert.rejects(failing, /No browser is installed/);
});

test('a shell with neither Tauri nor the bridge reports no native preview', () => {
  globalThis.window = { navigator: { userAgent: '' } };
  assert.equal(previewNativeAvailable(), false);
});

test('the native proxy keeps the Tauri preview proxy limits', () => {
  const bridge = readFileSync(new URL('../../harmony/entry/src/main/ets/bridge/PreviewBridge.ets', import.meta.url), 'utf8');

  assert.match(bridge, /const LOOPBACK: string = '127\.0\.0\.1'/);        // never a routable host
  assert.match(bridge, /const CHUNK_BYTES: number = 16 \* 1024/);
  assert.match(bridge, /const WINDOW_BYTES: number = 128 \* 1024/);
  assert.match(bridge, /const MAX_PENDING_BYTES: number = 512 \* 1024/);
  assert.match(bridge, /const MAX_STREAMS: number = 24/);
  assert.match(bridge, /const MAX_TUNNELS: number = 4/);
  assert.match(bridge, /UUID\.test\(tunnelId\)/);                         // tunnel IDs stay UUIDs
  assert.match(bridge, /this\.sessions\.size >= MAX_TUNNELS/);
  assert.match(bridge, /session\.streams\.size >= MAX_STREAMS/);
  assert.match(bridge, /queuedBytes \+ bytes\.length > MAX_PENDING_BYTES/);

  // listen() silently binds a random port when the requested one is taken, so the
  // origin handed to the frontend must come from the socket, not from the request.
  assert.match(bridge, /getLocalAddress\(\)/);

  // Credit gates delivery, and a fin never overtakes the bytes it covers.
  assert.match(bridge, /stream\.credit > 0 && stream\.queue\.length > 0/);
  assert.match(bridge, /stream\.finPending && !stream\.finSent && stream\.queue\.length === 0/);
});

// The declarative javaScriptProxy is the injection form this shell relies on, so
// every capability arrives on one window.harmonyBridge facade and this expansion
// is what the rest of the frontend actually detects.
test('the single injected facade expands into every feature namespace', () => {
  const calls = [];
  const facade = {};
  for (const method of ['scan', 'download', 'openExternal', 'previewStart', 'previewStop',
    'previewReset', 'previewWrite', 'previewShutdownWrite', 'previewCredit', 'previewCloseSocket']) {
    facade[method] = args => calls.push([method, args]);
  }
  globalThis.window = { harmonyBridge: facade, navigator: { userAgent: '' } };

  assert.equal(installHarmonyBridges(window), true);
  assert.equal(installHarmonyBridges(window), false); // idempotent
  assert.equal(previewNativeAvailable(), true);
  assert.equal(nativeDownloads(), true);

  window.harmonyScanBridge.scan();
  window.harmonyDownloadBridge.download('{"id":1}');
  window.harmonyOpenBridge.open('{"id":2}');
  window.harmonyPreviewBridge.write('{"id":3}');
  window.harmonyPreviewBridge.closeSocket('{"streamId":"s"}');

  assert.deepEqual(calls, [
    ['scan', undefined], ['download', '{"id":1}'], ['openExternal', '{"id":2}'],
    ['previewWrite', '{"id":3}'], ['previewCloseSocket', '{"streamId":"s"}'],
  ]);
});

test('a shell without the facade installs nothing', () => {
  globalThis.window = { navigator: { userAgent: '' } };
  assert.equal(installHarmonyBridges(window), false);
  assert.equal(window.harmonyPreviewBridge, undefined);
});

test('the facade method list matches what the frontend expands', () => {
  const facade = readFileSync(new URL('../../harmony/entry/src/main/ets/bridge/NativeBridge.ets', import.meta.url), 'utf8');
  const expander = readFileSync(new URL('../../web/js/harmony-bridge.js', import.meta.url), 'utf8');
  const declared = facade.slice(facade.indexOf('METHODS'), facade.indexOf('];', facade.indexOf('METHODS')))
    .match(/'[a-zA-Z]+'/g).map(name => name.slice(1, -1));
  const used = Array.from(new Set(Array.from(expander.matchAll(/bridge\.([a-zA-Z]+)\(/g), match => match[1])));

  assert.deepEqual(declared.slice().sort(), used.slice().sort());
  // Each declared name must also exist as a method on the ArkTS facade.
  for (const name of declared) assert.match(facade, new RegExp(`\\n  ${name}\\(`));
});

test('the shell injects the facade declaratively and allows the loopback preview frame', () => {
  const index = readFileSync(new URL('../../harmony/entry/src/main/ets/pages/Index.ets', import.meta.url), 'utf8');

  // registerJavaScriptProxy objects are documented to appear only after a reload.
  assert.doesNotMatch(index, /this\.controller\.registerJavaScriptProxy/);
  assert.match(index, /name: 'harmonyBridge'/);
  assert.match(index, /methodList: NativeBridge\.METHODS/);
  // app:// is a secure origin, so http://127.0.0.1 in an iframe is mixed content.
  assert.match(index, /\.mixedMode\(MixedMode\.All\)/);
  // The loopback listeners must not outlive the page that owns them.
  assert.match(index, /this\.nativeBridge\.release\(\)/);
});
