import copy
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "server", "src"))
import direct_rpc_ws

DATA = "https://data.execute-api.ap-northeast-1.amazonaws.com/v1"


class Table:
    def __init__(self, records=()):
        self.records = {r["connectionId"]: copy.deepcopy(r) for r in records}

    def put_item(self, Item):
        self.records[Item["connectionId"]] = copy.deepcopy(Item)

    def get_item(self, Key, **kwargs):
        record = self.records.get(Key["connectionId"])
        return {"Item": copy.deepcopy(record)} if record else {}

    def delete_item(self, Key):
        self.records.pop(Key["connectionId"], None)

    def update_item(self, Key, UpdateExpression, ExpressionAttributeValues, ConditionExpression=""):
        record = self.records[Key["connectionId"]]
        if ConditionExpression.startswith("rpcDataId") and record.get("rpcDataId") != ExpressionAttributeValues[":data"]:
            raise RuntimeError("condition")
        if UpdateExpression.startswith("REMOVE "):
            record.pop(UpdateExpression.split(" ", 1)[1], None)
        else:
            name, value = UpdateExpression.split("SET ", 1)[1].split(" = ")
            record[name] = ExpressionAttributeValues[value]


class Sts:
    def __init__(self):
        self.calls = []

    def assume_role(self, **kwargs):
        self.calls.append(kwargs)
        return {"Credentials": {"AccessKeyId": "AK", "SecretAccessKey": "SK", "SessionToken": "TOKEN",
            "Expiration": datetime.now(timezone.utc) + timedelta(hours=1)}}


@pytest.fixture
def world(monkeypatch):
    monkeypatch.setenv("TERMINAL_DIRECT_ENDPOINT", DATA)
    monkeypatch.setenv("TERMINAL_DIRECT_ROLE_ARN", "arn:aws:iam::123456789012:role/direct")
    monkeypatch.setenv("AWS_REGION", "ap-northeast-1")
    direct_rpc_ws._credential_cache.clear()
    table = Table([
        {"connectionId": "bridge-a", "accountId": "A", "role": "bridge", "deviceName": "mac", "bridgeProtocol": 2},
        {"connectionId": "bridge-b", "accountId": "B", "role": "bridge", "deviceName": "pc", "bridgeProtocol": 2},
        {"connectionId": "data-a", "accountId": "A", "role": "bridge_data"},
        {"connectionId": "app-a", "accountId": "A", "role": "app_data"},
        {"connectionId": "app-b", "accountId": "B", "role": "app_data"},
    ])

    def query(account, role, device=""):
        return [copy.deepcopy(r) for r in table.records.values() if r.get("accountId") == account and r.get("role") == role
                and (not device or r.get("deviceName") == device)]

    sent = []
    post = lambda endpoint, target, data: sent.append((endpoint, target, data)) or True
    sts = Sts()
    return table, query, post, sent, sts


def token_for(world, control="bridge-a"):
    table, query, post, sent, sts = world
    direct_rpc_ws.handle_direct_rpc({"op": "bridge_token"}, table.records[control], control, "https://control/v1",
        table=table, query=query, post=post, sts=sts)
    return sent[-1][2]["token"]


def join(world, token, data="data-a"):
    table, query, post, sent, sts = world
    return direct_rpc_ws.handle_direct_rpc({"op": "bridge_join", "token": token}, table.records[data], data, DATA,
        table=table, query=query, post=post, sts=sts)


def test_join_binds_bridge_and_pushes_scoped_credentials_to_same_account_apps(world):
    table, query, post, sent, sts = world
    assert join(world, token_for(world))["statusCode"] == 200
    assert table.records["bridge-a"]["rpcDataId"] == "data-a"
    pushes = [(target, data) for _, target, data in sent if data.get("type") == "bridges"]
    assert [target for target, _ in pushes] == ["app-a"]
    rpc = pushes[0][1]["rpc"]
    assert rpc["bridges"] == [{"device": "mac", "dataId": "data-a"}]
    policy = json.loads(sts.calls[-1]["Policy"])
    assert policy["Statement"][0]["Resource"] == "arn:aws:execute-api:ap-northeast-1:123456789012:data/v1/POST/@connections/*"


def test_join_rejects_bad_expired_reused_or_cross_account_tokens(world):
    table, query, post, sent, sts = world
    assert join(world, "0" * 64)["statusCode"] == 403
    token = token_for(world)
    table.records[direct_rpc_ws._ticket_key(token)]["ttl"] = int(time.time()) - 1
    assert join(world, token)["statusCode"] == 403
    token = token_for(world)
    assert join(world, token)["statusCode"] == 200
    assert join(world, token)["statusCode"] == 403
    table.records["data-b"] = {"connectionId": "data-b", "accountId": "B", "role": "bridge_data"}
    assert join(world, token_for(world), data="data-b")["statusCode"] == 403


def test_join_rejects_a_replaced_bridge_connection(world):
    table, query, post, sent, sts = world
    token = token_for(world)
    table.records["bridge-a"]["deviceName"] = "renamed"
    assert join(world, token)["statusCode"] == 403


def test_credentials_are_reused_and_only_issued_with_a_joined_bridge(world):
    table, query, post, sent, sts = world
    assert "credentials" not in direct_rpc_ws.rpc_info("A", query, sts)
    join(world, token_for(world))
    calls = len(sts.calls)
    info = direct_rpc_ws.rpc_info("A", query, sts)
    assert info["credentials"]["sessionToken"] == "TOKEN" and len(sts.calls) == calls
    assert direct_rpc_ws.rpc_info("B", query, sts)["bridges"] == []


def test_bridge_data_disconnect_unbinds_and_notifies(world):
    table, query, post, sent, sts = world
    join(world, token_for(world))
    connection = table.records.pop("data-a") | {"rpcControlId": "bridge-a"}
    sent.clear()
    direct_rpc_ws.direct_rpc_disconnect(connection, table=table, query=query, post=post, sts=sts)
    assert "rpcDataId" not in table.records["bridge-a"]
    assert sent[-1][1] == "app-a" and sent[-1][2]["rpc"]["bridges"] == []


def test_new_roles_are_data_api_only(monkeypatch):
    import bridge_ws
    puts = []
    monkeypatch.setenv("TERMINAL_DIRECT_ENDPOINT", DATA)
    monkeypatch.setattr(bridge_ws, "_connections_table", type("T", (), {"put_item": lambda self, Item: puts.append(Item)})())
    for role in ("app_data", "bridge_data"):
        event = {"queryStringParameters": {"apiKey": "k", "role": role},
                 "requestContext": {"domainName": "control.execute-api.ap-northeast-1.amazonaws.com", "stage": "v1"}}
        assert bridge_ws._handle_connect(event, "c1")["statusCode"] == 403
        event["requestContext"]["domainName"] = "data.execute-api.ap-northeast-1.amazonaws.com"
        assert bridge_ws._handle_connect(event, "c2")["statusCode"] == 200
    assert {item["role"] for item in puts} == {"app_data", "bridge_data"}
