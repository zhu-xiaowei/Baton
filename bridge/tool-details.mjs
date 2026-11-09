import fs from 'node:fs';
import { Worker } from 'node:worker_threads';
import { extractCodexMessages } from './codex-extract.mjs';
import { compactToolFields, stripToolResultBase64, toolPreview, toolResultStats } from './tool-preview.mjs';

// History pages leave thinking text out; it is fetched like a tool, under this id.
function thinkingDetailId(messageUuid, blockIndex) {
  return `thinking:${messageUuid}:${blockIndex}`;
}

export function readToolIndex(filePath, nativeSessionId, runtime) {
  const tools = new Map();
  const messages = runtime === 'codex'
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

export function readToolDetails(filePath, nativeSessionId, runtime, toolUseIds, index) {
  const tools = index || readToolIndex(filePath, nativeSessionId, runtime);
  const details = toolUseIds.map(id => tools.get(id));
  if (details.some(entry => !entry?.toolUse)) {
    throw new Error('Original tool details are not available yet.');
  }
  return { details };
}

export function createToolDetailsReader(readIndex = readToolIndex) {
  let cached;
  return (filePath, nativeSessionId, runtime, toolUseIds) => {
    const stat = fs.statSync(filePath);
    const key = JSON.stringify([filePath, nativeSessionId, runtime, stat.size, stat.mtimeMs, stat.ctimeMs]);
    if (cached?.key !== key) cached = { key, index: readIndex(filePath, nativeSessionId, runtime) };
    return readToolDetails(filePath, nativeSessionId, runtime, toolUseIds, cached.index);
  };
}

let readerWorker;
let requestSequence = 0;
const pending = new Map();

export function readToolDetailsAsync(filePath, nativeSessionId, runtime, toolUseIds) {
  if (!readerWorker) {
    const worker = readerWorker = new Worker(new URL('./tool-details-worker.mjs', import.meta.url));
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
    readerWorker.postMessage({ id, filePath, nativeSessionId, runtime, toolUseIds });
  });
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SESSION_ID = new RegExp(`^(?:codex:${UUID}|${UUID}(?::subagent:agent-[A-Za-z0-9_-]+)?)$`, 'i');

// The `tool_details` direct RPC: full tool bodies (or, with `preview`, their 500-character previews)
// and thinking text from the original transcript.
export async function toolDetails({ sessionId, toolUseIds, preview } = {}, { identityOf, adapterOf }) {
  if (!SESSION_ID.test(String(sessionId || ''))) throw new Error('invalid session');
  if (!Array.isArray(toolUseIds) || !toolUseIds.length || toolUseIds.length > 128
    || toolUseIds.some((id) => typeof id !== 'string' || !id || id.length > 512)) throw new Error('invalid toolUseIds');
  const identity = identityOf(sessionId);
  const filePath = adapterOf(identity.runtime).findSessionFile(identity.nativeSessionId);
  if (!filePath) throw new Error('Original session file is unavailable.');
  const { details } = await readToolDetailsAsync(filePath, identity.nativeSessionId, identity.runtime, toolUseIds);
  if (!preview) return { details };
  return { details: details.map(({ toolUse, toolResult }) => {
    const [use, result] = toolPreview({ content: [toolUse, ...(toolResult ? [toolResult] : [])] }).content;
    return { toolUse: use, toolResult: result || null };
  }) };
}
