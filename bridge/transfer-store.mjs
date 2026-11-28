// Files between the App and its Bridges travel through S3 / R2 at t/<accountId>/<key>, which a lifecycle
// rule empties after 7 days (1 day on Cloudflare): a transfer channel, not storage. Both sides sign their own requests
// (SigV4 query authentication) with the temporary credentials the server issues for this account
// only, so no file or URL goes through Lambda. Used by the Bridge (Node) and the App (browser).

const encoder = new TextEncoder();
const KEY = /^[0-9a-f]{8,64}(?:\.[a-z0-9]{1,16})?$/;
const MAX_EXPIRES = 3600;
// Objects expire 1 hour after they were written on Cloudflare (R2 checks about hourly), 7 days on S3.
// One older than its store's reuse window is written again, and a key is remembered for REMEMBER_MS
// (`transferKeys`), so a key handed out still has ≥ 15 min for the App to read it (ranges while open).
const REUSE_MS = { r2: 30 * 60_000, s3: 21.5 * 3600_000 };
const REMEMBER_MS = 15 * 60_000;
export const reusable = (object) => !!object && Date.now() - object.modified < object.reuse;
// A single PUT holds at most 5 GiB; the sealing overhead stays below it.
export const PUT_MAX = 5e9;
export const transferKeys = (limit) => recentKeys(limit, REMEMBER_MS);

export const IMAGE_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon',
};
const PREVIEW_TYPES = {
  pdf: 'application/pdf', ...IMAGE_TYPES,
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', webm: 'video/webm',
  mkv: 'video/x-matroska', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg',
};

const extension = (key) => (key.includes('.') ? key.slice(key.lastIndexOf('.') + 1).toLowerCase() : '');
export const previewType = (key) => PREVIEW_TYPES[extension(key)] || 'application/octet-stream';
const OFFICE = /^(docx|pptx|xlsx|doc|ppt|xls)$/;

// With K, every file is sealed in 64 KiB records (STREAM: each nonce ‖ AES-GCM ‖ tag, AAD = key |
// index | last), so any range can be read. They carry `x-amz-meta-sealed: 1` and are keyed by
// HMAC(content hash), so dedup stays within the account.
export const RECORD = 64 * 1024;
const SEALED_RECORD = RECORD + 28;
const records = (stored) => Math.max(1, Math.ceil(stored / SEALED_RECORD));
export const plainSize = (stored) => Math.max(0, stored - 28 * records(stored));
const sealedSize = (size) => size + 28 * Math.max(1, Math.ceil(size / RECORD));
// Files written before the account had K are read as they are for the 7 days S3 keeps them.
const PLAIN_GRACE_MS = 7 * 86400_000;
let fileKeys = () => null;
// `next()` resolves { key: AES-GCM CryptoKey, id: HMAC CryptoKey, since: when K arrived } or null.
export function setTransferKeys(next) { fileKeys = next; }
// An unmarked file: only one written before K, within the grace.
async function plainRefused() {
  const keys = await fileKeys();
  return !!keys && !(Date.now() - keys.since < PLAIN_GRACE_MS);
}
const recordAad = (key, index, count) => encoder.encode(`${key}|${index}|${index === count - 1 ? 1 : 0}`);
const join = (a, b) => { if (!a.length) return b; const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out; };

// Views of `unit` bytes each (the last may be shorter); each chunk is copied at most once.
async function* split(chunks, unit) {
  let buffer = new Uint8Array(0);
  let at = 0;
  for await (const chunk of chunks) {
    buffer = join(buffer.subarray(at), chunk);
    for (at = 0; buffer.length - at >= unit; at += unit) yield buffer.subarray(at, at + unit);
  }
  if (at < buffer.length) yield buffer.subarray(at);
}

async function* chunksOf(body) {
  const reader = body.getReader();
  try {
    for (let next; !(next = await reader.read()).done;) yield next.value;
  } finally {
    reader.cancel().catch(() => {});
  }
}

async function sealRecord(keys, key, plain, index, total) {
  const out = new Uint8Array(plain.length + 28);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  out.set(nonce);
  out.set(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: recordAad(key, index, total) },
    keys.key, plain)), 12);
  return out;
}

