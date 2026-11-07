import assert from 'node:assert/strict';
import test from 'node:test';
import {
  crc32, decodeEvent, encodeAudioEvent, encodeEvent, joinTranscript, toPcm16,
  transcribeLanguage, transcriptCollector,
} from '../../web/js/components/voice-stream.js';

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
});

test('audio events use AWS event-stream framing', () => {
  const payload = new Uint8Array([1, 2, 3, 4]);
  const frame = encodeAudioEvent(payload);
  const view = new DataView(frame.buffer);
  assert.equal(view.getUint32(0), frame.length);
  assert.equal(view.getUint32(8), crc32(frame.subarray(0, 8)));
  assert.equal(view.getUint32(frame.length - 4), crc32(frame.subarray(0, frame.length - 4)));
  const decoded = decodeEvent(frame);
  assert.deepEqual(decoded.headers, {
    ':content-type': 'application/octet-stream', ':event-type': 'AudioEvent', ':message-type': 'event',
  });
  assert.deepEqual([...frame.subarray(frame.length - 8, frame.length - 4)], [1, 2, 3, 4]);
});

test('decodes Transcribe transcript and exception events', () => {
  const body = new TextEncoder().encode('{"Transcript":{"Results":[]}}');
  const event = decodeEvent(encodeEvent({ ':message-type': 'event', ':event-type': 'TranscriptEvent' }, body));
  assert.equal(event.headers[':event-type'], 'TranscriptEvent');
  assert.equal(event.body, '{"Transcript":{"Results":[]}}');
  const error = decodeEvent(encodeEvent({ ':message-type': 'exception', ':exception-type': 'BadRequestException' },
    new TextEncoder().encode('{"Message":"bad"}')));
  assert.equal(error.headers[':exception-type'], 'BadRequestException');
});

test('downsamples float audio to 16 kHz little-endian PCM', () => {
  const samples = new Float32Array(480).fill(0.5);
  const pcm = toPcm16(samples, 48000);
  assert.equal(pcm.length, 160 * 2);
  const view = new DataView(pcm.buffer);
  assert.equal(view.getInt16(0, true), Math.trunc(0.5 * 0x7FFF));
  assert.equal(new DataView(toPcm16(new Float32Array([-2]), 16000).buffer).getInt16(0, true), -0x8000);
});

test('transcript collector keeps finals and the live partial', () => {
  const collector = transcriptCollector();
  const result = (text, partial) => JSON.stringify({ Transcript: { Results: [{ IsPartial: partial, Alternatives: [{ Transcript: text }] }] } });
  assert.equal(collector.apply(result('帮我看', true)), '帮我看');
  assert.equal(collector.apply(result('帮我看一下。', false)), '帮我看一下。');
  assert.equal(collector.apply(result('然后', true)), '帮我看一下。然后');
  assert.equal(collector.apply(result('然后跑测试。', false)), '帮我看一下。然后跑测试。');
  assert.equal(collector.apply('{}'), '帮我看一下。然后跑测试。');
});

test('collector reports when an utterance has settled', () => {
  const collector = transcriptCollector();
  const result = (text, partial) => JSON.stringify({ Transcript: { Results: [{ IsPartial: partial, Alternatives: [{ Transcript: text }] }] } });
  assert.equal(collector.settled(), false);
  collector.apply(result('先说', true));
  assert.equal(collector.settled(), false);
  collector.apply(result('先说中文。', false));
  assert.equal(collector.settled(), true);
  collector.apply(result('然后', true));
  assert.equal(collector.settled(), false);
});

test('joins Latin segments with a space and Chinese directly', () => {
  assert.equal(joinTranscript('Run the tests.', 'Then deploy.'), 'Run the tests. Then deploy.');
  assert.equal(joinTranscript('先测试。', '再部署。'), '先测试。再部署。');
  assert.equal(joinTranscript('', 'x'), 'x');
});

test('maps device locales to Transcribe language codes', () => {
  assert.equal(transcribeLanguage('zh-CN'), 'zh-CN');
  assert.equal(transcribeLanguage('zh-Hans-CN'), 'zh-CN');
  assert.equal(transcribeLanguage('zh-TW'), 'zh-TW');
  assert.equal(transcribeLanguage('en'), 'en-US');
  assert.equal(transcribeLanguage('ja'), 'ja-JP');
  assert.equal(transcribeLanguage(''), 'en-US');
});
