// The HTTP pipeline of the Python server (FastAPI + Starlette): CORS outermost, then GZip, then the
// authentication middleware, then the routes and the web files. Responses are { status, headers, body }
// with lower-case header names; `direct` marks the middleware's own replies, which Starlette does not
// stream (only streamed bodies are compressed regardless of size and get `Vary: Accept-Encoding`).
import { HTTPError, JSONDecodeError, dumps, loads, pyStrip, validate } from './py.mjs';

const encoder = new TextEncoder();
const STATUS = { 400: 'Bad Request', 401: 'Unauthorized', 404: 'Not Found', 405: 'Method Not Allowed' };
const NO_BODY = new Set([204, 304]);

export function response(status, body, contentType, headers = {}) {
  const bytes = typeof body === 'string' ? encoder.encode(body) : body;
  const out = { status, headers: { ...headers }, body: bytes };
  if (!out.headers['content-length'] && status >= 200 && !NO_BODY.has(status)) out.headers['content-length'] = String(bytes.length);
  if (contentType && !out.headers['content-type']) {
    out.headers['content-type'] = contentType.startsWith('text/') && !/charset=/i.test(contentType)
      ? `${contentType}; charset=utf-8` : contentType;
  }
  return out;
}
export const json = (content, status = 200, headers = {}) => response(status, dumps(content), 'application/json', headers);
export const text = (content, status = 200, headers = {}) => response(status, content, 'text/plain', headers);

// json.loads(bytes): the encoding comes from a BOM or the zero bytes of the first characters, and is
// decoded with 'surrogatepass' (lone surrogates are kept).
function decodeBody(b) {
  let encoding = 'utf-8';
  let offset = 0;
  if ((!b[0] && !b[1] && b[2] === 0xfe && b[3] === 0xff) || (b[0] === 0xff && b[1] === 0xfe && !b[2] && !b[3] && b.length >= 4)) {
    encoding = b[0] ? 'utf-32le' : 'utf-32be';
    offset = 4;
  } else if ((b[0] === 0xfe && b[1] === 0xff) || (b[0] === 0xff && b[1] === 0xfe)) [encoding, offset] = [b[0] === 0xff ? 'utf-16le' : 'utf-16be', 2];
  else if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) offset = 3;
  else if (b.length >= 4 && !b[0]) encoding = b[1] ? 'utf-16be' : 'utf-32be';
  else if (b.length >= 4 && !b[1]) encoding = b[2] || b[3] ? 'utf-16le' : 'utf-32le';
  else if (b.length === 2 && (!b[0] || !b[1])) encoding = b[0] ? 'utf-16le' : 'utf-16be';
  const bytes = b.subarray(offset);
  if (encoding === 'utf-8') return utf8(bytes);
  const size = encoding.startsWith('utf-32') ? 4 : 2;
  if (bytes.length % size) throw new Error('truncated data');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  let out = '';
  for (let i = 0; i < bytes.length; i += size) {
    const little = encoding.endsWith('le');
    out += size === 4 ? String.fromCodePoint(view.getUint32(i, little)) : String.fromCharCode(view.getUint16(i, little));
  }
  return out;
}

function utf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    // Encoded surrogates (ED A0-BF xx) are the only bytes 'surrogatepass' adds to strict UTF-8.
    const pieces = [];
    let start = 0;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0xed && bytes[i + 1] >= 0xa0 && bytes[i + 1] <= 0xbf && bytes[i + 2] >= 0x80 && bytes[i + 2] <= 0xbf) {
        pieces.push(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(start, i)),
          String.fromCharCode(0xd000 | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f)));
        start = i + 3;
        i += 2;
      }
    }
    return pieces.join('') + new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(start));
  }
}

// FastAPI's request body: JSON only with a JSON content type (strict), else the raw bytes.
function readBody(bytes, contentType) {
  if (!bytes.length) return undefined;
  if (!contentType) return { bytes };
  const type = pyStrip(contentType.split(';')[0]).toLowerCase();
  const [main, sub] = type.split('/').length === 2 ? type.split('/') : ['text', 'plain'];
  if (main !== 'application' || !(sub === 'json' || sub.endsWith('+json'))) return { bytes };
  let source;
  try {
    source = decodeBody(bytes);
  } catch {
    throw new HTTPError(400, 'There was an error parsing the body');
  }
  try {
    return { value: loads(source) };
  } catch (error) {
    if (!(error instanceof JSONDecodeError)) throw error;
    throw Object.assign(new Error('json'), { errors: [{ type: 'json_invalid', loc: ['body', error.pos], msg: 'JSON decode error',
      input: {}, ctx: { error: error.message } }] });
  }
}

const echo = (input) => (input?.bytes ? new TextDecoder('utf-8', { fatal: true }).decode(input.bytes) : input);

