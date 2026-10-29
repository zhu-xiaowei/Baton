import io
import json
import os
import time
from types import SimpleNamespace

import pytest
from boto3.dynamodb.types import TypeSerializer
from fastapi import HTTPException

os.environ.setdefault("AWS_DEFAULT_REGION", "ap-northeast-1")
import notifications
import notification_worker as worker


SESSION = {
    "entityType": "session", "accountId": "account", "deviceName": "Mac",
    "projectHash": "project", "projectName": "Baton", "sessionId": "codex:session",
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
    assert finished["body"] == "Run finished: Fixed it. · Mac"
    assert worker.notification(SESSION, WAITING, "ask")["body"] == "Needs input: npm test · Mac"
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
    monkeypatch.setenv("APNS_SENDER_FUNCTION", "apns-sender")
    sent = []

    def invoke(**kwargs):
        request = json.loads(kwargs["Payload"])
        sent.append(request)
        result = {"status": 200} if request["token"] == "a" * 64 else {"status": 410, "reason": "Unregistered"}
        return {"Payload": io.BytesIO(json.dumps(result).encode())}

    monkeypatch.setattr(worker, "_lambda", SimpleNamespace(invoke=invoke))
    monkeypatch.setattr(worker, "completion_summary", lambda session: "")
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
    monkeypatch.delenv("APNS_KEY_PARAMETER", raising=False)
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
