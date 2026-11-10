const CLOSE_SVG = '<svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor"'
  + ' stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

// Renders the titlebar tab strip from Rust's per-window state and forwards user actions.
export function createTabStrip(doc, invoke) {
  const root = doc.getElementById('tab-strip');
  const list = root.querySelector('.tab-list');
  const add = root.querySelector('.tab-new');
  let current = { tabs: [], selected: '' };
  let drag = null;
  let pending = null;
  const send = (command, args) => invoke(command, args).catch(() => {});

  function tabElement(tab) {
    const el = doc.createElement('div');
    el.className = 'tab';
    el.setAttribute('role', 'tab');
    el.dataset.id = tab.id;
    el.innerHTML = '<span class="tab-title"></span>'
      + '<button class="tab-close" type="button" tabindex="-1" aria-label="Close tab">' + CLOSE_SVG + '</button>';
    return el;
  }

  function render(state) {
    if (!state || !Array.isArray(state.tabs)) return;
    // Applying a new order mid-drag would yank the tab from under the pointer.
    if (drag) { pending = state; return; }
    current = state;
    root.classList.toggle('fullscreen', !!state.fullscreen);
    const existing = new Map([...list.querySelectorAll('.tab')].map(el => [el.dataset.id, el]));
    const ordered = state.tabs.map(tab => {
      const el = existing.get(tab.id) || tabElement(tab);
      existing.delete(tab.id);
      const title = el.querySelector('.tab-title');
      if (title.textContent !== tab.title) title.textContent = tab.title;
      el.title = tab.title;
      const selected = tab.id === state.selected;
      el.classList.toggle('active', selected);
      el.setAttribute('aria-selected', String(selected));
      return el;
    });
    for (const stale of existing.values()) stale.remove();
    // The + button lives in the list so it always follows the last tab.
    ordered.forEach((el, index) => {
      if (list.children[index] !== el) list.insertBefore(el, list.children[index] || add);
    });
  }

  // Like Chrome: a tab activates on press, closes on its × or a middle click.
  list.addEventListener('mousedown', event => {
    const tab = event.target.closest('.tab');
    if (!tab || event.button !== 0 || event.target.closest('.tab-close')) return;
    // Re-selecting the active tab still hands keyboard focus back to its content webview.
    send('macos_tabs_select', { id: tab.dataset.id });
  });
  list.addEventListener('auxclick', event => {
    const tab = event.target.closest('.tab');
    if (tab && event.button === 1) send('macos_tabs_close', { id: tab.dataset.id });
  });
  list.addEventListener('click', event => {
    const close = event.target.closest('.tab-close');
    if (close) send('macos_tabs_close', { id: close.closest('.tab').dataset.id });
  });
  add.addEventListener('click', () => send('macos_tabs_new'));

  // Horizontal drag reorders tabs; neighbours slide aside as the dragged tab passes their middle.
  list.addEventListener('pointerdown', event => {
    const tab = event.target.closest('.tab');
    if (!tab || event.button !== 0 || event.target.closest('.tab-close')) return;
    const tabs = [...list.querySelectorAll('.tab')];
    const from = tabs.indexOf(tab);
    drag = { tab, tabs, from, to: from, startX: event.clientX, moved: false,
      rects: tabs.map(el => el.getBoundingClientRect()) };
    tab.setPointerCapture?.(event.pointerId);
  });
  list.addEventListener('pointermove', event => {
    if (!drag) return;
    const { tab, tabs, from, rects } = drag;
    const dx = event.clientX - drag.startX;
    if (!drag.moved && Math.abs(dx) < 4) return;
    if (!drag.moved) {
      drag.moved = true;
      list.classList.add('reordering');
      tab.classList.add('dragging');
    }
    const offset = Math.max(rects[0].left - rects[from].left,
      Math.min(rects[rects.length - 1].right - rects[from].right, dx));
    tab.style.transform = `translateX(${offset}px)`;
    const center = rects[from].left + rects[from].width / 2 + offset;
    // A neighbour yields once the dragged tab's centre crosses its near edge, as in Chrome.
    drag.to = from + rects.filter((rect, i) => i > from && rect.left < center).length
      - rects.filter((rect, i) => i < from && rect.right > center).length;
    tabs.forEach((el, i) => {
      if (i === from) return;
      const shift = from < drag.to && i > from && i <= drag.to ? -rects[from].width
        : drag.to < from && i >= drag.to && i < from ? rects[from].width : 0;
      el.style.transform = shift ? `translateX(${shift}px)` : '';
    });
  });
  function endDrag() {
    const ended = drag;
    if (!ended) return;
    drag = null;
    // Drop the transition first so tabs land in their new DOM slots without animating back.
    list.classList.remove('reordering');
    ended.tab.classList.remove('dragging');
    for (const el of ended.tabs) el.style.transform = '';
    const latest = pending || current;
    pending = null;
    if (!ended.moved || ended.to === ended.from) return render(latest);
    const order = ended.tabs.filter(el => el !== ended.tab);
    order.splice(ended.to, 0, ended.tab);
    for (const el of order) list.insertBefore(el, add);
    // Rust broadcasts the authoritative order; restore the last state if the move fails.
    invoke('macos_tabs_move', { id: ended.tab.dataset.id, index: ended.to }).catch(() => render(latest));
  }
  list.addEventListener('pointerup', endDrag);
  list.addEventListener('pointercancel', endDrag);
  return { render };
}
