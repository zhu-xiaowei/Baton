// Answers ./__media/<token> with bytes the page decrypts (web/js/media/serve.js); nothing else.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('message', (event) => { if (event.data === 'claim') event.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', (event) => {
  const path = new URL(event.request.url).pathname;
  const at = path.lastIndexOf('/__media/');
  if (at >= 0) event.respondWith(serve(event, path.slice(at + 9)));
});

async function serve(event, token) {
  // A download navigation has no client of its own.
  const page = (event.clientId && await self.clients.get(event.clientId))
    || (await self.clients.matchAll({ type: 'window' }))[0];
  if (!page) return new Response(null, { status: 404 });
  const { port1, port2 } = new MessageChannel();
  const reply = () => new Promise((resolve) => { port1.onmessage = (message) => resolve(message.data); });
  const head = reply();
  page.postMessage({ media: token, range: event.request.headers.get('range'), method: event.request.method }, [port2]);
  const { status, headers, body } = await head;
  if (!body) { port1.close(); return new Response(null, { status, headers }); }
  return new Response(new ReadableStream({
    async pull(controller) {
      const next = reply();
      port1.postMessage('pull');
      const data = await next;
      if (data.chunk) controller.enqueue(new Uint8Array(data.chunk));
      else if (data.error) controller.error(new Error('Media read failed'));
      else { controller.close(); port1.close(); }
    },
    cancel() { port1.postMessage('cancel'); port1.close(); },
  }), { status, headers });
}
