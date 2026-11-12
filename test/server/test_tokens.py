import asyncio
import hashlib
import os
import sys
import time
from types import SimpleNamespace

import boto3
import pytest
from fastapi import Response

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'server', 'src'))

import api_key
import bridge_ws
import main

KEY = 'deployment-key'
REQUEST = SimpleNamespace(headers={'x-api-key': KEY}, url=SimpleNamespace(scheme='https'))


@pytest.fixture
def rows(monkeypatch):
    rows = {}
    monkeypatch.setattr(main, '_system_table', lambda: SimpleNamespace(
        put_item=lambda Item: rows.update({Item['sk']: Item}),
        get_item=lambda Key, **_: {'Item': rows[Key['sk']]} if Key['sk'] in rows else {}))
    monkeypatch.setenv('API_KEY_NAME', 'Baton-api-key')
    monkeypatch.setattr(api_key, 'current_key', lambda: KEY)
    monkeypatch.setenv('BRIDGE_IMAGES_BUCKET', 'bucket')
    monkeypatch.setattr(boto3, 'client', lambda *a, **k: SimpleNamespace(generate_presigned_url=lambda *a, **k: 'https://s3.test/b'))
    return rows


def exchange(token):
    response = Response()
    body = asyncio.run(main.exchange_token(main.ExchangeTokenBody(token=token), response))
    return response.status_code, body


def install(token, platform=''):
    return asyncio.run(main.install_with_token(REQUEST, t=token, name=None, platform=platform))


def test_tokens_are_reusable_until_they_expire_or_the_key_rotates(rows, monkeypatch):
    token = asyncio.run(main.start_token())['token']
    assert exchange(token) == exchange(token) == (200, {'apiKey': KEY})
    assert KEY not in str(rows[token])
    script = install(token)
    assert script.headers['cache-control'] == 'no-store' and f"BATON_API_KEY='{KEY}'" in script.body.decode()
    assert f"apiKey = '{KEY}'" in install(token, 'windows').body.decode()

    monkeypatch.setenv('API_KEY_NAME', 'Baton-api-key-20261028')
    assert exchange(token)[0] == 401 and install(token).status_code == 403
    monkeypatch.setenv('API_KEY_NAME', 'Baton-api-key')
    rows[token]['ttl'] = int(time.time()) - 1
    assert exchange(token)[0] == 401


@pytest.mark.real_key
def test_websocket_and_pinned_account_accept_only_the_current_key(monkeypatch):
    monkeypatch.setattr(api_key, 'current_key', lambda: KEY)
    monkeypatch.setattr(bridge_ws, '_connections_table', SimpleNamespace(put_item=lambda Item: None))
    monkeypatch.delenv('TERMINAL_DIRECT_ENDPOINT', raising=False)
    connect = lambda secret: bridge_ws._handle_connect({'queryStringParameters': {'apiKey': secret, 'role': 'app'},
        'requestContext': {'domainName': 'control.test', 'stage': 'v1'}}, 'c')
    assert connect('guess') == connect('') == {'statusCode': 401}
    assert connect(KEY) == {'statusCode': 200}

    monkeypatch.setenv('ACCOUNT_ID', 'pinned')
    assert api_key.account_id(KEY) == 'pinned'
    assert api_key.account_id('guess') == hashlib.sha256(b'guess').hexdigest()[:16]


@pytest.mark.real_key
def test_an_unreadable_key_is_a_503_not_a_guess(monkeypatch):
    monkeypatch.setattr(api_key, '_cached', (0, None))
    monkeypatch.setattr(boto3, 'client', lambda *a, **k: SimpleNamespace(get_api_keys=lambda **_: 1 / 0))
    monkeypatch.setenv('ACCOUNT_ID', 'pinned')
    with pytest.raises(api_key.KeyUnavailable):
        api_key.account_id(KEY)
    response = asyncio.run(main.key_unavailable(None, api_key.KeyUnavailable()))
    assert response.status_code == 503
    assert bridge_ws._handle_connect({'queryStringParameters': {'apiKey': KEY, 'role': 'app'},
        'requestContext': {'domainName': 'control.test', 'stage': 'v1'}}, 'c') == {'statusCode': 503}
