import asyncio
import importlib.util
import json
import os
import sys

import pytest
from fastapi import HTTPException

sys.path.insert(
    0,
    os.path.join(os.path.dirname(__file__), "..", "..", "server", "src"),
)

import bridge_read
import bridge_sync


class FakeRequest:
    headers = {"x-api-key": "test-key"}


class FakeListTable:
    def __init__(self, items):
        self.items = items
        self.query_calls = []

    def query(self, **kwargs):
        self.query_calls.append(kwargs)
        assert kwargs["IndexName"] == bridge_read.LIST_INDEX_NAME
        expression = kwargs["KeyConditionExpression"].get_expression()
        list_pk = expression["values"][1]
        rows = sorted(
            (item for item in self.items if item.get("listPk") == list_pk),
            key=lambda item: item["listSk"],
            reverse=not kwargs.get("ScanIndexForward", True),
        )

        start = 0
        cursor = kwargs.get("ExclusiveStartKey")
        if cursor:
            start = next(i for i, item in enumerate(rows) if item["sk"] == cursor["sk"]) + 1
        limit = kwargs["Limit"]
        page = rows[start:start + limit]
        response = {"Items": page}
        if start + limit < len(rows):
            last = page[-1]
            response["LastEvaluatedKey"] = {
                name: last[name] for name in ("accountId", "sk", "listPk", "listSk")
            }
        return response


class FakeBatch:
    def __init__(self, table):
        self.table = table

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def put_item(self, Item):
        self.table.items.append(Item)


class FakeWriteTable:
    def __init__(self):
        self.items = []
        self.updates = []

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

    def update_item(self, **kwargs):
        self.updates.append(kwargs)


def session_item(account_id, device, project, session_id, last_active):
    return {
        "accountId": account_id,
        "sk": f"SESS#{device}#{project}#{session_id}",
        "entityType": "session",
        "deviceName": device,
        "projectHash": project,
        "sessionId": session_id,
        "lastActive": last_active,
        "listPk": bridge_sync._session_list_pk(account_id, device, project),
        "listSk": bridge_sync._list_sk(last_active, session_id),
    }


def project_item(account_id, device, project, last_active):
    return {
        "accountId": account_id,
        "sk": f"PROJ#{device}#{project}",
        "entityType": "project",
        "deviceName": device,
        "projectHash": project,
        "projectName": f"/workspace/{project}",
        "sessionCount": 1,
        "lastActive": last_active,
        "listPk": bridge_sync._project_list_pk(account_id, device),
        "listSk": bridge_sync._list_sk(last_active, project),
    }


def test_session_pages_are_newest_first_without_duplicates(monkeypatch):
    account_id = bridge_read._account_id(FakeRequest())
    items = [
        session_item(account_id, "Mac", "repo", f"s{i}", f"2026-08-10T00:0{i}:00.000Z")
        for i in range(1, 6)
    ]
    items.extend([
        session_item(account_id, "Mac", "other", "other", "2026-08-10T01:00:00.000Z"),
        session_item("other-account", "Mac", "repo", "foreign", "2026-08-10T01:00:00.000Z"),
    ])
    table = FakeListTable(items)
    monkeypatch.setattr(bridge_read, "_tables", lambda: (table, None))

    first = asyncio.run(bridge_read.get_sessions(FakeRequest(), "Mac", "repo", 2, None))
    second = asyncio.run(
        bridge_read.get_sessions(FakeRequest(), "Mac", "repo", 2, first["nextCursor"])
    )
    third = asyncio.run(
        bridge_read.get_sessions(FakeRequest(), "Mac", "repo", 2, second["nextCursor"])
    )

    assert [item["sessionId"] for item in first["sessions"]] == ["s5", "s4"]
    assert [item["sessionId"] for item in second["sessions"]] == ["s3", "s2"]
    assert [item["sessionId"] for item in third["sessions"]] == ["s1"]
    assert first["hasMore"] is True
    assert second["hasMore"] is True
    assert third == {"sessions": third["sessions"], "hasMore": False, "nextCursor": None}


