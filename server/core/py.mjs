// The Python server's string, JSON and request-model semantics (CPython 3.12, pydantic 2, FastAPI),
// so every response, including error details, stays byte-identical after the rewrite.

export class HTTPError extends Error {
  constructor(status, detail, headers = {}) {
    super(detail);
    Object.assign(this, { status, detail, headers });
  }
}

// ---- str ----
export const pyLen = (text) => Array.from(text).length;
export const pySlice = (text, start, end) => Array.from(text).slice(start, end).join('');
const SPACE = '[\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const STRIP = new RegExp(`^${SPACE}+|${SPACE}+$`, 'gu');
export const pyStrip = (text) => text.replace(STRIP, '');
export const casefold = (text) => text.toUpperCase().toLowerCase().replace(/ς/g, 'σ')
  .replace(/[ꭰ-ꮿ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xab70 + 0x13a0))
  .replace(/[ᏸ-ᏽ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 8));
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;
export const isPrintable = (text) => Array.from(text).every((char) => char === ' ' || !UNPRINTABLE.test(char));
// \w of pydantic's (Rust) regex engine and \d of Python's re are Unicode classes.
export const WORD = '\\p{Alphabetic}\\p{M}\\p{Nd}\\p{Pc}\\p{Join_Control}';
export const DIGIT = '\\p{Nd}';
export const str = (value) => (value === undefined || value === null ? 'None' : String(value));
export const sha256 = async (text) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(text))), (byte) => byte.toString(16).padStart(2, '0')).join('');
// hmac.compare_digest: str arguments must be ASCII (else TypeError, a 500); `bytes` compares UTF-8.
export function compareDigest(a, b, bytes = false) {
  if (!bytes && /[^\x00-\x7f]/.test(a + b)) throw new TypeError('comparing strings with non-ASCII characters is not supported');
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
export const randomHex = (bytes) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)),
  (byte) => byte.toString(16).padStart(2, '0')).join('');
export const tokenUrlsafe = (bytes) => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes))))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const now = () => Date.now() / 1000;
export const nowInt = () => Math.floor(Date.now() / 1000);

// ---- JSON: json.loads (positions and messages of CPython's C scanner) and json.dumps ----
export class PyFloat {
  constructor(value) { this.value = value; }
}
export class JSONDecodeError extends Error {
  constructor(msg, pos) {
    super(msg);
    this.pos = pos;
  }
}

export function loads(text) {
  const fail = (msg, at) => { throw new JSONDecodeError(msg, Array.from(text.slice(0, at)).length); };
  const ws = (at) => { while (' \t\n\r'.includes(text[at] ?? 'x')) at++; return at; };
  const string = (at) => {
    const begin = at - 1;
    let out = '';
    for (;;) {
      let next = at;
      while (next < text.length && text[next] !== '"' && text[next] !== '\\') {
        if (text.charCodeAt(next) <= 0x1f) fail('Invalid control character at', next);
        next++;
      }
      if (next >= text.length) fail('Unterminated string starting at', begin);
      out += text.slice(at, next);
      if (text[next++] === '"') return [out, next];
      if (next === text.length) fail('Unterminated string starting at', begin);
      const esc = text[next];
      if (esc !== 'u') {
        const char = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[esc];
        if (char === undefined) fail('Invalid \\escape', next - 1);
        out += char;
        at = next + 1;
        continue;
      }
      const hex4 = (from) => {
        if (from + 4 >= text.length) fail('Invalid \\uXXXX escape', from - 1);
        const digits = text.slice(from, from + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(digits)) fail('Invalid \\uXXXX escape', from - 1);
        return parseInt(digits, 16);
      };
      let code = hex4(next + 1);
      at = next + 5;
      if (code >= 0xd800 && code <= 0xdbff && at + 6 < text.length && text[at] === '\\' && text[at + 1] === 'u') {
        const low = hex4(at + 2);
        if (low >= 0xdc00 && low <= 0xdfff) { code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00); at += 6; }
      }
      out += String.fromCodePoint(code);
    }
  };
  const value = (at) => {
    if (at >= text.length) fail('Expecting value', at);
    const c = text[at];
    if (c === '"') return string(at + 1);
    if (c === '{') {
      const object = new Map();
      at = ws(at + 1);
      if (text[at] === '}') return [object, at + 1];
      for (;;) {
        if (text[at] !== '"') fail('Expecting property name enclosed in double quotes', at);
        const [key, afterKey] = string(at + 1);
        at = ws(afterKey);
        if (text[at] !== ':') fail("Expecting ':' delimiter", at);
        const [item, afterValue] = value(ws(at + 1));
        object.set(key, item);
        at = ws(afterValue);
        if (text[at] === '}') return [object, at + 1];
        if (text[at] !== ',') fail("Expecting ',' delimiter", at);
        at = ws(at + 1);
      }
    }
    if (c === '[') {
      const array = [];
      at = ws(at + 1);
      if (text[at] === ']') return [array, at + 1];
      for (;;) {
        const [item, after] = value(at);
        array.push(item);
        at = ws(after);
        if (text[at] === ']') return [array, at + 1];
        if (text[at] !== ',') fail("Expecting ',' delimiter", at);
        at = ws(at + 1);
      }
    }
    for (const [word, result, room] of [['null', null, 3], ['true', true, 3], ['false', false, 4],
      ['NaN', new PyFloat(NaN), 2], ['Infinity', new PyFloat(Infinity), 7], ['-Infinity', new PyFloat(-Infinity), 8]]) {
      if (at + room < text.length && text.startsWith(word, at)) return [result, at + word.length];
    }
    const number = /^-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?/.exec(text.slice(at));
    if (!number) fail('Expecting value', at);
    const raw = number[0];
    if (number[1] || number[2]) return [new PyFloat(Number(raw)), at + raw.length];
    return [Number.isSafeInteger(Number(raw)) ? Number(raw) : BigInt(raw), at + raw.length];
  };
  const [result, end] = value(ws(0));
  if (ws(end) !== text.length) fail('Extra data', ws(end));
  return result;
}