// `body` holds records from `first` of a file with `total` records (a multipart part), or a whole file.
async function sealBytes(keys, key, body, first = 0, total) {
  const bytes = new Uint8Array(await new Response(body).arrayBuffer());
  const count = Math.max(1, Math.ceil(bytes.length / RECORD));
  const out = new Uint8Array(sealedSize(bytes.length));
  for (let i = 0; i < count; i++) {
    out.set(await sealRecord(keys, key, bytes.subarray(i * RECORD, (i + 1) * RECORD), first + i, total ?? count), i * SEALED_RECORD);
  }
  return out;
}

// Seals `source` (byte chunks, `size` in all) as it is read. The last record waits for the source to
// end, so a source that throws there (content check) leaves the upload short and S3 stores nothing.
export async function* sealStream(keys, key, size, source) {
  const total = Math.max(1, Math.ceil(size / RECORD));
  let held = new Uint8Array(0);
  let index = 0;
  let read = 0;
  for await (const record of split(source, RECORD)) {
    if (read + record.length > size) throw new Error('File changed while uploading');
    if (read) yield await sealRecord(keys, key, held, index++, total);
    held = record;
    read += record.length;
  }
  if (read !== size) throw new Error('File changed while uploading');
  yield await sealRecord(keys, key, held, total - 1, total);
}

// `bytes` are whole records starting at record `first` of `count`.
async function openRecords(keys, key, bytes, first, count) {
  if (bytes.length < 28) throw new Error('Sealed file is truncated');
  const out = new Uint8Array(bytes.length - 28 * Math.ceil(bytes.length / SEALED_RECORD));
  for (let at = 0, i = first; at < bytes.length; at += SEALED_RECORD, i++) {
    const record = bytes.subarray(at, at + SEALED_RECORD);
    out.set(new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.subarray(0, 12), additionalData: recordAad(key, i, count) },
      keys.key, record.subarray(12))), (i - first) * RECORD);
  }
  return out;
}

const opened = new Map(); // key → Blob URL of the opened file (browser), the newest 32
function blobUrl(key, bytes, type) {
  if (!opened.has(key)) {
    opened.set(key, URL.createObjectURL(new Blob([bytes], { type })));
    if (opened.size > 32) { const [old, url] = opened.entries().next().value; opened.delete(old); URL.revokeObjectURL(url); }
  }
  return opened.get(key);
}

