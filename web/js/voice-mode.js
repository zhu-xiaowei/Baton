// Voice mode: an opt-in, per-Session layer over the text workflow. Sessions start in text mode;
// the title-bar headphones toggle turns on dictation (components/voice.js) and spoken replies
// (here). Messages, history and what the agent receives stay text either way.
import { state } from './state.js';
import { showToast } from './components/toast.js';

const SETTINGS_KEY = 'baton-voice-settings';
const SESSION_PREFIX = 'baton-voice:';
const DEFAULTS = { autoRead: true, brief: true, threshold: 300, autoSend: false, language: 'auto' };
export const BRIEF_THRESHOLDS = [200, 300, 500];

function readJson(key) {
  try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch { return {}; }
}

export function voiceSettings() {
  return { ...DEFAULTS, ...readJson(SETTINGS_KEY) };
}

export function saveVoiceSettings(patch) {
  const next = { ...voiceSettings(), ...patch };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  return next;
}

export function currentVoiceSessionId() {
  const session = state.appState?.session;
  if (!session || session === '__new__') return '';
  return state.rootSessionId || session;
}

export function sessionVoice(sessionId = currentVoiceSessionId()) {
  const base = { on: false, brief: voiceSettings().brief };
  return sessionId ? { ...base, ...readJson(SESSION_PREFIX + sessionId) } : base;
}

function saveSessionVoice(sessionId, patch) {
  const next = { ...sessionVoice(sessionId), ...patch };
  // Text mode with the default brief choice is the absence of a record.
  if (!next.on && next.brief === voiceSettings().brief) localStorage.removeItem(SESSION_PREFIX + sessionId);
  else localStorage.setItem(SESSION_PREFIX + sessionId, JSON.stringify(next));
  return next;
}

// The server answers /api/voice/config only when voice mode is deployed (VoiceMode=true); older
// or voice-off stacks hide every voice control. The last answer is cached per server.
const AVAILABLE_KEY = 'baton-voice-available';
let available = null;

export function voiceAvailable() {
  if (available === null) {
    try { available = JSON.parse(localStorage.getItem(AVAILABLE_KEY) || '{}')[state.SERVER] === true; } catch { available = false; }
  }
  return available;
}

export async function refreshVoiceAvailability(fetchImpl = globalThis.fetch) {
  let next = false;
  try {
    if (state.SERVER && state.KEY) {
      const response = await fetchImpl(state.SERVER + '/api/voice/config', { headers: { 'x-api-key': state.KEY } });
      next = response.ok && (await response.json()).enabled === true;
    }
  } catch { next = false; }
  const changed = next !== voiceAvailable();
  available = next;
  try {
    const cache = JSON.parse(localStorage.getItem(AVAILABLE_KEY) || '{}');
    cache[state.SERVER] = next;
    localStorage.setItem(AVAILABLE_KEY, JSON.stringify(cache));
  } catch {}
  if (changed) {
    if (!next) { window.stopDictation?.(); stopVoicePlayback(); }
    window.updateBreadcrumb?.();
    window.updateMicButton?.();
    renderVoiceBar();
  }
  return next;
}

export function voiceModeActive() {
  const sessionId = currentVoiceSessionId();
  return !!sessionId && voiceAvailable() && sessionVoice(sessionId).on;
}

const HEADPHONES_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1v-6h3zM3 19a2 2 0 0 0 2 2h1v-6H3z"/></svg>';
const PLAY_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
const STOP_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>';

export function voiceModeControl() {
  if (!voiceAvailable()) return '';
  const on = voiceModeActive();
  const label = on ? 'Voice mode on: tap for text mode' : 'Text mode: tap for voice mode';
  return '<button class="project-files-entry voice-mode-toggle' + (on ? ' on' : '') + '" type="button" aria-pressed="' + on + '"'
    + ' title="' + label + '" aria-label="' + label + '"'
    + ' onclick="event.stopPropagation();toggleVoiceMode()">' + HEADPHONES_SVG + '</button>';
}

// ---------- spoken replies ----------

let audio = null;
let playback = null;  // { sessionId, phase: 'loading' | 'playing' | 'blocked', mode }
let pending = null;   // a reply that ended while the app was hidden
const spoken = new Set();

function hash(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + ':' + text.length;
}

