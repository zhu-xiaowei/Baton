// The REST pipeline: CORS, the authentication middleware, the routes, then the web app's files.
// Responses are { status, headers, body } with lower-case header names and a Uint8Array body.
import { HTTPError, validate } from './util.mjs';

const encoder = new TextEncoder();

export function response(status, body, contentType, headers = {}) {
  const bytes = typeof body === 'string' ? encoder.encode(body) : body;
  const type = contentType?.startsWith('text/') ? `${contentType}; charset=utf-8` : contentType;
  return { status, headers: { ...(type ? { 'content-type': type } : {}), ...headers }, body: bytes };
}
export const json = (content, status = 200, headers = {}) => response(status, JSON.stringify(content), 'application/json', headers);
export const text = (content, status = 200, headers = {}) => response(status, content, 'text/plain', headers);

class ValidationError extends Error {
  constructor(errors) {
    super('validation');
    this.errors = errors;
  }
}

// Query parameters (the last value of a repeated one) and the JSON body against the route's model.
function solve(route, { url }, bytes) {
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
    if (!bytes.length) {
      errors.push({ type: 'missing', loc: ['body'], msg: 'Field required', input: null });
    } else {
      let input;
      try {
        input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch (thrown) {
        if (!(thrown instanceof SyntaxError)) throw new HTTPError(400, 'There was an error parsing the body');
        throw new ValidationError([{ type: 'json_invalid', loc: ['body'], msg: 'JSON decode error', input: {}, ctx: { error: thrown.message } }]);
      }
      const result = validate(route.body, input, ['body']);
      if (result.errors) errors.push(...result.errors);
      else body = result.value;
    }
  }
  if (errors.length) throw new ValidationError(errors);
  return { query, body };
}

// routes: [{ method, path, query?, body?, handler(context) }]; a handler returns JSON content or a response.
// web(context): the web app's files, served for every other path.
export function createHttp({ routes, authenticate, web, onError, keyUnavailable }) {
  async function dispatch(context, bytes) {
    const route = routes.find((candidate) => candidate.path === context.path && candidate.method === context.method);
    try {
      if (!route) {
        if (web) return await web(context);
        throw new HTTPError(404, 'Not Found');
      }
      const result = await route.handler({ ...context, ...solve(route, context, bytes) });
      return result?.body instanceof Uint8Array ? result : json(result);
    } catch (error) {
      if (error instanceof HTTPError) return json({ detail: error.detail }, error.status, error.headers);
      if (error instanceof ValidationError) return json({ detail: error.errors }, 422);
      if (keyUnavailable(error)) return json({ error: 'temporarily unavailable' }, 503);
      throw error;
    }
  }

  return async function handle(request, extra = {}) {
    const url = new URL(request.url);
    const context = { request, url, method: request.method, headers: request.headers, path: url.pathname, ...extra };
    try {
      if (request.method === 'OPTIONS' && request.headers.has('access-control-request-method')) return preflight(request);
      const bytes = new Uint8Array(await request.arrayBuffer());
      const out = (await authenticate(context)) || (await dispatch(context, bytes));
      out.headers['access-control-allow-origin'] = '*';
      return out;
    } catch (error) {
      onError(error);
      return text('Internal Server Error', 500);
    }
  };
}

function preflight(request) {
  return text('OK', 200, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT',
    'access-control-max-age': '7200', 'access-control-allow-headers': request.headers.get('access-control-request-headers') ?? '*' });
}
