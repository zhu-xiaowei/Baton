import copy
import re
from types import SimpleNamespace

import boto3
import pytest
from botocore.exceptions import ClientError

import auth
import main
from asgi_client import call_app

A, B, SEALED, FP0 = 'a' * 16, 'b' * 16, 'S' * 60, '0' * 16


class Table:
    """In-memory SystemTable for the few expressions accounts.py and auth.py use (plain values, as boto3's resource)."""
    name = 'SystemTable'

    def __init__(self):
        self.rows, self.meta = {}, SimpleNamespace(client=self)

    def _check(self, item, condition, names, values):
        expr = re.sub(r'attribute_(not_)?exists\((\w+)\)', lambda m: f"({m[2]!r} {'not ' if m[1] else ''}in item)", condition or 'True')
        expr = re.sub(r'#\w+', lambda m: names[m[0]], expr).replace(' = ', ' == ').replace('AND', 'and').replace('OR', 'or')
        expr = re.sub(r"(?<!['\w:])([a-zA-Z]\w*)(?![\w'(])", lambda m: m[1] if m[1] in ('and', 'or', 'not', 'in', 'item', 'True')
                      else f"item.get({m[1]!r}, 0)", expr)
        if not eval(re.sub(r':\w+', lambda m: repr(values[m[0]]), expr)):  # noqa: S307 (test only)
            raise ClientError({'Error': {'Code': 'ConditionalCheckFailedException'}}, 'write')

    def get_item(self, Key, **_):
        return {'Item': dict(self.rows[(Key['pk'], Key['sk'])])} if (Key['pk'], Key['sk']) in self.rows else {}

    def put_item(self, Item, ConditionExpression=None, **_):
        self._check(self.rows.get((Item['pk'], Item['sk']), {}), ConditionExpression, {}, {})
        self.rows[(Item['pk'], Item['sk'])] = dict(Item)

    def delete_item(self, Key, ConditionExpression=None, ExpressionAttributeNames=None, ExpressionAttributeValues=None, **_):
        row = self.rows.get((Key['pk'], Key['sk']), {})
        self._check(row, ConditionExpression, ExpressionAttributeNames or {}, ExpressionAttributeValues or {})
        self.rows.pop((Key['pk'], Key['sk']), None)
        return {'Attributes': row}

    def update_item(self, Key, UpdateExpression, ConditionExpression=None, ExpressionAttributeNames=None,
                    ExpressionAttributeValues=None, **_):
        names, values = ExpressionAttributeNames or {}, ExpressionAttributeValues or {}
        row = self.rows.get((Key['pk'], Key['sk']), dict(Key))
        self._check(row, ConditionExpression, names, values)
        for verb, name, value in re.findall(r'(ADD|SET)?\s*(#?\w+)\s*=?\s*(:\w+)', UpdateExpression):
            row[names.get(name, name)] = row.get(names.get(name, name), 0) + values[value] if verb == 'ADD' else values[value]
        self.rows[(Key['pk'], Key['sk'])] = row
        return {'Attributes': dict(row)}

    def query(self, KeyConditionExpression, **_):
        expr = KeyConditionExpression.get_expression()
        pk, prefix = (c.get_expression()['values'][1] for c in expr['values']) if expr['operator'] == 'AND' else (expr['values'][1], '')
        return {'Items': [dict(r) for (p, s), r in self.rows.items() if p == pk and s.startswith(prefix)]}

    def transact_write_items(self, TransactItems):
        saved = copy.deepcopy(self.rows)  # all or nothing, like DynamoDB
        try:
            for op in TransactItems:
                kind, args = next(iter(op.items()))
                getattr(self, {'Update': 'update_item', 'Put': 'put_item', 'Delete': 'delete_item'}[kind])(**{k: v for k, v in args.items() if k != 'TableName'})
        except ClientError:
            self.rows = saved
            raise ClientError({'Error': {'Code': 'TransactionCanceledException'}}, 'transact')


@pytest.fixture
def api(monkeypatch):
    monkeypatch.setattr(auth, '_table', Table())
    monkeypatch.setattr('api_key.current_key', lambda: 'deploykey')
    monkeypatch.setenv('OPEN_REGISTRATION', 'true')
    import bridge_ws
    monkeypatch.setattr(bridge_ws, '_init', lambda: None)
    monkeypatch.setattr(bridge_ws, '_query_connections', lambda *a, **k: [])

    def call(path, body, token=None, ip='1.1.1.1', status=200):
        code, reply = call_app(main.app, path, body, {'x-forwarded-for': ip, **({'x-api-key': token} if token else {})})
        assert code == status, reply
        return reply
    return call


def register(api, account, secret, name='p', **kw):
    return api('/api/account/register', {'accountId': account, 'joinSecret': secret.ljust(24, '0'), 'fp': FP0, 'deviceName': name}, **kw)


def join_computer(api, approver, name='Mac'):
    start = api('/api/pair/start', {'deviceName': name})
    api('/api/pair/approve', {'code': start['code'], 'sealed': SEALED}, approver)
    return api('/api/pair/wait', {'code': start['code'], 'poll': start['poll']})


