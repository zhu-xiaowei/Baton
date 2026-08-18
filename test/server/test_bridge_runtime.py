import asyncio
import json
import os
import sys
from contextlib import contextmanager
from types import SimpleNamespace

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

    def get_item(self, Key, **_):
        item = next((
            item for item in reversed(self.items)
            if item.get("accountId") == Key["accountId"] and item.get("sk") == Key["sk"]
        ), None)
        return {"Item": item} if item else {}


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
                status="needs_input",
                agentDetail="Allow writing the test file?",
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
    assert by_runtime["claude"]["agentDetail"] == "Allow writing the test file?"
    assert by_runtime["codex"]["sk"].endswith("#codex:same-id")
    assert by_runtime["codex"]["sessionId"] == "codex:same-id"
    assert by_runtime["codex"]["nativeSessionId"] == "same-id"
    assert by_runtime["codex"]["modelProvider"] == "openai"


def test_sync_messages_persists_only_message_fields(monkeypatch):
    sessions = FakeTable()
    messages = FakeTable()
    monkeypatch.setattr(bridge_sync, "_tables", lambda: (sessions, messages))
    request = bridge_sync.SyncMessagesRequest(
        sessionId="native-id",
        runtime="codex",
        messages=[{
            "uuid": "m1",
            "nativeId": "codex:user:client-1",
            "type": "user",
            "content": "hello",
            "timestamp": "2026-08-06T00:00:00.000Z",
            "transient": "not-persisted",
        }],
    )
    asyncio.run(bridge_sync.sync_messages(request, FakeRequest()))
    assert messages.items[0]["sessionId"] == "codex:native-id"
    assert messages.items[0]["runtime"] == "codex"
    assert messages.items[0]["nativeId"] == "codex:user:client-1"
    assert "transient" not in messages.items[0]


def test_message_reads_return_only_message_fields():
    parsed = bridge_read._parse_messages([{
        "uuid": "m1",
        "nativeId": "codex:user:client-1",
        "type": "user",
        "content": json.dumps("hello"),
        "timestamp": "2026-08-06T00:00:00.000Z",
        "transient": "not-returned",
    }])
    assert parsed[0]["nativeId"] == "codex:user:client-1"
    assert "transient" not in parsed[0]


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


def test_incomplete_first_catalog_bootstraps_device_and_projects(monkeypatch):
    sessions = FakeTable()
    messages = FakeTable()
    monkeypatch.setattr(bridge_sync, "_tables", lambda: (sessions, messages))
    request = bridge_sync.SyncSessionsRequest(
        deviceName="Windows",
        os="win32",
        catalogComplete=False,
        sessions=[bridge_sync.SessionItem(
            id="session-1",
            project="C--repo",
            projectName="repo",
            lastActive="2026-08-16T00:00:00.000Z",
        )],
        device=bridge_sync.DeviceAggregate(
            sessionCount=1,
            projectCount=1,
            lastActive="2026-08-16T00:00:00.000Z",
        ),
        projects=[bridge_sync.ProjectAggregate(
            projectHash="C--repo",
            projectName="repo",
            sessionCount=1,
            lastActive="2026-08-16T00:00:00.000Z",
        )],
    )

    asyncio.run(bridge_sync.sync_sessions(request, FakeRequest()))

    assert any(item["sk"] == "DEV#Windows" for item in sessions.items)
    assert any(item["sk"] == "PROJ#Windows#C--repo" for item in sessions.items)


