import copy
import json
import os
import sys

import pytest
from botocore.exceptions import ClientError

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'server', 'src'))

import bridge_read
import bridge_ws


class ConnectionTable:
    def __init__(self):
        self.rows = {}
        self.index_rows = None

    def put_item(self, Item):
        self.rows[Item['connectionId']] = copy.deepcopy(Item)

    def get_item(self, Key, **kwargs):
        record = self.rows.get(Key['connectionId'])
        return {'Item': copy.deepcopy(record)} if record else {}

    def delete_item(self, Key):
        self.rows.pop(Key['connectionId'], None)

    def query(self, **kwargs):
        rows = self.index_rows if self.index_rows is not None else self.rows.values()
        return {'Items': copy.deepcopy([row for row in rows if row.get('role') == 'bridge'])}

    def update_item(self, Key, ExpressionAttributeValues, **kwargs):
        previous = copy.deepcopy(self.rows.get(Key['connectionId'], {}))
        values = ExpressionAttributeValues
        if ':order' in values and previous.get('connectionOrder', '') > values[':order']:
            raise ClientError({'Error': {'Code': 'ConditionalCheckFailedException'}}, 'UpdateItem')
        record = self.rows.setdefault(Key['connectionId'], dict(Key))
        record.update(activeConnectionId=values[':connection'], connectionOrder=values[':order'], ttl=values[':ttl'])
        return {'Attributes': previous}


@pytest.fixture
def connections(monkeypatch):
    table = ConnectionTable()
    monkeypatch.setattr(bridge_ws, '_connections_table', table)
    monkeypatch.setattr(bridge_read, '_connections_table', table)
    monkeypatch.setattr(bridge_ws.time, 'time', lambda: 1_800_000_000)
    retired = []

    def retire(connection_id, endpoint, replaced=True):
        retired.append((connection_id, replaced))
        table.delete_item(Key={'connectionId': connection_id})

    monkeypatch.setattr(bridge_ws, '_retire_bridge_connection', retire)
    table.retired = retired
    return table


def connect(connection_id, order, bridge_id='a' * 32, heartbeat='240'):
    return bridge_ws._handle_connect({
        'queryStringParameters': {
            'apiKey': 'key', 'role': 'bridge', 'device': 'Mac',
            'bridgeId': bridge_id, 'heartbeat': heartbeat,
        },
        'requestContext': {'connectedAt': order, 'domainName': 'control.test', 'stage': 'v1'},
    }, connection_id)


def test_handover_fences_old_handshakes_and_old_installations(connections):
    assert connect('old', 1000) == {'statusCode': 200}
    legacy = dict(connections.rows['old'], bridgeOwner='legacy-installation-owner')
    connections.rows[legacy['bridgeOwner']] = {'activeConnectionId': 'old'}
    assert connect('new', 2000, bridge_id='b' * 32) == {'statusCode': 200}
    assert connect('late-old', 1000) == {'statusCode': 409}
    assert 'late-old' not in connections.rows
    connections.rows['old'] = legacy
    assert bridge_ws._handle_message({'body': json.dumps({'action': 'heartbeat'})}, 'old', 'https://control.test/v1') == {'statusCode': 200}
    account = bridge_ws._account_id('key')
    assert [row['connectionId'] for row in bridge_ws._query_connections(account, 'bridge')] == ['new']
    assert connections.retired == [('old', True), ('old', True)]
    assert bridge_read._online_bridge_devices(account) == {'Mac'}


def test_routing_uses_current_owner_despite_stale_or_empty_index(connections):
    connect('old', 1000)
    old_index = copy.deepcopy(connections.rows['old'])
    connect('new', 2000)
    connections.index_rows = [old_index]
    account = bridge_ws._account_id('key')
    assert 'old' not in connections.rows
    assert [row['connectionId'] for row in bridge_ws._query_connections(account, 'bridge')] == ['new']
    connections.index_rows = []
    rows = bridge_ws._query_connections(account, 'bridge', device='Mac')
    assert [row['connectionId'] for row in rows] == ['new']
    connections.index_rows = None
    connections.rows.pop(connections.rows['new']['bridgeOwner'])
    assert bridge_read._online_bridge_devices(account) == set()


def test_online_lease_matches_four_minute_heartbeat(connections, monkeypatch):
    connect('new', 1000)
    account = bridge_ws._account_id('key')
    monkeypatch.setattr(bridge_ws.time, 'time', lambda: 1_800_000_241)
    assert bridge_read._online_bridge_devices(account) == {'Mac'}
    monkeypatch.setattr(bridge_ws.time, 'time', lambda: 1_800_000_246)
    assert bridge_read._online_bridge_devices(account) == set()
