let _config;

export function initHttp(config) {
  _config = config;
}

export async function get(endpoint) {
  try {
    const res = await fetch(`${_config.server}${endpoint}`, { headers: { 'x-api-key': _config.apiKey } });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

export async function post(endpoint, data) {
  try {
    const res = await fetch(`${_config.server}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': _config.apiKey },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`POST ${endpoint} → ${res.status}: ${text.slice(0, 200)}`);
    }
    return res;
  } catch (err) {
    console.error(`POST ${endpoint} failed: ${err.message}`);
    return null;
  }
}

export async function postRequired(endpoint, data) {
  const response = await post(endpoint, data);
  if (!response?.ok) throw new Error(`POST ${endpoint} failed`);
  return response;
}
