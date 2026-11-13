"""
WebSocket handler for Baton — manages connections and message relay.
Deployed as a standalone Lambda (not in Docker), invoked by WebSocket API Gateway.
"""

import json
import os
import time
import hashlib
import re
import boto3
from botocore.exceptions import ClientError
import api_key as deployment_key
import auth
import devices
from direct_rpc_ws import direct_rpc_disconnect, handle_direct_rpc

_DATA_ROLES = ("app_data", "bridge_data")

_ddb = None
_connections_table = None
_apigw = None
_apigw_endpoint = None

def _init():
    global _ddb, _connections_table
    if _ddb is None:
        _ddb = boto3.resource("dynamodb", region_name=os.environ.get("AWS_REGION", "us-west-2"))
        _connections_table = _ddb.Table(os.environ["CONNECTIONS_TABLE"])


def _apigw_client(endpoint):
    global _apigw, _apigw_endpoint
    if _apigw is None or (_apigw_endpoint is not None and _apigw_endpoint != endpoint):
        _apigw = boto3.client("apigatewaymanagementapi", endpoint_url=endpoint)
        _apigw_endpoint = endpoint
    return _apigw


def _account_id(api_key):
    return auth.resolve(api_key)["accountId"]


def _bridge_owner_key(account_id, device):
    identity = json.dumps([account_id, device], separators=(",", ":"))
    return "BRIDGE#" + hashlib.sha256(identity.encode()).hexdigest()


def _bridge_connection_fresh(record):
    if "ttl" not in record:
        return True
    last_seen = int(record["ttl"]) - 86400
    return last_seen + int(record.get("heartbeatInterval", 240)) + 5 >= time.time()


def _connection_order(record):
    return record.get("connectionOrder") or f"{int(record.get('connectedAt', 0)) * 1000:016d}:{record['connectionId']}"


def _query_connections(account_id, role, table=None, device=""):
    """Query ConnectionsTable.accountId-role-index for active connections.
    Auto-paginates. Returns list of items with deviceName + connectionId."""
    from boto3.dynamodb.conditions import Key
    table = table if table is not None else _connections_table
    if role == "bridge" and device:
        owner = table.get_item(Key={"connectionId": _bridge_owner_key(account_id, device)},
            ConsistentRead=True).get("Item", {})
        if owner.get("activeConnectionId"):
            record = table.get_item(Key={"connectionId": owner["activeConnectionId"]},
                ConsistentRead=True).get("Item", {})
            if record.get("role") == role and record.get("accountId") == account_id \
                    and record.get("deviceName") == device and _bridge_connection_fresh(record):
                return [record]
            return []
    items = []
    kwargs = {
        "IndexName": "accountId-role-index",
        "KeyConditionExpression": Key("accountId").eq(account_id) & Key("role").eq(role),
    }
    resp = table.query(**kwargs)
    items.extend(resp.get("Items", []))
    while "LastEvaluatedKey" in resp:
        resp = table.query(ExclusiveStartKey=resp["LastEvaluatedKey"], **kwargs)
        items.extend(resp.get("Items", []))
    if role != "bridge":
        return items
    active = {}
    owners = {}
    for item in items:
        device = item.get("deviceName", "")
        owner = {}
        owner_keys = [_bridge_owner_key(account_id, device), item.get("bridgeOwner")]
        for owner_key in dict.fromkeys(key for key in owner_keys if key):
            if owner_key not in owners:
                owners[owner_key] = table.get_item(Key={"connectionId": owner_key},
                    ConsistentRead=True).get("Item", {})
            owner = owners[owner_key]
            if owner.get("activeConnectionId"):
                break
        current_id = owner.get("activeConnectionId", item["connectionId"])
        if item.get("bridgeOwner") and not owner.get("activeConnectionId"):
            continue
        record = table.get_item(Key={"connectionId": current_id}, ConsistentRead=True).get("Item")
        if not record or record.get("role") != role or record.get("accountId") != account_id:
            continue
        if record.get("deviceName", "") != device or not _bridge_connection_fresh(record):
            continue
        identity = device or current_id
        if identity not in active or _connection_order(record) > _connection_order(active[identity]):
            active[identity] = record
    return list(active.values())


def _retire_bridge_connection(connection_id, endpoint, replaced=True):
    if replaced:
        try:
            _post_to_connection(endpoint, connection_id, {"action": "bridge_replaced"})
        except Exception:
            pass
    try:
        _delete_connection(endpoint, connection_id)
    except Exception:
        print(f"Bridge socket cleanup deferred: {connection_id}")
    _handle_disconnect(connection_id, endpoint)


