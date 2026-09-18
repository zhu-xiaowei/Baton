from contextlib import contextmanager
import json
from pathlib import Path
import subprocess
import sys

import boto3
from fastapi import FastAPI
from fastapi.testclient import TestClient
from moto import mock_aws

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server" / "src"))
import bridge_read
import bridge_sync

HEADERS = {"x-api-key": "local-status-regression"}


@contextmanager
def local_status_app():
    with mock_aws():
        ddb = boto3.resource("dynamodb", region_name="us-east-1")
        indexes = [
            (bridge_read.LIST_INDEX_NAME, "listPk", "listSk"),
            (bridge_read.THREAD_ROOT_INDEX_NAME, "threadRootPk", "threadRootSk"),
            ("accountId-activeStatus-index", "accountId", "activeStatus"),
        ]
        attributes = {"accountId", "sk", *(name for _, pk, sk in indexes for name in (pk, sk))}
        sessions = ddb.create_table(
            TableName="local-status-sessions",
            KeySchema=[{"AttributeName": "accountId", "KeyType": "HASH"}, {"AttributeName": "sk", "KeyType": "RANGE"}],
            AttributeDefinitions=[{"AttributeName": name, "AttributeType": "S"} for name in attributes],
            GlobalSecondaryIndexes=[{
                "IndexName": name,
                "KeySchema": [{"AttributeName": pk, "KeyType": "HASH"}, {"AttributeName": sk, "KeyType": "RANGE"}],
                "Projection": {"ProjectionType": "ALL"},
            } for name, pk, sk in indexes],
            BillingMode="PAY_PER_REQUEST",
        )
        messages = ddb.create_table(
            TableName="local-status-messages",
            KeySchema=[{"AttributeName": "sessionId", "KeyType": "HASH"}, {"AttributeName": "sk", "KeyType": "RANGE"}],
            AttributeDefinitions=[{"AttributeName": name, "AttributeType": "S"} for name in ("sessionId", "sk")],
            BillingMode="PAY_PER_REQUEST",
        )
        original_sync, original_read = bridge_sync._tables, bridge_read._tables
        original_connections = bridge_read._connections_table
        bridge_sync._tables = bridge_read._tables = lambda: (sessions, messages)
        bridge_read._connections_table = None
        app = FastAPI()
        app.include_router(bridge_sync.bridge_router)
        app.include_router(bridge_read.read_router)
        try:
            yield app
        finally:
            bridge_sync._tables, bridge_read._tables = original_sync, original_read
            bridge_read._connections_table = original_connections


def native_fixture():
    result = subprocess.run(
        ["node", str(ROOT / "test/codex/phase3/status-sync-fixture.mjs")],
        capture_output=True, text=True, check=True, timeout=30,
    )
    return json.loads(result.stdout)


def seed_stale_target(client, fixture):
    response = client.post("/api/bridge/sync-sessions", headers=HEADERS, json={
        "deviceName": "local-regression",
        "device": {
            "sessionCount": 1, "projectCount": 1, "runningCount": 1,
            "lastActive": "2026-09-15T02:17:22.071Z",
            "runtimeCapabilities": {"codex": {"installed": True, "canRead": True}},
        },
        "projects": [{
            "projectHash": fixture["project"], "projectName": "Local status regression",
            "sessionCount": 1, "runningCount": 1, "lastActive": "2026-09-15T02:17:22.071Z",
        }],
        "sessions": [{
            "id": fixture["target"], "runtime": "codex", "project": fixture["project"],
            "lastActive": "2026-09-15T02:17:22.071Z",
            "status": "completed", "agentCount": 11, "runningAgentCount": 11,
        }],
    })
    assert response.status_code == 200, response.text


def apply_native_fixture(client, fixture):
    for call in fixture["calls"]:
        response = client.post(call["endpoint"], headers=HEADERS, json=call["body"])
        assert response.status_code == 200, response.text


def test_native_catalog_to_real_server_excludes_archived_target_from_home_and_normal_lists(monkeypatch):
    monkeypatch.delenv("WS_API_ENDPOINT", raising=False)
    fixture = native_fixture()
    target = f'codex:{fixture["target"]}'
    with local_status_app() as app, TestClient(app) as client:
        seed_stale_target(client, fixture)
        before = client.get("/api/bridge/active-sessions", headers=HEADERS).json()
        assert target in {row["sessionId"] for row in before["sessions"]}

        apply_native_fixture(client, fixture)
        after = client.get("/api/bridge/active-sessions", headers=HEADERS).json()
        assert {row["sessionId"] for row in after["sessions"]} == {f"codex:{sid}" for sid in fixture["active"]}
        assert target not in {row["sessionId"] for row in after["recentSessions"]}
        assert all(target not in {row["sessionId"] for row in project["sessions"]} for project in after["recentProjects"])
        params = {"device": "local-regression", "project": fixture["project"], "limit": 100}
        normal = client.get("/api/bridge/sessions", params=params, headers=HEADERS).json()
        archived = client.get("/api/bridge/sessions", params={**params, "archived": "true"}, headers=HEADERS).json()
        assert target not in {row["sessionId"] for row in normal["sessions"]}
        assert [row["sessionId"] for row in archived["sessions"]] == [target]
        detail = client.get("/api/bridge/messages", params={
            "device": "local-regression", "project": fixture["project"], "session": target,
        }, headers=HEADERS).json()
        assert detail["archiveState"] == "archived"
        assert detail["canSend"] is False
