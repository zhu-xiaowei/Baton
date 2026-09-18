import asyncio
import os
import sys

import boto3
import pytest
from moto import mock_aws

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "server", "src"))
import bridge_read
import bridge_sync
from test_bridge_list_pagination import FakeRequest


@pytest.fixture
def metadata_table(monkeypatch):
    with mock_aws():
        table = boto3.resource("dynamodb", region_name="us-east-1").create_table(
            TableName="metadata-preservation",
            KeySchema=[
                {"AttributeName": "accountId", "KeyType": "HASH"},
                {"AttributeName": "sk", "KeyType": "RANGE"},
            ],
            AttributeDefinitions=[
                {"AttributeName": name, "AttributeType": "S"}
                for name in ("accountId", "sk", "listPk", "listSk")
            ],
            GlobalSecondaryIndexes=[{
                "IndexName": bridge_read.LIST_INDEX_NAME,
                "KeySchema": [
                    {"AttributeName": "listPk", "KeyType": "HASH"},
                    {"AttributeName": "listSk", "KeyType": "RANGE"},
                ],
                "Projection": {"ProjectionType": "ALL"},
            }],
            BillingMode="PAY_PER_REQUEST",
        )
        monkeypatch.setattr(bridge_sync, "_tables", lambda: (table, None))
        monkeypatch.setattr(bridge_read, "_tables", lambda: (table, None))
        monkeypatch.delenv("WS_API_ENDPOINT", raising=False)
        yield table


def sync_metadata(**fields):
    return asyncio.run(bridge_sync.sync_sessions(
        bridge_sync.SyncSessionsRequest(deviceName="Mac", sessions=[{
            "id": "root",
            "runtime": "codex",
            "project": "repo",
            "lastActive": "2026-09-16T00:00:00Z",
            **fields,
        }]),
        FakeRequest(),
    ))


def stored_session(table, session_id="codex:root"):
    return table.get_item(Key={
        "accountId": bridge_read._account_id(FakeRequest()),
        "sk": f"SESS#Mac#repo#{session_id}",
    }, ConsistentRead=True)["Item"]


@pytest.mark.parametrize("older", [{"statusVersion": 10}, {}])
def test_old_status_writes_cannot_hide_native_active_sessions(metadata_table, older):
    sync_metadata(status="running", statusVersion=20)
    sync_metadata(status="completed", preview="Renamed", **older)
    result = asyncio.run(bridge_read.get_sessions(FakeRequest(), "Mac", "repo", 10, None))
    assert result["sessions"][0]["status"] == "running"
    assert result["sessions"][0]["preview"] == "Renamed"


def test_newer_native_completion_clears_active_status(metadata_table):
    sync_metadata(status="running", statusVersion=20)
    sync_metadata(status="completed", statusVersion=21)
    result = asyncio.run(bridge_read.get_sessions(FakeRequest(), "Mac", "repo", 10, None))
    assert result["sessions"][0]["status"] == "completed"


def test_reconcile_repairs_a_completed_tree_with_stale_running_summary(metadata_table):
    sync_metadata(status="completed", agentCount=11, runningAgentCount=11)
    for i in range(11):
        sync_metadata(id=f"child-{i}", status="completed", parentSessionId="codex:root", threadKind="subagent")
    before = asyncio.run(bridge_read.get_sessions(FakeRequest(), "Mac", "repo", 10, None))
    assert before["sessions"][0]["status"] == "running"
    asyncio.run(bridge_sync.reconcile(bridge_sync.ReconcileRequest(deviceName="Mac"), FakeRequest()))
    after = asyncio.run(bridge_read.get_sessions(FakeRequest(), "Mac", "repo", 10, None))
    assert after["sessions"][0]["status"] == "completed"


def test_stale_summary_uploads_cannot_resurrect_finished_agents(metadata_table):
    sync_metadata(status="completed", agentCount=1, runningAgentCount=0, agentSummaryVersion=30)
    sync_metadata(runningAgentCount=1, agentSummaryVersion=20)
    asyncio.run(bridge_sync.sync_sessions(bridge_sync.SyncSessionsRequest(
        deviceName="Mac", sessions=[], agentCountUpdates=[{
            "sessionId": "codex:root", "project": "repo",
            "agentCount": 1, "runningAgentCount": 1, "agentSummaryVersion": 20,
        }],
    ), FakeRequest()))
    result = asyncio.run(bridge_read.get_sessions(FakeRequest(), "Mac", "repo", 10, None))
    assert result["sessions"][0]["status"] == "completed"


