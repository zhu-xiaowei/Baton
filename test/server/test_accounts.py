import re
from types import SimpleNamespace

import boto3
import pytest
from botocore.exceptions import ClientError
from fastapi.testclient import TestClient

import auth
import main

A, B, SEALED = 'a' * 16, 'b' * 16, 'S' * 60


class Table:
    """In-memory SystemTable for the few expressions accounts.py and auth.py use."""
    def __init__(self):
        self.rows = {}

    def _check(self, item, condition, names, values):
        if not condition:
            return
        expr = re.sub(r'attribute_(not_)?exists\((\w+)\)', lambda m: f"({m[2]!r} {'not ' if m[1] else ''}in item)", condition)
        expr = re.sub(r'#\w+', lambda m: names[m[0]], expr).replace(' = ', ' == ').replace('AND', 'and').replace('OR', 'or')
        expr = re.sub(r"(?<!['\w:])([a-zA-Z]\w*)(?![\w'(])", lambda m: m[1] if m[1] in ('and', 'or', 'not', 'in', 'item')
                      else f"item.get({m[1]!r}, 0)", expr)
        if not eval(re.sub(r':\w+', lambda m: repr(values[m[0]]), expr)):  # noqa: S307 (test only)
            raise ClientError({'Error': {'Code': 'ConditionalCheckFailedException'}}, 'write')

    def get_item(self, Key, **_):
        row = self.rows.get((Key['pk'], Key['sk']))
        return {'Item': dict(row)} if row else {}

    def put_item(self, Item, ConditionExpression=None, **_):
        self._check(self.rows.get((Item['pk'], Item['sk']), {}), ConditionExpression, {}, {})
        self.rows[(Item['pk'], Item['sk'])] = dict(Item)

    def delete_item(self, Key, ConditionExpression=None, ExpressionAttributeNames=None, ExpressionAttributeValues=None, **_):
        row = self.rows.get((Key['pk'], Key['sk']), {})
        self._check(row, ConditionExpression, ExpressionAttributeNames or {}, ExpressionAttributeValues or {})
        self.rows.pop((Key['pk'], Key['sk']), None)
        return {'Attributes': row}

    def update_item(self, Key, UpdateExpression, ConditionExpression=None, ExpressionAttributeNames=None,
                    ExpressionAttributeValues=None, ReturnValues=None, **_):
        names, values = ExpressionAttributeNames or {}, ExpressionAttributeValues or {}
        row = self.rows.get((Key['pk'], Key['sk']), dict(Key))
        self._check(row, ConditionExpression, names, values)
        before = dict(row)
        for verb, name, value in re.findall(r'(ADD|SET)?\s*(#?\w+)\s*=?\s*(:\w+)', UpdateExpression):
            name = names.get(name, name)
            row[name] = row.get(name, 0) + values[value] if verb == 'ADD' else values[value]
        self.rows[(Key['pk'], Key['sk'])] = row
        return {'Attributes': before if ReturnValues == 'UPDATED_OLD' else dict(row)}

    def query(self, KeyConditionExpression, **_):
        expr = KeyConditionExpression.get_expression()
        pk, prefix = ((c.get_expression()['values'][1] for c in expr['values']) if expr['operator'] == 'AND'
                      else (expr['values'][1], ''))
        return {'Items': [dict(r) for (p, s), r in self.rows.items() if p == pk and s.startswith(prefix)]}


@pytest.fixture
def api(monkeypatch):
    monkeypatch.setattr(auth, '_table', Table())
    monkeypatch.setattr(auth, '_cache', {})
    monkeypatch.setenv('OPEN_REGISTRATION', 'true')
    import bridge_ws
    monkeypatch.setattr(bridge_ws, '_init', lambda: None)
    monkeypatch.setattr(bridge_ws, '_query_connections', lambda *a, **k: [])
    client = TestClient(main.app)

    def call(path, body, token=None, ip='1.1.1.1', status=200):
        headers = {'x-forwarded-for': ip, **({'x-api-key': token} if token else {})}
        response = client.request('GET' if body is None else 'POST', path, json=body, headers=headers)
        assert response.status_code == status, response.text
        return response.json()
    return call


