// Requests whose reply arrives as frames made for the former control socket (files, Git, rename,
// delete): sent to the Bridge as a direct request, which answers `{ frames }`; each operation
// assembles its frames as before. Progress frames come as request progress.
import { state } from './state.js';
import { request as requestBridge } from './v2/direct-transport.js';

// Reads asked again get "not modified" from the Bridge while they are current.
var FRESH = { project_files: new Set(['list', 'browse']), git_status: new Set(['status', 'refs', 'history']) };
var answers = new Map();
var send = requestBridge; // (device, method, params, options) → Promise; tests replace it

export function configureWsRpc(next) {
  send = next || requestBridge;
}

export async function requestWsRpc(payload, options) {
  options = options || {};
  var { action, device, ...params } = payload;
  var fresh = FRESH[action]?.has(params.operation);
  var key = fresh ? JSON.stringify([state.SERVER, device, action, params]) : '';
  var known = key && answers.get(key);
  var reply;
  try {
    reply = await send(device ?? state.appState.device ?? '', action,
      fresh ? { ...params, known: known?.fingerprint || '' } : params, {
        onProgress: function (frame) { if (typeof options.onProgress === 'function') options.onProgress(frame); },
      });
  } catch (error) {
    throw new Error(error.message === 'timeout' ? 'Request timed out — device may be offline.'
      : error.message === 'offline' ? 'Bridge offline' : error.message);
  }
  if (reply.notModified && known) reply = known.reply;
  else if (key) {
    answers.delete(key);
    answers.set(key, { fingerprint: reply.fingerprint, reply: reply });
    if (answers.size > 100) answers.delete(answers.keys().next().value);
  }
  return assembleReply(reply.frames || [], options.assemble || assembleLastFrame);
}

function assembleReply(frames, assemble) {
  var failed = frames.find(function (frame) { return frame.ok === false; });
  // A Git snapshot that failed still carries its groups across frames.
  if (failed && !(Number.isInteger(failed.sequence) && Number.isInteger(failed.chunkCount) && failed.groups)) {
    var error = new Error(failed.error || 'Request failed.');
    error.response = failed;
    throw error;
  }
  var ordered = frames.some(function (frame) { return Number.isInteger(frame.sequence); })
    ? frames.slice().sort(function (left, right) { return left.sequence - right.sequence; })
    : frames;
  if (!ordered.length) throw new Error('Request failed.');
  var value = assemble(ordered);
  if (failed) {
    var snapshotError = new Error(failed.error || 'Request failed.');
    snapshotError.response = value;
    throw snapshotError;
  }
  return value;
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
