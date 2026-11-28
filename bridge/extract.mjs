import fs from 'fs';
import crypto from 'crypto';
import sharp from 'sharp';
import { isMainThread } from 'node:worker_threads';
import { reusable, transfer, transferKeys } from './transfer-store.mjs';
import { VALID_TYPES } from './config.mjs';

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

// History pages are read again and again: each image is compressed at most every 30 minutes.
const imageKeys = transferKeys(500); // sha1(base64) → Promise<key>

function processImage(base64Data) {
  const id = crypto.createHash('sha1').update(base64Data).digest('hex');
  let job = imageKeys.get(id);
  if (!job) {
    job = limited(() => compressAndUpload(base64Data)).then(({ key, ok }) => {
      if (!ok) imageKeys.delete(id); // tried again next time
      return key;
    }, (error) => { imageKeys.delete(id); throw error; });
    imageKeys.set(id, job);
  }
  return job;
}

// At most 4 images are compressed and uploaded at a time; a free slot passes to the next waiting one.
let active = 0;
const waiting = [];
async function limited(job) {
  if (active < 4) active++; else await new Promise((resolve) => waiting.push(resolve));
  try { return await job(); } finally { if (waiting.length) waiting.shift()(); else active--; }
}

const UPLOAD_TIMEOUT_MS = 30_000; // a stalled upload fails, so the rows waiting for it go out

async function compressAndUpload(base64Data) {
  const buffer = Buffer.from(base64Data, 'base64');
  const compressed = await sharp(buffer)
    .resize(1280, 1280, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();

  const hashInput = Buffer.concat([compressed.subarray(0, 8192), Buffer.from(String(compressed.length))]);
  const hash = crypto.createHash('md5').update(hashInput).digest('hex');
  const key = await transfer.keyFor(hash, '.jpg');

  try {
    let timer;
    const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), UPLOAD_TIMEOUT_MS); });
    await Promise.race([(async () => {
      if (!reusable(await transfer.head(key))) await transfer.put(key, compressed, { contentType: 'image/jpeg' });
    })(), late]).finally(() => clearTimeout(timer));
    return { key, ok: true };
  } catch {
    return { key, ok: false };
  }
}

// An image's bytes: inline base64, a local file (Codex view_image, Hermes MEDIA:), or a data URI.
function imageData(b) {
  if (b.source?.data || b.source?.bytes) return b.source.data || b.source.bytes;
  try { if (b.path && fs.statSync(b.path).size <= 20 << 20) return fs.readFileSync(b.path).toString('base64'); } catch {}
  return /^data:image\/[\w.+-]+;base64,(.+)$/s.exec(b.image_url || '')?.[1] || '';
}

// Message and tool-result images become uploaded keys. Only the main thread reaches storage, so a
// worker leaves the bytes for it (history-service, tool_details and the live exits convert them).
export async function withImageKeys(content) {
  if (!Array.isArray(content) || !isMainThread) return content;
  return Promise.all(content.map(async (b) => {
    if (b?.type === 'tool_result' && Array.isArray(b.content)) return { ...b, content: await withImageKeys(b.content) };
    if (b?.type !== 'image') return b;
    if (b.key) { const { path, ...rest } = b; return rest; } // never a local path to the App
    const data = imageData(b);
    try { if (data) return { type: 'image', key: await processImage(data) }; } catch (e) { console.error(`Image upload failed: ${e.message}`); }
    return { type: 'image', placeholder: true };
  }));
}

const pendingImage = (b) => (b?.type === 'image' ? !!(b.source || b.image_url || b.path)
  : b?.type === 'tool_result' && Array.isArray(b.content) && b.content.some(pendingImage));
export const hasPendingImages = (rows) => rows.some((row) => Array.isArray(row?.content) && row.content.some(pendingImage));

export async function rowsWithImageKeys(rows) {
  await Promise.all(rows.map(async (row) => { row.content = await withImageKeys(row.content); }));
  return rows;
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
    content = await withImageKeys(content.map((block) => (block.type === 'text' && block.text && /\r/.test(block.text)
      ? { ...block, text: block.text.replace(/\r\n?/g, '\n') } : block)));
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
