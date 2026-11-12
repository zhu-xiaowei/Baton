import io
import os
import sys
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse

import pytest
from botocore.credentials import ReadOnlyCredentials
from botocore.exceptions import ClientError
from fastapi import HTTPException

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'server', 'src'))
import voice

REQUEST = SimpleNamespace(headers={'x-api-key': 'test-key'})


@pytest.fixture(autouse=True)
def voice_on(monkeypatch):
    monkeypatch.setenv('VOICE_ENABLED', 'true')
LONG_REPLY = '## 结果\n' + '已经完成语音功能的服务端部分，测试全部通过。' * 30 + '\n```js\nconsole.log(1)\n```\n'


def test_transcribe_url_is_signed_websocket():
    creds = ReadOnlyCredentials('AKIDEXAMPLE', 'secret', 'session-token')
    url = voice.transcribe_url('zh-CN', 16000, credentials=creds, region='ap-northeast-1')
    parsed = urlparse(url)
    query = parse_qs(parsed.query)
    assert parsed.scheme == 'wss'
    assert parsed.netloc == 'transcribestreaming.ap-northeast-1.amazonaws.com:8443'
    assert parsed.path == '/stream-transcription-websocket'
    assert query['language-code'] == ['zh-CN']
    assert query['media-encoding'] == ['pcm']
    assert query['sample-rate'] == ['16000']
    assert query['X-Amz-Expires'] == [str(voice.STT_URL_TTL)]
    assert query['X-Amz-Security-Token'] == ['session-token']
    assert query['X-Amz-Credential'][0].startswith('AKIDEXAMPLE/')
    assert '/ap-northeast-1/transcribe/aws4_request' in query['X-Amz-Credential'][0]
    assert len(query['X-Amz-Signature'][0]) == 64


def test_transcribe_url_adds_configured_vocabulary(monkeypatch):
    monkeypatch.setenv('VOICE_VOCABULARY_NAME', 'baton-terms')
    creds = ReadOnlyCredentials('AKID', 'secret', None)
    query = parse_qs(urlparse(voice.transcribe_url('zh-CN', credentials=creds, region='us-east-1')).query)
    assert query['vocabulary-name'] == ['baton-terms']


def test_transcribe_url_auto_identifies_the_language(monkeypatch):
    monkeypatch.setenv('VOICE_VOCABULARY_NAME', 'baton-terms')
    creds = ReadOnlyCredentials('AKID', 'secret', None)
    query = parse_qs(urlparse(voice.transcribe_url('auto', credentials=creds, region='us-east-1')).query)
    assert query['identify-language'] == ['true']
    assert query['language-options'] == ['zh-CN,en-US']
    assert 'language-code' not in query and 'vocabulary-name' not in query
    assert voice.SttUrlRequest().language == 'auto'


def test_speakable_text_drops_code_tables_urls_and_paths():
    text = voice.speakable_text(
        '## 结果\n已完成 **两个接口**，见 [文档](https://example.com/doc)。\n\n'
        '```python\nprint("hi")\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n'
        '- 改了 /home/me/project/server/voice.py\n- 访问 https://example.com/x 查看\n> 引用\n'
    )
    assert text == '结果\n已完成 两个接口，见 文档。\n改了 voice.py\n访问 查看\n引用'


def test_language_of_prefers_chinese_with_identifiers():
    assert voice.language_of('已修改 server voice handler 和 install script') == 'zh'
    assert voice.language_of('All 312 tests passed after the voice handler change.') == 'en'


def test_split_chunks_respects_limit_and_sentences():
    chunks = voice.split_chunks('第一句。' * 400, limit=100)
    assert all(len(chunk) <= 100 for chunk in chunks)
    assert ''.join(chunks) == '第一句。' * 400
    assert all(chunk.endswith('。') for chunk in chunks)
    assert voice.split_chunks('x' * 250, limit=100) == ['x' * 100, 'x' * 100, 'x' * 50]


def test_truncate_original_adds_note():
    text, truncated = voice.truncate_original('很长的句子。' * 2000, 'zh', limit=600)
    assert truncated and len(text) < 650 and text.endswith('请在屏幕上查看。')
    assert voice.truncate_original('短', 'zh') == ('短', False)


class FakeS3:
    def __init__(self, existing=None):
        self.objects = dict(existing or {})
        self.puts = []

    def head_object(self, Bucket, Key):
        if Key not in self.objects:
            # The Lambda role has no s3:ListBucket, so S3 reports a missing object as 403.
            raise ClientError({'Error': {'Code': '403'}}, 'HeadObject')
        return {'Metadata': self.objects[Key]}

    def put_object(self, **kwargs):
        self.puts.append(kwargs)
        self.objects[kwargs['Key']] = kwargs['Metadata']

    def generate_presigned_url(self, operation, Params, ExpiresIn):
        return f"https://bucket/{Params['Key']}?ttl={ExpiresIn}"


class FakePolly:
    def __init__(self):
        self.calls = []

    def synthesize_speech(self, **kwargs):
        self.calls.append(kwargs)
        return {'AudioStream': io.BytesIO(b'mp3:' + kwargs['Text'].encode())}