def _claim_bridge_connection(item, context, endpoint):
    connected_at = int(context.get("connectedAt") or context.get("requestTimeEpoch") or time.time() * 1000)
    try:
        previous = _connections_table.update_item(
            Key={"connectionId": item["bridgeOwner"]},
            UpdateExpression="SET activeConnectionId = :connection, connectionOrder = :order, #ttl = :ttl",
            ConditionExpression="attribute_not_exists(connectionOrder) OR connectionOrder <= :order",
            ExpressionAttributeNames={"#ttl": "ttl"},
            ExpressionAttributeValues={":connection": item["connectionId"],
                ":order": item.get("connectionOrder", f"{connected_at:016d}:{item['connectionId']}"), ":ttl": item["ttl"]},
            ReturnValues="ALL_OLD").get("Attributes", {})
    except ClientError as error:
        if error.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
        _connections_table.delete_item(Key={"connectionId": item["connectionId"]})
        return False
    previous_id = previous.get("activeConnectionId")
    if previous_id and previous_id != item["connectionId"]:
        _retire_bridge_connection(previous_id, endpoint)
    from boto3.dynamodb.conditions import Key
    kwargs = {"IndexName": "accountId-role-index",
        "KeyConditionExpression": Key("accountId").eq(item["accountId"]) & Key("role").eq("bridge")}
    while True:
        response = _connections_table.query(**kwargs)
        for candidate in response.get("Items", []):
            if candidate["connectionId"] not in (previous_id, item["connectionId"]) \
                    and candidate.get("deviceName") == item.get("deviceName") \
                    and _connection_order(candidate) < _connection_order(item):
                _retire_bridge_connection(candidate["connectionId"], endpoint)
        if "LastEvaluatedKey" not in response:
            break
        kwargs["ExclusiveStartKey"] = response["LastEvaluatedKey"]
    return True


