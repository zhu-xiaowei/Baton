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