def test_incomplete_catalog_preserves_existing_device_aggregates(monkeypatch):
    account_id = bridge_sync._hash_key("test-key")
    existing_device = {
        "accountId": account_id,
        "sk": "DEV#Windows",
        "entityType": "device",
        "deviceName": "Windows",
        "sessionCount": 99,
        "projectCount": 12,
    }
    sessions = FakeTable()
    sessions.items.append(existing_device)
    messages = FakeTable()
    monkeypatch.setattr(bridge_sync, "_tables", lambda: (sessions, messages))
    request = bridge_sync.SyncSessionsRequest(
        deviceName="Windows",
        os="win32",
        catalogComplete=False,
        sessions=[],
        device=bridge_sync.DeviceAggregate(sessionCount=1, projectCount=1),
        projects=[bridge_sync.ProjectAggregate(
            projectHash="partial",
            sessionCount=1,
        )],
    )

    asyncio.run(bridge_sync.sync_sessions(request, FakeRequest()))

    devices = [item for item in sessions.items if item.get("sk") == "DEV#Windows"]
    assert devices == [existing_device]
    assert not any(item.get("sk") == "PROJ#Windows#partial" for item in sessions.items)


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
    assert "ci --omit=dev --include=optional --silent --no-audit --no-fund" in script
    assert "verify-dependencies.mjs" in script
    assert "[version]'20.9.0'" in script
    assert "-LogonType ServiceAccount" in script
    assert "Baton Bridge failed to stay running" in script
    assert "AppData\\Local\\Programs\\nodejs\\node.exe" in script
    assert "'C:\\nodejs'" in script
    assert "Node.js 20.9+ was not found or could not run" in script
    assert "Get-CimInstance Win32_UserProfile" in script
    assert "$useSystemTask = $isSystemContext -or ($currentIdentity -match" in script
    assert "bridge.log" in script
    assert "installed and running" in script


def test_windows_installer_prompts_for_device_name():
    script = bridge_read._windows_install_script(
        "https://example.com/bridge.tar.gz",
        "https://example.com/v1",
        "test-key",
        None,
    )
    assert "if (-not $isSystemContext)" in script
    assert 'Read-Host "Device name [$defaultName]"' in script
    assert "$deviceName = $defaultName" in script


def test_unix_installer_validates_runtime_dependencies(monkeypatch):
    class S3:
        def generate_presigned_url(self, *_args, **_kwargs):
            return "https://example.com/bridge.tar.gz"

    request = FakeRequest()
    request.url = SimpleNamespace(scheme="https")
    monkeypatch.setenv("BRIDGE_IMAGES_BUCKET", "bridge-bucket")
    monkeypatch.setattr("boto3.client", lambda *_args, **_kwargs: S3())

    response = asyncio.run(bridge_read.get_install(request, name="Linux", platform=""))
    script = response.body.decode()

    assert "Requires >= 20.9" in script
    assert "npm ci --omit=dev --include=optional --silent --no-audit --no-fund" in script
    assert "node verify-dependencies.mjs" in script
    assert 'NODE_DIR=$(dirname "$NODE")' in script
    assert (
        "<key>PATH</key><string>$NODE_DIR:/opt/homebrew/bin:"
        "/usr/local/bin:/opt/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>"
    ) in script


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


def test_send_result_includes_the_responding_bridge_device(monkeypatch):
    class ConnectionTable:
        def get_item(self, Key):
            return {
                "Item": {
                    "connectionId": Key["connectionId"],
                    "role": "bridge",
                    "accountId": "account-1",
                    "deviceName": "Mac",
                },
            }

    sent = []
    monkeypatch.setattr(bridge_ws, "_connections_table", ConnectionTable())
    monkeypatch.setattr(
        bridge_ws,
        "_query_connections",
        lambda account_id, role: [{"connectionId": "app-1"}]
        if account_id == "account-1" and role == "app" else [],
    )
    monkeypatch.setattr(
        bridge_ws,
        "_post_to_connection",
        lambda endpoint, connection_id, data: sent.append((connection_id, data)),
    )

    response = bridge_ws._handle_message(
        {
            "body": json.dumps({
                "action": "send_message_result",
                "turnId": "turn-1",
                "ok": False,
                "error": "already has an active writer",
                "errorCode": "codex_active_writer",
                "writer": {
                    "pid": 123,
                    "label": "Codex terminal",
                    "canTerminate": True,
                },
            }),
        },
        "bridge-1",
        "https://example.test/v1",
    )

    assert response == {"statusCode": 200}
    assert sent == [(
        "app-1",
        {
            "action": "send_message_result",
            "turnId": "turn-1",
            "ok": False,
            "error": "already has an active writer",
            "errorCode": "codex_active_writer",
            "writer": {
                "pid": 123,
                "label": "Codex terminal",
                "canTerminate": True,
            },
            "deviceName": "Mac",
        },
    )]