def test_equal_timestamps_have_stable_cursor_order(monkeypatch):
    account_id = bridge_read._account_id(FakeRequest())
    timestamp = "2026-08-10T00:00:00.000Z"
    table = FakeListTable([
        session_item(account_id, "Mac", "repo", session_id, timestamp)
        for session_id in ("a", "b", "c")
    ])
    monkeypatch.setattr(bridge_read, "_tables", lambda: (table, None))

    first = asyncio.run(bridge_read.get_sessions(FakeRequest(), "Mac", "repo", 2, None))
    second = asyncio.run(
        bridge_read.get_sessions(FakeRequest(), "Mac", "repo", 2, first["nextCursor"])
    )

    assert [item["sessionId"] for item in first["sessions"]] == ["c", "b"]
    assert [item["sessionId"] for item in second["sessions"]] == ["a"]


def test_projects_use_the_same_pagination_index(monkeypatch):
    account_id = bridge_read._account_id(FakeRequest())
    table = FakeListTable([
        project_item(account_id, "Mac", "old", "2026-08-08T00:00:00.000Z"),
        project_item(account_id, "Mac", "new", "2026-08-10T00:00:00.000Z"),
        project_item(account_id, "Other", "foreign", "2026-08-11T00:00:00.000Z"),
    ])
    monkeypatch.setattr(bridge_read, "_tables", lambda: (table, None))
    monkeypatch.setattr(
        bridge_read,
        "_live_active_counts",
        lambda *_: ({}, {("Mac", "new"): {"running": 1, "needs_input": 0}}),
    )

    first = asyncio.run(bridge_read.get_projects(FakeRequest(), "Mac", 1, None))
    second = asyncio.run(
        bridge_read.get_projects(FakeRequest(), "Mac", 1, first["nextCursor"])
    )

    assert [item["projectHash"] for item in first["projects"]] == ["new"]
    assert first["projects"][0]["runningCount"] == 1
    assert [item["projectHash"] for item in second["projects"]] == ["old"]
    assert second["hasMore"] is False


def test_legacy_sessions_request_keeps_full_response_shape(monkeypatch):
    account_id = bridge_read._account_id(FakeRequest())
    items = [
        session_item(account_id, "Mac", "repo", "old", "2026-08-08T00:00:00.000Z"),
        session_item(account_id, "Mac", "repo", "new", "2026-08-10T00:00:00.000Z"),
    ]
    items[1]["status"] = "needs_input"
    items[1]["agentDetail"] = "Choose environment"
    items[1]["agentCount"] = 3
    monkeypatch.setattr(bridge_read, "_tables", lambda: (object(), None))
    monkeypatch.setattr(bridge_read, "_query_all", lambda *_args, **_kwargs: items)

    result = asyncio.run(bridge_read.get_sessions(FakeRequest(), "Mac", "repo", None, None))

    assert list(result) == ["sessions"]
    assert [item["sessionId"] for item in result["sessions"]] == ["new", "old"]
    assert result["sessions"][0]["agentDetail"] == "Choose environment"
    assert result["sessions"][0]["agentCount"] == 3


def test_cursor_is_bound_to_account_and_list(monkeypatch):
    account_id = bridge_read._account_id(FakeRequest())
    table = FakeListTable([])
    monkeypatch.setattr(bridge_read, "_tables", lambda: (table, None))
    wrong_cursor = bridge_read._encode_list_cursor({
        "accountId": account_id,
        "sk": "SESS#Mac#other#s1",
        "listPk": bridge_sync._session_list_pk(account_id, "Mac", "other"),
        "listSk": "2026-08-10T00:00:00.000Z#s1",
    })

    with pytest.raises(HTTPException) as error:
        asyncio.run(bridge_read.get_sessions(FakeRequest(), "Mac", "repo", 50, wrong_cursor))
    assert error.value.status_code == 400

    with pytest.raises(HTTPException) as error:
        asyncio.run(bridge_read.get_sessions(FakeRequest(), "Mac", "repo", None, "bad"))
    assert error.value.status_code == 400