@pytest.mark.parametrize("runtime", ["codex", "claude"])
@pytest.mark.parametrize("status", ["running", "needs_input"])
def test_omitted_status_preserves_source_and_list_status(metadata_table, runtime, status):
    sync_metadata(runtime=runtime, status=status)
    sync_metadata(runtime=runtime, preview="Updated title")

    session_id = "codex:root" if runtime == "codex" else "root"
    stored = stored_session(metadata_table, session_id)
    assert stored["status"] == status
    assert stored["activeStatus"] == status
    assert stored["preview"] == "Updated title"
    result = asyncio.run(bridge_read.get_sessions(FakeRequest(), "Mac", "repo", 10, None))
    assert result["sessions"][0]["status"] == status


@pytest.mark.parametrize("archived", [False, True])
def test_omitted_parent_keeps_child_out_of_root_indexes(metadata_table, archived):
    sync_metadata(status="running")
    sync_metadata(
        id="child", status="running", parentSessionId="codex:root",
        threadKind="internal", threadRootId="codex:root",
        agentPath="root/child", agentDepth=2, canSend=False,
    )
    archive_state = "archived" if archived else "unarchived"
    asyncio.run(bridge_sync.sync_archives(bridge_sync.SyncArchivesRequest(
        deviceName="Mac", observations=[{
            "sessionId": "codex:child", "projectHash": "repo",
            "archiveState": archive_state, "archiveVersion": 2,
        }],
    ), FakeRequest()))

    sync_metadata(id="child", preview="Updated child title")

    stored = stored_session(metadata_table, "codex:child")
    assert stored["parentSessionId"] == "codex:root"
    assert stored["threadKind"] == "internal"
    assert stored["threadRootId"] == "codex:root"
    assert stored["agentPath"] == "root/child"
    assert stored["agentDepth"] == 2
    assert stored["canSend"] is False
    assert stored["status"] == "running"
    assert stored["archiveState"] == archive_state
    assert stored["archiveVersion"] == 2
    assert not {"listPk", "listSk", "activeStatus"}.intersection(stored)
    for limit in (None, 10):
        normal = asyncio.run(bridge_read.get_sessions(FakeRequest(), "Mac", "repo", limit, None))
        archives = asyncio.run(bridge_read.get_sessions(FakeRequest(), "Mac", "repo", limit, None, True))
        assert [row["sessionId"] for row in normal["sessions"]] == ["codex:root"]
        assert archives["sessions"] == []


@pytest.mark.parametrize("change", ["status", "parent", "agent_summary"])
def test_metadata_retries_when_derived_inputs_change(metadata_table, monkeypatch, change):
    sync_metadata(status="completed", runningAgentCount=0)
    original_update = metadata_table.update_item
    metadata_writes = []

    def interleave(**kwargs):
        metadata_writes.append(kwargs)
        if len(metadata_writes) == 1:
            if change == "status":
                original_update(
                    Key=kwargs["Key"],
                    UpdateExpression="SET #status = :status, activeStatus = :status",
                    ExpressionAttributeNames={"#status": "status"},
                    ExpressionAttributeValues={":status": "running"},
                )
            elif change == "parent":
                original_update(
                    Key=kwargs["Key"],
                    UpdateExpression=(
                        "SET parentSessionId = :parent, threadKind = :kind "
                        "REMOVE listPk, listSk, activeStatus"
                    ),
                    ExpressionAttributeValues={":parent": "codex:parent", ":kind": "subagent"},
                )
            else:
                original_update(
                    Key=kwargs["Key"],
                    UpdateExpression="SET runningAgentCount = :count, activeStatus = :active",
                    ExpressionAttributeValues={":count": 1, ":active": "running"},
                )
        return original_update(**kwargs)

    monkeypatch.setattr(metadata_table, "update_item", interleave)
    sync_metadata(preview="Concurrent title update")

    stored = stored_session(metadata_table)
    assert stored["preview"] == "Concurrent title update"
    if change == "parent":
        assert stored["parentSessionId"] == "codex:parent"
        assert not {"listPk", "listSk", "activeStatus"}.intersection(stored)
    else:
        assert stored["activeStatus"] == "running"
        if change == "status":
            assert stored["status"] == "running"
        else:
            assert stored["status"] == "completed"
            assert stored["runningAgentCount"] == 1
    assert len(metadata_writes) == 2


