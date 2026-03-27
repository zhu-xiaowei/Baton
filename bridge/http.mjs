let _config;

export function initHttp(config) {
  _config = config;
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