def test_new_session_send_carries_the_origin_connection_to_the_bridge(monkeypatch):
    class ConnectionTable:
        def get_item(self, Key):
            return {
                "Item": {
                    "connectionId": Key["connectionId"],
                    "role": "app",
                    "accountId": "account-1",
                },
            }

    sent = []
    monkeypatch.setattr(bridge_ws, "_connections_table", ConnectionTable())
    monkeypatch.setattr(
        bridge_ws,
        "_query_connections",
        lambda account_id, role: [{
            "connectionId": "bridge-1",
            "deviceName": "Mac",
        }] if account_id == "account-1" and role == "bridge" else [],
    )
    monkeypatch.setattr(
        bridge_ws,
        "_post_to_connection",
        lambda endpoint, connection_id, data: sent.append((connection_id, data)),
    )

    response = bridge_ws._handle_message(
        {
            "body": json.dumps({
                "action": "send_message",
                "projectHash": "-repo",
                "requestId": "request-1",
                "turnId": "turn-1",
                "text": "hello",
                "device": "Mac",
                "runtime": "codex",
            }),
        },
        "app-1",
        "https://example.test/v1",
    )

    assert response == {"statusCode": 200}
    assert sent == [(
        "bridge-1",
        {
            "action": "send_message",
            "projectHash": "-repo",
            "requestId": "request-1",
            "turnId": "turn-1",
            "text": "hello",
            "runtime": "codex",
            "replyConnectionId": "app-1",
        },
    )]


def test_new_session_result_subscribes_origin_before_reply(monkeypatch):
    events = []

    class ConnectionTable:
        def get_item(self, Key):
            connection_id = Key["connectionId"]
            role = "bridge" if connection_id == "bridge-1" else "app"
            return {
                "Item": {
                    "connectionId": connection_id,
                    "role": role,
                    "accountId": "account-1",
                    **({"deviceName": "Mac"} if role == "bridge" else {}),
                },
            }

    class SubscriptionTable:
        def put_item(self, Item):
            events.append(("subscribe", Item))

    monkeypatch.setattr(bridge_ws, "_connections_table", ConnectionTable())
    monkeypatch.setattr(bridge_ws, "_subscriptions_table", SubscriptionTable())
    monkeypatch.setattr(
        bridge_ws,
        "_post_to_connection",
        lambda endpoint, connection_id, data: events.append(
            ("send", connection_id, data),
        ),
    )

    response = bridge_ws._handle_message(
        {
            "body": json.dumps({
                "action": "send_message_result",
                "sessionId": "codex:thread-1",
                "requestId": "request-1",
                "turnId": "turn-1",
                "replyConnectionId": "app-1",
                "ok": True,
            }),
        },
        "bridge-1",
        "https://example.test/v1",
    )

    assert response == {"statusCode": 200}
    assert events[0][0] == "subscribe"
    assert events[0][1]["sessionId"] == "codex:thread-1"
    assert events[0][1]["connectionId"] == "app-1"
    assert events[0][1]["accountId"] == "account-1"
    assert events[1] == (
        "send",
        "app-1",
        {
            "action": "send_message_result",
            "sessionId": "codex:thread-1",
            "requestId": "request-1",
            "turnId": "turn-1",
            "ok": True,
            "deviceName": "Mac",
        },
    )


