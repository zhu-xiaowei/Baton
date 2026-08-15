import { parentPort, workerData } from 'worker_threads';
import { scanClaudeStats } from './claude-usage.mjs';

try {
  const value = scanClaudeStats({
    projectsRoot: workerData.projectsRoot,
    now: workerData.now,
    useCache: false,
  });
  parentPort.postMessage({ ok: true, value });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error.message || String(error),
  });
}
