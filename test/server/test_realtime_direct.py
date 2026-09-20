import copy
from datetime import datetime, timedelta, timezone
import json
import os
import re
import sys
from types import SimpleNamespace

import pytest
from botocore.exceptions import ClientError

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "server", "src"))
import bridge_ws
import realtime_direct_ws


class Connections:
    def __init__(self, records):
        self.records = {record["connectionId"]: copy.deepcopy(record) for record in records}

    def get_item(self, Key, **kwargs):
        record = self.records.get(Key["connectionId"])
        return {"Item": copy.deepcopy(record)} if record else {}

    def update_item(self, Key, UpdateExpression, ExpressionAttributeValues, ConditionExpression="", **kwargs):
        record = copy.deepcopy(self.records.get(Key["connectionId"], {}))
        for condition in ConditionExpression.split(" AND "):
            if condition == "attribute_exists(connectionId)":
                valid = "connectionId" in record
            elif " = " in condition:
                field, value = condition.split(" = ")
                valid = record.get(field) == ExpressionAttributeValues[value]
            else:
                valid = True
            if not valid:
                raise ClientError({"Error": {"Code": "ConditionalCheckFailedException"}}, "UpdateItem")
        for match in re.finditer(r"(?:^| )(SET|REMOVE|ADD|DELETE) (.*?)(?= (?:SET|REMOVE|ADD|DELETE) |$)", UpdateExpression):
            operation, fields = match.groups()
            for field in fields.split(", "):
                if operation == "REMOVE":
                    record.pop(field, None)
                elif operation == "SET":
                    name, value = field.split(" = ")
                    record[name] = copy.deepcopy(ExpressionAttributeValues[value])
                else:
                    name, value = field.split(" ")
                    current = record.setdefault(name, set())
                    if operation == "ADD":
                        current.update(ExpressionAttributeValues[value])
                    else:
                        current.difference_update(ExpressionAttributeValues[value])
        self.records[Key["connectionId"]] = record


@pytest.fixture
def harness(monkeypatch):
    monkeypatch.setenv("REALTIME_DIRECT_ENABLED", "1")
    monkeypatch.setenv("WS_API_ENDPOINT", "https://control.example.test/v1")
    monkeypatch.setenv("TERMINAL_DIRECT_ENDPOINT", "https://data.execute-api.ap-northeast-1.amazonaws.com/v1")
    monkeypatch.setenv("TERMINAL_DIRECT_ROLE_ARN", "arn:aws:iam::123456789012:role/direct")
    monkeypatch.setenv("AWS_REGION", "ap-northeast-1")
    table = Connections([
        {"connectionId": "app", "role": "app", "accountId": "account"},
        {"connectionId": "legacy", "role": "app", "accountId": "account"},
        {"connectionId": "foreign", "role": "app", "accountId": "other"},
        {"connectionId": "bridge", "role": "bridge", "accountId": "account", "realtimeVersion": 1},
        {"connectionId": "old-bridge", "role": "bridge", "accountId": "account"},
        {"connectionId": "data", "role": "realtime_data", "accountId": "account",
         "terminalDataEndpoint": os.environ["TERMINAL_DIRECT_ENDPOINT"]},
    ])
    posted, disconnected = [], []
    service = realtime_direct_ws.RealtimeDirect(table,
        lambda account, role: [copy.deepcopy(record) for record in table.records.values()
                              if record["accountId"] == account and record["role"] == role],
        lambda endpoint, target, message: posted.append((endpoint, target, message)) or True,
        lambda endpoint, target: disconnected.append((endpoint, target)),
        lambda body, account, bridge: {"app", "legacy", "foreign"}, os.environ["TERMINAL_DIRECT_ENDPOINT"])
    return SimpleNamespace(table=table, service=service, posted=posted, disconnected=disconnected)


def open_channel(harness):
    harness.service.handle({"v": 1, "op": "open", "requestId": "request"}, harness.table.records["app"], "app")
    offer = harness.posted[-1][2]
    return {"v": 1, "op": "join", "controlId": "app", "bindingId": offer["bindingId"], "joinToken": offer["joinToken"]}