def test_two_accounts_pair_remove_rotate_recover_and_delete_apart(api):
    a, b = register(api, A, 'secret-a', 'iPhone')['token'], register(api, B, 'secret-b', 'Pixel')['token']
    register(api, A, 'other', status=409)
    import api_key
    register(api, api_key.account_id('deploykey'), 'squatter', status=409)  # the self-host account
    # An App code works once and only for its account.
    api('/api/pair/create', {'code': 'app-code-0000000000000', 'sealed': SEALED}, a)
    api('/api/pair/create', {'code': 'app-code-0000000000000', 'sealed': SEALED}, b, status=409)
    ipad = api('/api/pair/claim', {'code': 'app-code-0000000000000', 'deviceName': 'iPad'})
    assert ipad['accountId'] == A and ipad['head'] == FP0
    api('/api/pair/claim', {'code': 'app-code-0000000000000', 'deviceName': 'iPad'}, status=404)
    # A computer's code: a wrong poll, B after A, a reused name all fail; the token comes only once.
    start = api('/api/pair/start', {'deviceName': 'Mac'})
    api('/api/pair/wait', {'code': start['code'], 'poll': 'wrong-poll-000000000000'}, status=404)
    assert api('/api/pair/wait', {'code': start['code'], 'poll': start['poll']}) == {'pending': True}
    api('/api/pair/approve', {'code': start['code'], 'sealed': SEALED}, a)
    api('/api/pair/approve', {'code': start['code'], 'sealed': SEALED}, b, status=404)
    mac = api('/api/pair/wait', {'code': start['code'], 'poll': start['poll']})
    assert mac['accountId'] == A and mac['approvedBy'] == 'iPhone'
    api('/api/pair/wait', {'code': start['code'], 'poll': start['poll']}, status=404)
    api('/api/pair/approve', {'code': api('/api/pair/start', {'deviceName': 'Mac'})['code'], 'sealed': SEALED}, a, status=409)
    pc = join_computer(api, mac['token'], 'PC')  # a computer adds another one for an App (pair_approve)
    assert [t['deviceName'] for t in api('/api/bridge/devices', None, b)['apps']] == ['Pixel']
    # Logout; a code the leaving device made is void; removing a computer needs K' in the same request.
    api('/api/pair/create', {'code': 'app-code-0000000000009', 'sealed': SEALED}, ipad['token'])
    api('/api/tokens/revoke', {}, ipad['token'])
    api('/api/pair/claim', {'code': 'app-code-0000000000009', 'deviceName': 'thief'}, status=404)
    api('/api/bridge/devices', None, ipad['token'], status=401)
    api('/api/bridge/delete-device', {'deviceName': 'Mac'}, a, status=400)
    rotation = {'joinSecret': 'secret-a1'.ljust(24, '0'), 'fp': FP0, 'next': '1' * 16, 'sealed': SEALED}
    api('/api/bridge/delete-device', {'deviceName': 'Mac', 'rotation': rotation}, a)
    api('/api/bridge/devices', None, mac['token'], status=401)
    api('/api/account/recover', {'joinSecret': 'secret-a'.ljust(24, '0'), 'deviceName': 'x'}, status=403)
    assert api('/api/bridge/devices', None, a)['rotations'] == [{'fp': FP0, 'sealed': SEALED}]
    assert api('/api/bridge/devices', None, b)['rotations'] == []
    # A lost App: a rotation from the replaced key is refused (no fork), then the current one removes it.
    phone = api('/api/account/recover', {'joinSecret': 'secret-a1'.ljust(24, '0'), 'deviceName': 'old phone'})
    assert phone['accountId'] == A
    lost = next(t['id'] for t in api('/api/bridge/devices', None, a)['apps'] if t['deviceName'] == 'old phone')
    api('/api/tokens/revoke', {'id': lost, 'rotation': rotation}, a, status=409)
    api('/api/tokens/revoke', {'id': lost, 'rotation': {**rotation, 'fp': '1' * 16, 'next': '2' * 16, 'joinSecret': 'secret-a2'.ljust(24, '0')}}, a)
    api('/api/bridge/devices', None, phone['token'], status=401)
    # Deleting A leaves B alone.
    api('/api/account/delete', {}, a)
    for token in (a, pc['token']):
        api('/api/bridge/devices', None, token, status=401)
    api('/api/account/recover', {'joinSecret': 'secret-a2'.ljust(24, '0'), 'deviceName': 'x'}, ip='6.6.6.6', status=403)
    assert api('/api/bridge/devices', None, b)['apps'][0]['deviceName'] == 'Pixel'


def test_limits(api, monkeypatch):
    monkeypatch.setenv('ORIGIN_SECRET', 'cdn-secret')
    for n in range(6):  # a direct caller inventing addresses is still one caller
        register(api, f'{n:016x}', f'secret-{n}', ip=f'10.0.0.{n}, 9.9.9.9', status=200 if n < 5 else 429)
    for n in range(6):
        api('/api/account/recover', {'joinSecret': 'n' * 24, 'deviceName': 'p'}, ip='8.8.8.8', status=403 if n < 5 else 429)
    owner = register(api, 'e' * 16, 'owner')['token']
    monkeypatch.setattr('accounts.MAX_BRIDGES', 1)
    starts = [api('/api/pair/start', {'deviceName': 'Mac'}) for _ in range(2)]  # both approved before either joins
    for start in starts:
        api('/api/pair/approve', {'code': start['code'], 'sealed': SEALED}, owner)
    api('/api/pair/wait', {'code': starts[0]['code'], 'poll': starts[0]['poll']})
    api('/api/pair/wait', {'code': starts[1]['code'], 'poll': starts[1]['poll']}, status=409)
    api('/api/pair/approve', {'code': api('/api/pair/start', {'deviceName': 'PC'})['code'], 'sealed': SEALED}, owner, status=409)
    monkeypatch.setenv('BRIDGE_IMAGES_BUCKET', 'bucket')
    monkeypatch.setattr(boto3, 'client', lambda *a, **k: SimpleNamespace(generate_presigned_url=lambda *a, **k: 'https://s3/b'))
    assert 'bridge.mjs" pair' in call_app(main.app, '/install')[1]
    monkeypatch.setenv('OPEN_REGISTRATION', 'false')
    assert call_app(main.app, '/install')[0] == 404
    register(api, 'd' * 16, 'closed', status=404)
