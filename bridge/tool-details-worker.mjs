import { parentPort } from 'node:worker_threads';
import { createToolDetailsReader } from './tool-details.mjs';

const read = createToolDetailsReader();
parentPort.on('message', ({ id, filePath, nativeSessionId, runtime, toolUseIds }) => {
  try {
    parentPort.postMessage({ id, result: read(filePath, nativeSessionId, runtime, toolUseIds) });
  } catch (error) {
    parentPort.postMessage({ id, error: error.message });
  }
});
