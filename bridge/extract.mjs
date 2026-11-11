import fs from 'fs';
import crypto from 'crypto';
import sharp from 'sharp';
import { post } from './http.mjs';
import { VALID_TYPES } from './config.mjs';
import { stripToolResultBase64 } from './tool-preview.mjs';

// sessionId → next line the watcher reads; startup sets it to the end of every known file.
export const synced = new Map();

// jsonl line count matching the watcher's convention (drop a single trailing empty line).
export function countJsonlLines(filePath) {
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

// Fixed timestamp for uuid/timestamp-less metadata rows — keeps them identical across reads.
const META_EPOCH_TS = '1970-01-01T00:00:00.000Z';

// History pages are read again and again: each image is compressed and uploaded once per run.
const IMAGE_MEMO_LIMIT = 500;
const imageKeys = new Map(); // sha1(base64) → Promise<key>

function processImage(base64Data) {
  const id = crypto.createHash('sha1').update(base64Data).digest('hex');
  let job = imageKeys.get(id);
  if (!job) {
    if (imageKeys.size >= IMAGE_MEMO_LIMIT) imageKeys.delete(imageKeys.keys().next().value);
    job = compressAndUpload(base64Data).then(({ key, ok }) => {
      if (!ok) imageKeys.delete(id); // tried again next time
      return key;
    }, (error) => { imageKeys.delete(id); throw error; });
    imageKeys.set(id, job);
  }
  return job;
}

async function compressAndUpload(base64Data) {
  const buffer = Buffer.from(base64Data, 'base64');
  const compressed = await sharp(buffer)
    .resize(1280, 1280, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();

  const hashInput = Buffer.concat([compressed.subarray(0, 8192), Buffer.from(String(compressed.length))]);
  const hash = crypto.createHash('md5').update(hashInput).digest('hex');
  const key = `${hash}.jpg`;

  const res = await post('/api/bridge/upload-image', { key, data: compressed.toString('base64') });
  return { key, ok: !!res?.ok };
}

export async function extractForApp(msg) {
  msg = normalizeClaudeQueuedInput(msg);
  if (msg.type === 'ai-title' || msg.type === 'custom-title' || msg.type === 'last-prompt') {
    const content = msg.aiTitle || msg.customTitle || msg.lastPrompt || '';
    // Content-addressed uuid: every read of the same title yields the same row.
    const hash = crypto.createHash('sha1').update(`${msg.type}|${msg.sessionId || ''}|${content}`).digest('hex').slice(0, 16);
    return { uuid: `${msg.type}_${hash}`, type: msg.type, content, timestamp: META_EPOCH_TS };
  }

  let content = msg.message?.content ?? '';
  // Normalize \r → \n defensively (some inputs carry CR line endings)
  if (typeof content === 'string') {
    content = content.replace(/\r\n?/g, '\n');
  }
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
      // tool_result image base64 is unused by the app (it renders via S3 key) — strip it.
      if (block.type === 'tool_result') return stripToolResultBase64(block);
      // Normalize \r → \n in text blocks
      if (block.type === 'text' && block.text && /\r/.test(block.text)) {
        return { ...block, text: block.text.replace(/\r\n?/g, '\n') };
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
  // jsonl uses camelCase toolUseResult; headless stream uses snake_case — accept either.
  const tur = msg.toolUseResult ?? msg.tool_use_result;
  if (tur) extracted.toolUseResult = tur.file?.base64
    ? { ...tur, file: { ...tur.file, base64: '' } }
    : tur;
  if (msg.message?.stop_reason) extracted.stopReason = msg.message.stop_reason;
  return extracted;
}

export function normalizeClaudeQueuedInput(message) {
  // A compaction summary renders like Codex's: one collapsed "Context compacted" row.
  if (message?.type === 'user' && message.isCompactSummary) return { ...message, type: 'summary' };
  // Render system local_command output like the older <local-command-stdout> user row.
  if (message?.type === 'system' && message.subtype === 'local_command'
    && /^<local-command-stdout>/.test(message.content || '')) {
    return { ...message, type: 'user', message: { role: 'user', content: message.content } };
  }
  const attachment = message?.attachment;
  if (message?.type !== 'attachment' || attachment?.type !== 'queued_command'
    || !attachment.source_uuid) return message;
  return {
    ...message,
    type: 'user',
    uuid: attachment.source_uuid,
    message: { role: 'user', content: attachment.prompt ?? '' },
  };
}

export function nativeOrderKey(line, fragment = 0) {
  return `O2#${String(line).padStart(12, '0')}#${String(fragment).padStart(4, '0')}`;
}

export function isClaudeLocalCommandCaveat(msg) {
  const content = msg?.message?.content;
  return msg?.type === 'user'
    && msg.isMeta === true
    && typeof content === 'string'
    && content.trimStart().startsWith('<local-command-caveat>');
}

// One parsed JSONL line → the message to extract, or null. `metaUuids` carries the rule that a meta
// prompt hides the prompt answering it; shared by full extraction and the history reader.
export function claudeMessageLine(msg, metaUuids) {
  msg = normalizeClaudeQueuedInput(msg);
  if (!VALID_TYPES.has(msg.type)) return null;
  if (msg.isMeta && msg.type === 'user') {
    if (!isClaudeLocalCommandCaveat(msg)) metaUuids.add(msg.uuid);
    return null;
  }
  if (msg.isCompactSummary) metaUuids.add(msg.uuid);
  if (msg.type === 'user' && msg.parentUuid && metaUuids.has(msg.parentUuid)) {
    metaUuids.delete(msg.parentUuid);
    return null;
  }
  return msg;
}
