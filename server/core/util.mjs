// Small helpers shared by the routes: errors, request-model validation, hashing and random ids.

export class HTTPError extends Error {
  constructor(status, detail, headers = {}) {
    super(detail);
    Object.assign(this, { status, detail, headers });
  }
}

export const length = (text) => [...text].length; // characters, not UTF-16 units
export const truncate = (text, max) => [...text].slice(0, max).join('');
export const isPrintable = (text) => !/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u.test(text.replace(/ /g, ''));
export const sha256 = async (text) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(text))), (byte) => byte.toString(16).padStart(2, '0')).join('');
export function compareDigest(a, b) { // constant time
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

// Request models: fields are [name, { required, default, pattern, maxLength, model, nullable }]; errors keep
// the shape the App and Bridge have seen ({ type, loc, msg, input, ctx }).
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const error = (type, loc, msg, input, ctx) => ({ type, loc, msg, input, ...(ctx ? { ctx } : {}) });

export function validate(fields, input, loc) {
  if (!isObject(input)) return { errors: [error('model_attributes_type', loc, 'Input should be a valid dictionary or object to extract fields from', input)] };
  const errors = [];
  const value = {};
  for (const [name, spec] of fields) {
    const at = [...loc, name];
    if (!Object.hasOwn(input, name)) {
      if (spec.required) errors.push(error('missing', at, 'Field required', input));
      else value[name] = 'default' in spec ? spec.default : '';
      continue;
    }
    const item = input[name];
    if (spec.model) {
      if (item === null && spec.nullable) { value[name] = null; continue; }
      const nested = validate(spec.model, item, at);
      if (nested.errors) errors.push(...nested.errors);
      else value[name] = nested.value;
    } else if (typeof item !== 'string') {
      errors.push(error('string_type', at, 'Input should be a valid string', item));
    } else if (spec.maxLength !== undefined && length(item) > spec.maxLength) {
      errors.push(error('string_too_long', at, `String should have at most ${spec.maxLength} characters`, item, { max_length: spec.maxLength }));
    } else if (spec.pattern && !new RegExp(spec.pattern).test(item)) {
      errors.push(error('string_pattern_mismatch', at, `String should match pattern '${spec.pattern}'`, item, { pattern: spec.pattern }));
    } else {
      value[name] = item;
    }
  }
  return errors.length ? { errors } : { value };
}

export const pattern = (source, extra = {}) => ({ pattern: source, ...extra });