export function latestReplyText(container = document.querySelector('.messages')) {
  if (!container) return '';
  const row = [...container.children].filter(node =>
    node.matches('.assistant-turn, .msg-user, .msg-system-event') && !node.hidden).at(-1);
  if (!row?.matches('.assistant-turn:not(.stream-preview)')) return '';
  const item = [...row.querySelectorAll(':scope > .tl-item.assistant-text[data-message-text]')].at(-1);
  return item?.dataset.messageText.trim() || '';
}

export function stopVoicePlayback() {
  if (audio) {
    audio.onended = audio.onerror = null;
    audio.pause();
    audio.removeAttribute('src');
    audio = null;
  }
  playback = null;
  renderVoiceBar();
}

function finish(token) {
  if (playback !== token) return;
  audio = null;
  playback = null;
  renderVoiceBar();
}

async function startAudio(token) {
  try {
    await audio.play();
    if (playback === token) { token.phase = 'playing'; renderVoiceBar(); }
  } catch (error) {
    if (playback !== token) return;
    if (error?.name === 'NotAllowedError') { token.phase = 'blocked'; renderVoiceBar(); return; }
    finish(token);
    showToast('Could not play the reply');
  }
}

export async function speakReply(text) {
  if (!text) { showToast('No reply to read yet'); return; }
  stopVoicePlayback();
  const sessionId = currentVoiceSessionId();
  const token = { sessionId, phase: 'loading', mode: '' };
  playback = token;
  renderVoiceBar();
  try {
    const result = await window.apiPost('/api/voice/speak', {
      text, brief: sessionVoice(sessionId).brief, threshold: voiceSettings().threshold,
    });
    if (playback !== token) return;
    token.mode = result.mode;
    audio = new Audio(result.url);
    audio.onended = () => finish(token);
    audio.onerror = () => { finish(token); showToast('Could not play the reply'); };
    await startAudio(token);
  } catch {
    if (playback !== token) return;
    finish(token);
    showToast('Could not read the reply aloud');
  }
}

function waitForStableReply(sessionId, done, tries = 12, last = '') {
  setTimeout(() => {
    if (currentVoiceSessionId() !== sessionId || !voiceModeActive()) return;
    const text = latestReplyText();
    if (text && text === last) return done(text);
    if (tries > 0) waitForStableReply(sessionId, done, tries - 1, text);
    else if (text) done(text);
  }, 400);
}

// ws.js calls this when a running Session settles to completed.
window.onVoiceTurnEnd = function () {
  const sessionId = currentVoiceSessionId();
  if (!sessionId || !voiceModeActive() || !voiceSettings().autoRead) return;
  waitForStableReply(sessionId, text => {
    const key = sessionId + ':' + hash(text);
    if (spoken.has(key)) return;
    spoken.add(key);
    if (document.hidden) { pending = { sessionId, text }; return; }
    speakReply(text);
  });
};

document.addEventListener('visibilitychange', () => {
  if (document.hidden || !pending) return;
  const next = pending;
  pending = null;
  if (next.sessionId === currentVoiceSessionId() && voiceModeActive()) speakReply(next.text);
});

// ---------- voice bar (above the composer) ----------

function voiceBar() {
  let bar = document.getElementById('voice-bar');
  if (bar) return bar;
  const inputBar = document.getElementById('input-bar');
  const row = inputBar?.querySelector('.input-row');
  if (!row) return null;
  bar = document.createElement('div');
  bar.id = 'voice-bar';
  bar.className = 'voice-bar';
  bar.hidden = true;
  bar.addEventListener('click', event => {
    const action = event.target.closest('[data-voice-action]')?.dataset.voiceAction;
    if (action === 'play') speakReply(latestReplyText());
    else if (action === 'resume' && audio && playback) startAudio(playback);
    else if (action === 'stop') stopVoicePlayback();
    else if (action === 'brief') window.toggleVoiceBrief();
  });
  inputBar.insertBefore(bar, row);
  return bar;
}

let barSignature = '';

