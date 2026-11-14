import os
import time
from types import SimpleNamespace

import pytest
from botocore.credentials import Credentials
from fastapi import HTTPException

os.environ.setdefault("AWS_DEFAULT_REGION", "ap-northeast-1")
import notifications

def test_relay_signs_reuses_its_connection_and_retries_throttling_with_jitter(monkeypatch):
    monkeypatch.setenv("PUSH_RELAY_URL", "https://abc.lambda-url.us-west-2.on.aws/")
    waits, answers, sent, opened = [], [], [], []
    monkeypatch.setattr(notifications.random, "uniform", lambda low, high: waits.append(high) or 0)
    monkeypatch.setattr(notifications.time, "sleep", lambda seconds: None)
    monkeypatch.setattr(notifications, "_session", SimpleNamespace(
        get_credentials=lambda: Credentials("AKIDEXAMPLE", "secret", "token")))

    class Connection:
        sock = None

        def __init__(self, host, timeout):
            opened.append(host)

        def request(self, method, path, body, headers):
            sent.append(headers)
            self.answer = answers.pop(0)
            if self.answer == "dropped":
                raise ConnectionResetError()

        def getresponse(self):
            status, body = self.answer if isinstance(self.answer, tuple) else (self.answer, b"")
            return SimpleNamespace(status=status, read=lambda: body)

        def close(self):
            pass

    monkeypatch.setattr(notifications.http.client, "HTTPSConnection", Connection)
    monkeypatch.setattr(notifications, "_relay", None)
    ok = (200, b'{"status": 200}')
    answers[:] = [429, 503, 502, ok, ok]
    assert notifications.relay({"token": "a"}) == {"status": 200}
    assert notifications.relay({"token": "a"}) == {"status": 200}
    assert waits == [2, 4, 8]
    assert opened == ["abc.lambda-url.us-west-2.on.aws"]  # One connection for all five requests.
    assert "us-west-2/lambda/aws4_request" in sent[0]["Authorization"]
    assert sent[0]["X-Amz-Security-Token"] == "token"
    answers[:] = ["dropped", ok]  # Dropped while frozen: reconnect at once, no backoff.
    assert notifications.relay({"token": "a"}) == {"status": 200}
    assert len(opened) == 2 and waits == [2, 4, 8]
    answers[:] = [400]
    with pytest.raises(RuntimeError, match="rejected"):
        notifications.relay({"token": "a"})


def test_the_extension_resolves_only_its_own_live_events(monkeypatch):
    event_id = "EVENT#" + "1" * 16 + "#" + "e" * 64
    rows = {("NOTIFICATIONS#account", event_id): {"event": {"title": "Baton · Fix login"}, "ttl": time.time() + 99}}
    store = SimpleNamespace(get_item=lambda Key: {"Item": rows.get((Key["pk"], Key["sk"]))} if (Key["pk"], Key["sk"]) in rows else {})
    monkeypatch.setattr(notifications, "_table", lambda: store)
    monkeypatch.setattr(notifications, "_account", lambda request: "account")
    assert notifications.event(event_id, None) == {"title": "Baton · Fix login"}
    monkeypatch.setattr(notifications, "_account", lambda request: "other")
    with pytest.raises(HTTPException) as error:
        notifications.event(event_id, None)
    assert error.value.status_code == 404
    with pytest.raises(HTTPException) as error:
        notifications.event("e" * 64, None)
    assert error.value.status_code == 400