def test_subscribe_only_persists_the_connection(monkeypatch):
    events = []

    class SubscriptionTable:
        def put_item(self, Item):
            events.append(("put", Item))

    monkeypatch.setattr(bridge_ws, "_subscriptions_table", SubscriptionTable())
    monkeypatch.setattr(
        bridge_ws,
        "_post_to_connection",
        lambda endpoint, connection_id, data: events.append(("send", connection_id, data)),
    )
    response = bridge_ws._handle_subscribe(
        {
            "sessionId": "codex:thread-1",
        },
        "app-1",
        "account-1",
        "https://example.test/v1",
    )

    assert response == {"statusCode": 200}
    assert len(events) == 1
    assert events[0][0] == "put"
    assert events[0][1]["sessionId"] == "codex:thread-1"
    assert events[0][1]["connectionId"] == "app-1"
    assert events[0][1]["accountId"] == "account-1"
    assert "requestId" not in events[0][1]


def test_subscribe_write_failure_propagates(monkeypatch):
    class SubscriptionTable:
        def put_item(self, Item):
            raise RuntimeError("write failed")

    sent = []
    monkeypatch.setattr(bridge_ws, "_subscriptions_table", SubscriptionTable())
    monkeypatch.setattr(
        bridge_ws,
        "_post_to_connection",
        lambda endpoint, connection_id, data: sent.append((connection_id, data)),
    )

    try:
        bridge_ws._handle_subscribe(
            {
                "sessionId": "codex:thread-1",
            },
            "app-1",
            "account-1",
            "https://example.test/v1",
        )
        assert False, "subscription write failure must propagate"
    except RuntimeError as error:
        assert str(error) == "write failed"
    assert sent == []


def test_bridge_relay_uses_consistent_subscription_read(monkeypatch):
    query_args = []

    class SubscriptionTable:
        def query(self, **kwargs):
            query_args.append(kwargs)
            return {
                "Items": [
                    {"connectionId": "app-1"},
                    {"connectionId": "app-2"},
                ],
            }

    sent = []
    monkeypatch.setattr(bridge_ws, "_subscriptions_table", SubscriptionTable())
    monkeypatch.setattr(
        bridge_ws,
        "_post_to_connection",
        lambda endpoint, connection_id, data: sent.append((connection_id, data)),
    )

    response = bridge_ws._handle_bridge_relay(
        {
            "action": "stream_delta",
            "sessionId": "codex:thread-1",
            "turnId": "turn-1",
            "seq": 2,
        },
        "bridge-1",
        "https://example.test/v1",
    )

    assert response == {"statusCode": 200}
    assert query_args[0]["ConsistentRead"] is True
    assert sent == [
        ("app-1", {
            "action": "stream_delta",
            "sessionId": "codex:thread-1",
            "turnId": "turn-1",
            "seq": 2,
        }),
        ("app-2", {
            "action": "stream_delta",
            "sessionId": "codex:thread-1",
            "turnId": "turn-1",
            "seq": 2,
        }),
    ]


def test_turn_event_validation_requires_turn_id_and_seq():
    for action in (
        "stream_turn_start",
        "stream_block_start",
        "stream_delta",
        "stream_tool_input",
        "stream_block_stop",
        "stream_end",
        "messages",
        "permission_request",
        "permission_resolved",
    ):
        valid = {
            "action": action,
            "sessionId": "codex:thread-1",
            "turnId": "turn-1",
            "seq": 0,
        }
        assert bridge_ws._requires_turn_sequence(valid)
        assert bridge_ws._has_valid_turn_sequence(valid)
        assert bridge_ws._requires_turn_sequence({**valid, "turnId": ""})
        assert not bridge_ws._has_valid_turn_sequence({**valid, "turnId": ""})
        assert not bridge_ws._has_valid_turn_sequence({**valid, "seq": None})
        assert not bridge_ws._has_valid_turn_sequence({**valid, "seq": -1})
        assert not bridge_ws._has_valid_turn_sequence({**valid, "seq": True})
        assert not bridge_ws._has_valid_turn_sequence({**valid, "seq": 1.5})
        assert not bridge_ws._has_valid_turn_sequence({**valid, "seq": "1"})

    for action in (
        "send_message_result",
        "messages_ack",
        "heartbeat",
    ):
        assert not bridge_ws._requires_turn_sequence({"action": action})


