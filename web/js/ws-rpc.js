var DEFAULT_TIMEOUT = 20000;
var pendingRequests = new Map();

function requestUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  var bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (var index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  var hex = Array.from(bytes, function (value) {
    return value.toString(16).padStart(2, '0');
  }).join('');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-'
    + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
}

function armTimeout(requestId, pending) {
  if (pending.timer) clearTimeout(pending.timer);
  pending.timer = setTimeout(function () {
    pendingRequests.delete(requestId);
    pending.reject(new Error('Request timed out — device may be offline.'));
  }, pending.timeout);
}

function finish(requestId, pending, value, error) {
  pendingRequests.delete(requestId);
  if (pending.timer) clearTimeout(pending.timer);
  if (error) pending.reject(error);
  else pending.resolve(value);
}

function completeFrames(requestId, pending) {
  var finalSequence = pending.chunkCount != null
    ? pending.chunkCount - 1
    : pending.finalSequence;
  if (finalSequence == null) return false;
  var frames = [];
  for (var sequence = 0; sequence <= finalSequence; sequence++) {
    if (!pending.frames.has(sequence)) return false;
    frames.push(pending.frames.get(sequence));
  }
  var value = pending.assemble(frames);
  if (pending.frameError) {
    var error = new Error(pending.frameError.error || 'Request failed.');
    error.response = value;
    finish(requestId, pending, null, error);
  } else {
    finish(requestId, pending, value);
  }
  return true;
}

export function requestWsRpc(payload, options) {
  options = options || {};
  var requestId = requestUuid();
  return new Promise(function (resolve, reject) {
    var pending = {
      resolve: resolve,
      reject: reject,
      timer: null,
      timeout: options.timeout || DEFAULT_TIMEOUT,
      onProgress: options.onProgress,
      assemble: options.assemble || assembleLastFrame,
      frames: new Map(),
      chunkCount: null,
      finalSequence: null,
      frameError: null,
    };
    pendingRequests.set(requestId, pending);
    armTimeout(requestId, pending);
    window.wsSendReliable({ ...payload, requestId: requestId });
  });
}

export function handleWsRpcMessage(message) {
  var pending = message?.requestId && pendingRequests.get(message.requestId);
  if (!pending) return false;
  if (message.ok === false
    && Number.isInteger(message.sequence)
    && Number.isInteger(message.chunkCount)
    && message.groups) {
    pending.frameError = message;
  } else if (message.ok === false) {
    var error = new Error(message.error || 'Request failed.');
    error.response = message;
    finish(message.requestId, pending, null, error);
    return true;
  }
  if (message.progress) {
    if (typeof pending.onProgress === 'function') pending.onProgress(message);
    armTimeout(message.requestId, pending);
    return true;
  }
  if (Number.isInteger(message.sequence) && message.sequence >= 0) {
    pending.frames.set(message.sequence, message);
    if (Number.isInteger(message.chunkCount) && message.chunkCount > 0) {
      pending.chunkCount = message.chunkCount;
    }
    if (message.complete) pending.finalSequence = message.sequence;
    armTimeout(message.requestId, pending);
    completeFrames(message.requestId, pending);
    return true;
  }
  finish(message.requestId, pending, pending.assemble([message]));
  return true;
}

export function assembleLastFrame(frames) {
  return frames[frames.length - 1];
}

export function assembleTextFrames(frames) {
  // Large files arrive as an uploaded key without content frames.
  if (!frames.some(function (frame) { return typeof frame.content === 'string'; })) {
    return frames[frames.length - 1];
  }
  return {
    ...frames[frames.length - 1],
    content: frames.map(function (frame) { return frame.content || ''; }).join(''),
  };
}
