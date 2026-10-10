import { state } from './state.js';
import { parsePreviewTarget } from './preview-link.js';

const content = document.getElementById('content');

if (content && (window.isTauri || window.__TAURI_INTERNALS__) && window.IntersectionObserver) {
  const links = new Set();
  const visible = new Set();
  let candidate = null;
  let context = null;
  let generation = 0;
  let timer = null;
  let preview = null;
  let warming = false;

  function update() {
    const nextContext = [state.SERVER, state.KEY, state.appState.device, state.appState.session];
    const sameContext = context?.every((value, index) => value === nextContext[index]);
    let next = null;
    if (state.KEY && state.appState.session && state.deviceOnlineMap[state.appState.device] !== false) {
      if (sameContext && warming) next = candidate;
      else if (!document.hidden) next = Array.from(visible).find(link => link.isConnected) || null;
    }
    if (candidate === next && sameContext) return;
    candidate = next;
    context = nextContext;
    warming = false;
    const version = ++generation;
    clearTimeout(timer);
    void preview?.cancelPreviewPrewarm();
    if (!next) return;
    timer = setTimeout(async () => {
      try {
        const module = await import('./preview.js');
        if (version !== generation || !next.isConnected || document.hidden) return;
        preview = module;
        warming = true;
        await module.prewarmPreviewLink(next.href, nextContext[2]);
      } catch {}
    }, 250);
  }

  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting && entry.target.isConnected) visible.add(entry.target);
      else visible.delete(entry.target);
    }
    update();
  }, { root: content, threshold: 0.01 });

  function observe(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const candidates = node.matches('a.ext-link') ? [node] : node.querySelectorAll('a.ext-link');
    for (const link of candidates) {
      if (links.has(link) || !link.closest('.messages') || !parsePreviewTarget(link.href)) continue;
      links.add(link);
      observer.observe(link);
    }
  }

  observe(content);
  const mutations = new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) observe(node);
    }
    for (const link of links) {
      if (link.isConnected) continue;
      observer.unobserve(link);
      links.delete(link);
      visible.delete(link);
    }
    update();
  });
  mutations.observe(content, { childList: true, subtree: true });
  document.addEventListener('visibilitychange', update);
  window.addEventListener('pagehide', () => {
    clearTimeout(timer);
    generation++;
    mutations.disconnect();
    observer.disconnect();
    void preview?.cancelPreviewPrewarm();
  }, { once: true });
}
