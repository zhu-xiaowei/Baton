import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'server', 'src'))

import api_key


def pytest_configure(config):
    config.addinivalue_line('markers', 'real_key: check WebSocket keys against the deployment key')


@pytest.fixture(autouse=True)
def any_websocket_key(request, monkeypatch):
    """Existing tests connect with arbitrary keys, as before the WebSocket key check."""
    if not request.node.get_closest_marker('real_key'):
        monkeypatch.setattr(api_key, 'is_current', lambda key: bool(key))


class FakeDeviceTable:
    def __init__(self):
        self.items = {}

    def put_item(self, Item):
        self.items[(Item['pk'], Item['sk'])] = dict(Item)

    def delete_item(self, Key):
        self.items.pop((Key['pk'], Key['sk']), None)

    def query(self, KeyConditionExpression, **kwargs):
        pk = KeyConditionExpression.get_expression()['values'][1]
        return {'Items': [dict(item) for (key, _), item in sorted(self.items.items()) if key == pk]}


@pytest.fixture(autouse=True)
def device_table(monkeypatch):
    import devices
    table = FakeDeviceTable()
    monkeypatch.setattr(devices, '_table', table)
    return table
