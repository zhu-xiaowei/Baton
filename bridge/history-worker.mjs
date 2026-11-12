import { parentPort, workerData } from 'node:worker_threads';
import { createHistoryPages } from './history-pages.mjs';
import { loadRuntimeModules } from './session-identity.mjs';

await loadRuntimeModules(workerData?.runtimeModules);

const pages = createHistoryPages();
let queue = Promise.resolve(); // one request at a time: an update must not land inside another's page

parentPort.on('message', ({ id, op, target, params }) => {
  queue = queue.then(async () => {
    try {
      parentPort.postMessage({ id, result: await pages[op](target, params) });
    } catch (error) {
      parentPort.postMessage({ id, error: error.message });
    }
  });
});
