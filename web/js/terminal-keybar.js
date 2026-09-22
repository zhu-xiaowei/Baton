import { attachTerminalJoystick } from './terminal-joystick.js';

function encodeKey(key, modifiers, terminal) {
  const { ctrl, shift, alt } = modifiers;
  const modifier = 1 + Number(shift) + Number(alt) * 2 + Number(ctrl) * 4;
  const arrow = { ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D' }[key];
  if (arrow) return modifier > 1 ? `\x1b[1;${modifier}${arrow}`
    : `\x1b${terminal.modes.applicationCursorKeysMode ? 'O' : '['}${arrow}`;
  if (key === 'Escape') return '\x1b';
  if (key === 'Enter') return '\r';
  if (key === 'Tab') return shift && !ctrl && !alt ? '\x1b[Z' : `${alt ? '\x1b' : ''}\t`;
  if (key === 'Backspace') return `${alt ? '\x1b' : ''}\x7f`;
  if (!/^[\x20-\x7e]$/.test(key)) return null;
  let character = key;
  if (shift) {
    const index = '`1234567890-=[]\\;\',./'.indexOf(character);
    character = index < 0 ? character.toUpperCase() : '~!@#$%^&*()_+{}|:"<>?'[index];
  }
  if (ctrl) {
    const symbols = { ' ': 0, '2': 0, '3': 27, '4': 28, '5': 29, '6': 30, '7': 31, '8': 127, '/': 31, '?': 127 };
    const code = character.toUpperCase().charCodeAt(0);
    if (Object.hasOwn(symbols, character)) character = String.fromCharCode(symbols[character]);
    else if (code >= 64 && code <= 95) character = String.fromCharCode(code - 64);
  }
  return `${alt ? '\x1b' : ''}${character}`;
}

export function attachTerminalKeybar({ page, screen, terminal, send, canInput, showError, onJoystickStart }) {
  const document = page.ownerDocument;
  const window = document.defaultView;
  const listeners = [];
  const listen = (target, name, callback, options) => {
    target.addEventListener(name, callback, options);
    listeners.push(() => target.removeEventListener(name, callback, options));
  };
  const modifiers = { ctrl: false, shift: false, alt: false };
  let revision = 0;
  let disposed = false;
  let pasting = false;
  const bar = document.createElement('div');
  bar.className = 'project-terminal-keybar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Terminal keys');
  for (const [key, label] of [['Escape', 'Esc'], ['Tab', 'Tab'], ['ctrl', 'Ctrl'], ['shift', 'Shift'],
    ['alt', 'Alt'], ['Paste', 'Paste'], ['Enter', 'Enter']]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.key = key;
    button.textContent = label;
    if (Object.hasOwn(modifiers, key)) button.setAttribute('aria-pressed', 'false');
    bar.appendChild(button);
  }
  screen.after(bar);
  page.classList.add('has-mobile-controls');

  function clearModifiers() {
    for (const key of Object.keys(modifiers)) modifiers[key] = false;
    renderModifiers();
  }

  function renderModifiers() {
    for (const button of bar.querySelectorAll('[aria-pressed]')) {
      button.setAttribute('aria-pressed', String(modifiers[button.dataset.key]));
    }
  }

  function sendKey(key, consume = true) {
    if (!canInput()) return false;
    const data = encodeKey(key, modifiers, terminal);
    if (data === null) return false;
    if (consume) clearModifiers();
    send(data);
    return true;
  }

  const joystick = attachTerminalJoystick({ page, screen, canInput,
    onStart: onJoystickStart, onEnd: clearModifiers, onKey: key => sendKey(key, false) });

  function reset() {
    revision++;
    clearModifiers();
    joystick.reset();
  }

  function sync() {
    const enabled = canInput();
    if (!enabled) reset();
    for (const button of bar.querySelectorAll('button')) {
      button.disabled = !enabled || (button.dataset.key === 'Paste' && pasting);
    }
  }

  async function paste() {
    if (pasting || !canInput()) return;
    clearModifiers();
    const requestedRevision = revision;
    pasting = true;
    sync();
    try {
      if (!window.navigator.clipboard?.readText) throw new Error('Clipboard unavailable');
      const text = await window.navigator.clipboard.readText();
      if (disposed || requestedRevision !== revision || !canInput()) return;
      clearModifiers();
      terminal.paste(text);
    } catch {
      if (!disposed && requestedRevision === revision && canInput()) {
        showError('Unable to read clipboard. Allow paste access and try again.');
      }
    } finally {
      pasting = false;
      if (!disposed) sync();
    }
  }

  listen(bar, 'pointerdown', event => event.preventDefault());
  listen(bar, 'mousedown', event => event.preventDefault());
  listen(bar, 'contextmenu', event => event.preventDefault());
  listen(bar, 'click', event => {
    const button = event.target.closest('button');
    if (!button || button.disabled || !canInput()) return;
    const key = button.dataset.key;
    if (Object.hasOwn(modifiers, key)) {
      modifiers[key] = !modifiers[key];
      renderModifiers();
    } else if (key === 'Paste') void paste();
    else sendKey(key);
  });
  listen(terminal.textarea, 'paste', clearModifiers, true);
  listen(terminal.textarea, 'compositionstart', clearModifiers, true);
  listen(window, 'blur', reset);
  listen(document, 'visibilitychange', () => { if (document.hidden) reset(); });
  terminal.attachCustomKeyEventHandler(event => {
    if (event.type !== 'keydown' || event.isComposing || event.keyCode === 229
      || !Object.values(modifiers).some(Boolean) || !canInput()) return true;
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return true;
    const combined = { ctrl: modifiers.ctrl || event.ctrlKey, shift: modifiers.shift || event.shiftKey,
      alt: modifiers.alt || event.altKey };
    const data = encodeKey(event.key, combined, terminal);
    if (data === null || event.metaKey) return true;
    clearModifiers();
    event.preventDefault();
    event.stopPropagation();
    send(data);
    return false;
  });
  sync();

  return {
    reset, sync,
    handleData(data) {
      if (!Object.values(modifiers).some(Boolean)) return false;
      const key = { '\r': 'Enter', '\n': 'Enter', '\t': 'Tab', '\x7f': 'Backspace', '\b': 'Backspace', '\x1b': 'Escape' }[data]
        || (/^[\x20-\x7e]$/.test(data) ? data : null);
      if (key && sendKey(key)) return true;
      clearModifiers();
      return false;
    },
    dispose() {
      disposed = true;
      reset();
      joystick.dispose();
      for (const remove of listeners) remove();
      terminal.attachCustomKeyEventHandler(() => true);
      bar.remove();
      page.classList.remove('has-mobile-controls');
    },
  };
}
