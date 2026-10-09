import copy
import datetime
import json
import os
import sys
import uuid

import pytest
from botocore.exceptions import ClientError

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "server", "src"))

from preview_tunnel_ws import PreviewSessions
import bridge_ws


def conditional():
    return ClientError({"Error": {"Code": "ConditionalCheckFailedException"}}, "UpdateItem")


class Table:
    def __init__(self):
        self.rows = {}

    def get_item(self, Key, **_):
        row = self.rows.get(Key["connectionId"])
        return {"Item": copy.deepcopy(row)} if row else {}

    def put_item(self, Item, **_):
        if Item["connectionId"] in self.rows:
            raise conditional()
        self.rows[Item["connectionId"]] = copy.deepcopy(Item)

    def update_item(self, Key, UpdateExpression, ExpressionAttributeValues, **kwargs):
        row = self.rows.get(Key["connectionId"])
        if row is None:
            raise conditional()
        values = ExpressionAttributeValues
        if UpdateExpression.startswith("ADD previewTunnelIds"):
            if len(row.get("previewTunnelIds", set())) >= 4:
                raise conditional()
            row.setdefault("previewTunnelIds", set()).update(values[":ids"])
        elif UpdateExpression.startswith("DELETE previewTunnelIds"):
            row.setdefault("previewTunnelIds", set()).difference_update(values[":ids"])
        elif UpdateExpression.startswith("SET #data"):
            field = kwargs["ExpressionAttributeNames"]["#data"]
            if row["state"] != "joining" or field in row:
                raise conditional()
            row[field] = values[":connection"]
        elif "SET #state = :issuing" in UpdateExpression:
            if row["state"] != "joining" or not row.get("appData") or not row.get("bridgeData"):
                raise conditional()
            row["state"] = "issuing"
            row.pop("appToken", None)
            row.pop("bridgeToken", None)
        elif "SET #state = :active" in UpdateExpression:
            if row["state"] != values[":expected"]:
                raise conditional()
            row.update(state="active", expiresAt=values[":expires"],
                issuedAt=values[":now"], ttl=values[":ttl"])
        elif "SET #state = :closed" in UpdateExpression:
            if row["state"] == "closed":
                raise conditional()
            row.update(state="closed", ttl=values[":ttl"])
            for field in ("appToken", "bridgeToken", "frameKey"):
                row.pop(field, None)
        else:
            raise AssertionError(UpdateExpression)
        return {"Attributes": copy.deepcopy(row)}


class Sts:
    def assume_role(self, **_):
        return {"Credentials": {
            "AccessKeyId": "test", "SecretAccessKey": "test",
            "SessionToken": "test", "Expiration": datetime.datetime.now(
                datetime.timezone.utc) + datetime.timedelta(minutes=15),
        }}


def make_manager():
    table = Table()
    account = "one"
    data_endpoint = "https://data.execute-api.ap-northeast-1.amazonaws.com/v1"
    table.rows["app"] = {"connectionId": "app", "role": "app", "accountId": account}
    table.rows["bridge"] = {"connectionId": "bridge", "role": "bridge",
        "accountId": account, "deviceName": "test-ec2", "previewProtocol": 1}
    for side in ("app", "bridge"):
        table.rows[side + "-data"] = {"connectionId": side + "-data",
            "role": "preview_data", "accountId": account,
            "terminalDataEndpoint": data_endpoint}
    messages, disconnected = [], []

    def query(account_id, role, *, device):
        return [table.rows["bridge"]] if account_id == account and role == "bridge" and device == "test-ec2" else []

    def post(endpoint, target, message):
        messages.append((target, message))
        return True

    manager = PreviewSessions(table, query, post,
        lambda endpoint, target: disconnected.append(target),
        "https://control.example.test/v1", data_endpoint,
        "arn:aws:iam::123456789012:role/direct", "ap-northeast-1", Sts())
    return manager, table, messages, disconnected


