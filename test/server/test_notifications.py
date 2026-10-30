import io
import json
import os
import time
from types import SimpleNamespace

import pytest
from boto3.dynamodb.types import TypeSerializer
from botocore.credentials import Credentials
from fastapi import HTTPException

os.environ.setdefault("AWS_DEFAULT_REGION", "ap-northeast-1")
import notifications
import notification_worker as worker


SESSION = {
    "entityType": "session", "accountId": "account", "deviceName": "Mac",
    "projectHash": "project", "projectName": "workspace/github/Baton", "sessionId": "codex:session",
    "activeStatus": "running", "preview": "Fix login",
}
DONE = {**SESSION, "activeStatus": "done#2026-10-29"}
WAITING = {**SESSION, "activeStatus": "needs_input", "agentDetail": "npm test"}


class MemoryTable:
    def __init__(self, *rows):
        self.rows = {(row["pk"], row["sk"]): row for row in rows}

    def put_item(self, Item, **_):
        self.rows[(Item["pk"], Item["sk"])] = Item

    def delete_item(self, Key, **_):
        self.rows.pop((Key["pk"], Key["sk"]), None)

    def query(self, **_):
        return {"Items": [row for (pk, _), row in self.rows.items() if pk == "PUSH_DEVICE"]}


def test_status_transitions(monkeypatch):
    monkeypatch.setattr(worker, "completion_summary", lambda session: "Fixed it.")
    finished = worker.notification(SESSION, DONE, "finished")
    assert finished["title"] == "Baton · Fix login"
    assert finished["body"] == "Finished: Fixed it."
    assert worker.notification(SESSION, WAITING, "ask")["body"] == "Needs input: npm test"
    # A queued next approval stays needs_input but changes the detail.
    assert worker.notification(WAITING, {**WAITING, "agentDetail": "rm -rf build"}, "next")
    assert worker.notification(WAITING, WAITING, "re-sync") is None
    assert worker.notification({}, DONE, "imported") is None
    assert worker.notification(DONE, DONE, "renamed") is None
    assert worker.notification(SESSION, {**DONE, "parentSessionId": "root"}, "child") is None
    assert "Session session" in worker.notification(SESSION, {**DONE, "preview": ""}, "x")["title"]


def test_text_summary_keeps_only_reply_text():
    assert worker.text_summary(json.dumps([
        {"type": "thinking", "thinking": "private reasoning"},
        {"type": "tool_use", "name": "Bash"},
        {"type": "text", "text": "**Fixed** the login.\nTests passed."},
    ])) == "Fixed the login. Tests passed."


def test_delivery_targets_account_devices_and_drops_dead_tokens(monkeypatch):
    live = {"pk": "PUSH_DEVICE", "sk": "production:" + "a" * 64, "accountId": "account", "ttl": time.time() + 99}
    dead = {**live, "sk": "development:" + "b" * 64}
    other = {**live, "sk": "production:" + "c" * 64, "accountId": "other"}
    table = MemoryTable(live, dead, other)
    monkeypatch.setattr(worker._ddb, "Table", lambda name: table)
    monkeypatch.setenv("SYSTEM_TABLE", "system")
    monkeypatch.setenv("PUSH_RELAY_URL", "https://relay.example")
    sent = []

    def relay(request):
        sent.append(request)
        return {"status": 200} if request["token"] == "a" * 64 else {"status": 410, "reason": "Unregistered"}

    monkeypatch.setattr(worker, "relay", relay)
    monkeypatch.setattr(worker, "completion_summary", lambda session: "")
    monkeypatch.setattr(worker, "being_viewed", lambda event: False)
    worker.deliver(worker.notification(SESSION, DONE, "finished"))
    assert sorted(request["environment"] for request in sent) == ["development", "production"]
    assert sent[0]["payload"]["aps"]["alert"]["title"] == "Baton · Fix login"
    assert sent[0]["payload"]["sessionId"] == "codex:session"
    assert ("PUSH_DEVICE", dead["sk"]) not in table.rows
    assert len([key for key in table.rows if key[1].startswith("EVENT#")]) == 1


def test_worker_reports_only_failed_records(monkeypatch):
    encode = TypeSerializer().serialize

    def record(identifier):
        return {"eventID": identifier, "dynamodb": {
            "SequenceNumber": identifier,
            "OldImage": {k: encode(v) for k, v in SESSION.items()},
            "NewImage": {k: encode(v) for k, v in WAITING.items()},
        }}

    def deliver(event):
        if event["eventId"] == worker.hashlib.sha256(b"failed").hexdigest():
            raise RuntimeError("APNs unavailable")

    monkeypatch.setattr(worker, "deliver", deliver)
    result = worker.handler({"Records": [record("ok"), record("failed")]}, None)
    assert result == {"batchItemFailures": [{"itemIdentifier": "failed"}]}


