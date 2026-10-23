import json
import os
import sys

sys.path.insert(
    0,
    os.path.join(os.path.dirname(__file__), "..", "..", "server", "src"),
)

import bridge_ws


def test_download_is_a_valid_project_file_operation():
    from project.files_ws import _valid_request
    assert _valid_request({"operation": "download", "projectHash": "project", "requestId": REQUEST_ID})
    assert not _valid_request({"operation": "delete", "projectHash": "project", "requestId": REQUEST_ID})


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


def test_project_file_request_and_response_are_connection_scoped(monkeypatch):
    delivered = []
    monkeypatch.setattr(bridge_ws, "_connections_table", Connections("app"))
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
        lambda endpoint, connection_id, payload: (
            delivered.append((connection_id, payload)) or True
        ),
    )

    response = bridge_ws._handle_message(
        {"body": json.dumps({
            "action": "project_files",
            "operation": "list",
            "requestId": REQUEST_ID,
            "projectHash": "project",
            "path": "",
            "device": "Mac",
        })},
        "incoming",
        "https://example.test/v1",
    )
    assert response == {"statusCode": 200}
    assert delivered == [("bridge-1", {
        "action": "project_files",
        "operation": "list",
        "requestId": REQUEST_ID,
        "projectHash": "project",
        "path": "",
        "replyConnectionId": "incoming",
    })]

    delivered.clear()
    monkeypatch.setattr(bridge_ws, "_connections_table", Connections("bridge"))
    response = bridge_ws._handle_message(
        {"body": json.dumps({
            "action": "project_files",
            "operation": "list",
            "requestId": REQUEST_ID,
            "ok": True,
            "entries": [{"name": "web", "type": "directory"}],
            "replyConnectionId": "app-1",
        })},
        "incoming",
        "https://example.test/v1",
    )
    assert response == {"statusCode": 200}
    assert delivered == [("app-1", {
        "action": "project_files",
        "operation": "list",
        "requestId": REQUEST_ID,
        "ok": True,
        "entries": [{"name": "web", "type": "directory"}],
    })]


def test_directory_browse_requires_a_device_but_no_project():
    from project.files_ws import _valid_request
    request = {"operation": "browse", "requestId": REQUEST_ID, "device": "Mac"}
    assert _valid_request(request)
    assert not _valid_request({**request, "device": ""})
    assert not _valid_request({**request, "path": None})
    assert not _valid_request({**request, "path": "/bad\0path"})
    assert not _valid_request({**request, "operation": "list"})
    assert not _valid_request({**request, "requestId": "invalid"})


def test_directory_browse_routes_to_selected_device_and_reports_offline(monkeypatch):
    from project.files_ws import handle_project_files
    delivered = []
    args = dict(
        role="app", connection_id="app-1", account_id="account-1", endpoint="endpoint",
        query_connections=lambda *_: [
            {"connectionId": "bridge-1", "deviceName": "Mac"},
            {"connectionId": "bridge-2", "deviceName": "Linux"},
        ],
        post_to_connection=lambda endpoint, connection, payload: delivered.append((connection, payload)),
        connections_table=Connections("app"),
    )
    request = {"operation": "browse", "requestId": REQUEST_ID, "device": "Mac", "path": "/tmp"}
    assert handle_project_files(request, **args) == {"statusCode": 200}
    assert delivered == [("bridge-1", {
        "action": "project_files", "operation": "browse", "requestId": REQUEST_ID,
        "path": "/tmp", "replyConnectionId": "app-1",
    })]
    delivered.clear()
    handle_project_files({**request, "device": "Offline"}, **args)
    assert delivered[0][0] == "app-1"
    assert delivered[0][1]["error"] == "Bridge offline"


def test_cancellable_download_requires_a_token_and_explicit_device():
    from project.files_ws import _valid_request
    valid = {
        'operation': 'cancel_download', 'projectHash': 'project',
        'requestId': REQUEST_ID, 'downloadToken': REQUEST_ID, 'device': 'Mac',
    }
    assert _valid_request(valid)
    assert _valid_request({**valid, 'operation': 'download'})
    for field, bad in [('device', ''), ('device', None), ('downloadToken', None),
                       ('downloadToken', 'not-a-uuid'), ('projectHash', '')]:
        assert not _valid_request({**valid, field: bad})
    assert not _valid_request({**valid, 'operation': 'list'})


def test_download_owner_is_authenticated_account_not_client_input():
    from project.files_ws import handle_project_files
    delivered = []
    for operation in ['download', 'cancel_download']:
        result = handle_project_files({
            'operation': operation, 'projectHash': 'project', 'path': 'file.txt',
            'requestId': REQUEST_ID, 'downloadToken': REQUEST_ID, 'device': 'Mac',
            'downloadOwner': 'forged-account', 'replyConnectionId': 'forged-app',
        }, 'app', 'new-app-connection', 'authenticated-account', 'endpoint',
            query_connections=lambda account, role: [
                {'connectionId': 'mac-bridge', 'deviceName': 'Mac'},
                {'connectionId': 'other-bridge', 'deviceName': 'Other'},
            ] if account == 'authenticated-account' and role == 'bridge' else [],
            post_to_connection=lambda endpoint, connection, payload:
                delivered.append((connection, payload)) or True,
            connections_table=None)
        assert result == {'statusCode': 200}
        assert delivered[-1][0] == 'mac-bridge'
        assert delivered[-1][1]['downloadOwner'] == 'authenticated-account'
        assert delivered[-1][1]['replyConnectionId'] == 'new-app-connection'
        assert delivered[-1][1]['downloadToken'] == REQUEST_ID
    assert len(delivered) == 2
