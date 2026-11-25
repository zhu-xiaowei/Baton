// GitHub star prompt: after a reply to the 5th message sent here (Later: the 10th, then the 20th, 3 days apart,
// at most 3 times). The first online computer whose gh is signed in stars in one click; otherwise the button
// opens GitHub (an .ext-link, so the Apps open the system browser).
import { state } from '../state.js';
import { cachedOnlineDevices, request } from '../v2/direct-transport.js';
import { showToast } from './toast.js';

const KEY = 'baton-star';
const STAR = '<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/></svg>';
const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return { done: true }; } };
const save = (patch) => { try { localStorage.setItem(KEY, JSON.stringify({ ...load(), ...patch })); } catch {} };
let checking = false;
const sentHere = new Set(); // turns this App started: only their replies count

export function noteStarSend(turnId) {
  const s = load();
  if (!s.done) save({ sent: (s.sent || 0) + 1 });
  sentHere.add(turnId);
}

export async function maybeAskForStar(turnId) {
  const s = load(), shown = s.shown || 0;
  if (!sentHere.delete(turnId) || checking || s.done || shown >= 3 || (s.sent || 0) < 5 * 2 ** shown || Date.now() - (s.at || 0) < 3 * 864e5) return;
  checking = true;
  const session = state.wsSessionId;
  try {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    if (document.getElementById('msg-input')?.value.trim() || document.querySelector('.has-permission-prompt, .star-card')) return;
    let device = '';
    for (const d of new Set([state.appState.device, ...cachedOnlineDevices()].filter(Boolean))) {
      const reply = await request(d, 'github_star').catch(() => null);
      if (reply?.starred) return save({ done: true });
      if (reply?.gh) { device = d; break; }
    }
    if (state.wsSessionId !== session) return;
    save({ shown: shown + 1, at: Date.now() });
    show(device);
  } finally {
    checking = false;
  }
}

function show(device) {
  const card = document.createElement('div');
  card.className = 'star-card';
  card.innerHTML = `<div class="star-card-title">${STAR}Enjoying Baton?</div><p>It’s open source. A star helps others find it.</p>
    <div class="star-card-actions"><button type="button" class="modal-btn cancel">Later</button>
    <a class="modal-btn ext-link" href="https://github.com/agentbaton/baton" target="_blank" rel="noopener">${STAR}Star on GitHub</a></div>`;
  const [later, go] = card.querySelectorAll('.modal-btn');
  later.onclick = () => card.remove();
  go.onclick = async (event) => {
    if (!device) { save({ done: true }); card.remove(); return; } // the link itself opens GitHub
    event.preventDefault();
    event.stopPropagation();
    if (go.classList.contains('busy')) return;
    go.classList.add('busy');
    go.innerHTML = '<span class="spinner"></span>Starring…';
    const reply = await request(device, 'github_star', { star: true }).catch(() => null);
    go.classList.remove('busy');
    if (reply?.starred) { save({ done: true }); card.remove(); showToast('Thanks for the star!'); return; }
    device = '';
    go.textContent = 'Open GitHub';
  };
  document.getElementById('input-bar')?.prepend(card);
}
