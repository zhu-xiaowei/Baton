// Files between the App and its Bridges travel through S3 at t/<accountId>/<key>, which a lifecycle
// rule empties after 7 days: a transfer channel, not storage. Both sides sign their own requests
// (SigV4 query authentication) with the temporary credentials the server issues for this account
// only, so no file or URL goes through Lambda. Used by the Bridge (Node) and the App (browser).

const encoder = new TextEncoder();
const KEY = /^[0-9a-f]{8,64}(?:\.[a-z0-9]{1,16})?$/;
const MAX_EXPIRES = 3600;
// Objects expire 7 days after they were written; one older than this is written again before it
// is reused, so it outlives the day the writer remembers it (`recentKeys`).
const REUSE_MS = 6 * 86400_000;
export const reusable = (object) => !!object && Date.now() - object.modified < REUSE_MS;

export const IMAGE_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon',
};
const PREVIEW_TYPES = {
  pdf: 'application/pdf', ...IMAGE_TYPES,
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  mkv: 'video/x-matroska', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg',
};

const extension = (key) => (key.includes('.') ? key.slice(key.lastIndexOf('.') + 1).toLowerCase() : '');
export const previewType = (key) => PREVIEW_TYPES[extension(key)] || 'application/octet-stream';

// With K, files up to SEALED_MAX that are not played as streams are sealed whole (AES-GCM, nonce ‖
// ciphertext ‖ tag, AAD = key) and keyed by HMAC(content hash), so dedup stays within the account.
// Videos, audio and larger files stay as they are, so they keep ranged reads (plan §6 "Attachments").
export const SEALED_MAX = 50 * 1024 * 1024;
const SEAL_OVERHEAD = 28;
const STREAMED = /^(mp4|m4v|mov|webm|mkv|avi|mp3|wav|m4a|ogg)$/;
let fileKeys = () => null;
// `next()` resolves { key: AES-GCM CryptoKey, id: HMAC CryptoKey } for this account, or null.
export function setTransferKeys(next) { fileKeys = next; }
const sealedKeys = async (name, size) => (size <= SEALED_MAX + SEAL_OVERHEAD && !STREAMED.test(extension(name)) ? fileKeys() : null);

async function sealBytes(keys, key, body) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const bytes = new Uint8Array(await new Response(body).arrayBuffer());
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: encoder.encode(key) }, keys.key, bytes));
  const out = new Uint8Array(12 + sealed.length);
  out.set(nonce);
  out.set(sealed, 12);
  return out;
}

const openBytes = async (keys, key, bytes) => new Uint8Array(await crypto.subtle.decrypt(
  { name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: encoder.encode(key) }, keys.key, bytes.subarray(12)));

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

// A URL for `t/<accountId>/<key>`. `access` is { bucket, region, accountId, accelerate,
// credentials: { accessKeyId, secretAccessKey, sessionToken, expiresAt } }.
export async function presign(access, method, key, { headers = {}, query = {}, accelerate = false, now = new Date() } = {}) {
  if (!KEY.test(key)) throw new Error('Invalid file key');
  const { bucket, region, accountId, credentials } = access;
  const expires = Math.min(MAX_EXPIRES, Math.floor(credentials.expiresAt - now.getTime() / 1000) - 5);
  if (expires < 1) throw new Error('Storage credentials expired');
  return signUrl({
    method, region, credentials, expires, headers, query, now,
    host: accelerate ? `${bucket}.s3-accelerate.amazonaws.com` : `${bucket}.s3.${region}.amazonaws.com`,
    path: `/t/${rfc3986(accountId)}/${rfc3986(key)}`,
  });
}

function base64FromHex(value) {
  return btoa(String.fromCharCode(...value.match(/../g).map((pair) => parseInt(pair, 16))));
}

const randomKey = (ext) => crypto.randomUUID().replace(/-/g, '') + ext;
const disposition = (name) => `attachment; filename*=UTF-8''${rfc3986(name)}`;