def test_registration_and_feed_validation(monkeypatch):
    monkeypatch.delenv("PUSH_RELAY_URL", raising=False)
    body = notifications.PushDevice(token="A" * 64, environment="production")
    assert body.key() == {"pk": "PUSH_DEVICE", "sk": "production:" + "a" * 64}
    with pytest.raises(HTTPException) as error:
        notifications.register_device(body, SimpleNamespace(headers={}))
    assert error.value.status_code == 503
    monkeypatch.setattr(notifications, "_table", lambda: pytest.fail("baseline must not read history"))
    assert notifications.events(SimpleNamespace(headers={}))["events"] == []
    with pytest.raises(HTTPException) as error:
        notifications.events(SimpleNamespace(headers={}), "invalid")
    assert error.value.status_code == 400


class Pages:
    """A table whose successive queries return successive pages."""

    def __init__(self, *pages):
        self.pages = list(pages)
        self.queries = 0

    def get_item(self, **_):
        return {}

    def query(self, **_):
        self.queries += 1
        return {"Items": self.pages[min(self.queries, len(self.pages)) - 1]}


def assistant(text, stop="end_turn"):
    return {"type": "assistant", "stopReason": stop, "content": json.dumps([{"type": "text", "text": text}])}


def test_summary_waits_for_the_final_reply_and_skips_interrupts(monkeypatch):
    monkeypatch.setenv("BRIDGE_MESSAGES_TABLE", "messages")
    monkeypatch.setattr(worker.time, "sleep", lambda seconds: None)
    user = {"type": "user", "content": "go"}
    thinking = {"type": "assistant", "stopReason": "end_turn", "content": json.dumps([{"type": "thinking"}])}
    table = Pages([thinking, user], [assistant("Done."), thinking, user])
    monkeypatch.setattr(worker._ddb, "Table", lambda name: table)
    assert worker.completion_summary(SESSION) == "Done."
    assert table.queries == 2
    table = Pages([assistant("Checking", "tool_use"), user])
    monkeypatch.setattr(worker._ddb, "Table", lambda name: table)
    assert worker.completion_summary(SESSION) == "Checking"  # Best effort after the retries.
    assert table.queries == 3
    stopped = Pages([{"type": "user", "content": json.dumps([{"type": "text", "text": "[Request interrupted by user]"}])}])
    monkeypatch.setattr(worker._ddb, "Table", lambda name: stopped)
    assert worker.notification(SESSION, DONE, "stopped") is None


def test_an_open_focused_viewer_suppresses_the_push(monkeypatch):
    monkeypatch.setenv("SUBSCRIPTIONS_TABLE", "subscriptions")
    monkeypatch.setenv("WS_API_ENDPOINT", "https://ws.example/v1")
    monkeypatch.setattr(worker.time, "sleep", lambda seconds: None)
    event = {"eventId": "e" * 64, "accountId": "account", "rootSessionId": "codex:session"}
    row = {"connectionId": "phone", "accountId": "account"}
    posted = []
    api = SimpleNamespace(post_to_connection=lambda **kwargs: posted.append(kwargs["ConnectionId"]))
    monkeypatch.setattr(worker.boto3, "client", lambda *args, **kwargs: api)
    monkeypatch.setattr(worker._ddb, "Table", lambda name: Pages([row], [{**row, "seenEvent": "e" * 64}]))
    assert worker.being_viewed(event) is True
    assert posted == ["phone"]
    monkeypatch.setattr(worker._ddb, "Table", lambda name: Pages([row]))
    assert worker.being_viewed(event, timeout=0.01) is False  # A suspended socket never answers.
    posted.clear()
    monkeypatch.setattr(worker._ddb, "Table", lambda name: Pages([]))
    assert worker.being_viewed(event) is False and posted == []


def test_relay_signs_requests_and_retries_throttling_with_jitter(monkeypatch):
    monkeypatch.setenv("PUSH_RELAY_URL", "https://abc.lambda-url.us-west-2.on.aws/")
    waits, answers, seen = [], [], []
    monkeypatch.setattr(worker.random, "uniform", lambda low, high: waits.append(high) or 0)
    monkeypatch.setattr(worker.time, "sleep", lambda seconds: None)
    monkeypatch.setattr(worker.boto3, "Session", lambda: SimpleNamespace(
        get_credentials=lambda: Credentials("AKIDEXAMPLE", "secret", "token")))

    def urlopen(request, timeout):
        seen.append(request.headers)
        answer = answers.pop(0)
        if isinstance(answer, int):
            raise worker.urllib.error.HTTPError(request.full_url, answer, "", {}, None)
        return io.BytesIO(json.dumps(answer).encode())

    monkeypatch.setattr(worker.urllib.request, "urlopen", urlopen)
    answers[:] = [429, 503, 502, {"status": 200}]
    assert worker.relay({"token": "a"}) == {"status": 200}
    assert waits == [2, 4, 8]
    assert "us-west-2/lambda/aws4_request" in seen[0]["Authorization"]
    assert seen[0]["X-amz-security-token"] == "token"
    answers[:] = [400]
    with pytest.raises(RuntimeError, match="rejected"):
        worker.relay({"token": "a"})
