import fs from 'fs';
import crypto from 'crypto';
import sharp from 'sharp';
import { post } from './http.mjs';
import { VALID_TYPES, MAX_POST_BYTES } from './config.mjs';

// Track sync position: sessionId → line number
export const synced = new Map();

async function processImage(base64Data) {
  const buffer = Buffer.from(base64Data, 'base64');
  const compressed = await sharp(buffer)
    .resize(720, 720, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();

  const hashInput = Buffer.concat([compressed.subarray(0, 8192), Buffer.from(String(compressed.length))]);
  const hash = crypto.createHash('md5').update(hashInput).digest('hex');
  const key = `${hash}.jpg`;

  await post('/api/bridge/upload-image', { key, data: compressed.toString('base64') });
  return key;
}

export async function extractForApp(msg) {
  // ai-title: special format
  if (msg.type === 'ai-title') {
    return {
      uuid: msg.sessionId || '',
      type: 'ai-title',
      content: msg.aiTitle || '',
      timestamp: msg.timestamp || '',
    };
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
      return block;
    });
  }
  return {
    uuid: msg.uuid || msg.leafUuid || '',
    parentUuid: msg.parentUuid || null,
    type: msg.type || '',
    content,
    timestamp: msg.timestamp || '',
  };
}

export async function readNewMessages(filePath, sessionId) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  const lastLine = synced.get(sessionId) ?? 0;
  const newMsgs = [];

  for (let i = lastLine; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let msg;
    try { msg = JSON.parse(lines[i]); } catch { continue; }
    if (!VALID_TYPES.has(msg.type)) continue;
    const extracted = await extractForApp(msg);
    if (extracted.uuid) newMsgs.push(extracted);
  }

  synced.set(sessionId, lines.length);
  return newMsgs;
}

// Read ALL messages from a session file (for on-demand sync)
export async function readAllMessages(filePath, sessionId) {
  synced.delete(sessionId); // Reset position to read from beginning
  return readNewMessages(filePath, sessionId);
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