@pytest.mark.parametrize("order", [("app", "bridge"), ("bridge", "app")])
def test_preview_pairs_only_own_account_and_fixed_device_port(order):
    manager, table, messages, disconnected = make_manager()
    tunnel_id = str(uuid.uuid4())
    request = {"tunnelId": tunnel_id, "device": "test-ec2", "port": 8000}
    manager.open(request, table.rows["app"], "app")
    offers = {message["side"]: message for _, message in messages if message["type"] == "offer"}
    assert offers["app"]["port"] == 8000
    assert offers["bridge"]["port"] == 8000
    with pytest.raises(PermissionError):
        manager.join({"tunnelId": tunnel_id, "side": "app", "joinToken": offers["app"]["joinToken"]},
            {**table.rows["app-data"], "accountId": "other"}, "app-data")
    with pytest.raises(PermissionError):
        manager.join({"tunnelId": tunnel_id, "side": "bridge", "joinToken": offers["app"]["joinToken"]},
            table.rows["bridge-data"], "bridge-data")
    for side in order:
        manager.join({"tunnelId": tunnel_id, "side": side, "joinToken": offers[side]["joinToken"]},
            table.rows[side + "-data"], side + "-data")
    assert table.rows["preview-tunnel:" + tunnel_id]["state"] == "active"
    ready = {message["side"]: message for _, message in messages if message["type"] == "ready"}
    assert ready["app"]["peerConnectionId"] == "bridge-data"
    assert ready["bridge"]["peerConnectionId"] == "app-data"
    assert ready["app"]["frameKey"] == ready["bridge"]["frameKey"]
    table.rows["preview-tunnel:" + tunnel_id]["issuedAt"] = 0
    with pytest.raises(PermissionError):
        manager.control({"tunnelId": tunnel_id, "op": "renew"}, table.rows["bridge"], "bridge")
    manager.control({"tunnelId": tunnel_id, "op": "renew"}, table.rows["app"], "app")
    assert sum(message["type"] == "ready" for _, message in messages) == 4
    with pytest.raises(PermissionError):
        manager.join({"tunnelId": tunnel_id, "side": "app", "joinToken": offers["app"]["joinToken"]},
            table.rows["app-data"], "app-data")
    manager.close(tunnel_id)
    assert table.rows["preview-tunnel:" + tunnel_id]["state"] == "closed"
    assert not table.rows["app"]["previewTunnelIds"]
    assert not table.rows["bridge"]["previewTunnelIds"]
    assert set(disconnected) == {"app-data", "bridge-data"}


def test_preview_rejects_other_device_and_invalid_port():
    manager, table, _, _ = make_manager()
    request = {"tunnelId": str(uuid.uuid4()), "device": "test-ec2", "port": 5173}
    with pytest.raises(ValueError, match="Invalid port"):
        manager.open({**request, "port": 0}, table.rows["app"], "app")
    with pytest.raises(ValueError, match="Device offline"):
        manager.open({**request, "device": "other-device"}, table.rows["app"], "app")
    with pytest.raises(PermissionError):
        manager.open(request, table.rows["bridge"], "bridge")


def test_preview_data_role_stays_on_data_api_and_cannot_send_chat(monkeypatch):
    table = Table()
    monkeypatch.setattr(bridge_ws, "_connections_table", table)
    monkeypatch.setenv("TERMINAL_DIRECT_ENDPOINT",
        "https://data.execute-api.ap-northeast-1.amazonaws.com/v1")
    query = {"apiKey": "test-key", "role": "preview_data"}
    control_event = {"queryStringParameters": query,
        "requestContext": {"domainName": "control.example.test", "stage": "v1"}}
    assert bridge_ws._handle_connect(control_event, "preview-connection")["statusCode"] == 403
    data_event = {"queryStringParameters": query,
        "requestContext": {"domainName": "data.execute-api.ap-northeast-1.amazonaws.com",
            "stage": "v1"}}
    assert bridge_ws._handle_connect(data_event, "preview-connection")["statusCode"] == 200
    assert table.rows["preview-connection"]["role"] == "preview_data"
    assert bridge_ws._handle_message({"body": json.dumps({
        "action": "send_message", "sessionId": "test",
    })}, "preview-connection", "https://data.execute-api.ap-northeast-1.amazonaws.com/v1") == {
        "statusCode": 403,
    }
