import os
import sys
import json

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "server", "src"))

from project.tool_details_ws import handle_tool_details
import bridge_ws


REQUEST = {
    "action": "tool_details",
    "requestId": "550e8400-e29b-41d4-a716-446655440000",
    "sessionId": "codex:22222222-2222-4222-8222-222222222222",
    "toolUseIds": ["tool-one", "tool-two"],
    "device": "Mac",
}


class Connections:
    def __init__(self, account="account"):
        self.account = account

    def get_item(self, **kwargs):
        return {"Item": {"role": "app", "accountId": self.account}}


def run(body, role="app", account="account"):
    sent = []
    result = handle_tool_details(
        body, role, "requesting-app", "account", "endpoint",
        query_connections=lambda *_: [
            {"connectionId": "mac-bridge", "deviceName": "Mac"},
            {"connectionId": "other-bridge", "deviceName": "Other"},
        ],
        post_to_connection=lambda _endpoint, connection, payload: sent.append((connection, payload)),
        connections_table=Connections(account),
    )
    return result, sent


def test_details_route_only_to_selected_device_and_requesting_app():
    result, sent = run(REQUEST)
    assert result["statusCode"] == 200
    assert [connection for connection, _ in sent] == ["mac-bridge"]
    assert sent[0][1]["replyConnectionId"] == "requesting-app"

    reply = {**sent[0][1], "ok": True, "sequence": 0, "complete": True, "content": "{}"}
    result, sent = run(reply, role="bridge")
    assert result["statusCode"] == 200
    assert sent[0][0] == "requesting-app"
    assert "replyConnectionId" not in sent[0][1]


def test_details_reject_cross_account_reply_and_report_offline():
    result, sent = run({**REQUEST, "replyConnectionId": "other-app"}, role="bridge", account="other")
    assert result["statusCode"] == 403 and sent == []
    result, sent = run({**REQUEST, "device": "Offline"})
    assert result["statusCode"] == 200
    assert sent[0][1]["ok"] is False


def test_details_validate_ids_before_routing():
    for change in ({"toolUseIds": []}, {"toolUseIds": ["x"] * 129}, {"sessionId": "../file"}, {"requestId": "bad"}):
        result, sent = run({**REQUEST, **change})
        assert result["statusCode"] == 400
        assert sent == []


def test_details_accept_claude_subagents_and_reject_unsafe_suffixes():
    parent = "22222222-2222-4222-8222-222222222222"
    session = f"{parent}:subagent:agent-a1b2c3"
    result, sent = run({**REQUEST, "sessionId": session})
    assert result["statusCode"] == 200
    assert sent[0][1]["sessionId"] == session
    for session in (
        f"{parent}:subagent:../private",
        f"{parent}:subagent:agent-name/other",
        f"{parent}:subagent:",
        f"codex:{parent}:subagent:agent-a1b2c3",
    ):
        result, sent = run({**REQUEST, "sessionId": session})
        assert result["statusCode"] == 400
        assert sent == []


def test_details_are_wired_into_the_real_ws_dispatcher(monkeypatch):
    class Incoming:
        def get_item(self, **kwargs):
            return {"Item": {"role": "app", "accountId": "account"}}

    sent = []
    monkeypatch.setattr(bridge_ws, "_connections_table", Incoming())
    monkeypatch.setattr(bridge_ws, "_query_connections", lambda *_: [
        {"connectionId": "bridge", "deviceName": "Mac"},
    ])
    monkeypatch.setattr(bridge_ws, "_post_to_connection", lambda _, connection, payload: sent.append((connection, payload)))
    result = bridge_ws._handle_message(
        {"body": json.dumps(REQUEST)}, "requesting-app", "endpoint",
    )
    assert result["statusCode"] == 200
    assert sent[0][0] == "bridge"
    assert sent[0][1]["toolUseIds"] == REQUEST["toolUseIds"]