def test_two_accounts_never_reach_each_other(api):
    a = api('/api/account/register', {'accountId': A, 'joinSecret': 'secret-of-a-000000000000', 'deviceName': 'iPhone'})['token']
    b = api('/api/account/register', {'accountId': B, 'joinSecret': 'secret-of-b-000000000000', 'deviceName': 'Pixel'})['token']
    api('/api/account/register', {'accountId': A, 'joinSecret': 'x' * 24, 'deviceName': 'x'}, status=409)
    # Another phone joins A; the code works once.
    code = 'app-code-0000000000000'
    api('/api/pair/create', {'code': code, 'sealed': SEALED}, a)
    api('/api/pair/create', {'code': code, 'sealed': SEALED}, b, status=409)
    assert api('/api/pair/claim', {'code': code, 'deviceName': 'iPad'})['accountId'] == A
    api('/api/pair/claim', {'code': code, 'deviceName': 'iPad'}, status=404)
    # A computer joins A: wrong poll, B approving after A, a second wait all fail.
    start = api('/api/pair/start', {'deviceName': 'Mac'})
    api('/api/pair/wait', {'code': start['code'], 'poll': 'wrong-poll-000000000000'}, status=404)
    assert api('/api/pair/wait', {'code': start['code'], 'poll': start['poll']}) == {'pending': True}
    assert api('/api/pair/approve', {'code': start['code'], 'sealed': SEALED}, a) == {'deviceName': 'Mac'}
    api('/api/pair/approve', {'code': start['code'], 'sealed': SEALED}, b, status=404)
    joined = api('/api/pair/wait', {'code': start['code'], 'poll': start['poll']})
    assert joined['accountId'] == A and joined['approvedBy'] == 'iPhone'
    api('/api/pair/wait', {'code': start['code'], 'poll': start['poll']}, status=404)
    api('/api/pair/approve', {'code': api('/api/pair/start', {'deviceName': 'Mac'})['code'], 'sealed': SEALED}, a, status=409)
    # A computer of the account adds another one on behalf of an App (pair_approve).
    assert api('/api/pair/approve', {'code': api('/api/pair/start', {'deviceName': 'PC'})['code'], 'sealed': SEALED},
               joined['token']) == {'deviceName': 'PC'}
    assert sorted(t['deviceName'] for t in api('/api/bridge/devices', None, a)['apps']) == ['Mac', 'iPad', 'iPhone']
    assert [t['deviceName'] for t in api('/api/bridge/devices', None, b)['apps']] == ['Pixel']
    # A joinSecret recovers its own account only.
    assert api('/api/account/recover', {'joinSecret': 'secret-of-b-000000000000', 'deviceName': 'x'})['accountId'] == B
    api('/api/account/recover', {'joinSecret': 'secret-of-nobody-000000', 'deviceName': 'x'}, status=403)
    api('/api/account/recover', {'joinSecret': 'secret-of-a-000000000000', 'deviceName': 'New'})


def test_limits(api, monkeypatch):
    for n in range(5):
        api('/api/account/register', {'accountId': f'{n:016x}', 'joinSecret': 's' * 24, 'deviceName': 'p'}, ip='9.9.9.9')
    api('/api/account/register', {'accountId': 'f' * 16, 'joinSecret': 's' * 24, 'deviceName': 'p'}, ip='9.9.9.9', status=429)
    for _ in range(5):
        api('/api/account/recover', {'joinSecret': 'n' * 24, 'deviceName': 'p'}, ip='8.8.8.8', status=403)
    api('/api/account/recover', {'joinSecret': 'n' * 24, 'deviceName': 'p'}, ip='8.8.8.8', status=429)
    owner = api('/api/account/register', {'accountId': 'e' * 16, 'joinSecret': 's' * 24, 'deviceName': 'p'})['token']
    monkeypatch.setattr('accounts.MAX_BRIDGES', 1)
    for status in (200, 409):
        start = api('/api/pair/start', {'deviceName': 'Mac'})
        api('/api/pair/approve', {'code': start['code'], 'sealed': SEALED}, owner, status=status)
        if status == 200:
            api('/api/pair/wait', {'code': start['code'], 'poll': start['poll']})
    monkeypatch.setenv('BRIDGE_IMAGES_BUCKET', 'bucket')
    monkeypatch.setattr(boto3, 'client', lambda *a, **k: SimpleNamespace(generate_presigned_url=lambda *a, **k: 'https://s3/b'))
    client = TestClient(main.app)
    assert 'bridge.mjs" pair' in client.get('/install').text
    monkeypatch.setenv('OPEN_REGISTRATION', 'false')
    assert client.get('/install').status_code == 404
    api('/api/account/register', {'accountId': 'd' * 16, 'joinSecret': 's' * 24, 'deviceName': 'p'}, status=404)


def test_logout_removal_rotation_and_deletion_stay_in_their_account(api):
    a = api('/api/account/register', {'accountId': A, 'joinSecret': 'secret-of-a-000000000000', 'deviceName': 'iPhone'})['token']
    b = api('/api/account/register', {'accountId': B, 'joinSecret': 'secret-of-b-000000000000', 'deviceName': 'Pixel'})['token']
    api('/api/pair/create', {'code': 'app-code-0000000000001', 'sealed': SEALED}, a)
    ipad = api('/api/pair/claim', {'code': 'app-code-0000000000001', 'deviceName': 'iPad'})['token']
    api('/api/tokens/revoke', {}, ipad)
    api('/api/bridge/devices', None, ipad, status=401)
    start = api('/api/pair/start', {'deviceName': 'Mac'})
    api('/api/pair/approve', {'code': start['code'], 'sealed': SEALED}, a)
    mac = api('/api/pair/wait', {'code': start['code'], 'poll': start['poll']})['token']
    api('/api/bridge/delete-device', {'deviceName': 'Mac'}, a)
    api('/api/bridge/devices', None, mac, status=401)
    rotation = {'joinSecret': 'secret-of-a-111111111111', 'fp': '0' * 16, 'sealed': SEALED}
    api('/api/account/rotate', rotation, a)
    assert api('/api/bridge/devices', None, a)['rotations'] == [{'fp': '0' * 16, 'sealed': SEALED}]
    assert api('/api/bridge/devices', None, b)['rotations'] == []
    api('/api/account/recover', {'joinSecret': 'secret-of-a-000000000000', 'deviceName': 'x'}, status=403)
    assert api('/api/account/recover', {'joinSecret': 'secret-of-a-111111111111', 'deviceName': 'x'})['accountId'] == A
    api('/api/account/delete', {}, a)
    api('/api/account/recover', {'joinSecret': 'secret-of-a-111111111111', 'deviceName': 'x'}, ip='6.6.6.6', status=403)
    api('/api/bridge/devices', None, a, status=401)
    assert api('/api/bridge/devices', None, b)['apps'][0]['deviceName'] == 'Pixel'
