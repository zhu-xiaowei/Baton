import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'server', 'src'))

import auth


def pytest_configure(config):
    config.addinivalue_line('markers', 'real_auth: use the real credential store instead of master-key stubs')


@pytest.fixture(autouse=True)
def master_key_credentials(request, monkeypatch):
    """Treat every non-empty key as the deployment master key, as before device credentials."""
    if request.node.get_closest_marker('real_auth'):
        return
    def resolve(secret, table=None):
        if not secret:
            return None
        return {'accountId': auth.legacy_account_id(secret), 'kind': 'master', 'credId': 'master',
            'hash': auth.secret_hash(secret)}
    monkeypatch.setattr(auth, 'resolve', resolve)