function hex(bytes) {
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(text) {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

async function hmac(key, text) {
  const imported = await crypto.subtle.importKey('raw', typeof key === 'string' ? encoder.encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', imported, encoder.encode(text));
}

const rfc3986 = (value) => encodeURIComponent(value)
  .replace(/[!'()*]/g, (character) => '%' + character.charCodeAt(0).toString(16).toUpperCase());

// SigV4 query authentication for one S3 request; the caller sends exactly `headers` with it.
export async function signUrl({ method, host, path, region, credentials, expires, headers = {}, query = {}, now = new Date() }) {
  const stamp = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = stamp.slice(0, 8);
  const scope = `${date}/${region}/s3/aws4_request`;
  const signed = { host };
  for (const [name, value] of Object.entries(headers)) signed[name.toLowerCase()] = String(value).trim();
  const names = Object.keys(signed).sort();
  const params = {
    ...query,
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${credentials.accessKeyId}/${scope}`,
    'X-Amz-Date': stamp,
    'X-Amz-Expires': String(expires),
    ...(credentials.sessionToken ? { 'X-Amz-Security-Token': credentials.sessionToken } : {}),
    'X-Amz-SignedHeaders': names.join(';'),
  };
  const canonicalQuery = Object.keys(params).map((name) => [rfc3986(name), rfc3986(params[name])])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, value]) => `${name}=${value}`).join('&');
  const canonical = [method, path, canonicalQuery, names.map((name) => `${name}:${signed[name]}\n`).join(''),
    names.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
  let signingKey = await hmac(`AWS4${credentials.secretAccessKey}`, date);
  for (const part of [region, 's3', 'aws4_request']) signingKey = await hmac(signingKey, part);
  const signature = hex(await hmac(signingKey, `AWS4-HMAC-SHA256\n${stamp}\n${scope}\n${await sha256Hex(canonical)}`));
  return `https://${host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

// SigV4 header authentication for one AWS API request (the server's DynamoDB, STS, API Gateway and
// push relay calls): the headers to send besides `headers`. The day's signing key is derived once.
const signingKeys = new Map();
export async function signHeaders({ method, url, region, service, credentials, headers = {}, body = '', now = new Date() }) {
  const target = new URL(url);
  const stamp = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = stamp.slice(0, 8);
  const scope = `${date}/${region}/${service}/aws4_request`;
  const added = { 'x-amz-date': stamp, ...(credentials.sessionToken ? { 'x-amz-security-token': credentials.sessionToken } : {}) };
  const signed = { host: target.host, ...added };
  for (const [name, value] of Object.entries(headers)) signed[name.toLowerCase()] = String(value).trim().replace(/\s+/g, ' ');
  const names = Object.keys(signed).sort();
  const query = [...target.searchParams].map(([name, value]) => [rfc3986(name), rfc3986(value)])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0)).map((pair) => pair.join('=')).join('&');
  // Non-S3 services sign the path as sent, encoded once more.
  const path = target.pathname.split('/').map(rfc3986).join('/');
  const canonical = [method, path, query, names.map((name) => `${name}:${signed[name]}\n`).join(''),
    names.join(';'), await sha256Hex(body)].join('\n');
  const id = `${credentials.accessKeyId}/${scope}`;
  if (!signingKeys.has(id)) {
    if (signingKeys.size > 16) signingKeys.clear();
    signingKeys.set(id, (async () => {
      let key = await hmac(`AWS4${credentials.secretAccessKey}`, date);
      for (const part of [region, service, 'aws4_request']) key = await hmac(key, part);
      return crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    })());
  }
  const toSign = `AWS4-HMAC-SHA256\n${stamp}\n${scope}\n${await sha256Hex(canonical)}`;
  const signature = hex(await crypto.subtle.sign('HMAC', await signingKeys.get(id), encoder.encode(toSign)));
  return { ...added, authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}

// A URL for `t/<accountId>/<key>`. `access` is { bucket, region, accountId, accelerate, endpoint?,
// credentials: { accessKeyId, secretAccessKey, sessionToken, expiresAt } }. With `endpoint` (R2) the
// bucket goes in the path.
export async function presign(access, method, key, { headers = {}, query = {}, accelerate = false, now = new Date() } = {}) {
  if (!KEY.test(key)) throw new Error('Invalid file key');
  const { bucket, region, accountId, credentials, endpoint } = access;
  const expires = Math.min(MAX_EXPIRES, Math.floor(credentials.expiresAt - now.getTime() / 1000) - 5);
  if (expires < 1) throw new Error('Storage credentials expired');
  const path = `/t/${rfc3986(accountId)}/${rfc3986(key)}`;
  return signUrl({
    method, region, credentials, expires, headers, query, now,
    ...(endpoint ? { host: new URL(endpoint).host, path: `/${rfc3986(bucket)}${path}` }
      : { host: accelerate ? `${bucket}.s3-accelerate.amazonaws.com` : `${bucket}.s3.${region}.amazonaws.com`, path }),
  });
}

function base64FromHex(value) {
  return btoa(String.fromCharCode(...value.match(/../g).map((pair) => parseInt(pair, 16))));
}

const randomKey = (ext) => crypto.randomUUID().replace(/-/g, '') + ext;
const PART = 16 * 1024 * 1024; // multipart part, a whole number of records
const disposition = (name) => `attachment; filename*=UTF-8''${rfc3986(name)}`;

// `access()` resolves fresh credentials and the account's storage.
export function createTransferStore(access, fetchFn = (...args) => fetch(...args)) {
  async function head(key) {
    const storage = await access();
    const response = await fetchFn(await presign(storage, 'HEAD', key, { headers: { 'x-amz-checksum-mode': 'ENABLED' } }),
      { method: 'HEAD', headers: { 'x-amz-checksum-mode': 'ENABLED' } });
    // Without list permission S3 answers 403 for a missing object.
    if (response.status === 404 || response.status === 403) return null;
    if (!response.ok) throw new Error(`Storage HEAD failed (${response.status})`);
    const meta = (name) => { try { return decodeURIComponent(response.headers.get(`x-amz-meta-${name}`) || ''); } catch { return ''; } };
    return {
      size: Number(response.headers.get('content-length')),
      checksum: response.headers.get('x-amz-checksum-sha256') || '',
      name: meta('filename'),
      contentType: meta('content-type'),
      sealed: meta('sealed') === '1',
      modified: Date.parse(response.headers.get('last-modified') || '') || 0,
      reuse: storage.endpoint ? REUSE_MS.r2 : REUSE_MS.s3,
    };
  }

  // S3 multipart: `start()` → upload id, `url(id, n)` signs part n (1-based), `complete(id, etags)`.
  function multipart(key, headers) {
    const call = async (method, query, body) => {
      const response = await fetchFn(await presign(await access(), method, key, { headers: 'uploads' in query ? headers : {}, query }),
        { method, headers: 'uploads' in query ? headers : {}, body });
      const text = await response.text();
      if (!response.ok || /<Error>/.test(text)) throw new Error(`Storage upload failed (${response.status})`);
      return text;
    };
    return {
      start: async () => /<UploadId>([^<]+)<\/UploadId>/.exec(await call('POST', { uploads: '' }))?.[1]
        || Promise.reject(new Error('Storage upload failed')),
      url: async (id, n) => presign(await access(), 'PUT', key, { query: { partNumber: String(n), uploadId: id } }),
      complete: (id, etags) => call('POST', { uploadId: id }, `<CompleteMultipartUpload>${etags
        .map((etag, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${etag}</ETag></Part>`).join('')}</CompleteMultipartUpload>`),
      // Free on R2; where the credentials may not abort, the lifecycle rule clears it after a day.
      abort: (id) => call('DELETE', { uploadId: id }).catch(() => {}),
    };
  }

  return {
    head,

    // Plain records of `key` (`stored` bytes) from record `first` up to record `end`, opened when sealed,
    // in one GET; a short read resumes where it stopped.
    async *records(key, stored, first = 0, { sealed = true, signal, end } = {}) {
      const unit = sealed ? SEALED_RECORD : RECORD;
      const count = Math.max(1, Math.ceil(stored / unit));
      const limit = Math.min(count, end ?? count);
      const keys = sealed ? await fileKeys() : null;
      if (sealed && !keys) throw new Error('File storage key is unavailable');
      for (let at = first, tries = 0; at < limit;) {
        const begin = at;
        try {
          const reply = await fetchFn(await presign(await access(), 'GET', key), { signal, cache: 'no-store',
            headers: { Range: `bytes=${at * unit}-${Math.min(stored, limit * unit) - 1}` } });
          if (reply.status === 404 || reply.status === 403) throw Object.assign(new Error('File not found'), { missing: true });
          if (reply.status !== 206) { await reply.body?.cancel(); throw new Error(`Storage read failed (${reply.status})`); }
          for await (const record of split(chunksOf(reply.body), unit)) {
            if (record.length !== (at === count - 1 ? stored - at * unit : unit)) break; // cut short: read again
            yield keys ? await openRecords(keys, key, record, at, count) : record.slice();
            if (++at === limit) break;
          }
        } catch (error) {
          if (error.missing || signal?.aborted) throw error;
        }
        if (at === begin && ++tries > 2) throw new Error('Storage read failed');
        if (at > begin) tries = 0;
      }
    },

    // The plain records of a whole sealed object read as `body` (`stored` bytes).
    async *openBody(key, stored, body) {
      const keys = await fileKeys();
      const count = records(stored);
      let at = 0;
      for await (const record of split(body, SEALED_RECORD)) yield await openRecords(keys, key, record, at++, count);
      if (at !== count) throw new Error('Sealed file is truncated');
    },

    // An attachment upload: identical content (by SHA-256) is stored once; S3 refuses other bytes.
    // A sealed upload returns `seal(body, first)` (the caller PUTs what it returns), `sealStream(source)`
    // and, over PART, `parts` for a multipart upload; `stored` is the size to PUT.
    async prepareUpload({ name, size, contentType = 'application/octet-stream', contentHash = '' }) {
      name = String(name || '').replace(/\\/g, '/').split('/').pop();
      if (!name || /[\u0000-\u001f]/.test(name)) throw new Error('Invalid file name');
      const ext = (name.toLowerCase().match(/\.[a-z0-9]{1,16}$/) || [''])[0];
      const keys = await fileKeys();
      if (keys) {
        const key = await this.keyFor(/^[0-9a-f]{64}$/.test(contentHash) ? contentHash : crypto.randomUUID(), ext);
        const stored = sealedSize(size);
        const existing = contentHash ? await head(key) : null;
        if (existing?.sealed && existing.size === stored && reusable(existing)) return { key, exists: true, sealed: true, stored };
        const headers = { 'Content-Type': 'application/octet-stream', 'x-amz-meta-content-type': rfc3986(contentType), 'x-amz-meta-sealed': '1' };
        const storage = await access();
        const url = await presign(storage, 'PUT', key, { headers });
        const total = Math.max(1, Math.ceil(size / RECORD));
        return { key, url: storage.accelerate ? await presign(storage, 'PUT', key, { headers, accelerate: true }) : url, fallbackUrl: url,
          headers, sealed: true, stored, seal: (body, first = 0) => sealBytes(keys, key, body, first, total),
          sealStream: (source) => sealStream(keys, key, size, source),
          ...(size > 2 * PART ? { parts: { size: PART, records: PART / RECORD, ...multipart(key, headers) } } : {}) };
      }
      let key = randomKey(ext);
      const checksum = /^[0-9a-f]{64}$/.test(contentHash) ? base64FromHex(contentHash) : '';
      if (checksum) {
        const hashed = contentHash.slice(0, 32) + ext;
        const existing = await head(hashed);
        const same = existing?.checksum === checksum && existing.size === size;
        if (same && reusable(existing)) return { key: hashed, exists: true, sealed: false, stored: size };
        if (!existing || same) key = hashed;
      }
      const headers = {
        'Content-Type': 'application/octet-stream',
        'x-amz-meta-filename': rfc3986(name),
        'x-amz-meta-content-type': rfc3986(contentType),
        ...(checksum ? { 'x-amz-checksum-sha256': checksum } : {}),
      };
      const storage = await access();
      const url = await presign(storage, 'PUT', key, { headers });
      const accelerated = storage.accelerate ? await presign(storage, 'PUT', key, { headers, accelerate: true }) : url;
      return { key, url: accelerated, fallbackUrl: url, headers, sealed: false, stored: size };
    },

    // A PUT URL for bytes the caller streams itself, with the headers to send.
    async uploadUrl(key, { contentType = 'application/octet-stream', sealed = false } = {}) {
      const headers = { 'Content-Type': contentType, ...(sealed ? { 'x-amz-meta-sealed': '1' } : {}) };
      return { url: await presign(await access(), 'PUT', key, { headers }), headers };
    },

    // The key for content identified by `id` (any string): HMAC-derived when files are sealed.
    plainRefused,

    async keyFor(id, ext) {
      const keys = await fileKeys();
      if (!keys) return id.slice(0, 32) + ext;
      return hex(await crypto.subtle.sign('HMAC', keys.id, encoder.encode(id))).slice(0, 32) + ext;
    },

    async put(key, body, { contentType = 'application/octet-stream' } = {}) {
      const keys = await fileKeys();
      if (keys) body = await sealBytes(keys, key, body);
      const { url, headers } = await this.uploadUrl(key, { contentType, sealed: !!keys });
      const response = await fetchFn(url, { method: 'PUT', headers, body });
      if (!response.ok) throw new Error(`Storage upload failed (${response.status})`);
    },

    // The stored file's bytes, opened when sealed. `sealed` comes from head(); unknown (undefined),
    // a file that does not open is taken as written before K, within PLAIN_GRACE_MS of it.
    async bytes(key, sealed) {
      const response = await fetchFn(await this.url(key, { plain: true }));
      if (!response.ok) throw new Error(`Storage read failed (${response.status})`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const keys = await fileKeys();
      if (!keys) return bytes;
      if (sealed !== false) {
        try { return await openRecords(keys, key, bytes, 0, records(bytes.length)); } catch (error) { if (sealed) throw error; }
      }
      if (await plainRefused()) throw new Error('File is not sealed');
      return bytes;
    },

    // Plain bytes [begin, end) of a sealed file stored with `stored` bytes: only the records needed.
    async range(key, begin, end, stored) {
      const first = Math.floor(begin / RECORD);
      const last = Math.floor((end - 1) / RECORD);
      const response = await fetchFn(await this.url(key, { plain: true }),
        { headers: { Range: `bytes=${first * SEALED_RECORD}-${Math.min(stored, (last + 1) * SEALED_RECORD) - 1}` } });
      if (response.status === 404 || response.status === 403) throw Object.assign(new Error('File not found'), { missing: true });
      if (response.status !== 206 && response.status !== 200) throw new Error(`Storage read failed (${response.status})`);
      let bytes = new Uint8Array(await response.arrayBuffer());
      if (response.status === 200) bytes = bytes.subarray(first * SEALED_RECORD, (last + 1) * SEALED_RECORD);
      const plain = await openRecords(await fileKeys(), key, bytes, first, records(stored));
      return plain.subarray(begin - first * RECORD, end - first * RECORD);
    },

    // A GET URL shown inline with the type its key implies, or downloaded under `download`. A sealed
    // file is fetched and opened here and comes back as a Blob URL.
    async url(key, { download = '', contentType = previewType(key), plain = false, sealed } = {}) {
      if (!plain && sealed !== false && typeof document !== 'undefined' && await fileKeys()) {
        return opened.get(key) || blobUrl(key, await this.bytes(key, sealed), contentType);
      }
      return presign(await access(), 'GET', key, { query: download
        ? { 'response-content-disposition': disposition(download) }
        : { 'response-content-disposition': 'inline', 'response-content-type': contentType } });
    },

    // What a file card needs: its name, size and type, a download URL and an inline preview URL.
    async fileInfo(key, name = '') {
      const object = await head(key);
      if (!object) throw new Error('File not found');
      // Deduplicated files keep the first uploader's name; the caller's own name wins.
      const shown = name && name.length <= 255 && !/[\u0000-\u001f/\\]/.test(name) ? name : object.name || key;
      const type = previewType(key);
      const { sealed } = object;
      if (!sealed && await plainRefused()) throw new Error('File is not sealed');
      // Only images and Office files up to 256 MB are opened whole here; the rest is read by range.
      const lazy = sealed && !(type.startsWith('image/') || (OFFICE.test(extension(key)) && object.size <= 256 * 1024 * 1024));
      return {
        key, name: shown, size: sealed ? plainSize(object.size) : object.size, stored: object.size,
        contentType: object.contentType || 'application/octet-stream', sealed,
        url: lazy ? '' : await this.url(key, { download: shown, sealed }),
        previewUrl: lazy ? '' : await this.url(key, { contentType: type, sealed }), previewType: type,
      };
    },

    async text(key) {
      return new TextDecoder().decode(await this.bytes(key));
    },
  };
}

// What this process stored in the last day (id → value), so a hot page does not write again.
export function recentKeys(limit = 1000, maxAgeMs = 86400_000) {
  const entries = new Map();
  return {
    get(id) {
      const entry = entries.get(id);
      return entry && Date.now() - entry.at < maxAgeMs ? entry.value : undefined;
    },
    set(id, value = true) {
      entries.delete(id);
      entries.set(id, { value, at: Date.now() });
      if (entries.size > limit) entries.delete(entries.keys().next().value);
    },
    delete: (id) => entries.delete(id),
  };
}

let provider = null;
// Where this process gets its storage access (the App's /devices, the Bridge's control socket).
export function setTransferAccess(next) { provider = next; }
export const transfer = createTransferStore(() => {
  if (!provider) throw new Error('File storage is unavailable');
  return provider();
});
