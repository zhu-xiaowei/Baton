export function parsePreviewTarget(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.protocol !== 'http:' || url.username || url.password
    || !['localhost', '127.0.0.1', '::1'].includes(hostname)) return null;
  const port = url.port ? Number(url.port) : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return {
    port,
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
    displayUrl: url.href,
  };
}

export function parsePreviewInput(value) {
  const text = String(value || '').trim();
  if (/^\d{1,5}$/.test(text)) {
    return parsePreviewTarget(`http://127.0.0.1:${text}/`);
  }
  if (/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(text)) {
    return parsePreviewTarget(`http://${text}`);
  }
  return parsePreviewTarget(text);
}