// `access()` resolves fresh credentials and the account's storage.
export function createTransferStore(access, fetchFn = (...args) => fetch(...args)) {
  async function head(key) {
    const response = await fetchFn(await presign(await access(), 'HEAD', key, { headers: { 'x-amz-checksum-mode': 'ENABLED' } }),
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
      modified: Date.parse(response.headers.get('last-modified') || '') || 0,
    };
  }

  return {
    head,

    // An attachment upload: identical content (by SHA-256) is stored once; S3 refuses other bytes.
    // A sealed upload returns `seal(body)`: the caller PUTs what it returns.
    async prepareUpload({ name, size, contentType = 'application/octet-stream', contentHash = '' }) {
      name = String(name || '').replace(/\\/g, '/').split('/').pop();
      if (!name || /[\u0000-\u001f]/.test(name)) throw new Error('Invalid file name');
      const ext = (name.toLowerCase().match(/\.[a-z0-9]{1,16}$/) || [''])[0];
      const keys = await sealedKeys(name, size);
      if (keys) {
        const key = await this.keyFor(/^[0-9a-f]{64}$/.test(contentHash) ? contentHash : crypto.randomUUID(), ext);
        const existing = contentHash ? await head(key) : null;
        if (existing?.size === size + SEAL_OVERHEAD && reusable(existing)) return { key, exists: true };
        const headers = { 'Content-Type': 'application/octet-stream', 'x-amz-meta-filename': rfc3986(name), 'x-amz-meta-content-type': rfc3986(contentType) };
        const storage = await access();
        const url = await presign(storage, 'PUT', key, { headers });
        return { key, url: storage.accelerate ? await presign(storage, 'PUT', key, { headers, accelerate: true }) : url, fallbackUrl: url,
          headers, seal: (body) => sealBytes(keys, key, body) };
      }
      let key = randomKey(ext);
      const checksum = /^[0-9a-f]{64}$/.test(contentHash) ? base64FromHex(contentHash) : '';
      if (checksum) {
        const hashed = contentHash.slice(0, 32) + ext;
        const existing = await head(hashed);
        const same = existing?.checksum === checksum && existing.size === size;
        if (same && reusable(existing)) return { key: hashed, exists: true };
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
      return { key, url: accelerated, fallbackUrl: url, headers };
    },

    // A PUT URL for bytes the caller streams itself, with the headers to send.
    async uploadUrl(key, { contentType = 'application/octet-stream' } = {}) {
      const headers = { 'Content-Type': contentType };
      return { url: await presign(await access(), 'PUT', key, { headers }), headers };
    },

    sealed: async (key, size) => !!await sealedKeys(key, size),

    // The key for content identified by `id` (any string): HMAC-derived when files are sealed.
    async keyFor(id, ext) {
      const keys = await fileKeys();
      if (!keys) return id.slice(0, 32) + ext;
      return hex(await crypto.subtle.sign('HMAC', keys.id, encoder.encode(id))).slice(0, 32) + ext;
    },

    async put(key, body, { contentType = 'application/octet-stream' } = {}) {
      const keys = await sealedKeys(key, body.size ?? body.length ?? 0);
      if (keys) body = await sealBytes(keys, key, body);
      const { url, headers } = await this.uploadUrl(key, { contentType });
      const response = await fetchFn(url, { method: 'PUT', headers, body });
      if (!response.ok) throw new Error(`Storage upload failed (${response.status})`);
    },

    // The stored file's bytes, opened when sealed (`size` from head(), when known).
    async bytes(key, size = 0) {
      const response = await fetchFn(await this.url(key, { plain: true }));
      if (!response.ok) throw new Error(`Storage read failed (${response.status})`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const keys = await sealedKeys(key, size || bytes.length);
      return keys ? openBytes(keys, key, bytes) : bytes;
    },

    // A GET URL shown inline with the type its key implies, or downloaded under `download`. A sealed
    // file is fetched and opened here and comes back as a Blob URL (`size`: skip that for larger ones).
    async url(key, { download = '', contentType = previewType(key), plain = false, size = 0 } = {}) {
      if (!plain && typeof document !== 'undefined' && await sealedKeys(key, size)) {
        return opened.get(key) || blobUrl(key, await this.bytes(key, size), contentType);
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
      const sealed = !!await sealedKeys(key, object.size);
      return {
        key, name: shown, size: sealed ? object.size - SEAL_OVERHEAD : object.size, contentType: object.contentType || 'application/octet-stream',
        url: await this.url(key, { download: shown, size: object.size }),
        previewUrl: await this.url(key, { contentType: type, size: object.size }), previewType: type, sealed,
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
