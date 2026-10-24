import copy
import json
import os
import sys
import time
from types import SimpleNamespace

import boto3
import pytest
from botocore.exceptions import ClientError
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'server', 'src'))

import auth
import auth_routes
import bridge_ws
import main

pytestmark = pytest.mark.real_auth

MASTER = 'legacy-master-key'


def conditional_failure(operation):
    return ClientError({'Error': {'Code': 'ConditionalCheckFailedException'}}, operation)


class SystemTable:
    def __init__(self):
        self.rows = {}

    def get_item(self, Key, **kwargs):
        row = self.rows.get((Key['pk'], Key['sk']))
        return {'Item': copy.deepcopy(row)} if row else {}

    def put_item(self, Item, ConditionExpression=None):
        key = (Item['pk'], Item['sk'])
        if ConditionExpression and key in self.rows:
            raise conditional_failure('PutItem')
        self.rows[key] = copy.deepcopy(Item)

    def update_item(self, Key, UpdateExpression, ExpressionAttributeValues, ConditionExpression=None):
        row = self.rows.get((Key['pk'], Key['sk']))
        if row is None or ('attribute_not_exists(device)' in (ConditionExpression or '') and 'device' in row):
            raise conditional_failure('UpdateItem')
        if ':device' in ExpressionAttributeValues:
            row['device'] = ExpressionAttributeValues[':device']
        if ':now' in ExpressionAttributeValues:
            row['lastUsedAt'] = ExpressionAttributeValues[':now']

    def delete_item(self, Key, ReturnValues=None, ConditionExpression=None):
        key = (Key['pk'], Key['sk'])
        if ConditionExpression and key not in self.rows:
            raise conditional_failure('DeleteItem')
        row = self.rows.pop(key, None)
        return {'Attributes': row} if ReturnValues and row else {}

    def query(self, **kwargs):
        return {'Items': copy.deepcopy([row for (pk, _), row in self.rows.items() if pk == 'CRED'])}


@pytest.fixture
def table(monkeypatch):
    system = SystemTable()
    monkeypatch.setattr(auth, '_table', system)
    auth.forget()
    disconnected = []
    monkeypatch.setattr(auth_routes, 'disconnect_credentials',
        lambda account, ids: disconnected.append((account, set(ids))))
    system.disconnected = disconnected
    auth.ensure_master(MASTER)
    yield system
    auth.forget()


@pytest.fixture
def client(table):
    return TestClient(main.app)


def headers(secret):
    return {'x-api-key': secret}


def test_master_key_keeps_the_original_account_and_registration_is_idempotent(table):
    auth.ensure_master(MASTER)
    assert len([row for row in table.rows.values() if row.get('kind') == 'master']) == 1
    assert auth.resolve(MASTER)['accountId'] == auth.legacy_account_id(MASTER)
    assert auth.resolve('unknown') is None
    assert auth.resolve('bp_pairing-codes-are-not-credentials') is None


def test_api_requires_a_registered_credential(client):
    assert client.get('/api/version').status_code == 403
    assert client.get('/api/version', headers=headers('guess')).status_code == 403
    assert client.get('/api/version', headers=headers(MASTER)).status_code == 200


def test_forbidden_responses_still_carry_cors_headers(client):
    response = client.get('/api/version', headers={'x-api-key': 'guess', 'Origin': 'tauri://localhost'})
    assert response.status_code == 403
    assert response.headers['access-control-allow-origin'] == '*'


def test_start_token_is_single_use_and_issues_an_app_credential(client):
    token = client.post('/api/auth/start-token', headers=headers(MASTER)).json()['token']
    first = client.post('/auth/exchange-token', json={'token': token, 'name': 'iPhone'})
    assert first.status_code == 200
    credential = first.json()
    assert credential['apiKey'].startswith(auth.DEVICE_PREFIX)
    assert credential['accountId'] == auth.legacy_account_id(MASTER)
    assert client.post('/auth/exchange-token', json={'token': token}).status_code == 401
    assert client.get('/api/version', headers=headers(credential['apiKey'])).status_code == 200


def test_expired_wrong_kind_and_legacy_tokens(table):
    account = auth.legacy_account_id(MASTER)
    table.put_item(Item={'pk': 'TOKEN', 'sk': 'old', 'accountId': account, 'kind': 'app', 'ttl': int(time.time()) - 1})
    assert auth.consume_one_time('old', 'app') is None
    assert ('TOKEN', 'old') not in table.rows
    code, _ = auth.create_one_time(account, 'bridge')
    assert auth.consume_one_time(code, 'app') is None
    table.put_item(Item={'pk': 'TOKEN', 'sk': 'install', 'apiKey': MASTER, 'ttl': int(time.time()) + 60})
    assert auth.consume_one_time('install', 'app') == account


