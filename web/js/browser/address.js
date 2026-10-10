export function normalizeBrowserAddress(value, base) {
  let address = String(value || '').trim();
  if (!address) throw new Error('Enter an HTTP or HTTPS address.');
  if (/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(address)) {
    address = `http://${address}`;
  } else if (/^(?:[^\s./?#:]+\.)+[^\s./?#:]+(?::\d+)?(?:[/?#]|$)/.test(address)) {
    address = `https://${address}`;
  } else if (address.startsWith('//')) {
    address = `https:${address}`;
  }
  let url;
  try { url = new URL(address, base || undefined); }
  catch { throw new Error('Enter a valid HTTP or HTTPS address.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Enter an HTTP or HTTPS address.');
  }
  return url.href;
}
