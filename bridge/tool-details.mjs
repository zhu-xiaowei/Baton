import fs from 'node:fs';
import { Worker } from 'node:worker_threads';
import { extractCodexMessages } from './codex-extract.mjs';
import { runtimeDescriptor, runtimeModules } from './session-identity.mjs';
import { compactToolFields, stripToolResultBase64, toolPreview, toolResultStats } from './tool-preview.mjs';

// History pages leave thinking text out; it is fetched like a tool, under this id.
function thinkingDetailId(messageUuid, blockIndex) {
  return `thinking:${messageUuid}:${blockIndex}`;
}

export function readToolIndex(filePath, nativeSessionId, runtime) {
  const tools = new Map();
  const messages = runtimeDescriptor(runtime) ? runtimeDescriptor(runtime).messages(filePath, nativeSessionId) : runtime === 'codex'
    ? extractCodexMessages(filePath, nativeSessionId).messages
    : fs.readFileSync(filePath, 'utf8').split('\n').flatMap((line) => {
      if (!line.trim()) return [];
      try {
        const raw = JSON.parse(line);
        return [{
          uuid: raw.uuid,
          content: raw.message?.content || raw.content,
          toolUseResult: raw.toolUseResult || raw.tool_use_result,
        }];
      } catch { return []; }
    });
  for (const message of messages) {
    for (const [index, block] of (Array.isArray(message.content) ? message.content : []).entries()) {
      if (block?.type === 'thinking' && message.uuid) {
        const id = thinkingDetailId(message.uuid, index);
        tools.set(id, { toolUse: { id, type: 'thinking', thinking: block.thinking || '' }, toolResult: null });
        continue;
      }
      if (!block || !['tool_use', 'tool_result'].includes(block.type)) continue;
      const id = block.type === 'tool_use' ? block.id : block.tool_use_id;
      if (!id) continue;
      if (!tools.has(id)) tools.set(id, { toolUse: null, toolResult: null });
      if (block.type === 'tool_use') {
        tools.get(id).toolUse = compactToolFields(block);
      } else if (!block.codexSuperseded) {
        const stats = toolResultStats(message.toolUseResult);
        tools.get(id).toolResult = compactToolFields({
          ...stripToolResultBase64(block),
          ...(stats ? { _agentMeta: stats } : {}),
        });
      }
    }
  }
  return tools;
}

// With `preview`, each tool is cut to its 500-character preview, as in a history row.
export function readToolDetails(filePath, nativeSessionId, runtime, toolUseIds, index, preview) {
  const tools = index || readToolIndex(filePath, nativeSessionId, runtime);
  const details = toolUseIds.map(id => tools.get(id));
  if (details.some(entry => !entry?.toolUse)) {
    throw new Error('Original tool details are not available yet.');
  }
  if (!preview) return { details };
  return { details: details.map(({ toolUse, toolResult }) => {
    const [use, result] = toolPreview({ content: [toolUse, ...(toolResult ? [toolResult] : [])] }).content;
    return { toolUse: use, toolResult: result || null };
  }) };
}

export function createToolDetailsReader(readIndex = readToolIndex) {
  let cached;
  return (filePath, nativeSessionId, runtime, toolUseIds, preview) => {
    // Rows sources (SQLite) have no file to version the cached index by.
    if (filePath.startsWith('rows:')) return readToolDetails(filePath, nativeSessionId, runtime, toolUseIds, null, preview);
    const stat = fs.statSync(filePath);
    const key = JSON.stringify([filePath, nativeSessionId, runtime, stat.size, stat.mtimeMs, stat.ctimeMs]);
    if (cached?.key !== key) cached = { key, index: readIndex(filePath, nativeSessionId, runtime) };
    return readToolDetails(filePath, nativeSessionId, runtime, toolUseIds, cached.index, preview);
  };
}

let readerWorker;
let requestSequence = 0;
const pending = new Map();

export function readToolDetailsAsync(filePath, nativeSessionId, runtime, toolUseIds, preview) {
  if (!readerWorker) {
    const worker = readerWorker = new Worker(new URL('./tool-details-worker.mjs', import.meta.url), { workerData: { runtimeModules: runtimeModules() } });
    const fail = error => {
      if (readerWorker !== worker) return;
      readerWorker = null;
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    };
    worker.on('error', fail);
    worker.on('exit', () => fail(new Error('Tool details reader stopped.')));
    worker.on('message', ({ id, result, error }) => {
      const request = pending.get(id);
      if (!request) return;
      pending.delete(id);
      if (error) request.reject(new Error(error));
      else request.resolve(result);
      if (!pending.size) worker.unref();
    });
    worker.unref();
  }
  readerWorker.ref();
  return new Promise((resolve, reject) => {
    const id = ++requestSequence;
    pending.set(id, { resolve, reject });
    readerWorker.postMessage({ id, filePath, nativeSessionId, runtime, toolUseIds, preview });
  });
}

// The `tool_details` direct RPC: full tool bodies (or, with `preview`, their previews) and thinking
// text from the original transcript. `resolve` maps a Session id to its file, as for `history`.
export async function toolDetails({ sessionId, toolUseIds, preview } = {}, resolve) {
  if (!Array.isArray(toolUseIds) || !toolUseIds.length || toolUseIds.length > 128
    || toolUseIds.some((id) => typeof id !== 'string' || !id || id.length > 512)) throw new Error('invalid toolUseIds');
  const target = resolve(String(sessionId || ''));
  if (!target) throw new Error('Original session file is unavailable.');
  return readToolDetailsAsync(target.file, target.nativeSessionId, target.runtime, toolUseIds, !!preview);
}
