import fs from 'fs';
import crypto from 'crypto';
import sharp from 'sharp';
import { post } from './http.mjs';
import { VALID_TYPES, MAX_POST_BYTES } from './config.mjs';
import { isToolAllowed } from './permissions.mjs';

// Track sync position: sessionId → line number
export const synced = new Map();

async function processImage(base64Data) {
  const buffer = Buffer.from(base64Data, 'base64');
  const compressed = await sharp(buffer)
    .resize(1280, 1280, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();

  const hashInput = Buffer.concat([compressed.subarray(0, 8192), Buffer.from(String(compressed.length))]);
  const hash = crypto.createHash('md5').update(hashInput).digest('hex');
  const key = `${hash}.jpg`;

  await post('/api/bridge/upload-image', { key, data: compressed.toString('base64') });
  return key;
}

export async function extractForApp(msg, projectDir) {
  if (msg.type === 'ai-title' || msg.type === 'custom-title' || msg.type === 'last-prompt') {
    const content = msg.aiTitle || msg.customTitle || msg.lastPrompt || '';
    return { uuid: `${msg.type}_${Date.now()}`, type: msg.type, content, timestamp: msg.timestamp || new Date().toISOString() };
  }

  let content = msg.message?.content ?? '';
  if (Array.isArray(content)) {
    const imageJobs = [];
    for (let i = 0; i < content.length; i++) {
      if (content[i].type === 'image') {
        const b64 = content[i].source?.data || content[i].source?.bytes || '';
        if (b64) imageJobs.push({ index: i, promise: processImage(b64) });
      }
    }
    const results = await Promise.allSettled(imageJobs.map(j => j.promise));

    content = content.map((block, i) => {
      if (block.type === 'image') {
        const job = imageJobs.find(j => j.index === i);
        if (job) {
          const result = results[imageJobs.indexOf(job)];
          if (result.status === 'fulfilled') return { type: 'image', key: result.value };
          console.error(`Image upload failed: ${result.reason?.message}`);
        }
        return { type: 'image', placeholder: true };
      }
      // Mark tool_use blocks with needsPermission
      if (block.type === 'tool_use' && msg.type === 'assistant') {
        const allowed = isToolAllowed(block.name, block.input, projectDir);
        return { ...block, needsPermission: !allowed };
      }
      return block;
    });
  }
  const extracted = {
    uuid: msg.uuid || msg.leafUuid || '',
    parentUuid: msg.parentUuid || null,
    type: msg.type || '',
    content,
    timestamp: msg.timestamp || '',
  };
  if (msg.toolUseResult) extracted.toolUseResult = msg.toolUseResult;
  if (msg.message?.stop_reason) extracted.stopReason = msg.message.stop_reason;
  return extracted;
}

export async function readNewMessages(filePath, sessionId, projectDir) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  const lastLine = synced.get(sessionId) ?? 0;
  const newMsgs = [];
  const metaUuids = new Set();
  const metaIdx = {}; // type → index in newMsgs (keep only latest per type)

  for (let i = lastLine; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let msg;
    try { msg = JSON.parse(lines[i]); } catch { continue; }
    if (!VALID_TYPES.has(msg.type)) continue;
    if ((msg.isMeta || msg.isCompactSummary) && msg.type === 'user') { metaUuids.add(msg.uuid); continue; }
    if (msg.type === 'user' && msg.parentUuid && metaUuids.has(msg.parentUuid)) { metaUuids.delete(msg.parentUuid); continue; }
    const extracted = await extractForApp(msg, projectDir);
    if (!extracted.uuid) continue;
    if (extracted.type === 'ai-title' || extracted.type === 'custom-title' || extracted.type === 'last-prompt') {
      if (metaIdx[extracted.type] !== undefined) newMsgs[metaIdx[extracted.type]] = extracted;
      else { metaIdx[extracted.type] = newMsgs.length; newMsgs.push(extracted); }
      continue;
    }
    newMsgs.push(extracted);
  }

  synced.set(sessionId, lines.length);
  return newMsgs;
}

// Read ALL messages from a session file (for on-demand sync)
export async function readAllMessages(filePath, sessionId, projectDir) {
  synced.delete(sessionId); // Reset position to read from beginning
  return readNewMessages(filePath, sessionId, projectDir);
}

export async function uploadMessages(sessionId, messages) {
  if (messages.length === 0) return;
  let batch = [];
  let batchSize = 0;

  for (const msg of messages) {
    const msgJson = JSON.stringify(msg);
    if (batchSize + msgJson.length > MAX_POST_BYTES && batch.length > 0) {
      await post('/api/bridge/sync-messages', { sessionId, messages: batch });
      await new Promise(r => setTimeout(r, 200));
      batch = [];
      batchSize = 0;
    }
    batch.push(msg);
    batchSize += msgJson.length;
  }
  if (batch.length > 0) {
    await post('/api/bridge/sync-messages', { sessionId, messages: batch });
  }
}