class FakeBedrock:
    def __init__(self, reply='这是简报。', fail=None):
        self.reply, self.fail, self.calls = reply, fail, []

    def converse(self, **kwargs):
        self.calls.append(kwargs)
        if self.fail:
            raise self.fail
        return {'output': {'message': {'content': [{'reasoningContent': {}}, {'text': self.reply}]}}}


@pytest.fixture
def clients(monkeypatch):
    monkeypatch.setenv('BRIDGE_IMAGES_BUCKET', 'bucket')
    monkeypatch.setattr(voice.api_key, 'account_id', lambda key: 'acct')
    fakes = SimpleNamespace(s3=FakeS3(), polly=FakePolly(), bedrock=FakeBedrock())
    monkeypatch.setattr(voice, '_s3', lambda: fakes.s3)
    monkeypatch.setattr(voice, '_polly', lambda: fakes.polly)
    monkeypatch.setattr(voice, '_bedrock', lambda: fakes.bedrock)
    return fakes


def test_speak_short_reply_reads_original(clients):
    result = voice.speak(voice.SpeakRequest(text='**测试**全部通过。', brief=True), REQUEST)
    assert result['mode'] == 'original' and result['spokenText'] == '测试全部通过。'
    assert result['url'].startswith('https://bucket/voice/acct/')
    assert clients.bedrock.calls == []
    assert clients.polly.calls[0]['VoiceId'] == 'Zhiyu'
    assert clients.s3.puts[0]['Key'].startswith('voice/acct/')
    assert clients.s3.puts[0]['ContentType'] == 'audio/mpeg'


def test_speak_long_reply_reads_brief_without_thinking(clients):
    result = voice.speak(voice.SpeakRequest(text=LONG_REPLY, brief=True, threshold=300), REQUEST)
    assert result['mode'] == 'brief' and result['spokenText'] == '这是简报。'
    call = clients.bedrock.calls[0]
    assert call['additionalModelRequestFields'] == {'thinking': {'type': 'disabled'}}
    assert 'console.log' in call['messages'][0]['content'][0]['text']
    assert clients.polly.calls[0]['Text'] == '这是简报。'


def test_speak_brief_switch_off_reads_original(clients):
    result = voice.speak(voice.SpeakRequest(text=LONG_REPLY, brief=False), REQUEST)
    assert result['mode'] == 'original'
    assert clients.bedrock.calls == []
    assert 'console.log' not in ''.join(call['Text'] for call in clients.polly.calls)


def test_speak_brief_failure_falls_back_to_original(clients):
    clients.bedrock.fail = ClientError({'Error': {'Code': 'ThrottlingException'}}, 'Converse')
    result = voice.speak(voice.SpeakRequest(text=LONG_REPLY, brief=True), REQUEST)
    assert result['mode'] == 'original' and result['briefFallback'] is True


def test_speak_retries_brief_without_thinking_field(clients):
    calls = []

    def converse(**kwargs):
        calls.append(kwargs)
        if 'additionalModelRequestFields' in kwargs:
            raise ClientError({'Error': {'Code': 'ValidationException'}}, 'Converse')
        return {'output': {'message': {'content': [{'text': 'Brief.'}]}}}

    clients.bedrock.converse = converse
    assert voice.make_brief('long reply') == 'Brief.'
    assert len(calls) == 2


def test_speak_reuses_cached_audio(clients):
    first = voice.speak(voice.SpeakRequest(text=LONG_REPLY, brief=True), REQUEST)
    second = voice.speak(voice.SpeakRequest(text=LONG_REPLY, brief=True), REQUEST)
    assert second['cached'] is True and second['mode'] == 'brief'
    assert second['url'] == first['url']
    assert len(clients.bedrock.calls) == 1 and len(clients.s3.puts) == 1


def test_speak_rejects_code_only_reply(clients):
    with pytest.raises(HTTPException) as error:
        voice.speak(voice.SpeakRequest(text='```\ncode\n```'), REQUEST)
    assert error.value.status_code == 422


def test_voice_is_off_unless_the_stack_enables_it(monkeypatch):
    monkeypatch.delenv('VOICE_ENABLED')
    assert voice.config() == {'enabled': False}
    for call in (lambda: voice.stt_url(voice.SttUrlRequest()),
                 lambda: voice.speak(voice.SpeakRequest(text='hi'), REQUEST)):
        with pytest.raises(HTTPException) as error:
            call()
        assert error.value.status_code == 404
    monkeypatch.setenv('VOICE_ENABLED', 'true')
    assert voice.config() == {'enabled': True}


def test_auto_languages_follow_the_stack_parameter(monkeypatch):
    monkeypatch.setenv('VOICE_AUTO_LANGUAGES', 'en-US,ja-JP')
    creds = ReadOnlyCredentials('AKID', 'secret', None)
    query = parse_qs(urlparse(voice.transcribe_url('auto', credentials=creds, region='us-east-1')).query)
    assert query['language-options'] == ['en-US,ja-JP']


def test_cache_keys_are_scoped_by_account_and_mode():
    a = voice.cache_key('a', 'text', 'brief', 'zh')
    assert a != voice.cache_key('b', 'text', 'brief', 'zh')
    assert a != voice.cache_key('a', 'text', 'original', 'zh')
    assert a.startswith('voice/a/') and a.endswith('.mp3')