def _post_to_connection(endpoint, connection_id, data):
    """Send data to a WebSocket connection. Returns False if connection is gone."""
    client = _apigw_client(endpoint)
    try:
        payload = json.dumps(
            data,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode()
        client.post_to_connection(ConnectionId=connection_id, Data=payload)
        return True
    except client.exceptions.GoneException:
        # Connection no longer exists — clean up
        _init()
        try:
            _connections_table.delete_item(Key={"connectionId": connection_id})
        except Exception:
            pass
        return False


def handler(event, context):
    _init()
    route = event.get("requestContext", {}).get("routeKey", "")
    connection_id = event.get("requestContext", {}).get("connectionId", "")
    domain = event.get("requestContext", {}).get("domainName", "")
    stage = event.get("requestContext", {}).get("stage", "")
    endpoint = f"https://{domain}/{stage}"

    if route == "$connect":
        return _handle_connect(event, connection_id)
    elif route == "$disconnect":
        return _handle_disconnect(connection_id, endpoint)
    elif route == "$default":
        return _handle_message(event, connection_id, endpoint)

    return {"statusCode": 400}


def _handle_connect(event, connection_id):
    """Store connection in DDB."""
    qs = event.get("queryStringParameters") or {}
    api_key = qs.get("apiKey", "")
    role = qs.get("role", "app")  # "app" or "bridge"
    device = qs.get("device", "")
    version = qs.get("version", "")

    try:
        resolved = auth.resolve(api_key)
    except deployment_key.KeyUnavailable:
        return {"statusCode": 503}
    if not resolved:
        return {"statusCode": 401}
    # A device token connects only in its own role: a phone cannot pose as a Bridge, nor a Bridge as an App.
    if resolved["kind"] != "key" and (resolved["kind"] == "bridge") != role.startswith("bridge"):
        return {"statusCode": 403}
    bridge_id = qs.get("bridgeId") if role == "bridge" else None
    if bridge_id is not None and not re.fullmatch(r"[a-f0-9]{32}", bridge_id):
        return {"statusCode": 400}

    context = event.get("requestContext", {})
    connected_endpoint = f"https://{context.get('domainName', '')}/{context.get('stage', '')}"
    data_endpoint = os.environ.get("TERMINAL_DIRECT_ENDPOINT")
    if (role in _DATA_ROLES) != (bool(data_endpoint) and connected_endpoint == data_endpoint):
        return {"statusCode": 403}

    account_id = resolved["accountId"]
    ttl = int(time.time()) + 86400  # 24h

    item = {
        "connectionId": connection_id,
        "accountId": account_id,
        "role": role,
        "connectedAt": int(time.time()),
        "ttl": ttl,
    }
    if device:
        item["deviceName"] = device
    if resolved.get("tokenHash"):
        item["tokenHash"] = resolved["tokenHash"]
    if role == "bridge" and version:
        item["bridgeVersion"] = version
    if role == "bridge" and device:
        item["bridgeOwner"] = _bridge_owner_key(account_id, device)
        item["heartbeatInterval"] = 5 if qs.get("heartbeat") == "5" else 240
        connected_at = int(context.get("connectedAt") or context.get("requestTimeEpoch") or time.time() * 1000)
        item["connectionOrder"] = f"{connected_at:016d}:{connection_id}"
    if bridge_id:
        item["bridgeId"] = bridge_id
    _connections_table.put_item(Item=item)
    if item.get("bridgeOwner"):
        if not _claim_bridge_connection(item, context, connected_endpoint):
            return {"statusCode": 409}
        try:  # display only: the connection does not depend on it
            devices.put_device(account_id, device, qs.get("name", ""), qs.get("os", ""))
        except Exception as error:
            print(f"device row not written: {error}")

    return {"statusCode": 200}


def _delete_connection(endpoint, connection_id):
    try:
        _apigw_client(endpoint).delete_connection(ConnectionId=connection_id)
    except _apigw_client(endpoint).exceptions.GoneException:
        pass


def _handle_disconnect(connection_id, endpoint=None):
    """Remove the connection and tell its peers."""
    try:
        connection = (_connections_table.get_item(Key={"connectionId": connection_id},
            ConsistentRead=True).get("Item") if endpoint else None)
    except Exception:
        connection = None
    try:
        _connections_table.delete_item(Key={"connectionId": connection_id})
    except Exception:
        pass
    try:
        direct_rpc_disconnect(connection, table=_connections_table, query=_query_connections,
            post=_post_to_connection)
    except Exception:
        print("Direct RPC disconnect notification failed")

    return {"statusCode": 200}


def _handle_message(event, connection_id, endpoint):
    """Route messages by action."""
    try:
        body = json.loads(event.get("body", "{}"))
    except json.JSONDecodeError:
        return {"statusCode": 400}

    action = body.get("action", "")


    # Get connection info — if missing (e.g. DDB cleared), force reconnect.
    # Client's onclose handler will auto-reconnect → $connect rewrites the record.
    conn = _connections_table.get_item(Key={"connectionId": connection_id}, ConsistentRead=True).get("Item")
    if not conn:
        try:
            _apigw_client(endpoint).delete_connection(ConnectionId=connection_id)
        except Exception:
            pass
        return {"statusCode": 200}

    role = conn.get("role", "app")
    account_id = conn.get("accountId", "")
    if role == "bridge" and conn.get("deviceName"):
        owner_key = _bridge_owner_key(account_id, conn.get("deviceName", ""))
        owner = _connections_table.get_item(Key={"connectionId": owner_key},
            ConsistentRead=True).get("Item", {})
        if not owner and conn.get("bridgeOwner") and conn["bridgeOwner"] != owner_key:
            owner = _connections_table.get_item(Key={"connectionId": conn["bridgeOwner"]},
                ConsistentRead=True).get("Item", {})
        if (owner or conn.get("bridgeOwner")) and owner.get("activeConnectionId") != connection_id:
            _retire_bridge_connection(connection_id, endpoint, replaced=bool(owner.get("activeConnectionId")))
            return {"statusCode": 200}
    if action == "direct_rpc":
        return handle_direct_rpc(body, conn, connection_id, endpoint, table=_connections_table,
            query=_query_connections, post=_post_to_connection)
    if role in _DATA_ROLES:
        return {"statusCode": 403}

    if action == "heartbeat":
        # Update TTL
        ttl = int(time.time()) + 86400
        try:
            if conn.get("bridgeOwner"):
                _connections_table.update_item(Key={"connectionId": conn["bridgeOwner"]},
                    UpdateExpression="SET #ttl = :ttl", ConditionExpression="activeConnectionId = :connection",
                    ExpressionAttributeNames={"#ttl": "ttl"},
                    ExpressionAttributeValues={":ttl": ttl, ":connection": connection_id})
            _connections_table.update_item(
                Key={"connectionId": connection_id},
                UpdateExpression="SET #t = :ttl",
                ConditionExpression="attribute_exists(connectionId)",
                ExpressionAttributeNames={"#t": "ttl"},
                ExpressionAttributeValues={":ttl": ttl},
            )
        except ClientError as error:
            if error.response["Error"]["Code"] != "ConditionalCheckFailedException":
                raise
            return {"statusCode": 200}
        response = {"action": "heartbeat", "ts": int(time.time())}
        if role == "bridge":
            response["bridgeVersion"] = os.environ.get("BRIDGE_VERSION", os.environ.get("APP_VERSION", "dev"))
        _post_to_connection(endpoint, connection_id, response)
        return {"statusCode": 200}

    return {"statusCode": 200}


def disconnect_removed_bridge(account_id, endpoint, device):
    """Tell every Bridge socket of a removed device to uninstall itself, then close it."""
    _init()
    from boto3.dynamodb.conditions import Key
    kwargs = {"IndexName": "accountId-role-index",
        "KeyConditionExpression": Key("accountId").eq(account_id) & Key("role").eq("bridge")}
    while True:
        response = _connections_table.query(**kwargs)
        for item in response.get("Items", []):
            if item.get("deviceName") != device:
                continue
            try:
                _post_to_connection(endpoint, item["connectionId"], {"action": "device_removed"})
            except Exception:
                pass
            _retire_bridge_connection(item["connectionId"], endpoint, replaced=False)
        if "LastEvaluatedKey" not in response:
            return
        kwargs["ExclusiveStartKey"] = response["LastEvaluatedKey"]
