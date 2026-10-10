export function openDevelopmentBrowser() {
  if (!import.meta.env.DEV) return false;
  const address = new URLSearchParams(location.search).get('browser');
  if (!address) return false;
  void Promise.all([import('./page.js'), import('../../css/style.css')]).then(([{ openBrowserPage }]) => {
    openBrowserPage({
      url: address,
      onExternal: url => window.open(url, '_blank', 'noopener'),
      onClose: () => {
        const url = new URL(location.href);
        url.searchParams.delete('browser');
        location.replace(url);
      },
    });
  });
  return true;
}