def test_permission_resolved_uses_the_shared_turn_relay(monkeypatch):
    class ConnectionTable:
        def get_item(self, Key):
            return {
                "Item": {
                    "connectionId": Key["connectionId"],
                    "role": "bridge",
                    "accountId": "account-1",
                },
            }

    relayed = []
    monkeypatch.setattr(bridge_ws, "_connections_table", ConnectionTable())
    monkeypatch.setattr(
        bridge_ws,
        "_handle_bridge_relay",
        lambda body, connection_id, endpoint: (
            relayed.append((body, connection_id, endpoint))
            or {"statusCode": 200}
        ),
    )
    body = {
        "action": "permission_resolved",
        "sessionId": "codex:thread-1",
        "turnId": "turn-1",
        "seq": 4,
        "requestId": "permission-1",
    }

    response = bridge_ws._handle_message(
        {"body": json.dumps(body)},
        "bridge-1",
        "https://example.test/v1",
    )

    assert response == {"statusCode": 200}
    assert relayed == [(body, "bridge-1", "https://example.test/v1")]


def test_reveal_permission_subscribes_before_forwarding_to_bridge(monkeypatch):
    class ConnectionTable:
        def get_item(self, Key):
            return {
                "Item": {
                    "connectionId": Key["connectionId"],
                    "role": "app",
                    "accountId": "account-1",
                },
            }

    calls = []
    monkeypatch.setattr(bridge_ws, "_connections_table", ConnectionTable())
    monkeypatch.setattr(
        bridge_ws,
        "_persist_subscription",
        lambda session_id, connection_id, account_id: calls.append(
            ("subscribe", session_id, connection_id, account_id)
        ),
    )
    monkeypatch.setattr(
        bridge_ws,
        "_handle_send_to_bridge",
        lambda body, account_id, endpoint, action: (
            calls.append(("forward", body, account_id, endpoint, action))
            or {"statusCode": 200}
        ),
    )
    body = {
        "action": "reveal_permission",
        "sessionId": "codex:thread-1",
        "device": "test-ec2-ap",
    }

    response = bridge_ws._handle_message(
        {"body": json.dumps(body)},
        "app-1",
        "https://example.test/v1",
    )

    assert response == {"statusCode": 200}
    assert calls == [
        ("subscribe", "codex:thread-1", "app-1", "account-1"),
        (
            "forward",
            body,
            "account-1",
            "https://example.test/v1",
            "reveal_permission",
        ),
    ]


def test_reveal_turn_state_subscribes_before_forwarding_to_bridge(monkeypatch):
    class ConnectionTable:
        def get_item(self, Key):
            return {
                "Item": {
                    "connectionId": Key["connectionId"],
                    "role": "app",
                    "accountId": "account-1",
                },
            }

    calls = []
    monkeypatch.setattr(bridge_ws, "_connections_table", ConnectionTable())
    monkeypatch.setattr(
        bridge_ws,
        "_persist_subscription",
        lambda session_id, connection_id, account_id: calls.append(
            ("subscribe", session_id, connection_id, account_id)
        ),
    )
    monkeypatch.setattr(
        bridge_ws,
        "_handle_send_to_bridge",
        lambda body, account_id, endpoint, action: (
            calls.append(("forward", body, account_id, endpoint, action))
            or {"statusCode": 200}
        ),
    )
    body = {
        "action": "reveal_turn_state",
        "sessionId": "codex:thread-1",
        "requestId": "state-1",
        "device": "test-ec2-ap",
    }

    response = bridge_ws._handle_message(
        {"body": json.dumps(body)},
        "app-1",
        "https://example.test/v1",
    )

    assert response == {"statusCode": 200}
    assert calls == [
        ("subscribe", "codex:thread-1", "app-1", "account-1"),
        (
            "forward",
            body,
            "account-1",
            "https://example.test/v1",
            "reveal_turn_state",
        ),
    ]


