import io
import json
import time
from types import SimpleNamespace

import pytest
from boto3.dynamodb.types import TypeSerializer
from botocore.exceptions import ClientError
from fastapi import HTTPException

import notifications
import notification_worker as worker
from notification_store import permission_detail


SESSION = {
    "entityType": "session", "accountId": "account", "deviceName": "Mac",
    "projectHash": "project", "projectName": "Baton", "sessionId": "codex:session",
    "status": "running", "preview": "Fix login",
}


class MemoryTable:
    def __init__(self):
        self.rows = {}

    def get_item(self, Key, **_):
        return {"Item": self.rows.get((Key["pk"], Key["sk"]), {}).copy()}

    def put_item(self, Item, ConditionExpression="", ExpressionAttributeValues=None, **_):
        key = (Item["pk"], Item["sk"])
        if ConditionExpression and key in self.rows:
            previous = self.rows[key]
            if ConditionExpression == "eventId = :previous" and previous["eventId"] == ExpressionAttributeValues[":previous"]:
                self.rows[key] = Item.copy()
                return
            if previous.get("ttl", float("inf")) < (ExpressionAttributeValues or {}).get(":now", 0):
                self.rows[key] = Item.copy()
                return
            lease_expired = previous.get("leaseUntil", float("inf")) < (
                ExpressionAttributeValues or {}
            ).get(":now", 0)
            if not lease_expired:
                raise ClientError({"Error": {"Code": "ConditionalCheckFailedException"}}, "PutItem")
        self.rows[key] = Item.copy()

    def update_item(self, Key, ExpressionAttributeValues, **_):
        self.rows[(Key["pk"], Key["sk"])]["requestId"] = ExpressionAttributeValues[":request"]

    def delete_item(self, Key, **_):
        self.rows.pop((Key["pk"], Key["sk"]), None)


def test_transitions_use_effective_status_and_do_not_alert_for_imported_history():
    done = {**SESSION, "status": "completed"}
    assert worker.session_event({}, done, "first-import") is None
    assert worker.session_event(SESSION, done, "finished")["kind"] == "completed"
    assert worker.session_event(done, done, "title-edit") is None
    child_running = {**done, "activeStatus": "running", "runningAgentCount": 1}
    assert worker.session_event(SESSION, child_running, "child-still-running") is None
    assert worker.session_event(child_running, {**done, "activeStatus": "done#now"}, "all-finished")
    assert worker.session_event(SESSION, {**done, "parentSessionId": "root"}, "child-finished") is None
    assert worker.session_event(SESSION, {**SESSION, "activeStatus": "needs_input"}, "input")["kind"] == "needs_input"


def test_readable_titles_details_and_fallbacks():
    event = worker.make_event(SESSION, "completed", "finish", detail="Tests passed.")
    assert event["title"] == "Baton · Fix login"
    assert event["body"] == "Run finished: Tests passed. · Mac"
    assert "Session session" in worker.make_event({**SESSION, "preview": ""}, "completed", "finish")["title"]
    approval = worker.make_event(SESSION, "needs_input", "approval", "request", "tool", "npm test")
    assert approval["body"] == "Approval needed: npm test · Mac"
    assert permission_detail({"input": {"command": "npm test\n--run"}, "toolName": "Bash"}) == "npm test --run"
    assert permission_detail({"questions": [{"question": "Use SQLite?"}]}) == "Use SQLite?"
    assert worker.text_summary(json.dumps([
        {"type": "thinking", "thinking": "private reasoning"},
        {"type": "tool_use", "name": "Bash"},
        {"type": "text", "text": "**Fixed** the login.\nTests passed."},
    ])) == "Fixed the login. Tests passed."


def test_fresh_permission_can_precede_status_persistence_but_retries_skip_resolved_requests(monkeypatch):
    event = {
        "accountId": "account", "device": "Mac", "sessionId": "codex:session",
        "requestId": "first", "createdAt": time.time(),
    }
    monkeypatch.setattr(worker, "find_session", lambda *args: SESSION)
    assert worker.permission_event(event)["requestId"] == "first"
    assert worker.permission_event({**event, "createdAt": 0}) is None
    monkeypatch.setattr(worker, "find_session", lambda *args: {**SESSION, "status": "needs_input"})
    first = worker.permission_event(event)
    second = worker.permission_event({**event, "requestId": "second"})
    assert first["eventId"] != second["eventId"]


