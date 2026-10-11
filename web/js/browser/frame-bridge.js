(() => {
  if (window.parent === window || window.__batonBrowserFrame) return;
  window.__batonBrowserFrame = true;
  const documentId = Math.random().toString(36).slice(2);
  let token = null;

  function report(mode) {
    if (!token) return;
    window.parent.postMessage({
      type: 'baton-browser-state', token, mode,
      url: location.href, title: document.title, documentId, readyState: document.readyState,
    }, '*');
  }

  for (const [method, mode] of [['pushState', 'push'], ['replaceState', 'replace']]) {
    const original = history[method];
    history[method] = function (...args) {
      const result = original.apply(this, args);
      report(mode);
      return result;
    };
  }

  window.addEventListener('popstate', () => report('pop'));
  window.addEventListener('hashchange', () => report('hash'));
  window.addEventListener('pagehide', () => report('navigating'));
  document.addEventListener('DOMContentLoaded', () => report('ready'));
  window.addEventListener('pageshow', () => report('ready'));
  window.addEventListener('load', () => report('ready'));
  window.addEventListener('message', event => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (message?.type === 'baton-browser-init' && typeof message.token === 'string') {
      if (message.documentId && message.documentId !== documentId) return;
      token = message.token;
      report(document.readyState === 'loading' ? 'loading' : 'ready');
      return;
    }
    if (message?.type !== 'baton-browser-command' || message.token !== token) return;
    if (message.action === 'back') history.back();
    else if (message.action === 'forward') history.forward();
    else if (message.action === 'reload') location.reload();
    else if (message.action === 'stop') {
      window.stop();
      report('stopped');
    }
  });
  window.parent.postMessage({
    type: 'baton-browser-available', documentId, url: location.href,
    navigationType: window.navigation?.activation?.navigationType,
  }, '*');
})();
