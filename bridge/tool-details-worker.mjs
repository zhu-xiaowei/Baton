import { parentPort, workerData } from 'node:worker_threads';
import { createToolDetailsReader } from './tool-details.mjs';
import { loadRuntimeModules } from './session-identity.mjs';

await loadRuntimeModules(workerData?.runtimeModules);

const read = createToolDetailsReader();
parentPort.on('message', ({ id, filePath, nativeSessionId, runtime, toolUseIds, preview }) => {
  try {
    parentPort.postMessage({ id, result: read(filePath, nativeSessionId, runtime, toolUseIds, preview) });
  } catch (error) {
    parentPort.postMessage({ id, error: error.message });
  }
});
