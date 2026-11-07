import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { decodeEvent, encodeEvent } from '../../web/js/components/voice-stream.js';

const dom = new JSDOM('<!doctype html><div id="input-bar"><div class="input-row">'
  + '<textarea id="msg-input" placeholder="Send a message..."></textarea>'
  + '<button id="mic-btn" style="display:none"></button></div></div>',
{ url: 'https://baton.test/', pretendToBeVisual: true });
const { window } = dom;
Object.assign(globalThis, { window, document: window.document, navigator: window.navigator, Event: window.Event });

const sockets = [];
class FakeSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
  send(data) { this.sent.push(decodeEvent(data)); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  result(text, partial) {
    const body = JSON.stringify({ Transcript: { Results: [{ IsPartial: partial, Alternatives: [{ Transcript: text }] }] } });
    this.onmessage?.({ data: encodeEvent({ ':message-type': 'event', ':event-type': 'TranscriptEvent' }, new TextEncoder().encode(body)).buffer });
  }
}
let processor;
class FakeAudioContext {
  sampleRate = 48000; state = 'running'; destination = {};
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createGain() { return { gain: {}, connect() {} }; }
  createScriptProcessor() { processor = { connect() {}, disconnect() {} }; return processor; }
  close() { this.state = 'closed'; return Promise.resolve(); }
}
const tracks = [];
let micError = null;
Object.defineProperty(window.navigator, 'mediaDevices', { value: {
  getUserMedia: async () => {
    if (micError) throw micError;
    const track = { stopped: false, stop() { this.stopped = true; } };
    tracks.push(track);
    return { getTracks: () => [track] };
  },
} });
Object.assign(window, { WebSocket: FakeSocket, AudioContext: FakeAudioContext });
globalThis.WebSocket = FakeSocket;
const posts = [];
window.apiPost = async (path, body) => { posts.push({ path, body }); return { url: 'wss://transcribe.test/x' }; };
let voiceOn = true;
let settings = { autoSend: false };
window.voiceModeActive = () => voiceOn;
window.voiceSettings = () => settings;
const sends = [];
window.onSendBtnClick = () => sends.push(document.getElementById('msg-input').value);

await import('../../web/js/components/voice.js');
const input = document.getElementById('msg-input');
const mic = document.getElementById('mic-btn');
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
const press = type => mic.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
window.PointerEvent ??= window.MouseEvent;

function reset() {
  sockets.length = 0; posts.length = 0; sends.length = 0; tracks.length = 0;
  micError = null; voiceOn = true; settings = { autoSend: false };
  input.value = '';
  window.initVoiceButton();
}

test('the mic shows only in voice mode outside iOS', () => {
  reset();
  voiceOn = false;
  window.initVoiceButton();
  assert.equal(mic.style.display, 'none');
  voiceOn = true;
  window.updateMicButton();
  assert.equal(mic.style.display, 'flex');
});

test('dictation asks for automatic language identification by default', async () => {
  reset();
  press('pointerdown');
  await settle();
  assert.deepEqual(posts[0], { path: '/api/voice/stt-url', body: { language: 'auto' } });
  press('pointerdown');
  sockets[0].close();
});

test('hold to talk streams PCM and fills the composer without sending', async (t) => {
  reset();
  settings = { autoSend: false, language: 'zh-CN' };
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  input.value = '前缀 ';
  press('pointerdown');
  await settle();
  assert.deepEqual(posts, [{ path: '/api/voice/stt-url', body: { language: 'zh-CN' } }]);
  assert.equal(input.placeholder, 'Listening…');
  assert.ok(mic.classList.contains('recording'));
  const socket = sockets[0];
  socket.open();
  await settle();
  processor.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(4800).fill(0.1) } });
  assert.equal(socket.sent.length, 1);
  assert.equal(socket.sent[0].headers[':event-type'], 'AudioEvent');
  socket.result('帮我看', true);
  assert.equal(input.value, '前缀 帮我看');
  socket.result('帮我看一下。', false);
  socket.result('然后', true);
  assert.equal(input.value, '前缀 帮我看一下。然后');
  t.mock.timers.tick(800);
  press('pointerup');
  assert.equal(mic.classList.contains('recording'), false);
  assert.equal(socket.sent.at(-1).body, '');
  assert.ok(tracks[0].stopped);
  socket.result('然后跑测试。', false);
  socket.close();
  assert.equal(input.value, '前缀 帮我看一下。然后跑测试。');
  assert.equal(input.placeholder, 'Send a message...');
  assert.deepEqual(sends, []);
});

test('a quick tap keeps listening until the next tap, then can auto-send', async (t) => {
  reset();
  settings = { autoSend: true, language: 'en-US' };
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  press('pointerdown');
  t.mock.timers.tick(100);
  press('pointerup');
  await settle();
  assert.ok(mic.classList.contains('recording'));
  const socket = sockets[0];
  socket.open();
  await settle();
  socket.result('提交吧。', false);
  press('pointerdown');
  press('pointerup');
  socket.close();
  t.mock.timers.tick(0);
  assert.deepEqual(sends, ['提交吧。']);
});

test('auto language starts a fresh stream after each utterance and keeps the order', async (t) => {
  reset();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  press('pointerdown');
  await settle();
  assert.equal(posts.length, 2, 'first URL plus a spare for the next utterance');
  const first = sockets[0];
  first.open();
  const audio = () => processor.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(4800).fill(0.1) } });
  audio();
  assert.equal(first.sent.length, 1);
  first.result('先说中文', true);
  first.result('先说中文。', false);
  await settle();
  assert.equal(first.sent.at(-1).body, '', 'the finished utterance ends its stream');
  const second = sockets[1];
  assert.ok(second, 'next utterance connects with the spare URL');
  audio();
  assert.equal(second.sent.length, 0, 'audio waits while the new stream connects');
  second.open();
  assert.equal(second.sent.length, 1, 'queued audio is sent once it opens');
  first.close();
  second.result('Then English', true);
  assert.equal(input.value, '先说中文。Then English');
  t.mock.timers.tick(800);
  press('pointerup');
  assert.equal(second.sent.at(-1).body, '');
  second.result('Then English.', false);
  second.close();
  assert.equal(input.value, '先说中文。Then English.');
  assert.equal(mic.classList.contains('recording'), false);
});

test('a fixed language keeps one stream across utterances', async (t) => {
  reset();
  settings = { autoSend: false, language: 'zh-CN' };
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  press('pointerdown');
  await settle();
  sockets[0].open();
  sockets[0].result('第一句。', false);
  sockets[0].result('第二句。', false);
  await settle();
  assert.equal(sockets.length, 1);
  assert.equal(posts.length, 1);
  press('pointerdown');
  sockets[0].close();
  assert.equal(input.value, '第一句。第二句。');
});

test('a chosen dictation language overrides the device locale', async () => {
  reset();
  settings = { autoSend: false, language: 'zh-CN' };
  press('pointerdown');
  await settle();
  assert.deepEqual(posts[0].body, { language: 'zh-CN' });
  press('pointerdown');
  sockets[0].close();
});

test('System follows the device locale', async () => {
  reset();
  settings = { autoSend: false, language: 'system' };
  press('pointerdown');
  await settle();
  assert.deepEqual(posts[0].body, { language: 'en-US' });
  press('pointerdown');
  sockets[0].close();
});

test('microphone permission denial stops cleanly', async () => {
  reset();
  micError = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
  press('pointerdown');
  await settle();
  assert.equal(mic.classList.contains('recording'), false);
  assert.match(document.querySelector('.toast').textContent, /Microphone permission/);
  assert.equal(sockets.length, 0);
});