def test_list_commands_keeps_device_after_routing_to_the_bridge(monkeypatch):
    class ConnectionTable:
        def get_item(self, Key):
            return {
                "Item": {
                    "connectionId": Key["connectionId"],
                    "role": "app",
                    "accountId": "account-1",
                },
            }

    sent = []
    monkeypatch.setattr(bridge_ws, "_connections_table", ConnectionTable())
    monkeypatch.setattr(
        bridge_ws,
        "_query_connections",
        lambda account_id, role: [
            {"connectionId": "bridge-mac", "deviceName": "Mac"},
            {"connectionId": "bridge-linux", "deviceName": "Linux"},
        ] if account_id == "account-1" and role == "bridge" else [],
    )
    monkeypatch.setattr(
        bridge_ws,
        "_post_to_connection",
        lambda endpoint, connection_id, data: sent.append((connection_id, data)),
    )

    response = bridge_ws._handle_message(
        {
            "body": json.dumps({
                "action": "list_commands",
                "requestId": "commands-1",
                "runtime": "codex",
                "projectHash": "-workspace-project",
                "sessionId": "codex:thread-1",
                "device": "Mac",
                "knownRevision": "revision-1",
            }),
        },
        "app-1",
        "https://example.test/v1",
    )

    assert response == {"statusCode": 200}
    assert sent == [(
        "bridge-mac",
        {
            "action": "list_commands",
            "requestId": "commands-1",
            "runtime": "codex",
            "projectHash": "-workspace-project",
            "sessionId": "codex:thread-1",
            "device": "Mac",
            "knownRevision": "revision-1",
        },
    )]


def test_command_options_route_between_app_and_bridge(monkeypatch):
    class ConnectionTable:
        def get_item(self, Key):
            role = "bridge" if Key["connectionId"] == "bridge-mac" else "app"
            return {
                "Item": {
                    "connectionId": Key["connectionId"],
                    "role": role,
                    "accountId": "account-1",
                },
            }

    sent = []
    monkeypatch.setattr(bridge_ws, "_connections_table", ConnectionTable())
    monkeypatch.setattr(
        bridge_ws,
        "_query_connections",
        lambda account_id, role: (
            [{"connectionId": "bridge-mac", "deviceName": "Mac"}]
            if role == "bridge"
            else [{"connectionId": "app-1"}, {"connectionId": "app-2"}]
        ),
    )
    monkeypatch.setattr(
        bridge_ws,
        "_post_to_connection",
        lambda endpoint, connection_id, data: sent.append((connection_id, data)),
    )

    request = {
        "action": "list_command_options",
        "requestId": "options-1",
        "runtime": "codex",
        "projectHash": "-workspace-project",
        "sessionId": "codex:thread-1",
        "commandName": "agent",
        "device": "Mac",
    }
    response = bridge_ws._handle_message(
        {"body": json.dumps(request)},
        "app-1",
        "https://example.test/v1",
    )
    assert response == {"statusCode": 200}
    assert sent == [("bridge-mac", request)]

    sent.clear()
    result = {
        "action": "command_options",
        "requestId": "options-1",
        "runtime": "codex",
        "commandName": "agent",
        "options": [{"name": "thread-2"}],
    }
    response = bridge_ws._handle_message(
        {"body": json.dumps(result)},
        "bridge-mac",
        "https://example.test/v1",
    )
    assert response == {"statusCode": 200}
    assert sent == [("app-1", result), ("app-2", result)]


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


