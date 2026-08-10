import asyncio
import json
import os
import sys
from contextlib import contextmanager

sys.path.insert(
    0,
    os.path.join(os.path.dirname(__file__), "..", "..", "server", "src"),
)

import bridge_sync
import bridge_read
import bridge_ws


class FakeBatch:
    def __init__(self, table):
        self.table = table

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def put_item(self, Item):
        self.table.items.append(Item)

    def delete_item(self, Key):
        self.table.deleted.append(Key)


class FakeTable:
    def __init__(self):
        self.items = []
        self.deleted = []

    def batch_writer(self):
        return FakeBatch(self)

    def put_item(self, Item, **_):
        self.items.append(Item)


class FakeRequest:
    headers = {"x-api-key": "test-key"}


class FakeMessageTable:
    def __init__(self, items):
        self.items = sorted(items, key=lambda item: item["sk"])

    def query(self, Limit=None, ScanIndexForward=True, ExclusiveStartKey=None, **kwargs):
        items = self.items
        condition = kwargs.get("KeyConditionExpression")
        expression = condition.get_expression() if condition else {}
        if expression.get("operator") == "AND":
            sort_expression = expression["values"][1].get_expression()
            if sort_expression.get("operator") == "<":
                cursor = sort_expression["values"][1]
                items = [item for item in items if item["sk"] < cursor]
        items = list(reversed(items)) if not ScanIndexForward else list(items)
        start = 0
        if ExclusiveStartKey:
            start = next(i for i, item in enumerate(items) if item["sk"] == ExclusiveStartKey["sk"]) + 1
        limit = Limit or len(items)
        page = items[start:start + limit]
        response = {"Items": page}
        if start + limit < len(items):
            response["LastEvaluatedKey"] = {"sessionId": "session", "sk": page[-1]["sk"]}
        return response


def test_session_id_compatibility():
    assert bridge_sync._session_ids("claude", "abc") == ("claude", "abc", "abc")
    assert bridge_sync._session_ids("", "abc") == ("claude", "abc", "abc")
    assert bridge_sync._session_ids("codex", "abc") == ("codex", "abc", "codex:abc")
    assert bridge_sync._session_ids("codex", "codex:abc") == ("codex", "abc", "codex:abc")


def test_old_session_payload_defaults_to_claude():
    item = bridge_sync.SessionItem(
        id="old-id",
        project="-tmp-project",
        lastActive="2026-08-06T00:00:00.000Z",
    )
    assert item.runtime == "claude"
    assert item.nativeSessionId == ""


def test_runtime_fields_default_old_items_to_claude():
    assert bridge_read._runtime_fields({"sessionId": "old-id"}) == {
        "runtime": "claude",
        "nativeSessionId": "old-id",
    }
    assert bridge_read._runtime_fields({"sessionId": "codex:new-id", "runtime": "codex"}) == {
        "runtime": "codex",
        "nativeSessionId": "new-id",
    }


def test_old_device_gets_claude_capability():
    capabilities = bridge_read._runtime_capabilities({})
    assert list(capabilities) == ["claude"]
    assert capabilities["claude"]["canCreate"] is True


def test_ws_sync_payload_decodes_storage_id():
    assert bridge_ws._runtime_session_fields("old-id") == {
        "runtime": "claude",
        "nativeSessionId": "old-id",
    }
    assert bridge_ws._runtime_session_fields("codex:new-id") == {
        "runtime": "codex",
        "nativeSessionId": "new-id",
    }


def test_sync_sessions_writes_separate_runtime_keys(monkeypatch):
    sessions = FakeTable()
    messages = FakeTable()
    monkeypatch.setattr(bridge_sync, "_tables", lambda: (sessions, messages))
    request = bridge_sync.SyncSessionsRequest(
        deviceName="Mac",
        sessions=[
            bridge_sync.SessionItem(
                id="same-id",
                runtime="claude",
                project="-repo",
                lastActive="2026-08-06T00:00:00.000Z",
            ),
            bridge_sync.SessionItem(
                id="same-id",
                runtime="codex",
                project="-repo",
                lastActive="2026-08-06T00:00:00.000Z",
                modelProvider="openai",
                clientSource="codex-tui",
            ),
        ],
    )
    asyncio.run(bridge_sync.sync_sessions(request, FakeRequest()))
    by_runtime = {item["runtime"]: item for item in sessions.items}
    assert by_runtime["claude"]["sk"].endswith("#same-id")
    assert by_runtime["codex"]["sk"].endswith("#codex:same-id")
    assert by_runtime["codex"]["sessionId"] == "codex:same-id"
    assert by_runtime["codex"]["nativeSessionId"] == "same-id"
    assert by_runtime["codex"]["modelProvider"] == "openai"


def test_sync_messages_uses_storage_partition(monkeypatch):
    sessions = FakeTable()
    messages = FakeTable()
    monkeypatch.setattr(bridge_sync, "_tables", lambda: (sessions, messages))
    request = bridge_sync.SyncMessagesRequest(
        sessionId="native-id",
        runtime="codex",
        messages=[{
            "uuid": "m1",
            "type": "user",
            "content": "hello",
            "timestamp": "2026-08-06T00:00:00.000Z",
        }],
    )
    asyncio.run(bridge_sync.sync_messages(request, FakeRequest()))
    assert messages.items[0]["sessionId"] == "codex:native-id"
    assert messages.items[0]["runtime"] == "codex"


