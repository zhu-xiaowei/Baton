import json
import os
import sys

sys.path.insert(
    0,
    os.path.join(os.path.dirname(__file__), "..", "..", "server", "src"),
)

import bridge_ws


REQUEST_ID = "550e8400-e29b-41d4-a716-446655440000"


class Connections:
    def __init__(self, incoming_role):
        self.incoming_role = incoming_role

    def get_item(self, Key, **kwargs):
        connection_id = Key["connectionId"]
        if connection_id == "incoming":
            return {"Item": {
                "connectionId": connection_id,
                "role": self.incoming_role,
                "accountId": "account-1",
            }}
        if connection_id == "app-1":
            return {"Item": {
                "connectionId": connection_id,
                "role": "app",
                "accountId": "account-1",
            }}
        return {}


def configure(monkeypatch, role):
    delivered = []
    monkeypatch.setattr(bridge_ws, "_connections_table", Connections(role))
    monkeypatch.setattr(
        bridge_ws,
        "_query_connections",
        lambda account_id, requested_role: [{
            "connectionId": "bridge-1",
            "deviceName": "Mac",
        }] if account_id == "account-1" and requested_role == "bridge" else [],
    )
    monkeypatch.setattr(
        bridge_ws,
        "_post_to_connection",
        lambda endpoint, connection_id, payload: (
            delivered.append((connection_id, payload)) or True
        ),
    )
    return delivered


def send(body):
    return bridge_ws._handle_message(
        {"body": json.dumps(body)},
        "incoming",
        "https://example.test/v1",
    )


def test_git_status_routes_valid_requests_to_the_selected_bridge(monkeypatch):
    delivered = configure(monkeypatch, "app")
    response = send({
        "action": "git_status",
        "operation": "stage",
        "requestId": REQUEST_ID,
        "projectHash": "project",
        "device": "Mac",
        "group": "changes",
        "path": "src/app.js",
    })
    assert response == {"statusCode": 200}
    assert delivered == [("bridge-1", {
        "action": "git_status",
        "operation": "stage",
        "requestId": REQUEST_ID,
        "projectHash": "project",
        "group": "changes",
        "path": "src/app.js",
        "replyConnectionId": "incoming",
    })]


def test_git_status_rejects_invalid_operation_shapes(monkeypatch):
    delivered = configure(monkeypatch, "app")
    invalid = [
        {"operation": "stage", "group": "changes"},
        {"operation": "discard", "group": "staged", "path": "a.js"},
        {"operation": "unstage", "group": "staged", "all": True},
        {"operation": "diff", "group": "changes", "path": "../outside"},
    ]
    for fields in invalid:
        response = send({
            "action": "git_status",
            "requestId": REQUEST_ID,
            "projectHash": "project",
            **fields,
        })
        assert response == {"statusCode": 400}
    assert delivered == []


def test_git_status_response_is_connection_scoped(monkeypatch):
    delivered = configure(monkeypatch, "bridge")
    response = send({
        "action": "git_status",
        "operation": "status",
        "requestId": REQUEST_ID,
        "ok": True,
        "sequence": 0,
        "chunkCount": 1,
        "complete": True,
        "groups": {"conflicts": [], "staged": [], "changes": []},
        "replyConnectionId": "app-1",
    })
    assert response == {"statusCode": 200}
    assert delivered == [("app-1", {
        "action": "git_status",
        "operation": "status",
        "requestId": REQUEST_ID,
        "ok": True,
        "sequence": 0,
        "chunkCount": 1,
        "complete": True,
        "groups": {"conflicts": [], "staged": [], "changes": []},
    })]


def test_git_status_reports_bridge_offline_to_the_requesting_app(monkeypatch):
    delivered = configure(monkeypatch, "app")
    monkeypatch.setattr(bridge_ws, "_query_connections", lambda *_: [])
    response = send({
        "action": "git_status",
        "operation": "status",
        "requestId": REQUEST_ID,
        "projectHash": "project",
        "device": "Mac",
    })
    assert response == {"statusCode": 200}
    assert delivered == [("incoming", {
        "action": "git_status",
        "operation": "status",
        "requestId": REQUEST_ID,
        "ok": False,
        "sequence": 0,
        "chunkCount": 1,
        "complete": True,
        "errorCode": "bridge_offline",
        "error": "Bridge offline",
    })]
