import fs from 'fs';
import crypto from 'crypto';
import sharp from 'sharp';
import { post } from './http.mjs';
import { VALID_TYPES, MAX_POST_BYTES, DDB_ITEM_LIMIT } from './config.mjs';
import { isToolAllowed } from './permissions.mjs';

// Track sync position: sessionId → line number
export const synced = new Map();

const TRUNC_MARK = '\n…[truncated]';

// Fixed timestamp for uuid/timestamp-less metadata rows — keeps their DDB sk deterministic.
const META_EPOCH_TS = '1970-01-01T00:00:00.000Z';

// Walk a message and collect every string field, with a setter to replace it.
// Used to shrink oversized messages by trimming the longest strings first
// (tool results, large text/diff blocks) while keeping JSON structure intact.
function collectStrings(node, out) {
  if (typeof node !== 'object' || node === null) return;
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (typeof v === 'string') {
      out.push({ get: () => node[k], set: (s) => { node[k] = s; } });
    } else if (typeof v === 'object' && v !== null) {
      collectStrings(v, out);
    }
  }
}

// Return a structural clone of `msg` whose JSON byte size is <= maxBytes,
// preserving as much of each string's prefix as possible. Repeatedly trims the
// currently-longest string field (keeping its head + a truncation marker) until
// the whole message fits. Returns the message unchanged if already within limit.
export function truncateToBytes(msg, maxBytes) {
  if (Buffer.byteLength(JSON.stringify(msg)) <= maxBytes) return msg;
  const clone = JSON.parse(JSON.stringify(msg));
  const fields = [];
  collectStrings(clone, fields);
  // Trim longest-first; loop until it fits or no further reduction is possible.
  // Guard scales with field count: a message with many large strings may need
  // one pass per field to collapse them all.
  const maxIters = fields.length + 16;
  for (let guard = 0; guard < maxIters; guard++) {
    const over = Buffer.byteLength(JSON.stringify(clone)) - maxBytes;
    if (over <= 0) break;
    fields.sort((a, b) => b.get().length - a.get().length);
    const target = fields[0];
    const cur = target.get();
    if (!cur || cur.length <= TRUNC_MARK.length) break; // nothing left to trim
    // `over` is in bytes; convert to a char count using this string's own
    // bytes-per-char density so multibyte (CJK/emoji) text isn't over-trimmed.
    const bpc = Buffer.byteLength(cur) / cur.length;
    const dropChars = Math.ceil(over / bpc) + TRUNC_MARK.length + 16;
    const keep = Math.max(0, cur.length - dropChars);
    target.set(cur.slice(0, keep) + TRUNC_MARK);
  }
  return clone;
}

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
    // Content-addressed uuid so re-syncing overwrites one DDB item instead of accumulating (was Date.now()).
    const hash = crypto.createHash('sha1').update(`${msg.type}|${msg.sessionId || ''}|${content}`).digest('hex').slice(0, 16);
    return { uuid: `${msg.type}_${hash}`, type: msg.type, content, timestamp: META_EPOCH_TS };
  }

  let content = msg.message?.content ?? '';
  // Normalize \r → \n (tmux paste-buffer converts \n to \r in terminal input)
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
      // Mark tool_use blocks with needsPermission
      if (block.type === 'tool_use' && msg.type === 'assistant') {
        const allowed = isToolAllowed(block.name, block.input, projectDir);
        return { ...block, needsPermission: !allowed };
      }
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
  if (tur) extracted.toolUseResult = tur;
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

  for (const raw of messages) {
    // Cap each message under the DDB single-item limit before it ever hits DDB
    // (covers both the WS-oversize HTTP fallback and initial full sync).
    const msg = truncateToBytes(raw, DDB_ITEM_LIMIT);
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