def test_explicit_parent_clear_and_status_replace_preserved_values(metadata_table):
    sync_metadata(status="running")
    sync_metadata(
        id="child", status="running", parentSessionId="codex:root",
        threadKind="subagent", threadRootId="codex:root",
        agentPath="root/child", agentDepth=1,
    )

    sync_metadata(
        id="child", parentSessionId="", status="completed",
        threadRootId="codex:child", lastActive="2026-09-16T01:00:00Z",
    )

    stored = stored_session(metadata_table, "codex:child")
    assert not {"parentSessionId", "threadKind", "agentPath", "agentDepth"}.intersection(stored)
    assert stored["status"] == "completed"
    assert stored["activeStatus"] == "done#2026-09-16T01:00:00Z"
    assert stored["listSk"] == "2026-09-16T01:00:00Z#codex:child"
    assert stored["threadRootId"] == "codex:child"
    result = asyncio.run(bridge_read.get_sessions(FakeRequest(), "Mac", "repo", 10, None))
    assert [row["sessionId"] for row in result["sessions"]] == ["codex:child", "codex:root"]


def test_new_session_defaults_and_omitted_completed_status_update_indexes(metadata_table):
    sync_metadata()
    stored = stored_session(metadata_table)
    assert stored["status"] == "completed"
    assert stored["activeStatus"] == "done#2026-09-16T00:00:00Z"

    sync_metadata(lastActive="2026-09-16T01:00:00Z")
    stored = stored_session(metadata_table)
    assert stored["status"] == "completed"
    assert stored["activeStatus"] == "done#2026-09-16T01:00:00Z"
    assert stored["listSk"] == "2026-09-16T01:00:00Z#codex:root"


def test_concurrent_archive_observation_survives_metadata_without_retry(metadata_table, monkeypatch):
    sync_metadata(status="running")
    original_update = metadata_table.update_item
    metadata_writes = []

    def interleave_archive(**kwargs):
        metadata_writes.append(kwargs)
        if len(metadata_writes) == 1:
            original_update(
                Key=kwargs["Key"],
                UpdateExpression="SET archiveState = :state, archiveVersion = :version",
                ExpressionAttributeValues={":state": "archived", ":version": 42},
            )
        return original_update(**kwargs)

    monkeypatch.setattr(metadata_table, "update_item", interleave_archive)
    sync_metadata(preview="Updated during archive")

    stored = stored_session(metadata_table)
    assert stored["preview"] == "Updated during archive"
    assert stored["status"] == stored["activeStatus"] == "running"
    assert stored["archiveState"] == "archived"
    assert stored["archiveVersion"] == 42
    assert len(metadata_writes) == 1


def test_continuous_metadata_contention_returns_retryable_error(metadata_table, monkeypatch):
    sync_metadata(status="completed", preview="Original title")
    original_update = metadata_table.update_item
    attempts = []

    def interleave_every_attempt(**kwargs):
        attempts.append(kwargs)
        status = "running" if len(attempts) % 2 else "completed"
        active = status if status == "running" else "done#2026-09-16T00:00:00Z"
        original_update(
            Key=kwargs["Key"],
            UpdateExpression="SET #status = :status, activeStatus = :active",
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={":status": status, ":active": active},
        )
        return original_update(**kwargs)

    monkeypatch.setattr(metadata_table, "update_item", interleave_every_attempt)
    with pytest.raises(bridge_sync.HTTPException) as error:
        sync_metadata(preview="Must not overwrite a conflicting row")

    assert error.value.status_code == 409
    assert len(attempts) == 3
    stored = stored_session(metadata_table)
    assert stored["preview"] == "Original title"
    assert stored["status"] == stored["activeStatus"] == "running"
