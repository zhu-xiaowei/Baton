// Warm-up worker for session-index.mjs: one summary per file, posted in batches.
import { parentPort, workerData } from 'worker_threads';
import { summarize } from './session-summary.mjs';

const BATCH = 200;
let batch = [];
for (const [file, runtime, id] of workerData.files) {
  let state = null;
  try { state = summarize(file, runtime, id); } catch {}
  batch.push([file, state]);
  if (batch.length >= BATCH) { parentPort.postMessage(batch); batch = []; }
}
if (batch.length) parentPort.postMessage(batch);
