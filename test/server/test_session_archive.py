import asyncio
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "server", "src"))
import bridge_read
import bridge_sync
import bridge_ws
from test_bridge_list_pagination import FakeListTable, FakeRequest, session_item


@pytest.fixture
def archive_table(monkeypatch):
    import boto3
    from moto import mock_aws

    with mock_aws():
        table = boto3.resource("dynamodb", region_name="us-east-1").create_table(
            TableName="sessions",
            KeySchema=[{"AttributeName": "accountId", "KeyType": "HASH"}, {"AttributeName": "sk", "KeyType": "RANGE"}],
            AttributeDefinitions=[{"AttributeName": "accountId", "AttributeType": "S"}, {"AttributeName": "sk", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        monkeypatch.setattr(bridge_sync, "_tables", lambda: (table, None))
        monkeypatch.setattr(bridge_read, "_tables", lambda: (table, None))
        monkeypatch.delenv("WS_API_ENDPOINT", raising=False)
        yield table


def archive_row(session_id, state="unarchived", version=1, **fields):
    return {
        **session_item(
            bridge_read._account_id(FakeRequest()), "Mac", "repo",
            session_id, "2026-09-16T00:00:00Z",
        ),
        "runtime": "codex", "archiveState": state, "archiveVersion": version,
        **fields,
    }


def observe_archive(state, version, session_id="codex:root"):
    return asyncio.run(bridge_sync.sync_archives(bridge_sync.SyncArchivesRequest(
        deviceName="Mac", observations=[{
            "sessionId": session_id, "projectHash": "repo",
            "archiveState": state, "archiveVersion": version,
        }],
    ), FakeRequest()))


def test_archive_filter_fills_pages_and_binds_cursor(monkeypatch):
    account = bridge_read._account_id(FakeRequest())
    rows = []
    for i in range(8):
        item = session_item(account, "Mac", "repo", f"codex:s{i}", f"2026-09-16T00:0{i}:00Z")
        item.update(runtime="codex", archiveState="archived" if i in (7, 6, 4, 2) else "unarchived")
        rows.append(item)
    table = FakeListTable(rows)
    monkeypatch.setattr(bridge_read, "_tables", lambda: (table, None))
    first = asyncio.run(bridge_read.get_sessions(FakeRequest(), "Mac", "repo", 2, None, archived=False))
    assert [row["sessionId"] for row in first["sessions"]] == ["codex:s5", "codex:s3"]
    second = asyncio.run(bridge_read.get_sessions(FakeRequest(), "Mac", "repo", 2, first["nextCursor"], archived=False))
    assert [row["sessionId"] for row in second["sessions"]] == ["codex:s1", "codex:s0"]
    archived = asyncio.run(bridge_read.get_sessions(FakeRequest(), "Mac", "repo", 2, None, archived=True))
    assert [row["sessionId"] for row in archived["sessions"]] == ["codex:s7", "codex:s6"]
    with pytest.raises(bridge_read.HTTPException):
        asyncio.run(bridge_read.get_sessions(FakeRequest(), "Mac", "repo", 2, first["nextCursor"], archived=True))


def test_native_observations_survive_metadata_sync_and_ignore_older_versions(monkeypatch):
    import boto3
    from moto import mock_aws

    with mock_aws():
        table = boto3.resource("dynamodb", region_name="us-east-1").create_table(
            TableName="sessions",
            KeySchema=[{"AttributeName": "accountId", "KeyType": "HASH"}, {"AttributeName": "sk", "KeyType": "RANGE"}],
            AttributeDefinitions=[{"AttributeName": "accountId", "AttributeType": "S"}, {"AttributeName": "sk", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        monkeypatch.setattr(bridge_sync, "_tables", lambda: (table, None))
        monkeypatch.setattr(bridge_read, "_tables", lambda: (table, None))
        monkeypatch.delenv("WS_API_ENDPOINT", raising=False)
        metadata = dict(id="id", runtime="codex", project="repo", lastActive="2026-09-16T00:00:00Z", preview="A session")
        asyncio.run(bridge_sync.sync_sessions(bridge_sync.SyncSessionsRequest(deviceName="Mac", sessions=[metadata]), FakeRequest()))

        def observe(state, version):
            return asyncio.run(bridge_sync.sync_archives(bridge_sync.SyncArchivesRequest(
                deviceName="Mac", observations=[dict(sessionId="codex:id", projectHash="repo", archiveState=state, archiveVersion=version)],
            ), FakeRequest()))

        observe("archived", 2)
        metadata["status"] = "running"
        asyncio.run(bridge_sync.sync_sessions(bridge_sync.SyncSessionsRequest(deviceName="Mac", sessions=[metadata]), FakeRequest()))
        observe("unarchived", 1)
        result = asyncio.run(bridge_read.get_sessions(FakeRequest(), "Mac", "repo", None, None, archived=True))
        assert len(result["sessions"]) == 1
        assert result["sessions"][0]["canSend"] is False
        counts = bridge_sync._reconcile_device(table, bridge_read._account_id(FakeRequest()), "Mac", "")
        assert counts["sessionCount"] == 0
        assert counts["projectCount"] == 1
        observe("unarchived", 3)
        result = asyncio.run(bridge_read.get_sessions(FakeRequest(), "Mac", "repo", None, None))
        assert result["sessions"][0]["canSend"] is True


@pytest.mark.parametrize("index_has_root", [False, True])
def test_thread_fallback_uses_current_root_archive_state(monkeypatch, index_has_root):
    root = archive_row("codex:root", "archived", version=2, agentCount=1)
    child = archive_row("codex:child", parentSessionId="codex:root", threadKind="subagent")
    stale_root = {**root, "archiveState": "unarchived", "archiveVersion": 1}
    monkeypatch.setattr(bridge_read, "_tables", lambda: (object(), None))
    monkeypatch.setattr(
        bridge_read, "_query_all",
        lambda *_args, **kwargs: (
            [stale_root] if index_has_root else []
        ) if kwargs.get("IndexName") else [root, child],
    )

    result = asyncio.run(bridge_read.get_session_threads(FakeRequest(), "Mac", "repo", "codex:root"))
    actual_child = next(row for row in result["threads"] if row["sessionId"] == "codex:child")
    assert actual_child["archiveState"] == "unarchived"
    assert actual_child["rootArchiveState"] == "archived"
    assert actual_child["rootArchiveVersion"] == 2
    assert actual_child["canSend"] is False


def test_threads_block_archived_intermediate_ancestors(monkeypatch):
    root = archive_row("codex:root", agentCount=2)
    child = archive_row("codex:child", "archived", parentSessionId="codex:root", threadKind="subagent")
    grandchild = archive_row("codex:grandchild", parentSessionId="codex:child", threadKind="subagent")
    monkeypatch.setattr(bridge_read, "_tables", lambda: (object(), None))
    monkeypatch.setattr(bridge_read, "_query_all", lambda *_args, **_kwargs: [root, child, grandchild])

    threads = asyncio.run(bridge_read.get_session_threads(FakeRequest(), "Mac", "repo", "codex:root"))["threads"]
    assert threads[0]["canSend"] is True
    assert threads[1]["canSend"] is False
    assert threads[2]["canSend"] is False
    assert threads[2]["rootArchiveState"] == "unarchived"


@pytest.mark.parametrize("index_has_child", [False, True])
def test_thread_deep_link_resolves_actual_root(archive_table, monkeypatch, index_has_child):
    root = archive_row("codex:root", "archived", version=4)
    child = archive_row("codex:child", parentSessionId="codex:root", threadKind="subagent")
    archive_table.put_item(Item=root)
    archive_table.put_item(Item=child)
    monkeypatch.setattr(
        bridge_read, "_query_all",
        lambda *_args, **kwargs: (
            [child] if index_has_child else []
        ) if kwargs.get("IndexName") else [root, child],
    )

    result = asyncio.run(bridge_read.get_session_threads(FakeRequest(), "Mac", "repo", "codex:child"))
    assert result["rootSessionId"] == "codex:root"
    assert result["threads"][0]["rootSessionId"] == "codex:root"
    assert result["threads"][0]["rootArchiveState"] == "archived"
    assert result["threads"][0]["rootArchiveVersion"] == 4
    assert result["threads"][0]["archiveState"] == "unarchived"
    assert result["threads"][0]["canSend"] is False


def test_message_metadata_returns_actual_root_not_nearest_archived_parent(archive_table):
    root = archive_row("codex:root", "unarchived", version=4)
    child = archive_row("codex:child", "archived", version=3, parentSessionId="codex:root", threadKind="subagent")
    grandchild = archive_row("codex:grandchild", parentSessionId="codex:child", threadKind="subagent")
    for row in (root, child, grandchild):
        archive_table.put_item(Item=row)

    metadata = bridge_read._message_session_metadata(FakeRequest(), archive_table, "codex:grandchild", "Mac", "repo")
    assert metadata["rootSessionId"] == "codex:root"
    assert metadata["rootArchiveState"] == "unarchived"
    assert metadata["rootArchiveVersion"] == 4
    assert metadata["archiveState"] == "unarchived"
    assert metadata["canSend"] is False


@pytest.mark.parametrize("parent", ["codex:missing", "codex:child"])
def test_missing_or_cyclic_parent_is_read_only_without_inventing_root(archive_table, parent):
    archive_table.put_item(Item=archive_row("codex:child", parentSessionId=parent, threadKind="subagent"))
    metadata = bridge_read._message_session_metadata(FakeRequest(), archive_table, "codex:child", "Mac", "repo")
    assert metadata["archiveState"] == "unarchived"
    assert metadata["rootSessionId"] == ""
    assert metadata["rootArchiveState"] == "unknown"
    assert metadata["canSend"] is False


def test_same_version_conflicting_observation_is_not_acknowledged_or_broadcast(archive_table, monkeypatch):
    archive_table.put_item(Item=archive_row("codex:root", "archived", version=2))
    broadcasts = []
    monkeypatch.setenv("WS_API_ENDPOINT", "https://example.test")
    monkeypatch.setattr(bridge_ws, "notify_session_archives_changed", lambda *args: broadcasts.extend(args[-1]))

    with pytest.raises(bridge_sync.HTTPException) as error:
        observe_archive("unarchived", 2)
    assert error.value.status_code == 409
    assert broadcasts == []
    stored = archive_table.get_item(Key={
        "accountId": bridge_read._account_id(FakeRequest()), "sk": "SESS#Mac#repo#codex:root",
    })["Item"]
    assert stored["archiveState"] == "archived"
    assert stored["archiveVersion"] == 2


def test_exact_retry_rebroadcasts_only_persisted_state(archive_table, monkeypatch):
    archive_table.put_item(Item=archive_row("codex:root", "archived", version=2))
    broadcasts = []
    monkeypatch.setenv("WS_API_ENDPOINT", "https://example.test")
    monkeypatch.setattr(bridge_ws, "notify_session_archives_changed", lambda *args: broadcasts.extend(args[-1]))

    acknowledged = [{
        "sessionId": "codex:root", "projectHash": "repo",
        "archiveState": "archived", "archiveVersion": 2,
    }]
    assert observe_archive("archived", 2) == {"synced": 1, "acknowledged": acknowledged, "ignored": []}
    assert broadcasts == acknowledged


def test_new_observation_acknowledges_its_exact_persisted_version(archive_table):
    archive_table.put_item(Item=archive_row("codex:root"))
    result = observe_archive("archived", 2)
    assert result == {
        "synced": 1,
        "acknowledged": [{
            "sessionId": "codex:root", "projectHash": "repo",
            "archiveState": "archived", "archiveVersion": 2,
        }],
        "ignored": [],
    }


def test_stale_observation_reports_current_state_without_acknowledging_it(archive_table, monkeypatch):
    archive_table.put_item(Item=archive_row("codex:root", "unarchived", version=3))
    broadcasts = []
    monkeypatch.setenv("WS_API_ENDPOINT", "https://example.test")
    monkeypatch.setattr(bridge_ws, "notify_session_archives_changed", lambda *args: broadcasts.extend(args[-1]))

    assert observe_archive("archived", 2) == {
        "synced": 0,
        "acknowledged": [],
        "ignored": [{
            "sessionId": "codex:root", "projectHash": "repo",
            "archiveState": "archived", "archiveVersion": 2, "reason": "stale",
            "currentArchiveState": "unarchived", "currentArchiveVersion": 3,
        }],
    }
    assert broadcasts == []


@pytest.mark.parametrize("field,value", [
    ("accountId", "another-account"),
    ("deviceName", "Other"),
    ("projectHash", "other-project"),
])
def test_observations_cannot_update_out_of_scope_rows(archive_table, field, value):
    row = archive_row("codex:root")
    row[field] = value
    row["sk"] = f"SESS#{row['deviceName']}#{row['projectHash']}#{row['sessionId']}"
    archive_table.put_item(Item=row)

    with pytest.raises(bridge_sync.HTTPException) as error:
        observe_archive("archived", 2)
    assert error.value.status_code == 409
    stored = archive_table.get_item(Key={key: row[key] for key in ("accountId", "sk")})["Item"]
    assert stored["archiveState"] == "unarchived"


@pytest.fixture
def archive_ws(monkeypatch):
    account = bridge_read._account_id(FakeRequest())
    rows = {
        "app": {"role": "app", "accountId": account},
        "other-app": {"role": "app", "accountId": "another-account"},
        "bridge": {"role": "bridge", "accountId": account, "deviceName": "Mac"},
        "other-device": {"role": "bridge", "accountId": account, "deviceName": "Other"},
        "foreign-bridge": {"role": "bridge", "accountId": "another-account", "deviceName": "Mac"},
    }
    for connection_id, row in rows.items():
        row["connectionId"] = connection_id

    class Connections:
        def get_item(self, Key, **_kwargs):
            row = rows.get(Key["connectionId"])
            return {"Item": row} if row else {}

    delivered = []
    monkeypatch.setattr(bridge_ws, "_init", lambda: None)
    monkeypatch.setattr(bridge_ws, "_connections_table", Connections())
    monkeypatch.setattr(
        bridge_ws, "_query_connections",
        lambda account_id, role: [
            row for row in rows.values() if row["accountId"] == account_id and row["role"] == role
        ],
    )
    monkeypatch.setattr(
        bridge_ws, "_post_to_connection",
        lambda _endpoint, connection_id, payload: delivered.append((connection_id, payload)) or True,
    )

    def send(body, connection_id="app"):
        return bridge_ws._handle_message({"body": json.dumps(body)}, connection_id, "https://example.test")

    return send, delivered, rows


def test_archive_requests_route_only_to_selected_account_device(archive_ws):
    send, delivered, _rows = archive_ws
    body = {
        "action": "set_session_archive", "device": "Mac", "projectHash": "repo",
        "requestId": "request-1", "archived": True,
        "sessionIds": ["codex:root", "codex:root"],
        "replyConnectionId": "other-app",
    }
    assert send(body) == {"statusCode": 200}
    assert delivered == [("bridge", {
        **body, "sessionIds": ["codex:root"], "replyConnectionId": "app",
    })]


@pytest.mark.parametrize("connection_id,target,device", [
    ("bridge", "other-app", "Mac"),
    ("bridge", "other-device", "Mac"),
    ("bridge", "app", "Other"),
    ("app", "app", "Mac"),
    ("foreign-bridge", "app", "Mac"),
])
def test_archive_results_reject_wrong_account_role_or_device(archive_ws, connection_id, target, device):
    send, delivered, _rows = archive_ws
    send({
        "action": "set_session_archive_result", "replyConnectionId": target,
        "deviceName": device, "requestId": "request-1", "results": [],
    }, connection_id)
    assert delivered == []


def test_archive_result_is_scoped_to_its_requesting_app(archive_ws):
    send, delivered, _rows = archive_ws
    result = {
        "action": "set_session_archive_result", "deviceName": "Mac",
        "requestId": "request-1", "results": [{"sessionId": "codex:root", "ok": True}],
    }
    assert send({**result, "replyConnectionId": "app"}, "bridge") == {"statusCode": 200}
    assert delivered == [("app", result)]


def test_duplicate_device_connections_do_not_execute_archive(archive_ws):
    send, delivered, rows = archive_ws
    rows["duplicate"] = {**rows["bridge"], "connectionId": "duplicate"}
    send({
        "action": "set_session_archive", "device": "Mac", "projectHash": "repo",
        "requestId": "request-1", "archived": True, "sessionIds": ["codex:root"],
    })
    assert len(delivered) == 1
    assert delivered[0][0] == "app"
    assert delivered[0][1]["results"][0]["errorCode"] == "bridge_offline"


def test_archive_notifications_are_account_scoped_and_batched(archive_ws):
    _send, delivered, rows = archive_ws
    changes = [{"sessionId": f"codex:s{i}", "archiveState": "archived", "archiveVersion": 2} for i in range(51)]
    bridge_ws.notify_session_archives_changed(rows["app"]["accountId"], "https://example.test", "Mac", changes)
    assert [len(payload["changes"]) for _connection, payload in delivered] == [25, 25, 1]
    assert all(connection == "app" for connection, _payload in delivered)
