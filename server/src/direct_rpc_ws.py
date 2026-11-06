"""v2 direct App ⇄ Bridge requests.

A Bridge binds a `bridge_data` socket on the data API to its control connection. Apps get
STS credentials (from /devices) that may only post to their account's bridge data sockets, so
requests and replies travel through the API Gateway HTTP integration without Lambda.
"""

import hashlib
import json
import os
import re
import secrets
import time
import uuid

import boto3

from terminal_direct_ws import callback_policy

CREDENTIAL_SECONDS = 3600
CREDENTIAL_REUSE_MARGIN = 600
JOIN_TICKET_SECONDS = 60
_credential_cache = {}


def data_endpoint():
    return os.environ.get("TERMINAL_DIRECT_ENDPOINT", "")


def _ticket_key(token):
    return "RPCJOIN#" + hashlib.sha256(token.encode()).hexdigest()


def _policy(data_ids):
    policy = callback_policy(data_endpoint(), os.environ["TERMINAL_DIRECT_ROLE_ARN"], os.environ["AWS_REGION"])
    prefix = policy["Statement"][0]["Resource"][:-1]
    policy["Statement"][0]["Resource"] = [prefix + data_id for data_id in data_ids]
    return policy


def issue_app_credentials(account_id, data_ids, sts=None):
    ids = tuple(sorted(set(data_ids)))
    if not ids:
        return None
    cached = _credential_cache.get((account_id, ids))
    if cached and cached["expiresAt"] - time.time() > CREDENTIAL_REUSE_MARGIN:
        return cached
    region = os.environ["AWS_REGION"]
    sts = sts or boto3.client("sts", region_name=region)
    result = sts.assume_role(RoleArn=os.environ["TERMINAL_DIRECT_ROLE_ARN"],
        RoleSessionName="rpc-" + uuid.uuid4().hex[:20], DurationSeconds=CREDENTIAL_SECONDS,
        Policy=json.dumps(_policy(ids)))
    credentials = result["Credentials"]
    value = {"accessKeyId": credentials["AccessKeyId"], "secretAccessKey": credentials["SecretAccessKey"],
        "sessionToken": credentials["SessionToken"], "expiresAt": int(credentials["Expiration"].timestamp())}
    if len(_credential_cache) > 256:
        _credential_cache.clear()
    _credential_cache[(account_id, ids)] = value
    return value


def rpc_info(account_id, query, sts=None):
    """Bridges an App can address directly, plus credentials limited to exactly those sockets."""
    bridges = [{"device": bridge.get("deviceName", ""), "dataId": bridge["rpcDataId"],
                "bridgeProtocol": int(bridge.get("bridgeProtocol", 0))}
               for bridge in query(account_id, "bridge") if bridge.get("rpcDataId")]
    info = {"bridges": bridges, "endpoint": data_endpoint(), "region": os.environ.get("AWS_REGION", "")}
    credentials = issue_app_credentials(account_id, [bridge["dataId"] for bridge in bridges], sts)
    if credentials:
        info["credentials"] = credentials
    return info


def notify_apps(account_id, query, post, sts=None):
    apps = query(account_id, "app_data")
    if not apps:
        return
    message = {"action": "direct_rpc", "type": "bridges", "rpc": rpc_info(account_id, query, sts)}
    for app in apps:
        post(data_endpoint(), app["connectionId"], message)


def handle_direct_rpc(body, conn, connection_id, endpoint, *, table, query, post, sts=None):
    operation = body.get("op")
    role = conn.get("role")
    account_id = conn.get("accountId", "")
    if operation == "bridge_token" and role == "bridge" and conn.get("deviceName"):
        token = secrets.token_hex(32)
        table.put_item(Item={"connectionId": _ticket_key(token), "accountId": account_id, "role": "rpc_join",
            "controlId": connection_id, "deviceName": conn["deviceName"], "ttl": int(time.time()) + JOIN_TICKET_SECONDS})
        post(endpoint, connection_id, {"action": "direct_rpc", "type": "token", "token": token})
        return {"statusCode": 200}
    if operation == "bridge_join" and role == "bridge_data":
        token = body.get("token")
        ticket = None
        if isinstance(token, str) and re.fullmatch(r"[0-9a-f]{64}", token):
            key = _ticket_key(token)
            ticket = table.get_item(Key={"connectionId": key}, ConsistentRead=True).get("Item")
            table.delete_item(Key={"connectionId": key})
        current = []
        if ticket and ticket.get("accountId") == account_id and int(ticket.get("ttl", 0)) >= time.time():
            current = query(account_id, "bridge", device=ticket["deviceName"])
        if not current or current[0]["connectionId"] != ticket["controlId"]:
            post(endpoint, connection_id, {"action": "direct_rpc", "type": "error"})
            return {"statusCode": 403}
        table.update_item(Key={"connectionId": ticket["controlId"]}, UpdateExpression="SET rpcDataId = :data",
            ConditionExpression="attribute_exists(connectionId)", ExpressionAttributeValues={":data": connection_id})
        table.update_item(Key={"connectionId": connection_id}, UpdateExpression="SET rpcControlId = :control",
            ConditionExpression="attribute_exists(connectionId)", ExpressionAttributeValues={":control": ticket["controlId"]})
        post(endpoint, connection_id, {"action": "direct_rpc", "type": "joined"})
        notify_apps(account_id, query, post, sts)
        return {"statusCode": 200}
    return {"statusCode": 403}


def direct_rpc_disconnect(connection, *, table, query, post, sts=None):
    """Called after the connection row was removed."""
    if not connection:
        return
    role = connection.get("role")
    if role == "bridge_data" and connection.get("rpcControlId"):
        try:
            table.update_item(Key={"connectionId": connection["rpcControlId"]}, UpdateExpression="REMOVE rpcDataId",
                ConditionExpression="rpcDataId = :data", ExpressionAttributeValues={":data": connection["connectionId"]})
        except Exception:
            return
    elif not (role == "bridge" and connection.get("rpcDataId")):
        return
    notify_apps(connection.get("accountId", ""), query, post, sts)
