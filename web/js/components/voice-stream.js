// Streaming dictation for platforms without native speech (Android app, browsers): microphone PCM
// goes straight to Amazon Transcribe over a presigned WebSocket from /api/voice/stt-url, framed in
// AWS event-stream encoding. Nothing is recorded or stored on the way.

export const TARGET_RATE = 16000;
const CHUNK_BYTES = 3200;  // 100 ms of 16 kHz 16-bit mono

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeEvent(headers, payload) {
  const headerBytes = [];
  for (const [name, value] of Object.entries(headers)) {
    const n = encoder.encode(name);
    const v = encoder.encode(value);
    headerBytes.push(n.length, ...n, 7, v.length >> 8, v.length & 0xFF, ...v);
  }
  const total = 16 + headerBytes.length + payload.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, total);
  view.setUint32(4, headerBytes.length);
  view.setUint32(8, crc32(out.subarray(0, 8)));
  out.set(headerBytes, 12);
  out.set(payload, 12 + headerBytes.length);
  view.setUint32(total - 4, crc32(out.subarray(0, total - 4)));
  return out;
}

export function encodeAudioEvent(pcmBytes) {
  return encodeEvent({
    ':content-type': 'application/octet-stream',
    ':event-type': 'AudioEvent',
    ':message-type': 'event',
  }, pcmBytes);
}

export function decodeEvent(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const total = view.getUint32(0);
  const headersLength = view.getUint32(4);
  const headers = {};
  let i = 12;
  while (i < 12 + headersLength) {
    const nameLength = bytes[i++];
    const name = decoder.decode(bytes.subarray(i, i + nameLength));
    i += nameLength;
    const type = bytes[i++];
    if (type !== 7) throw new Error('Unsupported event-stream header type ' + type);
    const valueLength = view.getUint16(i);
    i += 2;
    headers[name] = decoder.decode(bytes.subarray(i, i + valueLength));
    i += valueLength;
  }
  return { headers, body: decoder.decode(bytes.subarray(12 + headersLength, total - 4)) };
}

// Float32 samples at `rate` -> 16 kHz little-endian Int16 bytes (box-filter decimation).
export function toPcm16(samples, rate) {
  const ratio = rate / TARGET_RATE;
  const length = Math.floor(samples.length / ratio);
  const out = new DataView(new ArrayBuffer(length * 2));
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.max(start + 1, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end && j < samples.length; j++) sum += samples[j];
    const value = Math.max(-1, Math.min(1, sum / (end - start)));
    out.setInt16(i * 2, value < 0 ? value * 0x8000 : value * 0x7FFF, true);
  }
  return new Uint8Array(out.buffer);
}

// Chinese segments join directly; Latin words keep a space between segments.
export function joinTranscript(left, right) {
  if (!left) return right;
  if (!right) return left;
  return /[A-Za-z0-9.,!?;:]$/.test(left) && /^[A-Za-z0-9]/.test(right) ? left + ' ' + right : left + right;
}

export function transcribeLanguage(locale) {
  const value = String(locale || '');
  if (/^zh[-_](TW|HK|Hant)/i.test(value)) return 'zh-TW';
  if (/^zh/i.test(value)) return 'zh-CN';
  if (/^[a-z]{2}-[A-Z]{2}$/.test(value)) return value;
  if (/^en/i.test(value)) return 'en-US';
  if (/^ja/i.test(value)) return 'ja-JP';
  return 'en-US';
}

// Collects Transcribe results into one cumulative transcript.
export function transcriptCollector() {
  let finals = '';
  let partial = '';
  let settled = false;  // the latest event finished an utterance and nothing new has started
  return {
    apply(body) {
      const results = JSON.parse(body || '{}').Transcript?.Results || [];
      for (const result of results) {
        const text = result.Alternatives?.[0]?.Transcript || '';
        if (result.IsPartial) { partial = text; settled = false; }
        else { finals = joinTranscript(finals, text); partial = ''; settled = true; }
      }
      return joinTranscript(finals, partial);
    },
    text: () => joinTranscript(finals, partial),
    settled: () => settled && !partial,
  };
}

const WORKLET = 'registerProcessor("baton-pcm-tap",class extends AudioWorkletProcessor{'
  + 'process(i){const c=i[0]&&i[0][0];if(c)this.port.postMessage(c.slice(0));return true}})';

// Opens mic -> AudioContext -> PCM chunks. `context` must be created inside the user gesture.
export async function captureMicrophone(context, stream, onChunk) {
  const source = context.createMediaStreamSource(stream);
  const sink = context.createGain();
  sink.gain.value = 0;
  sink.connect(context.destination);
  let pending = new Uint8Array(0);
  const push = samples => {
    const bytes = toPcm16(samples, context.sampleRate);
    const merged = new Uint8Array(pending.length + bytes.length);
    merged.set(pending);
    merged.set(bytes, pending.length);
    let offset = 0;
    for (; merged.length - offset >= CHUNK_BYTES; offset += CHUNK_BYTES) onChunk(merged.slice(offset, offset + CHUNK_BYTES));
    pending = merged.slice(offset);
  };
  let node;
  if (context.audioWorklet && typeof AudioWorkletNode === 'function') {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    try { await context.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    node = new AudioWorkletNode(context, 'baton-pcm-tap');
    node.port.onmessage = event => push(event.data);
  } else {
    node = context.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = event => push(event.inputBuffer.getChannelData(0));
  }
  source.connect(node);
  node.connect(sink);
  if (context.state === 'suspended') await context.resume();
  return function flush() {
    source.disconnect();
    node.disconnect();
    if (pending.length) onChunk(pending);
    pending = new Uint8Array(0);
  };
}
