// The deployment's single API key, read from API Gateway by name so it is never stored in a table.
import { KeyUnavailable } from '../core/auth.mjs';
import { call, region } from './aws.mjs';

const CACHE_SECONDS = 300;
let cached = [0, null];

export async function currentKey() {
  if (cached[0] > Date.now() / 1000) return cached[1];
  const name = process.env.API_KEY_NAME ?? '';
  let items;
  try {
    const query = new URLSearchParams({ name, includeValues: 'true', limit: '500' });
    const reply = JSON.parse(await call('apigateway', { method: 'GET', url: `https://apigateway.${region()}.amazonaws.com/apikeys?${query}`,
      headers: { accept: 'application/json' } }));
    items = reply.item ?? [];
  } catch (error) {
    console.log(`API key lookup failed: ${error.message}`);
    if (cached[1]) return cached[1];
    throw new KeyUnavailable();
  }
  const value = items.find((item) => item.name === name && item.enabled)?.value;
  // During rotation this Lambda may update before the new key exists; not cached, so it is retried.
  if (!value) throw new KeyUnavailable();
  cached = [Date.now() / 1000 + CACHE_SECONDS, value];
  return value;
}
