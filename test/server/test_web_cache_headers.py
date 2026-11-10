import os
import sys

from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'server', 'src'))

import main


def test_html_revalidates_and_hashed_assets_are_immutable(tmp_path):
    (tmp_path / 'assets').mkdir()
    (tmp_path / 'index.html').write_text('<html></html>')
    (tmp_path / 'setup.html').write_text('<html></html>')
    (tmp_path / 'assets' / 'app-abc123.js').write_text('export {}')
    app = FastAPI()
    app.mount('/', main.WebFiles(directory=str(tmp_path), html=True), name='web')
    client = TestClient(app)

    for path in ('/', '/index.html', '/setup.html'):
        assert client.get(path).headers['cache-control'] == 'no-cache'
    asset = client.get('/assets/app-abc123.js')
    assert asset.headers['cache-control'] == 'public, max-age=31536000, immutable'
    revalidated = client.get('/assets/app-abc123.js', headers={'if-none-match': asset.headers['etag']})
    assert revalidated.status_code == 304
    assert 'immutable' in revalidated.headers['cache-control']
    assert 'cache-control' not in client.get('/assets/missing-xyz.js').headers
