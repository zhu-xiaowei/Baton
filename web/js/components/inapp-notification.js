// In-app alerts (bridge/notify.mjs), shown like the native push while the app is in front: newest on top,
// one per Session, at most MAX before "N more"; they stay until closed, swiped away or tapped (opens the Session).
const MAX = 3;
let stack = null;
let items = []; // { key, alert, at, id }
let seq = 0;
let expanded = false;
const shown = new Set(); // ids already drawn: their entrance animation never replays

const keyOf = (alert) => alert.device + '|' + alert.sessionId;

export function showInAppNotification(alert, onOpen) {
  if (!alert?.projectName || !alert.sessionId || !alert.body) return false;
  items = [{ key: keyOf(alert), alert, at: new Date(), id: ++seq, onOpen }, ...items.filter((n) => n.key !== keyOf(alert))];
  draw();
  return true;
}

// The Session was opened some other way.
export function dismissInAppNotifications(sessionId) {
  const before = items.length;
  items = items.filter((n) => n.alert.rootSessionId !== sessionId && n.alert.sessionId !== sessionId);
  if (items.length !== before) draw();
}

function remove(id) {
  items = items.filter((n) => n.id !== id);
  draw();
}

function fadeOut(el, id) {
  el.classList.add('settle');
  el.style.opacity = '0';
  setTimeout(() => remove(id), 200);
}

function draw() {
  if (!stack) {
    stack = document.createElement('div');
    stack.className = 'inapp-stack';
    document.body.append(stack);
  }
  stack.textContent = '';
  if (items.length <= MAX) expanded = false;
  stack.classList.toggle('expanded', expanded);
  for (const n of items.slice(0, expanded ? items.length : MAX)) stack.append(card(n));
  if (items.length > MAX) {
    const more = document.createElement('button');
    more.className = 'inapp-more';
    more.textContent = expanded ? 'Collapse' : `${items.length - MAX} more`;
    more.onclick = () => { expanded = !expanded; draw(); };
    const clear = document.createElement('button');
    clear.className = 'inapp-more inapp-clear';
    clear.textContent = '✕';
    clear.title = 'Clear all';
    clear.setAttribute('aria-label', 'Clear all');
    clear.onclick = () => { items = []; draw(); };
    const row = document.createElement('div');
    row.className = 'inapp-actions';
    row.append(more, clear);
    stack.append(row);
  }
}

function card(n) {
  const el = document.createElement('div');
  el.className = shown.has(n.id) ? 'inapp' : 'inapp fresh';
  shown.add(n.id);
  el.setAttribute('role', 'alert');
  el.innerHTML = '<img src="assets/baton-notification-icon.png" alt=""><div class="inapp-head"><div class="inapp-title"></div>'
    + '<span class="inapp-time"></span></div><div class="inapp-subtitle"></div><div class="inapp-body"></div>'
    + '<button class="inapp-close" aria-label="Close">✕</button>';
  el.querySelector('.inapp-title').textContent = n.alert.projectName;
  el.querySelector('.inapp-time').textContent = n.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  el.querySelector('.inapp-subtitle').textContent = n.alert.sessionTitle || '';
  el.querySelector('.inapp-body').textContent = n.alert.body;
  el.querySelector('.inapp-close').onclick = (event) => { event.stopPropagation(); fadeOut(el, n.id); };
  el.onclick = () => {
    if (el.dataset.swiped) return;
    remove(n.id);
    n.onOpen?.(n.alert);
  };
  swipe(el, n.id);
  return el;
}

// Left/right slides it out. Collapsed, up fades it where it is and down only stretches a little; expanded, a
// vertical drag scrolls the list (touch-action: pan-y).
function swipe(el, id) {
  let x0 = null, y0 = 0, dx = 0, dy = 0, axis = '';
  el.addEventListener('pointerdown', (event) => {
    if (event.target.closest('.inapp-close')) return;
    x0 = event.clientX; y0 = event.clientY; dx = dy = 0; axis = '';
    el.setPointerCapture(event.pointerId);
    // A drag must not select the page below; on touch this would also cancel the click.
    if (event.pointerType === 'mouse') event.preventDefault();
    // Removing .dragging would otherwise replay the entrance and move the card off the click point.
    el.classList.remove('fresh');
    el.classList.add('dragging');
  });
  el.addEventListener('pointermove', (event) => {
    if (x0 === null) return;
    dx = event.clientX - x0; dy = event.clientY - y0;
    if (!axis && Math.hypot(dx, dy) > 6) { axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'; el.dataset.swiped = '1'; }
    if (axis === 'x') {
      el.style.transform = `translateX(${dx}px)`;
      el.style.opacity = String(1 - Math.min(Math.abs(dx) / el.offsetWidth, 1) * 0.8);
    } else if (axis === 'y' && !expanded) {
      el.style.transform = `translateY(${Math.min(dy, 0) + Math.max(dy, 0) * 0.2}px)`;
      el.style.opacity = String(1 - Math.min(-Math.min(dy, 0) / el.offsetHeight, 1) * 0.8);
    }
  });
  const end = () => {
    if (x0 === null) return;
    x0 = null;
    el.classList.remove('dragging');
    el.classList.add('settle');
    const gone = axis === 'x' ? Math.abs(dx) > el.offsetWidth * 0.3 : axis === 'y' && !expanded && -dy > Math.min(40, el.offsetHeight * 0.4);
    if (gone) {
      if (axis === 'x') el.style.transform = `translateX(${dx > 0 ? 120 : -120}%)`;
      fadeOut(el, id);
      return;
    }
    el.style.transform = el.style.opacity = '';
    setTimeout(() => { delete el.dataset.swiped; el.classList.remove('settle'); }, 220);
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}
