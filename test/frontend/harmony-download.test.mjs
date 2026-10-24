import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { browserCanShare, downloadFile, nativeDownloads } from '../../web/js/project/download.js';

// ArkWeb ignores <a download> and has no navigator.share, so on HarmonyOS the
// injected window.harmonyDownloadBridge is the only download path.
function installBridge() {
  const calls = [];
  globalThis.window = {
    harmonyDownloadBridge: { download(json) { calls.push(JSON.parse(json)); } },
    navigator: {
      userAgent: 'Mozilla/5.0 (Phone; OpenHarmony 5.0) ArkWeb/5.0 Mobile',
      share: async () => {}, canShare: () => true,
    },
  };
  return calls;
}

test.afterEach(() => { delete globalThis.window; });

test('the HarmonyOS bridge owns the transfer and reports its progress', async () => {
  const calls = installBridge();
  const percents = [];
  const file = { url: 'https://bucket.example/file?signed=1', name: '预算.xlsx' };
  const download = downloadFile(file, percent => percents.push(percent));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, file.url);
  assert.equal(calls[0].name, file.name);
  window.__onHarmonyDownloadProgress(calls[0].id, 42);
  window.__onHarmonyDownloadProgress(calls[0].id, 100);
  window.__onHarmonyDownload(calls[0].id, { status: 'saved_as' });

  assert.deepEqual(await download, { status: 'saved_as' });
  assert.deepEqual(percents, [42, 100]);
});

test('a native failure rejects with its message and a cancelled save resolves quietly', async () => {
  const calls = installBridge();
  const failed = downloadFile({ url: 'https://bucket.example/a', name: 'a.bin' });
  window.__onHarmonyDownload(calls[0].id, { error: 'File exceeds 512 MB' });
  await assert.rejects(failed, /512 MB/);

  const cancelled = downloadFile({ url: 'https://bucket.example/b', name: 'b.bin' });
  window.__onHarmonyDownload(calls[1].id, { status: 'cancelled' });
  assert.deepEqual(await cancelled, { status: 'cancelled' });
});

test('replies reach the caller that asked, whatever order they arrive in', async () => {
  const calls = installBridge();
  const first = downloadFile({ url: 'https://bucket.example/1', name: '1.bin' });
  const second = downloadFile({ url: 'https://bucket.example/2', name: '2.bin' });
  assert.notEqual(calls[0].id, calls[1].id);

  window.__onHarmonyDownload(calls[1].id, { status: 'saved_as' });
  window.__onHarmonyDownload(calls[0].id, { error: 'A download is already in progress' });
  window.__onHarmonyDownload(calls[0].id, { status: 'saved_as' }); // stale repeat is ignored

  assert.deepEqual(await second, { status: 'saved_as' });
  await assert.rejects(first, /already in progress/);
});

test('the bridge counts as a native download path, so browser sharing stays off', () => {
  installBridge();
  assert.equal(nativeDownloads(), true);
  assert.equal(browserCanShare(), false);
});

test('a bridge-less shell still falls back to the browser link', async () => {
  globalThis.window = { navigator: { userAgent: '' } };
  assert.equal(nativeDownloads(), false);
});

test('the native bridge keeps the Tauri plugins download guarantees', () => {
  const bridge = readFileSync(new URL('../../harmony/entry/src/main/ets/bridge/DownloadBridge.ets', import.meta.url), 'utf8');

  assert.match(bridge, /\/\^https:\\\/\\\/\(\[\^\/\?#\]\+\)\//);          // https + a host
  assert.match(bridge, /includes\('@'\)/);                                // no user:password
  assert.match(bridge, /MAX_BYTES: number = 512 \* 1024 \* 1024/);
  assert.match(bridge, /progress\.processed > MAX_BYTES \|\| total > MAX_BYTES/);
  assert.match(bridge, /if \(this\.busy\) \{\s*this\.fail\(id, 'A download is already in progress'\)/);
  // The save dialog is the only way out of the sandbox; the cache copy never stays.
  assert.match(bridge, /new picker\.DocumentViewPicker\(context\)\.save\(options\)/);
  assert.match(bridge, /finally \{[\s\S]*fs\.unlink\(cachePath\)/);
  // A paused foreground task emits neither 'completed' nor 'failed'.
  assert.match(bridge, /setTimeout\(\(\) => reject\(new Error\(STALLED\)\), STALL_MS\)/);
});

test('the download bridge is injected with the first page load and released with it', () => {
  const page = readFileSync(new URL('../../harmony/entry/src/main/ets/pages/Index.ets', import.meta.url), 'utf8');
  const facade = readFileSync(new URL('../../harmony/entry/src/main/ets/bridge/NativeBridge.ets', import.meta.url), 'utf8');

  // registerJavaScriptProxy objects are documented to appear only after the next
  // (re)load, so the declarative proxy is the injection form this shell relies on.
  assert.doesNotMatch(page, /this\.controller\.registerJavaScriptProxy/);
  assert.match(page, /name: 'harmonyBridge'/);
  assert.match(facade, /download\(argsJson: string\): void \{\s*this\.downloads\.download\(argsJson\);/);
  assert.match(page, /aboutToDisappear\(\): void \{\s*this\.nativeBridge\.release\(\);/);
  assert.match(facade, /release\(\): void \{[\s\S]*this\.downloads\.release\(\);/);
});

test('the viewer shows HarmonyOS download progress and its save result', () => {
  const viewer = readFileSync(new URL('../../web/js/project/file-viewer.js', import.meta.url), 'utf8');

  assert.match(viewer, /downloadFile\(file, percent => \{\s*if \(_downloadTarget === target\) downloadStatus\('Downloading… ' \+ percent \+ '%'\);/);
  assert.match(viewer, /saved_as: 'Saved\.'/);
});
