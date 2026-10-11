import asyncio
import importlib
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from botocore.exceptions import ClientError
from fastapi import HTTPException, Response

ROOT = os.path.join(os.path.dirname(__file__), '..', '..')
sys.path.insert(0, os.path.join(ROOT, 'server', 'src'))
import bridge_sync
import slide_preview

KEY = 'b' * 32 + '.pptx'
REQUEST = SimpleNamespace(headers={'x-api-key': 'test-key'})
SOURCE = f"attachments/{bridge_sync._hash_key('test-key')}/{KEY}"
STORED = {'ContentLength': 10, 'ETag': '"5d41402abc4b2a76b9719d911017c592"'}
IMAGE = '123.dkr.ecr.ap-northeast-1.amazonaws.com/baton-api@sha256:0123456789abcdef0123'
# Same content (ETag + size) shares one preview per converter image.
PREVIEW = f"previews/{bridge_sync._hash_key('test-key')}/0123456789ab/5d41402abc4b2a76b9719d911017c592-10"


def missing():
    # The API role has no s3:ListBucket, so S3 reports a missing key as 403.
    return ClientError({'Error': {'Code': '403'}}, 'HeadObject')


class FakeS3:
    def __init__(self, objects):
        self.objects = dict(objects)
        self.signed = []

    def head_object(self, Bucket, Key):
        if Key not in self.objects:
            raise missing()
        return self.objects[Key]

    def get_object(self, Bucket, Key):
        if Key not in self.objects:
            raise ClientError({'Error': {'Code': 'AccessDenied'}}, 'GetObject')
        return {'Body': SimpleNamespace(read=lambda: self.objects[Key]['Body'])}

    def put_object(self, Bucket, Key, Body, IfNoneMatch=None, IfMatch=None):
        current = self.objects.get(Key)
        if (IfNoneMatch and current) or (IfMatch and (not current or current['ETag'] != IfMatch)):
            raise ClientError({'Error': {'Code': 'PreconditionFailed'}}, 'PutObject')
        self.objects[Key] = {'Body': Body, 'ETag': f'"{len(self.objects)}"',
                             'LastModified': datetime.now(timezone.utc)}

    def generate_presigned_url(self, operation, Params, ExpiresIn):
        self.signed.append(Params)
        return 'https://bucket.test/' + Params['Key']


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setenv('BRIDGE_IMAGES_BUCKET', 'test-bucket')
    monkeypatch.setenv('PREVIEW_CONVERTER_FUNCTION', 'converter')
    monkeypatch.setenv('PREVIEW_CONVERTER_IMAGE', IMAGE)
    invokes = []
    monkeypatch.setattr(slide_preview, '_lambda_client', lambda: SimpleNamespace(
        invoke=lambda **kwargs: invokes.append(kwargs)))

    def use(objects):
        s3 = FakeS3(objects)
        monkeypatch.setattr(slide_preview, '_attachment_client', lambda: s3)
        return s3
    return use, invokes


def preview(key=KEY):
    return asyncio.run(slide_preview.file_preview(key, REQUEST, Response()))


def test_first_poll_claims_the_conversion_and_later_polls_wait(env):
    use, invokes = env
    s3 = use({SOURCE: STORED})
    assert preview() == {'status': 'converting'}
    assert preview() == {'status': 'converting'}
    assert len(invokes) == 1
    assert invokes[0]['InvocationType'] == 'Event'
    assert json.loads(invokes[0]['Payload']) == {'source': SOURCE, 'preview': PREVIEW}
    assert PREVIEW + '.pending' in s3.objects


def test_stale_claim_is_taken_over_once(env):
    use, invokes = env
    old = datetime.now(timezone.utc) - timedelta(seconds=slide_preview.PENDING_STALE_SECONDS + 1)
    use({SOURCE: STORED, PREVIEW + '.pending': {'ETag': '"old"', 'LastModified': old}})
    assert preview() == {'status': 'converting'}
    assert preview() == {'status': 'converting'}
    assert len(invokes) == 1


def test_reuploaded_content_reuses_the_preview(env):
    use, invokes = env
    other = 'c' * 32 + '.pptx'
    use({SOURCE: STORED, SOURCE.replace(KEY, other): STORED, PREVIEW + '.pdf': {'ContentLength': 42}})
    assert preview(other)['status'] == 'ready'
    assert invokes == []


def test_ready_and_failed_results_are_served_from_cache(env):
    use, invokes = env
    s3 = use({SOURCE: STORED, PREVIEW + '.pdf': {'ContentLength': 42}})
    assert preview() == {'status': 'ready', 'previewUrl': 'https://bucket.test/' + PREVIEW + '.pdf', 'size': 42}
    assert s3.signed[0]['ResponseContentType'] == 'application/pdf'
    use({SOURCE: STORED, PREVIEW + '.error': {'Body': b'Conversion timed out.'}})
    assert preview() == {'status': 'failed', 'error': 'Conversion timed out.'}
    assert invokes == []


def test_unsupported_and_missing_files_are_rejected(env):
    use, invokes = env
    use({})
    with pytest.raises(HTTPException) as error:
        preview('b' * 32 + '.docx')
    assert error.value.status_code == 400
    with pytest.raises(HTTPException) as error:
        preview()
    assert error.value.status_code == 404
    assert invokes == []


def test_converter_records_failures_and_releases_the_claim(monkeypatch):
    monkeypatch.setenv('AWS_DEFAULT_REGION', 'us-east-1')
    monkeypatch.setenv('BRIDGE_IMAGES_BUCKET', 'test-bucket')
    sys.path.insert(0, os.path.join(ROOT, 'server', 'converter'))
    handler = importlib.import_module('handler')
    calls = []
    monkeypatch.setattr(handler, '_s3', SimpleNamespace(
        head_object=lambda **kwargs: {'ContentLength': handler.MAX_BYTES + 1},
        put_object=lambda **kwargs: calls.append(('put', kwargs['Key'], kwargs['Body'])),
        delete_object=lambda **kwargs: calls.append(('delete', kwargs['Key'])),
    ))
    result = handler.handler({'source': SOURCE, 'preview': PREVIEW}, None)
    assert result == {'ok': False, 'error': 'File is too large to preview (over 100 MB).'}
    assert calls == [('put', PREVIEW + '.error', b'File is too large to preview (over 100 MB).'),
                     ('delete', PREVIEW + '.pending')]


def test_deployment_wires_the_converter():
    with open(os.path.join(ROOT, 'server', 'template', 'Baton.template')) as file:
        resources = json.load(file)['Resources']
    converter = resources['ConverterFunction']['Properties']
    assert converter['Architectures'] == ['arm64'] and converter['MemorySize'] == 1769
    assert resources['ConverterInvokeConfig']['Properties']['MaximumRetryAttempts'] == 0
    variables = resources['APIHandler']['Properties']['Environment']['Variables']
    assert variables['PREVIEW_CONVERTER_FUNCTION'] == {'Ref': 'ConverterFunction'}
    with open(os.path.join(ROOT, 'server', 'install.sh')) as file:
        install = file.read()
    assert install.count('ParameterKey=ConverterImageUri') == 2
    assert '"warmup":true' in install