// Path, then query, then body errors, as FastAPI's solve_dependencies collects them.
async function solve(route, { url, headers }, bytes) {
  const errors = [];
  const query = {};
  for (const [name, spec] of route.query || []) {
    const values = url.searchParams.getAll(name);
    if (values.length) query[name] = values.at(-1);
    else if (spec.required) errors.push({ type: 'missing', loc: ['query', name], msg: 'Field required', input: null });
    else query[name] = spec.default;
  }
  let body;
  if (route.body) {
    let input;
    try {
      input = readBody(bytes, headers.get('content-type'));
    } catch (error) {
      if (!error.errors) throw error;
      throw new HTTPValidation(error.errors);
    }
    if (input === undefined) {
      errors.push({ type: 'missing', loc: ['body'], msg: 'Field required', input: null });
    } else {
      const result = validate(route.body, input.bytes ? input : input.value, ['body']);
      if (result.errors) errors.push(...result.errors.map((item) => ({ ...item, input: echo(item.input) })));
      else body = result.value;
    }
  }
  if (errors.length) throw new HTTPValidation(errors);
  return { query, body };
}

class HTTPValidation extends Error {
  constructor(errors) {
    super('validation');
    this.errors = errors;
  }
}

async function compress(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// routes: [{ method, path, query?, body?, handler(context) }]; handler returns JSON content or a response.
// web(context): the web app's files, mounted at "/" after the routes (else Starlette's own 404/405).
export function createHttp({ routes, authenticate, web, onError, keyUnavailable }) {
  async function dispatch(context, bytes) {
    const path = context.path;
    const matches = routes.filter((route) => route.path === path);
    const route = matches.find((candidate) => candidate.method === context.method);
    try {
      if (!route) {
        if (web) return await web(context);
        if (matches.length) throw new HTTPError(405, STATUS[405], { allow: matches.map((item) => item.method).join(', ') });
        throw new HTTPError(404, STATUS[404]);
      }
      const { query, body } = await solve(route, context, bytes);
      const result = await route.handler({ ...context, query, body });
      return result?.body instanceof Uint8Array ? result : json(result);
    } catch (error) {
      if (error instanceof HTTPError) return json({ detail: error.detail }, error.status, error.headers);
      if (error instanceof HTTPValidation) {
        return json({ detail: error.errors.map(({ input, ...item }) => ({ type: item.type, loc: item.loc, msg: item.msg, input,
          ...(item.ctx ? { ctx: item.ctx } : {}) })) }, 422);
      }
      if (keyUnavailable(error)) return json({ error: 'temporarily unavailable' }, 503);
      throw error;
    }
  }

  return async function handle(request, extra = {}) {
    const url = new URL(request.url);
    const context = { request, url, method: request.method, headers: request.headers, path: url.pathname, ...extra };
    try {
      const origin = request.headers.get('origin');
      if (origin !== null && request.method === 'OPTIONS' && request.headers.has('access-control-request-method')) {
        return preflight(request);
      }
      const bytes = new Uint8Array(await request.arrayBuffer());
      let out = await authenticate(context);
      if (!out) {
        out = await dispatch(context, bytes);
        out.streamed = out.body.length > 0;
      }
      if (out.streamed) await gzip(out, request.headers.get('accept-encoding') ?? '');
      if (origin !== null) out.headers['access-control-allow-origin'] = '*';
      out.headers.vary = [out.headers.vary, 'Origin'].filter(Boolean).join(', ');
      return out;
    } catch (error) {
      onError(error);
      return text('Internal Server Error', 500);
    }
  };
}

const EXCLUDED = ['application/grpc', 'application/gzip', 'application/x-gzip', 'application/zip', 'audio/*', 'font/woff',
  'font/woff2', 'image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp', 'text/event-stream', 'video/*'];

// GZipMiddleware(minimum_size=1000) on a streamed body: `Vary` always, compressed when accepted.
async function gzip(out, acceptEncoding) {
  const type = (out.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  const types = [type, `${type.split('/')[0]}/*`, ...(type.startsWith('application/grpc+') ? ['application/grpc'] : [])];
  if (out.headers['content-encoding'] !== undefined || out.status === 206 || types.some((item) => EXCLUDED.includes(item))) return;
  out.headers.vary = [out.headers.vary, 'Accept-Encoding'].filter(Boolean).join(', ');
  if (!acceptEncoding.includes('gzip')) return;
  out.body = await compress(out.body);
  out.headers['content-encoding'] = 'gzip';
  delete out.headers['content-length'];
}

function preflight(request) {
  const headers = {
    vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers, Access-Control-Request-Private-Network',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT, QUERY',
    'access-control-max-age': '7200',
  };
  const failures = [];
  const method = request.headers.get('access-control-request-method');
  if (!headers['access-control-allow-methods'].split(', ').includes(method)) failures.push('method');
  const requested = request.headers.get('access-control-request-headers');
  if (requested !== null) headers['access-control-allow-headers'] = requested;
  if (request.headers.has('access-control-request-private-network')) failures.push('private-network');
  return failures.length ? text(`Disallowed CORS ${failures.join(', ')}`, 400, headers) : text('OK', 200, headers);
}
