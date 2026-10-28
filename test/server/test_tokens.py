import os
import sys
import time
from types import SimpleNamespace

import boto3
import pytest
from fastapi.testclient import TestClient

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


@pytest.fixture
def client(monkeypatch):
    table = SystemTable()
    monkeypatch.setattr(main, '_system_table', lambda: table)
    monkeypatch.setenv('API_KEY_NAME', 'Baton-api-key')
    monkeypatch.setattr(api_key, 'current_key', lambda: KEY)
    monkeypatch.setenv('BRIDGE_IMAGES_BUCKET', 'bucket')
    monkeypatch.setattr(boto3, 'client', lambda *args, **kwargs: SimpleNamespace(
        generate_presigned_url=lambda *a, **k: 'https://bucket.test/bridge.tar.gz'))
    test_client = TestClient(main.app)
    test_client.table = table
    return test_client


def test_setup_token_is_reusable_until_it_expires(client):
    token = client.post('/api/auth/start-token').json()['token']
    for _ in range(2):
        assert client.post('/auth/exchange-token', json={'token': token}).json() == {'apiKey': KEY}
    assert KEY not in str(client.table.rows[token])
    client.table.rows[token]['ttl'] = int(time.time()) - 1
    assert client.post('/auth/exchange-token', json={'token': token}).status_code == 401


def test_rotating_the_key_retires_tokens_and_old_tokens_still_work(client, monkeypatch):
    token = client.post('/api/auth/start-token').json()['token']
    monkeypatch.setenv('API_KEY_NAME', 'Baton-api-key-20261028')
    assert client.post('/auth/exchange-token', json={'token': token}).status_code == 401
    client.table.put_item({'pk': 'TOKEN', 'sk': 'legacy', 'apiKey': 'old-key', 'ttl': int(time.time()) + 60})
    assert client.post('/auth/exchange-token', json={'token': 'legacy'}).json() == {'apiKey': 'old-key'}


def test_install_command_carries_a_token_and_the_script_the_key(client):
    token = client.post('/api/auth/start-token').json()['token']
    script = client.get(f'/auth/install?t={token}')
    assert script.status_code == 200 and script.headers['cache-control'] == 'no-store'
    assert f"BATON_API_KEY='{KEY}'" in script.text
    assert f"apiKey = '{KEY}'" in client.get(f'/auth/install?t={token}&platform=windows').text
    expired = client.get('/auth/install?t=unknown')
    assert expired.status_code == 403 and expired.text.startswith('echo ')


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


def test_account_id_is_pinned_across_key_rotation(monkeypatch):
    original = api_key.account_id(KEY)
    monkeypatch.setenv('ACCOUNT_ID', original)
    assert api_key.account_id('rotated-key') == original


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


def test_removing_a_device_notifies_its_bridge_then_deletes_its_rows(client, monkeypatch):
    sessions = Sessions()
    notified = []
    monkeypatch.setattr(bridge_sync, '_tables', lambda: (sessions, None))
    monkeypatch.setenv('WS_API_ENDPOINT', 'https://ws.test/v1')
    monkeypatch.setattr(bridge_ws, 'disconnect_removed_bridge', lambda *args: notified.append(args))
    reply = client.post('/api/bridge/delete-device', headers={'x-api-key': KEY}, json={'deviceName': 'Mac'})
    assert reply.json() == {'ok': True, 'deletedSessions': 1}
    assert notified == [(api_key.account_id(KEY), 'https://ws.test/v1', 'Mac')]
    assert sessions.deleted == ['DEV#Mac', 'SESS#Mac#p#s', 'PROJ#Mac#p']