def test_sync_and_incremental_updates_write_list_index_fields(monkeypatch):
    sessions = FakeWriteTable()
    messages = FakeWriteTable()
    monkeypatch.setattr(bridge_sync, "_tables", lambda: (sessions, messages))
    request = bridge_sync.SyncSessionsRequest(
        deviceName="Mac",
        sessions=[bridge_sync.SessionItem(
            id="s1",
            project="repo",
            lastActive="2026-08-10T00:00:00.000Z",
        )],
        device=bridge_sync.DeviceAggregate(lastActive="2026-08-10T00:00:00.000Z"),
        projects=[bridge_sync.ProjectAggregate(
            projectHash="repo",
            lastActive="2026-08-10T00:00:00.000Z",
        )],
    )

    asyncio.run(bridge_sync.sync_sessions(request, FakeRequest()))
    account_id = bridge_sync._hash_key("test-key")
    session = next(item for item in sessions.items if item["entityType"] == "session")
    project = next(item for item in sessions.items if item["entityType"] == "project")
    assert session["listPk"] == f"{account_id}#SESS#Mac#repo"
    assert session["listSk"].endswith("#s1")
    assert project["listPk"] == f"{account_id}#PROJ#Mac"
    assert project["listSk"].endswith("#repo")

    bridge_sync._bump_last_active(
        account_id,
        "PROJ#Mac#repo",
        "2026-08-10T01:00:00.000Z",
        bridge_sync._project_list_pk(account_id, "Mac"),
        "repo",
    )
    update = sessions.updates[-1]
    assert "listPk = :list_pk, listSk = :list_sk" in update["UpdateExpression"]
    assert update["ExpressionAttributeValues"][":list_sk"].endswith("#repo")


def test_template_defines_shared_list_index():
    root = os.path.join(os.path.dirname(__file__), "..", "..")
    with open(os.path.join(root, "server", "template", "Baton.template")) as handle:
        template = json.load(handle)
    table = template["Resources"]["BridgeSessionsTable"]["Properties"]

    assert {"AttributeName": "listPk", "AttributeType": "S"} in table["AttributeDefinitions"]
    assert {"AttributeName": "listSk", "AttributeType": "S"} in table["AttributeDefinitions"]
    indexes = {index["IndexName"]: index for index in table["GlobalSecondaryIndexes"]}
    assert indexes["listPk-listSk-index"]["KeySchema"] == [
        {"AttributeName": "listPk", "KeyType": "HASH"},
        {"AttributeName": "listSk", "KeyType": "RANGE"},
    ]


def test_backfill_is_idempotent_and_skips_non_list_rows():
    script_path = os.path.join(
        os.path.dirname(__file__), "..", "..", "server", "backfill-list-index.py"
    )
    spec = importlib.util.spec_from_file_location("backfill_list_index", script_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    class Table:
        def __init__(self):
            self.updates = []
            self.items = [
                {
                    "accountId": "a",
                    "sk": "SESS#Mac#repo#s1",
                    "entityType": "session",
                    "deviceName": "Mac",
                    "projectHash": "repo",
                    "sessionId": "s1",
                    "lastActive": "2026-08-10T00:00:00.000Z",
                },
                {
                    "accountId": "a",
                    "sk": "PROJ#Mac#repo",
                    "entityType": "project",
                    "deviceName": "Mac",
                    "projectHash": "repo",
                    "lastActive": "",
                    "listPk": "a#PROJ#Mac",
                    "listSk": "0000#repo",
                },
                {"accountId": "a", "sk": "DEV#Mac", "entityType": "device"},
                {"accountId": "a", "sk": "SESS#broken", "entityType": "session"},
            ]

        def scan(self, **_):
            return {"Items": self.items}

        def update_item(self, **kwargs):
            self.updates.append(kwargs)
            key = kwargs["Key"]
            item = next(
                item for item in self.items
                if item["accountId"] == key["accountId"] and item["sk"] == key["sk"]
            )
            values = kwargs["ExpressionAttributeValues"]
            item.update({"listPk": values[":pk"], "listSk": values[":sk"]})

    table = Table()
    result = module.backfill(table)
    repeated = module.backfill(table)

    assert result == {
        "scanned": 4,
        "eligible": 2,
        "updated": 1,
        "malformed": 1,
        "conflicts": 0,
    }
    assert repeated["updated"] == 0
    assert len(table.updates) == 1
    assert table.updates[0]["ConditionExpression"] == "attribute_exists(#row_sk) AND #la = :la"
    assert table.updates[0]["ExpressionAttributeValues"] == {
        ":pk": "a#SESS#Mac#repo",
        ":sk": "2026-08-10T00:00:00.000Z#s1",
        ":la": "2026-08-10T00:00:00.000Z",
    }