def join_channel(harness):
    body = open_channel(harness)
    harness.service.handle(body, harness.table.records["data"], "data")
    return body


def test_binding_uses_control_channel_and_never_gives_browser_sts(harness):
    body = join_channel(harness)
    app = harness.table.records["app"]
    assert app["realtimeDataId"] == "data"
    assert "realtimeJoinHash" not in app
    assert body["joinToken"] not in json.dumps(harness.table.records, default=list)
    ready = next(message for _, target, message in harness.posted if message["type"] == "ready")
    assert "credentials" not in ready
    assert len(ready["frameKey"]) == 64
    assert all(endpoint == os.environ["WS_API_ENDPOINT"] for endpoint, _, _ in harness.posted)


@pytest.mark.parametrize("mutation", ["account", "binding", "token", "endpoint", "expiry"])
def test_join_rejects_foreign_stale_or_invalid_binding(harness, mutation):
    body = open_channel(harness)
    data = copy.deepcopy(harness.table.records["data"])
    if mutation == "account":
        data["accountId"] = "other"
    elif mutation == "binding":
        body["bindingId"] = "old"
    elif mutation == "token":
        body["joinToken"] = "00" * 32
    elif mutation == "endpoint":
        data["terminalDataEndpoint"] = os.environ["WS_API_ENDPOINT"]
    else:
        harness.table.records["app"]["realtimeJoinExpires"] = 0
    with pytest.raises(ValueError):
        harness.service.handle(body, data, "data")
    assert "realtimeDataId" not in harness.table.records["app"]


def test_join_token_is_single_use(harness):
    body = join_channel(harness)
    with pytest.raises(ValueError):
        harness.service.handle(body, harness.table.records["data"], "data")


def test_resolve_separates_legacy_clients_and_excludes_other_accounts(harness):
    join_channel(harness)
    harness.service.handle({"v": 1, "op": "resolve", "sessionId": "session", "requestId": "resolve"}, harness.table.records["bridge"], "bridge")
    targets = {target["controlId"]: target for target in harness.posted[-1][2]["targets"]}
    assert set(targets) == {"app", "legacy"}
    assert targets["app"]["dataId"] == "data"
    assert targets["legacy"] == {"controlId": "legacy"}


def test_subscription_invalidation_only_targets_capable_bridges(harness):
    harness.service.subscription("app", "account", "session")
    assert harness.table.records["app"]["realtimeSessions"] == {"session"}
    assert [target for _, target, _ in harness.posted] == ["bridge"]
    harness.service.subscription("app", "account", "session")
    assert len(harness.posted) == 1
    harness.service.subscription("app", "account", "session", remove=True)
    assert harness.table.records["app"]["realtimeSessions"] == set()


def test_stale_data_disconnect_does_not_revoke_replacement_binding(harness):
    join_channel(harness)
    stale = copy.deepcopy(harness.table.records["data"])
    stale["connectionId"] = "old-data"
    harness.service.close(stale)
    assert harness.table.records["app"]["realtimeDataId"] == "data"
    harness.service.close(harness.table.records["data"])
    assert "realtimeFrameKey" not in harness.table.records["app"]


def test_app_disconnect_revokes_data_binding_and_invalidates_subscriptions(harness):
    join_channel(harness)
    harness.service.subscription("app", "account", "session")
    harness.service.close(harness.table.records["app"])
    assert harness.disconnected == [(os.environ["TERMINAL_DIRECT_ENDPOINT"], "data")]
    assert "realtimeFrameKey" not in harness.table.records["app"]
    assert harness.posted[-1][2]["type"] == "invalidate"


