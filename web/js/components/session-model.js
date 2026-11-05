import { state } from '../state.js';
import { requestWsRpc } from '../ws-rpc.js';

let route = '';
let lastRead = 0;
let pending = '';

export function modelStatusLabel(status) {
  if (typeof status?.model !== 'string' || !status.model) return '';
  return status.model + (typeof status.reasoningEffort === 'string'
    ? ` · ${status.reasoningEffort}` : '');
}

function context() {
  return {
    device: state.appState.device || '',
    projectHash: state.appState.project?.hash || '',
    sessionId: state.appState.session === '__new__' ? '__new__'
      : state.activeThreadId || state.appState.session || '',
    runtime: state.appState.runtime || 'claude',
  };
}

function key(ctx) { return JSON.stringify([state.SERVER, ctx]); }

export async function refreshSessionModel() {
  const bar = document.getElementById('input-bar');
  const ctx = context();
  const current = key(ctx);
  let label = document.getElementById('session-model');
  if (route !== current) {
    route = current;
    lastRead = 0;
    label?.remove();
    label = null;
  }
  if (!bar || bar.style.display === 'none' || !ctx.sessionId || ctx.sessionId === '__new__') {
    label?.remove();
    return;
  }
  if (document.visibilityState === 'hidden' || state.ws?.readyState !== 1) {
    label?.remove();
    lastRead = 0;
    return;
  }
  if (pending === current || Date.now() - lastRead < 15000) return;
  pending = current;
  lastRead = Date.now();
  try {
    const result = await requestWsRpc({ action: 'list_command_options',
      commandName: '__session_model', ...ctx }, { timeout: 10000 });
    if (key(context()) !== current || bar.style.display === 'none' || state.ws?.readyState !== 1) return;
    if (['device', 'projectHash', 'sessionId', 'runtime'].some(field => result[field] !== ctx[field])) return;
    const text = modelStatusLabel(result.modelStatus);
    if (!text || result.error) { label?.remove(); return; }
    label = document.getElementById('session-model');
    if (!label) {
      label = document.createElement('div');
      label.id = 'session-model';
      label.style.cssText = 'font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%';
      bar.prepend(label);
    }
    label.textContent = text + (result.modelStatus.source === 'live' ? '' : ' (last reported)');
    label.title = `${result.modelStatus.source === 'live' ? 'Current' : 'Last reported'}: ${text}`;
    label.setAttribute('aria-label', label.title);
  } catch { if (key(context()) === current) document.getElementById('session-model')?.remove(); }
  finally { if (pending === current) pending = ''; }
}

// One inexpensive status read per visible session, at most every 15 seconds.
export function initSessionModel() {
  setInterval(refreshSessionModel, 5000);
  window.addEventListener('focus', () => { lastRead = 0; refreshSessionModel(); });
  document.addEventListener('visibilitychange', refreshSessionModel);
}