def test_bridge_messages_preserve_turn_sequence(monkeypatch):
    class SubscriptionTable:
        def query(self, **_):
            return {"Items": [{"connectionId": "app-1"}]}

    sent = []
    monkeypatch.setattr(bridge_ws, "_subscriptions_table", SubscriptionTable())
    monkeypatch.setattr(
        bridge_ws,
        "_post_to_connection",
        lambda endpoint, connection_id, data: sent.append((connection_id, data)),
    )

    message = {
        "uuid": "m1",
        "type": "assistant",
        "content": "answer",
        "timestamp": "2026-08-15T11:16:22.458Z",
    }
    response = bridge_ws._handle_bridge_messages(
        {
            "sessionId": "codex:test",
            "turnId": "turn-1",
            "seq": 3,
            "messages": [message],
            "noCache": True,
        },
        "bridge-1",
        "account-1",
        "https://example.test/v1",
    )

    assert response == {"statusCode": 200}
    assert sent == [
        ("app-1", {
                "action": "messages",
                "sessionId": "codex:test",
                "turnId": "turn-1",
                "seq": 3,
                "messages": [message],
        }),
        ("bridge-1", {
            "action": "messages_ack",
            "sessionId": "codex:test",
        }),
    ]


def test_bridge_message_cache_persists_only_message_fields(monkeypatch):
    class SubscriptionTable:
        def query(self, **_):
            return {"Items": []}

    messages = FakeTable()
    sent = []
    monkeypatch.setattr(bridge_ws, "_subscriptions_table", SubscriptionTable())
    monkeypatch.setattr(bridge_ws, "_messages_table", messages)
    monkeypatch.setattr(
        bridge_ws,
        "_post_to_connection",
        lambda endpoint, connection_id, data: sent.append((connection_id, data)),
    )

    response = bridge_ws._handle_bridge_messages(
        {
            "sessionId": "codex:test",
            "messages": [{
                "uuid": "m1",
                "nativeId": "codex:user:client-1",
                "type": "user",
                "content": "hello",
                "timestamp": "2026-08-12T00:00:00.000Z",
                "transient": "not-persisted",
            }],
        },
        "bridge-1",
        "account-1",
        "https://example.test/v1",
    )

    assert response == {"statusCode": 200}
    assert messages.items[0]["nativeId"] == "codex:user:client-1"
    assert "transient" not in messages.items[0]
    assert sent == [(
        "bridge-1",
        {"action": "messages_ack", "sessionId": "codex:test"},
    )]


def test_bridge_messages_echoes_delivery_id_only_to_bridge_ack(monkeypatch):
    class SubscriptionTable:
        def query(self, **_):
            return {"Items": [{"connectionId": "app-1"}]}

    sent = []
    monkeypatch.setattr(bridge_ws, "_subscriptions_table", SubscriptionTable())
    monkeypatch.setattr(bridge_ws, "_messages_table", FakeTable())
    monkeypatch.setattr(
        bridge_ws,
        "_post_to_connection",
        lambda endpoint, connection_id, data: sent.append((connection_id, data)),
    )

    response = bridge_ws._handle_bridge_messages(
        {
            "sessionId": "codex:test",
            "deliveryId": "delivery-1",
            "messages": [{
                "uuid": "m1",
                "type": "assistant",
                "content": "hello",
                "timestamp": "2026-08-12T00:00:00.000Z",
            }],
        },
        "bridge-1",
        "account-1",
        "https://example.test/v1",
    )

    assert response == {"statusCode": 200}
    assert sent == [
        ("app-1", {
            "action": "messages",
            "sessionId": "codex:test",
            "messages": [{
                "uuid": "m1",
                "type": "assistant",
                "content": "hello",
                "timestamp": "2026-08-12T00:00:00.000Z",
            }],
        }),
        ("bridge-1", {
            "action": "messages_ack",
            "sessionId": "codex:test",
            "deliveryId": "delivery-1",
        }),
    ]
