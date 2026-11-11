import os
import time
from types import SimpleNamespace

import pytest
from botocore.credentials import Credentials
from fastapi import HTTPException

os.environ.setdefault("AWS_DEFAULT_REGION", "ap-northeast-1")
import notifications

ALERT = {
    "eventId": "e" * 64, "device": "Mac", "projectHash": "project", "projectName": "Baton",
    "sessionId": "codex:session", "sessionTitle": "Fix login", "rootSessionId": "codex:session",
    "title": "Baton · Fix login", "body": "✅ Done · Fixed it.",
}


class MemoryTable:
    def __init__(self, *rows):
        self.rows = {(row["pk"], row["sk"]): row for row in rows}

    def put_item(self, Item, **_):
        self.rows[(Item["pk"], Item["sk"])] = Item

    def delete_item(self, Key, **_):
        self.rows.pop((Key["pk"], Key["sk"]), None)

    def query(self, **_):
        return {"Items": [row for (pk, _), row in self.rows.items() if pk == "PUSH_DEVICE"]}


def test_an_alert_is_stored_then_pushed_to_the_accounts_live_devices(monkeypatch):
    live = {"pk": "PUSH_DEVICE", "sk": "production:" + "a" * 64, "accountId": "account", "ttl": time.time() + 99}
    dead = {**live, "sk": "development:" + "b" * 64}
    other = {**live, "sk": "production:" + "c" * 64, "accountId": "other"}
    table = MemoryTable(live, dead, other)
    monkeypatch.setattr(notifications, "_table", lambda: table)
    monkeypatch.setattr(notifications, "_account", lambda request: "account")
    monkeypatch.setenv("PUSH_RELAY_URL", "https://relay.example")
    sent = []

    def relay(request, deadline=None):
        sent.append(request)
        return {"status": 200} if request["token"] == "a" * 64 else {"status": 410, "reason": "Unregistered"}

    monkeypatch.setattr(notifications, "relay", relay)
    notifications.post_event(notifications.Alert(**ALERT), None)
    assert sorted(request["environment"] for request in sent) == ["development", "production"]
    # The push carries only the feed row's key; no title, summary or session leaves the stack.
    assert set(sent[0]) == {"token", "environment", "id"}
    feed = [key for key in table.rows if key[1].startswith("EVENT#")]
    assert sent[0]["id"] == feed[0][1] and feed[0][1].endswith("#" + "e" * 64)
    assert table.rows[feed[0]]["event"]["accountId"] == "account"
    assert ("PUSH_DEVICE", dead["sk"]) not in table.rows
    # The relay being down still answers: the feed row is there for Android.
    monkeypatch.setattr(notifications, "relay", lambda request, deadline=None: 1 / 0)
    assert notifications.post_event(notifications.Alert(**ALERT), None) == {"ok": True}


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