def test_sync_sessions_persists_device_runtime_capabilities(monkeypatch):
    sessions = FakeTable()
    messages = FakeTable()
    monkeypatch.setattr(bridge_sync, "_tables", lambda: (sessions, messages))
    request = bridge_sync.SyncSessionsRequest(
        deviceName="Mac",
        sessions=[],
        device=bridge_sync.DeviceAggregate(
            runtimeCapabilities={
                "claude": bridge_sync.RuntimeCapability(
                    installed=True, historyAvailable=True, canRead=True,
                    canCreate=True, canSend=True, version="2.0.0",
                ),
                "codex": bridge_sync.RuntimeCapability(
                    installed=True, historyAvailable=True, canRead=True,
                    canCreate=False, canSend=False, version="1.0.0",
                ),
            },
        ),
        projects=[],
    )
    asyncio.run(bridge_sync.sync_sessions(request, FakeRequest()))
    devices = [item for item in sessions.items if item["entityType"] == "device"]
    assert len(devices) == 1
    device = devices[0]
    assert device["sk"] == "DEV#Mac"
    assert device["runtimeCapabilities"]["claude"]["canCreate"] is True
    assert device["runtimeCapabilities"]["codex"]["canRead"] is True
    assert device["runtimeCapabilities"]["codex"]["canCreate"] is False


def test_message_cursor_preserves_equal_timestamp_rows(monkeypatch):
    timestamp = "2026-08-06T00:00:00.000Z"
    messages = FakeMessageTable([
        {
            "sessionId": "session",
            "sk": f"{timestamp}#{uuid}",
            "uuid": uuid,
            "type": "user",
            "content": json.dumps(uuid),
            "timestamp": timestamp,
        }
        for uuid in ("a", "b", "c")
    ])
    monkeypatch.setattr(bridge_read, "_tables", lambda: (FakeTable(), messages))

    first = asyncio.run(
        bridge_read.get_messages(
            FakeRequest(),
            "session",
            after=None,
            before=None,
            device=None,
            limit=2,
        )
    )
    second = asyncio.run(
        bridge_read.get_messages(
            FakeRequest(),
            "session",
            after=None,
            before=first["oldestTimestamp"],
            device=None,
            limit=2,
        )
    )

    assert first["oldestTimestamp"] == f"{timestamp}#b"
    assert [item["uuid"] for item in first["messages"]] == ["b", "c"]
    assert [item["uuid"] for item in second["messages"]] == ["a"]


def test_windows_installer_runs_without_an_interactive_logon():
    script = bridge_read._windows_install_script(
        "https://example.com/bridge.tar.gz",
        "https://example.com/v1",
        "test-key",
        "Windows",
    )
    assert "-LogonType S4U" in script
    assert "-LogonType Interactive" not in script
    assert "$env:Path = (Split-Path $nodePath) + ';' + $env:Path" in script


def test_bridge_connection_persists_running_version(monkeypatch):
    connections = FakeTable()
    monkeypatch.setattr(bridge_ws, "_connections_table", connections)
    response = bridge_ws._handle_connect(
        {
            "queryStringParameters": {
                "apiKey": "test-key",
                "role": "bridge",
                "device": "Mac",
                "version": "0.2.0-test",
            },
        },
        "connection-1",
    )
    assert response == {"statusCode": 200}
    assert connections.items[0]["deviceName"] == "Mac"
    assert connections.items[0]["bridgeVersion"] == "0.2.0-test"


def test_bridge_recovery_complete_broadcasts_to_apps(monkeypatch):
    class ConnectionTable:
        def get_item(self, Key):
            return {
                "Item": {
                    "connectionId": Key["connectionId"],
                    "role": "bridge",
                    "accountId": "account-1",
                },
            }

    sent = []
    monkeypatch.setattr(bridge_ws, "_connections_table", ConnectionTable())
    monkeypatch.setattr(
        bridge_ws,
        "_query_connections",
        lambda account_id, role: [
            {"connectionId": "app-1"},
            {"connectionId": "app-2"},
        ] if account_id == "account-1" and role == "app" else [],
    )
    monkeypatch.setattr(
        bridge_ws,
        "_post_to_connection",
        lambda endpoint, connection_id, data: sent.append((endpoint, connection_id, data)),
    )

    response = bridge_ws._handle_message(
        {
            "body": json.dumps({
                "action": "bridge_recovery_complete",
                "deviceName": "Mac",
                "count": 3,
            }),
        },
        "bridge-1",
        "https://example.test/v1",
    )

    assert response == {"statusCode": 200}
    assert sent == [
        (
            "https://example.test/v1",
            "app-1",
            {
                "action": "bridge_recovery_complete",
                "deviceName": "Mac",
                "count": 3,
            },
        ),
        (
            "https://example.test/v1",
            "app-2",
            {
                "action": "bridge_recovery_complete",
                "deviceName": "Mac",
                "count": 3,
            },
        ),
    ]


def test_bridge_messages_do_not_ack_unavailable_or_failed_ddb_writes(monkeypatch):
    class SubscriptionTable:
        def query(self, **_):
            return {"Items": []}

    class FailingMessagesTable:
        def batch_writer(self):
            raise RuntimeError("ddb unavailable")

    monkeypatch.setattr(bridge_ws, "_subscriptions_table", SubscriptionTable())
    sent = []
    monkeypatch.setattr(
        bridge_ws,
        "_post_to_connection",
        lambda endpoint, connection_id, data: sent.append((endpoint, connection_id, data)),
    )

    body = {
        "sessionId": "codex:test",
        "messages": [{
            "uuid": "m1",
            "type": "assistant",
            "content": "hello",
            "timestamp": "2026-08-10T00:00:00.000Z",
        }],
    }
    for table in (None, FailingMessagesTable()):
        monkeypatch.setattr(bridge_ws, "_messages_table", table)
        response = bridge_ws._handle_bridge_messages(
            body,
            "bridge-1",
            "account-1",
            "https://example.test/v1",
        )
        assert response == {"statusCode": 500}
        assert sent == []
