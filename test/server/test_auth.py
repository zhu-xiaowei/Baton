from types import SimpleNamespace

from asgi_client import Client as TestClient

import auth
import bridge_ws
import main


def test_tokens_resolve_to_their_account_kind_and_role(monkeypatch):
    h = auth.token_hash('bt_phone')
    items = {(f'TOKEN#{h}', '-'): {'accountId': 'a1', 'kind': 'app'}, ('ACCOUNT#a1', 'META'): {'createdAt': 1}}
    monkeypatch.setattr(auth, '_table', SimpleNamespace(update_item=lambda **_: None,
        get_item=lambda Key: {'Item': items[(Key['pk'], Key['sk'])]} if (Key['pk'], Key['sk']) in items else {}))
    client, phone = TestClient(main.app), {'x-api-key': 'bt_phone'}
    assert client.get('/api/bridge/devices').status_code == 401
    assert client.post('/api/auth/start-token', headers=phone).status_code == 403
    assert client.get('/api/install', headers=phone).status_code == 403
    connect = lambda role: bridge_ws._handle_connect({'queryStringParameters': {'apiKey': 'bt_phone', 'role': role}}, 'c')
    assert connect('bridge') == {'statusCode': 403}
    assert auth.resolve('bt_phone') == {'accountId': 'a1', 'kind': 'app', 'deviceName': '', 'tokenHash': h}
    del items[('ACCOUNT#a1', 'META')]  # read on every request: a deleted account stops at once
    assert auth.resolve('bt_phone') is None and auth.resolve('bt_other') is None
