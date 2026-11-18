// A banner for an account limit the relay closed this page's socket for (4429), with a Reconnect button when allowed.
const TEXT = {
  too_many_apps: 'This window was disconnected (too many open windows)',
  monthly_limit: "This month's usage limit has been reached; it resets on the 1st",
};
let banner;

export function showLimit(reason, onReconnect) {
  if (typeof document === 'undefined' || !document.body) return;
  if (!reason) return banner?.remove();
  banner ||= document.createElement('div');
  banner.className = 'limit-banner';
  banner.setAttribute('role', 'alert');
  banner.textContent = TEXT[reason] || 'Disconnected by the server';
  if (reason !== 'monthly_limit') {
    const button = document.createElement('button');
    button.textContent = 'Reconnect';
    button.onclick = onReconnect;
    banner.append(button);
  }
  document.body.append(banner);
}
