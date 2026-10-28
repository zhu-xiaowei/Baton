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
import bridge_sync
import bridge_ws
import main

KEY = 'deployment-key'


class SystemTable:
    def __init__(self):
        self.rows = {}

    def get_item(self, Key, **kwargs):
        row = self.rows.get(Key['sk'])
        return {'Item': dict(row)} if row else {}

    def put_item(self, Item):
        self.rows[Item['sk']] = dict(Item)


def request(headers=None):
    return SimpleNamespace(headers=headers or {}, url=SimpleNamespace(scheme='https'))


@pytest.fixture
def table(monkeypatch):
    system = SystemTable()
    monkeypatch.setattr(main, '_system_table', lambda: system)
    monkeypatch.setenv('API_KEY_NAME', 'Baton-api-key')
    monkeypatch.setattr(api_key, 'current_key', lambda: KEY)
    monkeypatch.setenv('BRIDGE_IMAGES_BUCKET', 'bucket')
    monkeypatch.setattr(boto3, 'client', lambda *args, **kwargs: SimpleNamespace(
        generate_presigned_url=lambda *a, **k: 'https://bucket.test/bridge.tar.gz'))
    return system


def new_token():
    return asyncio.run(main.start_token())['token']


def exchange(token):
    response = Response()
    body = asyncio.run(main.exchange_token(main.ExchangeTokenBody(token=token), response))
    return response.status_code, body


def install(token, platform=''):
    return asyncio.run(main.install_with_token(request(), t=token, name=None, platform=platform))


def test_setup_token_is_reusable_until_it_expires(table):
    token = new_token()
    for _ in range(2):
        assert exchange(token) == (200, {'apiKey': KEY})
    assert KEY not in str(table.rows[token])
    table.rows[token]['ttl'] = int(time.time()) - 1
    assert exchange(token)[0] == 401


def test_rotating_the_key_retires_tokens(table, monkeypatch):
    token = new_token()
    monkeypatch.setenv('API_KEY_NAME', 'Baton-api-key-20261028')
    assert exchange(token)[0] == 401


def test_install_command_carries_a_token_and_the_script_the_key(table):
    token = new_token()
    script = install(token)
    assert script.status_code == 200 and script.headers['cache-control'] == 'no-store'
    assert f"BATON_API_KEY='{KEY}'" in script.body.decode()
    assert f"apiKey = '{KEY}'" in install(token, 'windows').body.decode()
    expired = install('unknown')
    assert expired.status_code == 403 and expired.body.decode().startswith('echo ')


@pytest.mark.real_key
def test_websocket_connect_requires_the_deployment_key(monkeypatch):
    monkeypatch.setattr(api_key, 'current_key', lambda: KEY)
    rows = {}
    monkeypatch.setattr(bridge_ws, '_connections_table', SimpleNamespace(put_item=lambda Item: rows.update({Item['connectionId']: Item})))
    monkeypatch.delenv('TERMINAL_DIRECT_ENDPOINT', raising=False)

    def connect(connection_id, secret):
        return bridge_ws._handle_connect({'queryStringParameters': {'apiKey': secret, 'role': 'app'},
            'requestContext': {'domainName': 'control.test', 'stage': 'v1'}}, connection_id)
    assert connect('guess', 'any-string') == {'statusCode': 401}
    assert connect('empty', '') == {'statusCode': 401}
    assert connect('ok', KEY) == {'statusCode': 200}


@pytest.mark.real_key
def test_account_id_is_pinned_only_for_the_current_key(monkeypatch):
    original = api_key.account_id('original-key')
    monkeypatch.setenv('ACCOUNT_ID', original)
    monkeypatch.setattr(api_key, 'current_key', lambda: 'rotated-key')
    assert api_key.account_id('rotated-key') == original
    assert api_key.account_id('guess') == hashlib.sha256(b'guess').hexdigest()[:16]


class Sessions:
    def __init__(self):
        self.deleted = []

    def query(self, KeyConditionExpression, **kwargs):
        prefix = KeyConditionExpression.get_expression()['values'][1].get_expression()['values'][1]
        return {'Items': [{'sk': sk} for sk in ('SESS#Mac#p#s', 'PROJ#Mac#p', 'SESS#Mac2#p#s') if sk.startswith(prefix)]}

    def batch_writer(self):
        deleted = self.deleted

        class Batch:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def delete_item(self, Key):
                deleted.append(Key['sk'])
        return Batch()


def test_removing_a_device_notifies_its_bridge_then_deletes_its_rows(monkeypatch):
    sessions = Sessions()
    notified = []
    monkeypatch.setattr(bridge_sync, '_tables', lambda: (sessions, None))
    monkeypatch.setenv('WS_API_ENDPOINT', 'https://ws.test/v1')
    monkeypatch.setattr(bridge_ws, 'disconnect_removed_bridge', lambda *args: notified.append(args))
    reply = asyncio.run(bridge_sync.delete_device(bridge_sync.DeleteDeviceRequest(deviceName='Mac'),
        request({'x-api-key': KEY})))
    assert reply == {'ok': True, 'deletedSessions': 1}
    assert notified == [(api_key.account_id(KEY), 'https://ws.test/v1', 'Mac')]
    assert sessions.deleted == ['DEV#Mac', 'SESS#Mac#p#s', 'PROJ#Mac#p']
