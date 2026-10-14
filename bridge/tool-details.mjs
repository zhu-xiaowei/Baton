import fs from 'node:fs';
import { extractCodexMessages } from './codex-extract.mjs';
import { sendTextFrames } from './project/ws-frames.mjs';
import { stripToolResultBase64 } from './extract.mjs';
import { compactToolFields, toolResultStats } from './tool-preview.mjs';

export function readToolDetails(filePath, nativeSessionId, runtime, toolUseIds) {
  const requested = new Map(toolUseIds.map((id) => [id, { toolUse: null, toolResult: null }]));
  const messages = runtime === 'codex'
    ? extractCodexMessages(filePath, nativeSessionId).messages
    : fs.readFileSync(filePath, 'utf8').split('\n').flatMap((line) => {
      if (!line.trim()) return [];
      try {
        const raw = JSON.parse(line);
        return [{
          content: raw.message?.content || raw.content,
          toolUseResult: raw.toolUseResult || raw.tool_use_result,
        }];
      } catch { return []; }
    });
  for (const message of messages) {
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block.type === 'tool_use' && requested.has(block.id)) {
        requested.get(block.id).toolUse = compactToolFields(block);
      } else if (block.type === 'tool_result' && requested.has(block.tool_use_id)
        && !block.codexSuperseded) {
        const stats = toolResultStats(message.toolUseResult);
        requested.get(block.tool_use_id).toolResult = compactToolFields({
          ...stripToolResultBase64(block),
          ...(stats ? { _agentMeta: stats } : {}),
        });
      }
    }
  }
  if ([...requested.values()].some((entry) => !entry.toolUse)) {
    throw new Error('Original tool details are not available yet.');
  }
  return { details: [...requested.values()] };
}

export function handleToolDetails(message, { adapter, identity, send }) {
  const envelope = {
    action: 'tool_details',
    requestId: message.requestId,
    replyConnectionId: message.replyConnectionId,
    sessionId: identity.sessionId,
  };
  try {
    const filePath = adapter.findSessionFile(identity.nativeSessionId);
    if (!filePath) throw new Error('Original session file is unavailable.');
    const details = readToolDetails(filePath, identity.nativeSessionId, identity.runtime, message.toolUseIds);
    sendTextFrames({ ...envelope, ok: true }, JSON.stringify(details), send);
  } catch (error) {
    send({ ...envelope, ok: false, error: error.message });
  }
}