export function renderVoiceBar() {
  const active = voiceModeActive();
  const bar = active ? voiceBar() : document.getElementById('voice-bar');
  if (!bar) return;
  const brief = sessionVoice().brief;
  const phase = playback?.phase || 'idle';
  const signature = [active, brief, phase, playback?.mode].join('|');
  if (signature === barSignature && bar.hidden === !active) return;
  barSignature = signature;
  bar.hidden = !active;
  if (!active) return;
  const status = phase === 'loading' ? 'Preparing audio…'
    : phase === 'blocked' ? 'Tap play to listen'
      : phase === 'playing' ? (playback.mode === 'brief' ? 'Reading brief' : 'Reading reply') : 'Voice mode';
  const main = phase === 'idle'
    ? '<button type="button" class="voice-bar-btn" data-voice-action="play" title="Read the latest reply" aria-label="Read the latest reply">' + PLAY_SVG + '<span>Latest reply</span></button>'
    : phase === 'blocked'
      ? '<button type="button" class="voice-bar-btn" data-voice-action="resume" aria-label="Play">' + PLAY_SVG + '<span>Play</span></button>'
      : '<button type="button" class="voice-bar-btn" data-voice-action="stop" aria-label="Stop reading">' + STOP_SVG + '<span>Stop</span></button>';
  bar.innerHTML = '<span class="voice-bar-status" role="status">' + status + '</span>' + main
    + '<button type="button" class="voice-bar-chip' + (brief ? ' on' : '') + '" data-voice-action="brief" aria-pressed="' + brief + '"'
    + ' title="Condense long replies into a spoken brief">Brief</button>';
}

window.refreshVoiceUi = function () {
  if (playback && playback.sessionId !== currentVoiceSessionId()) stopVoicePlayback();
  if (pending && pending.sessionId !== currentVoiceSessionId()) pending = null;
  renderVoiceBar();
};

window.toggleVoiceMode = function () {
  const sessionId = currentVoiceSessionId();
  if (!sessionId || !voiceAvailable()) return;
  const next = saveSessionVoice(sessionId, { on: !sessionVoice(sessionId).on });
  if (!next.on) { window.stopDictation?.(); stopVoicePlayback(); pending = null; }
  else if (!sessionStorage.getItem('baton-voice-hint')) {
    sessionStorage.setItem('baton-voice-hint', '1');
    showToast('Voice mode: hold the mic to talk; replies are read aloud');
  }
  for (const button of document.querySelectorAll('.voice-mode-toggle')) button.outerHTML = voiceModeControl();
  window.initVoiceButton?.();
  window.updateMicButton?.();
  renderVoiceBar();
};

window.toggleVoiceBrief = function () {
  const sessionId = currentVoiceSessionId();
  if (!sessionId) return;
  saveSessionVoice(sessionId, { brief: !sessionVoice(sessionId).brief });
  renderVoiceBar();
};

window.voiceModeActive = voiceModeActive;
window.voiceModeControl = voiceModeControl;
window.voiceSettings = voiceSettings;

// ---------- Settings page ----------

export function mountVoiceSettings(root = document.getElementById('voiceSettings')) {
  if (!root) return;
  if (!voiceAvailable()) {
    refreshVoiceAvailability().then(on => { if (on) mountVoiceSettings(root); });
    return;
  }
  if (root.dataset.mounted) return;
  root.dataset.mounted = '1';
  const settings = voiceSettings();
  const bind = (id, key) => {
    const input = root.querySelector('#' + id);
    if (!input) return;
    input.checked = !!settings[key];
    input.addEventListener('change', () => saveVoiceSettings({ [key]: input.checked }));
  };
  bind('voiceAutoRead', 'autoRead');
  bind('voiceBriefDefault', 'brief');
  bind('voiceAutoSend', 'autoSend');
  for (const button of root.querySelectorAll('[data-voice-language]')) {
    button.setAttribute('aria-pressed', String(button.dataset.voiceLanguage === settings.language));
    button.addEventListener('click', () => {
      saveVoiceSettings({ language: button.dataset.voiceLanguage });
      for (const other of root.querySelectorAll('[data-voice-language]')) other.setAttribute('aria-pressed', String(other === button));
    });
  }
  for (const button of root.querySelectorAll('[data-brief-threshold]')) {
    const value = Number(button.dataset.briefThreshold);
    button.setAttribute('aria-pressed', String(value === settings.threshold));
    button.addEventListener('click', () => {
      saveVoiceSettings({ threshold: value });
      for (const other of root.querySelectorAll('[data-brief-threshold]')) other.setAttribute('aria-pressed', String(other === button));
    });
  }
  root.hidden = false;
}

if (typeof document !== 'undefined' && !globalThis.__VOICE_NO_AUTO_REFRESH__) void refreshVoiceAvailability();