def test_status_and_request_coalesce_but_new_requests_alert(monkeypatch):
    storage = MemoryTable()
    monkeypatch.setattr(worker, "table", lambda: storage)
    status = worker.make_event(SESSION, "needs_input", "transition")
    first = worker.make_event(SESSION, "needs_input", "first", "request-one")
    second = worker.make_event(SESSION, "needs_input", "second", "request-two")
    assert worker.claim_attention(status)
    assert not worker.claim_attention(first)
    assert not worker.claim_attention(first)
    assert worker.claim_attention(second)
    assert worker.claim_attention(second)  # Retry uses the same delivery ID.


def test_delivery_retries_do_not_resend_to_already_notified_devices(monkeypatch):
    storage = MemoryTable()
    device = {
        "pk": "PUSH_DEVICE", "sk": "installation", "accountId": "account",
        "token": "a" * 64, "environment": "production",
        "ttl": int(time.time()) + 100,
    }
    storage.put_item(Item=device)
    storage.put_item(Item={
        "pk": "PUSH_ENDPOINT", "sk": worker.digest("production:" + "a" * 64),
        "accountId": "account", "installationId": "installation",
    })
    monkeypatch.setattr(worker, "table", lambda: storage)
    monkeypatch.setattr(worker, "devices", lambda account: [device])
    sent = []
    monkeypatch.setenv("APNS_SENDER_FUNCTION", "apns-sender")
    def invoke(**kwargs):
        sent.append(kwargs)
        return {"Payload": io.BytesIO(b'{"status":200}')}
    monkeypatch.setattr(worker.boto3, "client", lambda service: SimpleNamespace(invoke=invoke))
    event = worker.make_event(SESSION, "completed", "finished")
    worker.deliver(event)
    worker.deliver(event)
    assert len(sent) == 1
    payload = json.loads(sent[0]["Payload"])["payload"]
    assert payload["aps"]["alert"]["title"] == "Baton · Fix login"
    assert payload["sessionId"] == "codex:session"
    assert len([key for key in storage.rows if key[1].startswith("EVENT#")]) == 1


def test_delivery_rechecks_account_binding_after_logout(monkeypatch):
    storage = MemoryTable()
    monkeypatch.setattr(worker, "table", lambda: storage)
    calls = []
    monkeypatch.setattr(worker.boto3, "client", lambda service: calls.append(service))
    worker.send_apns(worker.make_event(SESSION, "completed", "finish"), {
        "sk": "installation", "token": "a" * 64, "environment": "production",
    })
    assert not calls


def test_worker_reports_only_failed_stream_records(monkeypatch):
    encoder = TypeSerializer()
    def record(identifier, status):
        return {
            "eventName": "MODIFY", "eventID": identifier,
            "dynamodb": {
                "SequenceNumber": identifier,
                "OldImage": {k: encoder.serialize(v) for k, v in SESSION.items()},
                "NewImage": {k: encoder.serialize(v) for k, v in {**SESSION, "status": status}.items()},
            },
        }
    monkeypatch.setattr(worker, "table", lambda: MemoryTable())
    monkeypatch.setattr(worker, "completion_summary", lambda session: "Completed the change.")
    delivered = []
    def deliver(event):
        delivered.append(event)
        if event["eventId"] == worker.digest("session:failed"):
            raise RuntimeError("APNs temporarily unavailable")
    monkeypatch.setattr(worker, "deliver", deliver)
    result = worker.handler({"Records": [record("ok", "completed"), record("failed", "completed")]}, None)
    assert result == {"batchItemFailures": [{"itemIdentifier": "failed"}]}
    assert delivered[0]["body"] == "Run finished: Completed the change. · Mac"


def test_android_feed_baseline_does_not_replay_history_and_validates_cursor(monkeypatch):
    monkeypatch.setattr(notifications, "table", lambda: pytest.fail("Baseline must not read historical notifications"))
    result = notifications.events(SimpleNamespace(headers={}))
    assert result["events"] == []
    assert result["cursor"].startswith("EVENT#")
    with pytest.raises(HTTPException) as error:
        notifications.events(SimpleNamespace(headers={}), "invalid")
    assert error.value.status_code == 400


def test_ios_registration_requires_matching_apns_environment(monkeypatch):
    monkeypatch.delenv("APNS_KEY_SECRET_ARN", raising=False)
    body = notifications.DeviceRegistration(
        installationId="12345678-1234-1234-1234-123456789012",
        token="a" * 64, environment="production",
    )
    with pytest.raises(HTTPException) as error:
        notifications.register_device(body, SimpleNamespace(headers={}))
    assert error.value.status_code == 503
