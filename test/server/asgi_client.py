"""Calls the FastAPI app in-process over ASGI (CI has no httpx, which TestClient needs)."""
import asyncio
import json


def call_app(app, url, body=None, headers=None):
    """(status, JSON reply or text); POST when `body` is given."""
    path, _, query = url.partition('?')
    head = {'content-type': 'application/json', **(headers or {})}
    scope = {'type': 'http', 'http_version': '1.1', 'method': 'GET' if body is None else 'POST', 'path': path,
             'raw_path': path.encode(), 'query_string': query.encode(), 'root_path': '', 'scheme': 'http',
             'server': ('test', 80), 'client': ('testclient', 0), 'headers': [(k.lower().encode(), v.encode()) for k, v in head.items()]}
    inbox, sent = [{'type': 'http.request', 'body': b'' if body is None else json.dumps(body).encode()}], []

    async def receive():
        return inbox.pop() if inbox else {'type': 'http.disconnect'}

    async def send(message):
        sent.append(message)

    asyncio.run(app(scope, receive, send))
    text = b''.join(m.get('body', b'') for m in sent if m['type'] == 'http.response.body').decode()
    try:
        reply = json.loads(text)
    except ValueError:
        reply = text
    return next(m['status'] for m in sent if m['type'] == 'http.response.start'), reply
