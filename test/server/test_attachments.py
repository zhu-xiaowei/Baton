import asyncio
import json
import os
import sys
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi import HTTPException, Response
from pydantic import ValidationError
from botocore.exceptions import ClientError

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'server', 'src'))
import bridge_sync


KEY = 'a' * 32 + '.pptx'
REQUEST = SimpleNamespace(headers={'x-api-key': 'test-key'})


class FakeS3:
    def __init__(self, accelerated=False):
        self.accelerated = accelerated
        self.signed = []
        self.heads = []

    def generate_presigned_url(self, operation, **kwargs):
        self.signed.append((operation, kwargs))
        host = 's3-accelerate.amazonaws.com' if self.accelerated else 's3.amazonaws.com'
        return f'https://bucket.{host}/{operation}/{len(self.signed)}'

    def head_object(self, **kwargs):
        self.heads.append(kwargs)
        return {'ContentLength': 8 * 1024 * 1024, 'Metadata': {
            'filename': '%E8%AE%A1%E5%88%92.pptx', 'content-type': 'application%2Foctet-stream',
        }}


@pytest.fixture
def clients(monkeypatch):
    monkeypatch.setenv('BRIDGE_IMAGES_BUCKET', 'test-bucket')
    monkeypatch.setenv('S3_UPLOAD_ACCELERATE', 'true')
    standard, accelerated = FakeS3(), FakeS3(True)
    monkeypatch.setattr(bridge_sync, '_attachment_client', lambda accelerated=False: clients_pair[accelerated])
    clients_pair = {False: standard, True: accelerated}
    return standard, accelerated


def test_large_file_prepare_signs_direct_upload_with_size_and_metadata(clients):
    response = Response()
    result = asyncio.run(bridge_sync.file_prepare(bridge_sync.FilePrepareRequest(
        name='计划.PPTX', size=8 * 1024 * 1024), REQUEST, response))
    assert result['key'].endswith('.pptx')
    assert 's3-accelerate' in result['url']
    assert 's3.amazonaws.com' in result['fallbackUrl']
    assert response.headers['Cache-Control'] == 'no-store'
    params = clients[0].signed[0][1]['Params']
    assert params['ContentLength'] == 8 * 1024 * 1024
    assert params['ContentType'] == 'application/octet-stream'
    assert params['Key'].startswith('attachments/' + bridge_sync._hash_key('test-key') + '/')
    assert result['headers']['x-amz-meta-filename'] == '%E8%AE%A1%E5%88%92.PPTX'


def test_standard_upload_when_acceleration_is_disabled(clients, monkeypatch):
    monkeypatch.setenv('S3_UPLOAD_ACCELERATE', 'false')
    result = asyncio.run(bridge_sync.file_prepare(bridge_sync.FilePrepareRequest(
        name='empty.txt', size=0), REQUEST, Response()))
    assert result['url'] == result['fallbackUrl']
    assert not clients[1].signed


def test_download_checks_account_and_returns_private_no_store_links(clients):
    response = Response()
    result = asyncio.run(bridge_sync.attachment_url(KEY, REQUEST, response))
    assert result['name'] == '计划.pptx'
    assert result['size'] == 8 * 1024 * 1024
    assert result['previewType'] == 'application/octet-stream'
    assert clients[0].heads[0]['Key'] == 'attachments/' + bridge_sync._hash_key('test-key') + '/' + KEY
    params = clients[0].signed[0][1]['Params']
    assert params['ResponseContentDisposition'].startswith('attachment;')
    assert response.headers['Cache-Control'] == 'no-store'
    other = SimpleNamespace(headers={'x-api-key': 'another-account'})
    asyncio.run(bridge_sync.attachment_url(KEY, other, Response()))
    assert clients[0].heads[0]['Key'] != clients[0].heads[1]['Key']


def test_pdf_preview_uses_signed_inline_type(clients):
    result = asyncio.run(bridge_sync.attachment_url('b' * 32 + '.pdf', REQUEST, Response()))
    assert result['previewType'] == 'application/pdf'
    assert clients[0].signed[-1][1]['Params']['ResponseContentDisposition'] == 'inline'


def test_invalid_size_key_and_filename_are_rejected(clients):
    for size in [-1, 513 * 1024 * 1024]:
        with pytest.raises(ValidationError):
            bridge_sync.FilePrepareRequest(name='large.pptx', size=size)
    for key in ['../secret', 'not-a-key.pdf', 'a' * 32 + '.pdf/../../secret']:
        with pytest.raises(HTTPException) as error:
            asyncio.run(bridge_sync.attachment_url(key, REQUEST, Response()))
        assert error.value.status_code == 400
    with pytest.raises(HTTPException):
        asyncio.run(bridge_sync.file_prepare(bridge_sync.FilePrepareRequest(
            name='bad\nname.pdf', size=1), REQUEST, Response()))


def test_missing_storage_and_missing_file_are_errors(clients, monkeypatch):
    def missing(**kwargs):
        raise ClientError({'Error': {'Code': '404'}}, 'HeadObject')
    monkeypatch.setattr(clients[0], 'head_object', missing)
    with pytest.raises(HTTPException) as error:
        asyncio.run(bridge_sync.attachment_url(KEY, REQUEST, Response()))
    assert error.value.status_code == 404
    monkeypatch.delenv('BRIDGE_IMAGES_BUCKET')
    with pytest.raises(HTTPException) as error:
        asyncio.run(bridge_sync.file_prepare(bridge_sync.FilePrepareRequest(
            name='test.txt', size=1), REQUEST, Response()))
    assert error.value.status_code == 503


def test_real_signer_uses_accelerated_host_and_signed_content_length(monkeypatch):
    monkeypatch.setenv('AWS_ACCESS_KEY_ID', 'testing')
    monkeypatch.setenv('AWS_SECRET_ACCESS_KEY', 'testing')
    monkeypatch.setenv('AWS_EC2_METADATA_DISABLED', 'true')
    monkeypatch.setenv('AWS_REGION', 'us-east-1')
    monkeypatch.setenv('BRIDGE_IMAGES_BUCKET', 'test-uploads')
    monkeypatch.setenv('S3_UPLOAD_ACCELERATE', 'true')
    result = asyncio.run(bridge_sync.file_prepare(bridge_sync.FilePrepareRequest(
        name='deck.pptx', size=9 * 1024 * 1024), REQUEST, Response()))
    assert urlparse(result['url']).hostname == 'test-uploads.s3-accelerate.amazonaws.com'
    signed = parse_qs(urlparse(result['url']).query)['X-Amz-SignedHeaders'][0]
    assert 'content-length' in signed
    assert 'content-type' in signed
    assert 'x-amz-meta-filename' in signed


def test_deployment_wires_acceleration_and_browser_cors():
    root = os.path.join(os.path.dirname(__file__), '..', '..')
    with open(os.path.join(root, 'server', 'template', 'Baton.template')) as file:
        template = json.load(file)
    environment = template['Resources']['APIHandler']['Properties']['Environment']['Variables']
    assert environment['S3_UPLOAD_ACCELERATE'] == {'Ref': 'FileUploadAcceleration'}
    with open(os.path.join(root, 'server', 'install.sh')) as file:
        install = file.read()
    assert 'put-bucket-cors' in install
    assert 'put-bucket-accelerate-configuration' in install
    assert install.count('ParameterKey=FileUploadAcceleration') == 2
