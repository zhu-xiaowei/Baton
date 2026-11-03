import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  cancelNativeDownload, downloadFile, nativeDownloads, nativeDownloadsStopOnClose, nativeSaveOpensAfterTransfer, saveGeneratedFile,
} from '../../web/js/project/download.js';

// ArkWeb ignores <a download>, so on HarmonyOS window.harmonyBridge downloads
// and answers through window.__onHarmony.
function installBridge() {
  const calls = [];
  globalThis.window = {
    harmonyBridge: {
      download(json) { calls.push({ method: 'download', ...JSON.parse(json) }); },
      save(json) { calls.push({ method: 'save', ...JSON.parse(json) }); },
      cancelDownload(json) { calls.push({ method: 'cancelDownload', ...JSON.parse(json) }); },
    },
    navigator: { userAgent: 'Mozilla/5.0 (Phone; OpenHarmony 5.0) ArkWeb/5.0 Mobile' },
  };
  return calls;
}

test.afterEach(() => { delete globalThis.window; delete globalThis.FileReader; });

// Node has Blob but no FileReader; this is the one call saveGeneratedFile makes.
function installFileReader() {
  globalThis.FileReader = class {
    readAsDataURL(blob) {
      blob.arrayBuffer().then(buffer => {
        this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`;
        this.onload();
      });
    }
  };
}

test('the HarmonyOS bridge owns the transfer and reports its progress', async () => {
  const calls = installBridge();
  const fractions = [];
  const file = { url: 'https://bucket.example/file?signed=1', name: '预算.xlsx' };
  const download = downloadFile(file, fraction => fractions.push(fraction));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, file.url);
  assert.equal(calls[0].name, file.name);
  window.__onHarmony({ id: calls[0].id, progress: 0.42 });
  window.__onHarmony({ id: calls[0].id, progress: 1 });
  window.__onHarmony({ id: calls[0].id, result: { status: 'saved_as' } });

  assert.deepEqual(await download, { status: 'saved_as' });
  assert.deepEqual(fractions, [0.42, 1]);
});

test('a native failure rejects with its message and a cancelled save resolves quietly', async () => {
  const calls = installBridge();
  const failed = downloadFile({ url: 'https://bucket.example/a', name: 'a.bin' });
  window.__onHarmony({ id: calls[0].id, error: 'File exceeds 512 MB' });
  await assert.rejects(failed, /512 MB/);

  const cancelled = downloadFile({ url: 'https://bucket.example/b', name: 'b.bin' });
  window.__onHarmony({ id: calls[1].id, result: { status: 'cancelled' } });
  assert.deepEqual(await cancelled, { status: 'cancelled' });
});

test('replies reach the caller that asked, whatever order they arrive in', async () => {
  const calls = installBridge();
  const first = downloadFile({ url: 'https://bucket.example/1', name: '1.bin' });
  const second = downloadFile({ url: 'https://bucket.example/2', name: '2.bin' });
  assert.notEqual(calls[0].id, calls[1].id);

  window.__onHarmony({ id: calls[1].id, result: { status: 'saved_as' } });
  window.__onHarmony({ id: calls[0].id, error: 'A download is already in progress' });
  window.__onHarmony({ id: calls[0].id, result: { status: 'saved_as' } }); // stale repeat is ignored

  assert.deepEqual(await second, { status: 'saved_as' });
  await assert.rejects(first, /already in progress/);
});

// A generated file (Mermaid PNG) has no HTTPS source, so it goes to the native
// save dialog as base64 instead of reaching for Tauri.
test('a generated file is saved through the bridge, not Tauri', async () => {
  const calls = installBridge();
  installFileReader();
  const saving = saveGeneratedFile(new Blob([Uint8Array.of(0x89, 0x50, 0x4e, 0x47)], { type: 'image/png' }), 'mermaid-diagram.png');
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'save');
  assert.equal(calls[0].name, 'mermaid-diagram.png');
  assert.equal(calls[0].data, 'iVBORw==');
  window.__onHarmony({ id: calls[0].id, result: { status: 'saved_as' } });
  assert.deepEqual(await saving, { status: 'saved_as' });

  const cancelled = saveGeneratedFile(new Blob(['x'], { type: 'image/png' }), 'b.png');
  await new Promise(resolve => setTimeout(resolve, 10));
  window.__onHarmony({ id: calls[1].id, result: { status: 'cancelled' } });
  assert.deepEqual(await cancelled, { status: 'cancelled' });
});

test('the bridge counts as a native download path whose save dialog opens after the transfer', () => {
  installBridge();
  assert.equal(nativeDownloads(), true);
  assert.equal(nativeSaveOpensAfterTransfer(), true);
});

// One download at a time: closing the preview must free the slot for the next one.
test('closing the preview cancels the HarmonyOS transfer, which ends as cancelled', async () => {
  const calls = installBridge();
  assert.equal(nativeDownloadsStopOnClose(), true);
  const download = downloadFile({ url: 'https://bucket.example/big', name: 'big.zip' });
  await cancelNativeDownload();
  assert.equal(calls[1].method, 'cancelDownload');
  window.__onHarmony({ id: calls[0].id, result: { status: 'cancelled' } });
  assert.deepEqual(await download, { status: 'cancelled' });
});

test('the bridge cancels the transfer and reports it as cancelled, not failed', () => {
  const bridge = readFileSync(new URL('../../harmony/entry/src/main/ets/bridge/DownloadBridge.ets', import.meta.url), 'utf8');
  const native = readFileSync(new URL('../../harmony/entry/src/main/ets/bridge/NativeBridge.ets', import.meta.url), 'utf8');
  assert.match(native, /'cancelDownload'/);
  assert.match(bridge, /this\.abort = \(\) => reject\(new Error\(CANCELLED\)\)/);
  assert.match(bridge, /\{"status":"cancelled"\}/);
});

test('a bridge-less shell still falls back to the browser link', async () => {
  globalThis.window = { navigator: { userAgent: '' } };
  assert.equal(nativeDownloads(), false);
  assert.equal(nativeSaveOpensAfterTransfer(), false);
});

test('the native bridge keeps the Tauri plugins download guarantees', () => {
  const bridge = readFileSync(new URL('../../harmony/entry/src/main/ets/bridge/DownloadBridge.ets', import.meta.url), 'utf8');

  assert.match(bridge, /\/\^https:\\\/\\\/\(\[\^\/\?#\]\+\)\//);          // https + a host
  assert.match(bridge, /includes\('@'\)/);                                // no user:password
  assert.match(bridge, /MAX_BYTES: number = 512 \* 1024 \* 1024/);
  assert.match(bridge, /progress\.processed > MAX_BYTES \|\| total > MAX_BYTES/);
  assert.match(bridge, /if \(this\.busy\) \{\s*this\.fail\(id, 'A download is already in progress'\)/);
  assert.match(bridge, /save\(argsJson: string\): void \{[\s\S]*?data\.length \/ 4 \* 3 > MAX_BYTES/);
  // The save dialog is the only way out of the sandbox; the cache copy never stays.
  assert.match(bridge, /new picker\.DocumentViewPicker\(context\)\.save\(options\)/);
  assert.match(bridge, /finally \{[\s\S]*fs\.unlink\(cachePath\)/);
  // A paused foreground task emits neither 'completed' nor 'failed'.
  assert.match(bridge, /setTimeout\(\(\) => reject\(new Error\(STALLED\)\), STALL_MS\)/);
});

test('an in-flight download is stopped when the page goes away', () => {
  const page = readFileSync(new URL('../../harmony/entry/src/main/ets/pages/Index.ets', import.meta.url), 'utf8');
  const facade = readFileSync(new URL('../../harmony/entry/src/main/ets/bridge/NativeBridge.ets', import.meta.url), 'utf8');

  assert.match(page, /aboutToDisappear\(\): void \{\s*this\.nativeBridge\.release\(\);/);
  assert.match(facade, /release\(\): void \{[\s\S]*this\.downloads\.release\(\);/);
});