export function floatRepr(value) {
  if (!Number.isFinite(value)) throw new Error('Out of range float values are not JSON compliant');
  if (Object.is(value, -0)) return '-0.0';
  const [mantissa, power] = value.toExponential().split('e');
  if (Number(power) < -4 || Number(power) >= 16) return `${mantissa}e${power[0]}${power.slice(1).padStart(2, '0')}`;
  const text = String(value);
  return /[.e]/.test(text) ? text : `${text}.0`;
}

// json.dumps(ensure_ascii=False, allow_nan=False, separators=(",", ":")), as JSONResponse renders.
export function dumps(value) {
  if (value === null || value === undefined) return 'null';
  if (value instanceof PyFloat) return floatRepr(value.value);
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : floatRepr(value);
  if (typeof value === 'string') {
    if (/\p{Cs}/u.test(value)) throw new Error('surrogates not allowed');
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(dumps).join(',')}]`;
  const entries = value instanceof Map ? [...value] : Object.entries(value).filter(([, item]) => item !== undefined);
  return `{${entries.map(([key, item]) => `${dumps(key)}:${dumps(item)}`).join(',')}}`;
}

// ---- pydantic models: fields are [name, { required, default, pattern, maxLength, model, nullable }] ----
const errorOf = (type, loc, msg, input, ctx) => ({ type, loc, msg, input, ...(ctx ? { ctx } : {}) });

export function validate(fields, input, loc) {
  if (!(input instanceof Map)) {
    return { errors: [errorOf('model_attributes_type', loc,
      'Input should be a valid dictionary or object to extract fields from', input)] };
  }
  const errors = [];
  const value = {};
  for (const [name, spec] of fields) {
    const at = [...loc, name];
    if (!input.has(name)) {
      if (spec.required) errors.push(errorOf('missing', at, 'Field required', input));
      else value[name] = 'default' in spec ? spec.default : '';
      continue;
    }
    const item = input.get(name);
    if (spec.model) {
      if (item === null && spec.nullable) { value[name] = null; continue; }
      const nested = validate(spec.model, item, at);
      if (nested.errors) errors.push(...nested.errors);
      else value[name] = nested.value;
    } else if (typeof item !== 'string') {
      errors.push(errorOf('string_type', at, 'Input should be a valid string', item));
    } else if (spec.maxLength !== undefined && pyLen(item) > spec.maxLength) {
      errors.push(errorOf('string_too_long', at, `String should have at most ${spec.maxLength} characters`, item,
        { max_length: spec.maxLength }));
    } else if (spec.pattern && !new RegExp(spec.pattern, 'u').test(item)) {
      errors.push(errorOf('string_pattern_mismatch', at, `String should match pattern '${spec.source}'`, item,
        { pattern: spec.source }));
    } else {
      value[name] = item;
    }
  }
  return errors.length ? { errors } : { value };
}

// A str field constrained like pydantic's Field(pattern=...): `source` is the Python pattern.
export const pattern = (source, extra = {}) => ({ source, pattern: source.replace(/\\w/g, WORD), ...extra });

// A loads() result as plain JavaScript values.
export const plain = (value) => (value instanceof Map ? Object.fromEntries([...value].map(([key, item]) => [key, plain(item)]))
  : Array.isArray(value) ? value.map(plain) : value instanceof PyFloat ? value.value : value);

// urllib.parse.unquote: %XX runs decoded as UTF-8, invalid bytes replaced.
export const unquote = (text) => text.replace(/(?:%[0-9a-fA-F]{2})+/g,
  (run) => new TextDecoder().decode(Uint8Array.from(run.slice(1).split('%'), (pair) => parseInt(pair, 16))));
