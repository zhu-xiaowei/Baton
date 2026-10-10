(() => {
  if (window.parent === window || window.__batonBrowserFrame) return;
  window.__batonBrowserFrame = true;
  let token = null;

  function report(mode) {
    if (!token) return;
    window.parent.postMessage({
      type: 'baton-browser-state', token, mode,
      url: location.href, title: document.title,
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
  window.addEventListener('message', event => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (message?.type === 'baton-browser-init' && typeof message.token === 'string') {
      token = message.token;
      report('ready');
      return;
    }
    if (message?.type !== 'baton-browser-command' || message.token !== token) return;
    if (message.action === 'back') history.back();
    else if (message.action === 'forward') history.forward();
    else if (message.action === 'reload') location.reload();
  });
})();
