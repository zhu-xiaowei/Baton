import asyncio
import os
import sys

import pytest
from starlette.exceptions import HTTPException

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'server', 'src'))

import main


def test_html_revalidates_and_hashed_assets_are_immutable(tmp_path):
    (tmp_path / 'assets').mkdir()
    (tmp_path / 'index.html').write_text('<html></html>')
    (tmp_path / 'setup.html').write_text('<html></html>')
    (tmp_path / 'assets' / 'app-Ab3_d-9z.js').write_text('export {}')
    (tmp_path / 'assets' / 'baton-logo.svg').write_text('<svg/>')
    (tmp_path / 'theme-init.js').write_text('')
    files = main.WebFiles(directory=str(tmp_path), html=True)

    def get(path, headers=()):
        return asyncio.run(files.get_response(path, {'type': 'http', 'method': 'GET', 'path': '/', 'headers': list(headers)}))

    for path in ('.', 'index.html', 'setup.html'):  # '.' is what "/" resolves to
        assert get(path).headers['cache-control'] == 'no-cache'
    asset = get('assets/app-Ab3_d-9z.js')
    assert asset.headers['cache-control'] == 'public, max-age=31536000, immutable'
    revalidated = get('assets/app-Ab3_d-9z.js', [(b'if-none-match', asset.headers['etag'].encode())])
    assert revalidated.status_code == 304
    assert 'immutable' in revalidated.headers['cache-control']
    for path in ('assets/baton-logo.svg', 'theme-init.js'):  # same name after a deploy: default caching
        assert 'cache-control' not in get(path).headers
    with pytest.raises(HTTPException):
        get('assets/missing-xyz.js')