def test_bridge_credentials_cannot_manage_credentials(client):
    bridge = client.post('/api/auth/bridge-credential', headers=headers(MASTER), json={'device': 'Mac'}).json()['apiKey']
    assert client.get('/api/version', headers=headers(bridge)).status_code == 200
    for path in ('/api/auth/start-token', '/api/auth/bridge-pairing', '/api/auth/rotate-master'):
        assert client.post(path, headers=headers(bridge)).status_code == 403
    assert client.get('/api/auth/credentials', headers=headers(bridge)).status_code == 403
    assert client.post('/api/auth/app-credential', headers=headers(bridge)).status_code == 403


def test_device_credentials_require_the_master_key(client):
    app = client.post('/api/auth/app-credential', headers=headers(MASTER), json={'name': 'Browser'}).json()['apiKey']
    assert client.post('/api/auth/app-credential', headers=headers(app)).status_code == 403
    assert client.post('/api/auth/bridge-credential', headers=headers(app), json={'device': 'Mac'}).status_code == 403


def test_revoked_credentials_are_rejected_and_disconnected(client, table):
    app = client.post('/api/auth/app-credential', headers=headers(MASTER), json={'name': 'Phone'}).json()
    listed = client.get('/api/auth/credentials', headers=headers(app['apiKey'])).json()['credentials']
    assert [item['current'] for item in listed if item['id'] == app['credentialId']] == [True]
    master_id = next(item['id'] for item in listed if item['kind'] == 'master')
    assert client.post('/api/auth/revoke', headers=headers(app['apiKey']), json={'id': master_id}).status_code == 404
    assert client.post('/api/auth/revoke', headers=headers(MASTER), json={'id': app['credentialId']}).json() == {'ok': True}
    assert table.disconnected == [(app['accountId'], {app['credentialId']})]
    assert client.get('/api/version', headers=headers(app['apiKey'])).status_code == 403


def test_rotating_the_master_key_keeps_devices_and_the_account(client, table):
    app = client.post('/api/auth/app-credential', headers=headers(MASTER)).json()['apiKey']
    rotated = client.post('/api/auth/rotate-master', headers=headers(app)).json()['masterKey']
    assert rotated.startswith(auth.MASTER_PREFIX)
    assert client.get('/api/version', headers=headers(MASTER)).status_code == 403
    assert client.get('/api/version', headers=headers(app)).status_code == 200
    assert auth.resolve(rotated)['accountId'] == auth.legacy_account_id(MASTER)
    assert len(table.disconnected) == 1


def test_install_consumes_the_pairing_code_and_embeds_a_bridge_credential(client, table, monkeypatch):
    monkeypatch.setenv('BRIDGE_IMAGES_BUCKET', 'bucket')
    monkeypatch.setattr(boto3, 'client', lambda *args, **kwargs: SimpleNamespace(
        generate_presigned_url=lambda *a, **k: 'https://bucket.test/bridge.tar.gz'))
    code = client.post('/api/auth/bridge-pairing', headers=headers(MASTER)).json()['code']
    script = client.get('/api/install', headers=headers(code))
    assert script.status_code == 200
    assert code not in script.text
    bridges = [row for row in table.rows.values() if row.get('kind') == 'bridge']
    assert len(bridges) == 1 and 'device' not in bridges[0]
    again = client.get('/api/install', headers=headers(code))
    assert again.status_code == 403 and again.text.startswith('echo ')
    assert client.get('/api/bridge/install', headers=headers(code)).status_code == 403


class Connections:
    def __init__(self):
        self.rows = {}

    def put_item(self, Item):
        self.rows[Item['connectionId']] = Item


@pytest.fixture
def ws(table, monkeypatch):
    connections = Connections()
    monkeypatch.setattr(bridge_ws, '_connections_table', connections)
    monkeypatch.setattr(bridge_ws, '_claim_bridge_connection', lambda *args: True)
    monkeypatch.delenv('TERMINAL_DIRECT_ENDPOINT', raising=False)

    def connect(connection_id, secret, role, device=''):
        return bridge_ws._handle_connect({
            'queryStringParameters': {'apiKey': secret, 'role': role, 'device': device},
            'requestContext': {'domainName': 'control.test', 'stage': 'v1'},
        }, connection_id)
    connect.rows = connections.rows
    return connect


def test_ws_connect_rejects_unknown_keys(ws):
    assert ws('guess', 'not-a-key', 'app') == {'statusCode': 401}
    assert ws('master', MASTER, 'app') == {'statusCode': 200}
    assert ws.rows['master']['accountId'] == auth.legacy_account_id(MASTER)


def test_bridge_credentials_bind_to_one_device_and_never_act_as_an_app(ws):
    secret, item = auth.issue_device_credential(auth.legacy_account_id(MASTER), 'bridge')
    assert ws('as-app', secret, 'app') == {'statusCode': 403}
    assert ws('first', secret, 'bridge', 'Mac') == {'statusCode': 200}
    assert ws.rows['first']['credId'] == item['credId']
    assert ws('other', secret, 'bridge', 'Linux') == {'statusCode': 403}
    assert ws('again', secret, 'bridge', 'Mac') == {'statusCode': 200}
    assert ws('nameless', secret, 'bridge') == {'statusCode': 403}