def test_only_bridge_gets_data_api_scoped_sts(harness, monkeypatch):
    calls = []
    def assume_role(**kwargs):
        calls.append(kwargs)
        return {"Credentials": {"AccessKeyId": "temporary", "SecretAccessKey": "secret", "SessionToken": "token",
                                "Expiration": datetime.now(timezone.utc) + timedelta(minutes=15)}}
    monkeypatch.setattr(realtime_direct_ws.boto3, "client", lambda *args, **kwargs: SimpleNamespace(assume_role=assume_role))
    harness.service.handle({"v": 1, "op": "hello"}, harness.table.records["bridge"], "bridge")
    policy = json.loads(calls[0]["Policy"])
    assert policy["Statement"][0]["Resource"].endswith(":data/v1/POST/@connections/*")
    assert harness.posted[-1][1] == "bridge"
    with pytest.raises(ValueError):
        harness.service.handle({"v": 1, "op": "hello"}, harness.table.records["data"], "data")


def test_lambda_fallback_does_not_duplicate_already_direct_targets(monkeypatch):
    posted = []
    monkeypatch.setattr(bridge_ws, "_turn_event_targets", lambda *args: {"direct", "legacy"})
    monkeypatch.setattr(bridge_ws, "_post_to_connection", lambda endpoint, target, message: posted.append((target, message)))
    event = {"action": "stream_delta", "sessionId": "session", "turnId": "turn", "seq": 1,
             "chunk": "text", "directDeliveredTo": ["direct"], "replyConnectionId": "direct"}
    bridge_ws._relay_turn_event(event, "account", "bridge", "endpoint")
    assert posted == [("legacy", {key: value for key, value in event.items() if key not in ("directDeliveredTo", "replyConnectionId")})]


def test_invalid_data_join_closes_only_its_data_connection(harness):
    result = realtime_direct_ws.handle_realtime_direct({"v": 1, "op": "join", "controlId": "foreign", "joinToken": "invalid"},
        harness.table.records["data"], "data", harness.service)
    assert result == {"statusCode": 400}
    assert harness.posted == []
    assert harness.disconnected == [(os.environ["TERMINAL_DIRECT_ENDPOINT"], "data")]


def test_control_and_data_apis_remain_isolated(harness, monkeypatch):
    monkeypatch.setattr(bridge_ws, "_connections_table", SimpleNamespace(put_item=lambda **kwargs: None))
    def connect(role, domain):
        return bridge_ws._handle_connect({"queryStringParameters": {"apiKey": "key", "role": role},
            "requestContext": {"domainName": domain, "stage": "v1"}}, "new")
    assert connect("realtime_data", "control.example.test") == {"statusCode": 403}
    assert connect("app", "data.execute-api.ap-northeast-1.amazonaws.com") == {"statusCode": 403}
    assert connect("realtime_data", "data.execute-api.ap-northeast-1.amazonaws.com") == {"statusCode": 200}
    monkeypatch.setenv("REALTIME_DIRECT_ENABLED", "0")
    assert connect("realtime_data", "data.execute-api.ap-northeast-1.amazonaws.com") == {"statusCode": 403}


def test_disabled_feature_uses_legacy_transport_without_credentials(harness, monkeypatch):
    monkeypatch.setenv("REALTIME_DIRECT_ENABLED", "0")
    harness.service.handle({"v": 1, "op": "hello"}, harness.table.records["bridge"], "bridge")
    assert harness.posted[-1][2]["type"] == "unsupported"


def test_template_direct_route_targets_data_api_without_expanding_iam():
    with open(os.path.join(os.path.dirname(__file__), "..", "..", "server", "template", "Baton.template")) as source:
        resources = json.load(source)["Resources"]
    integration = resources["RealtimeDirectIntegration"]["Properties"]
    assert integration["IntegrationType"] == "HTTP"
    assert integration["ApiId"] == {"Ref": "WsApi"}
    assert "${TerminalDirectApi}" in integration["IntegrationUri"]["Fn::Sub"]
    assert "CredentialsArn" not in integration
    role = resources["TerminalDirectRole"]["Properties"]["Policies"][0]["PolicyDocument"]
    assert "${TerminalDirectApi}" in role["Statement"][0]["Resource"]["Fn::Sub"]
