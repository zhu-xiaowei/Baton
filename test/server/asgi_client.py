"""A minimal in-process HTTP client for the FastAPI app (CI has no httpx, which TestClient needs)."""
import asyncio
import json
from types import SimpleNamespace


class Client:
    def __init__(self, app):
        self.app = app

    def request(self, method, url, json=None, headers=None):
        path, _, query = url.partition('?')
        body = b'' if json is None else _dumps(json)
        head = {'content-type': 'application/json', **{k.lower(): v for k, v in (headers or {}).items()}}
        scope = {'type': 'http', 'http_version': '1.1', 'method': method, 'path': path, 'raw_path': path.encode(),
                 'query_string': query.encode(), 'root_path': '', 'scheme': 'http', 'server': ('test', 80),
                 'client': ('testclient', 0), 'headers': [(k.encode(), v.encode()) for k, v in head.items()]}
        sent, chunks = [], [{'type': 'http.request', 'body': body, 'more_body': False}]

        async def receive():
            return chunks.pop(0) if chunks else {'type': 'http.disconnect'}

        async def send(message):
            sent.append(message)

        asyncio.run(self.app(scope, receive, send))
        text = b''.join(m.get('body', b'') for m in sent if m['type'] == 'http.response.body').decode()
        status = next(m['status'] for m in sent if m['type'] == 'http.response.start')
        return SimpleNamespace(status_code=status, text=text, json=lambda: _loads(text))

    def get(self, url, headers=None):
        return self.request('GET', url, headers=headers)

    def post(self, url, json=None, headers=None):
        return self.request('POST', url, json=json, headers=headers)


def _dumps(value):
    return json.dumps(value).encode()


def _loads(text):
    return json.loads(text)
