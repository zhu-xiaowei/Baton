// Stands in for the Bridge behind `requestWsRpc` (files, Git, rename, delete): each request is
// recorded as `{ action, ...params, device, requestId }`, and `answer(frame)` delivers a reply frame
// for it, as the Bridge's frames used to arrive. A reply completes at its last frame.
import { configureWsRpc } from '../../web/js/ws-rpc.js';

// `onRequest(request)` runs for each request (a test may answer it there).
export function mockBridgeFrames(configure = configureWsRpc, requests = [], onRequest) {
  configure((device, action, params, options) => new Promise((resolve, reject) => {
    const request = { action, ...params, device, requestId: `request-${requests.length + 1}`, frames: [], resolve, reject, options };
    requests.push(request);
    onRequest?.(request);
  }));
  function answer(frame) {
    const request = requests.find((item) => item.requestId === frame.requestId);
    if (!request) return false;
    if (frame.progress || frame.pending) {
      request.options?.onProgress?.(frame);
      return true;
    }
    request.frames.push(frame);
    const frames = request.frames;
    const final = frames.find((item) => item.complete);
    const count = frames.find((item) => Number.isInteger(item.chunkCount))?.chunkCount
      ?? (final ? final.sequence + 1 : Infinity);
    if (!Number.isInteger(frame.sequence) || frames.length >= count) request.resolve({ frames });
    return true;
  }
  return { requests, answer, fail: (index, error) => requests[index].reject(error) };
}
