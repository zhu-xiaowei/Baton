// The web app's files (Vite's dist/, copied to web/): ETag revalidation and the cache headers of #191.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { response } from '../core/http.mjs';
import { HTTPError } from '../core/util.mjs';

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.txt': 'text/plain',
  '.json': 'application/json', '.png': 'image/png', '.ico': 'image/vnd.microsoft.icon', '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm' };
// Vite's hashed chunks never change; HTML must revalidate, or a stale cached index.html
// requests chunks the next deploy deleted. Other files keep the browser's default.
const HASHED = /^assets\/[^/]+-[\w-]{8}\.(js|css)$/;

export function web(directory) {
  return async ({ method, path: requested, headers }) => {
    if (!['GET', 'HEAD'].includes(method)) throw new HTTPError(405, 'Method Not Allowed', { allow: 'GET, HEAD' });
    const relative = path.posix.normalize(`.${requested}`).replace(/^\.\/?/, '') || 'index.html';
    const file = path.resolve(directory, relative);
    const stat = file.startsWith(directory + path.sep) && await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) throw new HTTPError(404, 'Not Found');
    const etag = `"${createHash('md5').update(`${stat.mtimeMs}-${stat.size}`).digest('hex')}"`;
    const cache = HASHED.test(relative) ? { 'cache-control': 'public, max-age=31536000, immutable' }
      : relative.endsWith('.html') ? { 'cache-control': 'no-cache' } : {};
    const match = headers.get('if-none-match');
    if (match && (match.trim() === '*' || match.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag))) {
      return response(304, '', null, { etag, ...cache });
    }
    const body = method === 'HEAD' ? new Uint8Array() : new Uint8Array(await fs.readFile(file));
    return response(200, body, TYPES[path.extname(file)] ?? 'application/octet-stream', { etag, 'last-modified': stat.mtime.toUTCString(),
      'content-length': String(stat.size), ...cache });
  };
}
