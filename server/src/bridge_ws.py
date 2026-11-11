"""
WebSocket handler for Baton — manages connections and message relay.
Deployed as a standalone Lambda (not in Docker), invoked by WebSocket API Gateway.
"""

import json
from message_history import message_key
import os
import time
import hashlib
import re
import boto3
from botocore.exceptions import ClientError
import api_key as deployment_key
from terminal_ws import handle_terminal_poc
from terminal_direct_ws import handle_terminal_direct, terminal_direct_disconnect
from preview_tunnel_ws import handle_preview_tunnel, preview_tunnel_disconnect
from direct_rpc_ws import direct_rpc_disconnect, handle_direct_rpc

_DATA_ROLES = ("terminal_data", "preview_data", "app_data", "bridge_data")

_ddb = None
_connections_table = None
_messages_table = None
_apigw = None
_apigw_endpoint = None

_STRICT_STREAM_ACTIONS = {
    "stream_turn_start",
    "stream_block_start",
    "stream_delta",
    "stream_tool_input",
    "stream_block_stop",
    "stream_end",
}

def _requires_turn_sequence(body):
    action = body.get("action", "")
    return action in _STRICT_STREAM_ACTIONS or (
        action in ("messages", "permission_request", "permission_resolved")
        and "turnId" in body
    )


def _has_valid_turn_sequence(body):
    return (
        bool(body.get("sessionId"))
        and bool(body.get("turnId"))
        and isinstance(body.get("seq"), int)
        and not isinstance(body.get("seq"), bool)
        and body["seq"] >= 0
    )


def _init():
    global _ddb, _connections_table, _messages_table
    if _ddb is None:
        _ddb = boto3.resource("dynamodb", region_name=os.environ.get("AWS_REGION", "us-west-2"))
        _connections_table = _ddb.Table(os.environ["CONNECTIONS_TABLE"])
        _messages_table = _ddb.Table(os.environ.get("BRIDGE_MESSAGES_TABLE", ""))


def _apigw_client(endpoint):
    global _apigw, _apigw_endpoint
    if _apigw is None or (_apigw_endpoint is not None and _apigw_endpoint != endpoint):
        _apigw = boto3.client("apigatewaymanagementapi", endpoint_url=endpoint)
        _apigw_endpoint = endpoint
    return _apigw


def _account_id(api_key):
    return deployment_key.account_id(api_key)


def _runtime_session_fields(session_id):
    if session_id.startswith("codex:"):
        return {"runtime": "codex", "nativeSessionId": session_id[len("codex:"):]}
    return {"runtime": "claude", "nativeSessionId": session_id}


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
        _disconnect_terminal_data(endpoint, connection_id)
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

    # API Gateway checks the key only on REST, so WebSocket connections are checked here.
    try:
        if not deployment_key.is_current(api_key):
            return {"statusCode": 401}
    except deployment_key.KeyUnavailable:
        return {"statusCode": 503}
    bridge_id = qs.get("bridgeId") if role == "bridge" else None
    if bridge_id is not None and not re.fullmatch(r"[a-f0-9]{32}", bridge_id):
        return {"statusCode": 400}

    context = event.get("requestContext", {})
    connected_endpoint = f"https://{context.get('domainName', '')}/{context.get('stage', '')}"
    data_endpoint = os.environ.get("TERMINAL_DIRECT_ENDPOINT")
    if (role in _DATA_ROLES) != (bool(data_endpoint) and connected_endpoint == data_endpoint):
        return {"statusCode": 403}

    account_id = _account_id(api_key)
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
    if role == "bridge" and version:
        item["bridgeVersion"] = version
    if role == "bridge" and device:
        item["bridgeOwner"] = _bridge_owner_key(account_id, device)
        item["heartbeatInterval"] = 5 if qs.get("heartbeat") == "5" else 240
        connected_at = int(context.get("connectedAt") or context.get("requestTimeEpoch") or time.time() * 1000)
        item["connectionOrder"] = f"{connected_at:016d}:{connection_id}"
    if bridge_id:
        item["bridgeId"] = bridge_id
    if role == "bridge" and qs.get("terminal") == "2":
        item["terminalProtocol"] = 2
        if qs.get("terminalStartup") == "1":
            item["terminalStartup"] = 1
    if role == "bridge" and qs.get("preview") == "1":
        item["previewProtocol"] = 1
    if role in _DATA_ROLES:
        item["terminalDataEndpoint"] = connected_endpoint
    _connections_table.put_item(Item=item)
    if item.get("bridgeOwner") and not _claim_bridge_connection(item, context, connected_endpoint):
        return {"statusCode": 409}

    return {"statusCode": 200}


def _disconnect_terminal_data(endpoint, connection_id):
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
    if endpoint:
        try:
            terminal_direct_disconnect(connection, endpoint, table=_connections_table,
                query=_query_connections, post=_post_to_connection, disconnect=_disconnect_terminal_data)
        except Exception:
            pass
        try:
            preview_tunnel_disconnect(connection, endpoint, table=_connections_table,
                query=_query_connections, post=_post_to_connection, disconnect=_disconnect_terminal_data)
        except Exception:
            pass

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

    terminal_identity_started = time.perf_counter() if action == "terminal_poc" and body.get("profile") is True else None

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
    if action == "terminal_direct":
        return handle_terminal_direct(body, conn, connection_id, endpoint, table=_connections_table,
            query=lambda account, requested_role: _query_connections(account, requested_role, device=body.get("device", "")),
            post=_post_to_connection, disconnect=_disconnect_terminal_data)
    if action == "preview_tunnel":
        return handle_preview_tunnel(body, conn, connection_id, endpoint, table=_connections_table,
            query=_query_connections, post=_post_to_connection, disconnect=_disconnect_terminal_data)
    if action == "direct_rpc":
        return handle_direct_rpc(body, conn, connection_id, endpoint, table=_connections_table,
            query=_query_connections, post=_post_to_connection)
    if role in _DATA_ROLES:
        return {"statusCode": 403}
    if role == "bridge" and _requires_turn_sequence(body) \
            and not _has_valid_turn_sequence(body):
        return {"statusCode": 400}

    if action == "terminal_poc":
        return handle_terminal_poc(
            body, conn, connection_id, endpoint,
            identity_ms=(time.perf_counter() - terminal_identity_started) * 1000 if terminal_identity_started is not None else 0,
            query_connections=lambda account, requested_role: _query_connections(account, requested_role, device=body.get("device", "")),
            post_to_connection=_post_to_connection,
            connections_table=_connections_table,
        )
    elif action == "messages":
        if role == "bridge":
            return _handle_bridge_messages(body, connection_id, account_id, endpoint)
    elif action == "sync_complete":
        if role == "bridge":
            return _handle_sync_complete(body, account_id, endpoint)
    elif action == "bridge_recovery_complete":
        if role == "bridge":
            return _handle_bridge_broadcast(body, account_id, connection_id, endpoint)
    elif action == "heartbeat":
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


def _handle_bridge_messages(body, bridge_connection_id, account_id, endpoint):
    """Bridge rows DynamoDB stores; Apps get them from the Bridge directly."""
    session_id = body.get("sessionId", "")
    messages = body.get("messages", [])
    compact_placeholder = (
        body.get("truncated") is True
        and bool(body.get("turnId"))
        and body.get("seq") is not None
        and messages == []
    )
    if not session_id or (not messages and not compact_placeholder):
        return {"statusCode": 400}

    # Write to DDB (cache) with one retry.
    # Skip when the bridge flags noCache: it sent a truncated copy over WS (to fit
    # the 32KB frame cap) and is writing the full copy to DDB itself via HTTP, so
    # caching the truncated version here would clobber it.
    if messages and not body.get("noCache"):
        if not _messages_table:
            return {"statusCode": 500}
        persisted = False
        for attempt in range(2):
            try:
                from datetime import datetime
                with _messages_table.batch_writer() as batch:
                    for msg in messages:
                        uuid = msg.get("uuid", "")
                        if not uuid:
                            continue
                        timestamp = msg.get("timestamp", datetime.utcnow().isoformat())
                        item = {
                            **message_key(session_id, msg, timestamp),
                            "uuid": uuid,
                            "type": msg.get("type", ""),
                            "content": json.dumps(
                                msg.get("content", ""),
                                ensure_ascii=False,
                            ),
                            "timestamp": timestamp,
                            "ttl": int(time.time()) + 90 * 86400,  # 90-day expiry (matches sync_messages)
                        }
                        if msg.get("nativeId"):
                            item["nativeId"] = msg["nativeId"]
                        if msg.get("orderKey"):
                            item["orderKey"] = msg["orderKey"]
                        if msg.get("stopReason"):
                            item["stopReason"] = msg["stopReason"]
                        if msg.get("toolUseResult"):
                            item["toolUseResult"] = json.dumps(msg["toolUseResult"], ensure_ascii=False)
                        batch.put_item(Item=item)
                persisted = True
                break
            except Exception as e:
                if attempt == 0:
                    print(f"DDB write error (retrying): {e}")
                else:
                    print(f"DDB write error (gave up): {e}")
        if not persisted:
            # Do not ack: the Bridge will time out and persist the same
            # deterministic rows through the HTTP fallback before advancing.
            return {"statusCode": 500}

    # Ack back to bridge so it can advance synced position
    ack = {
        "action": "messages_ack",
        "sessionId": session_id,
    }
    if body.get("deliveryId"):
        ack["deliveryId"] = body["deliveryId"]
    _post_to_connection(endpoint, bridge_connection_id, ack)

    return {"statusCode": 200}


def _handle_sync_complete(body, account_id, endpoint):
    """Bridge completed on-demand sync — broadcast to account apps.
    Not subscription-based: the app's subscribe may not have landed in DDB yet
    (sync_complete can return within the WS handshake window), which would drop
    the message and leave the app on the skeleton forever."""
    session_id = body.get("sessionId", "")
    if not session_id:
        return {"statusCode": 400}

    for item in _query_connections(account_id, "app"):
        _post_to_connection(endpoint, item["connectionId"], {
            "action": "sync_complete",
            "sessionId": session_id,
            "status": body.get("status", "ok"),
            "count": body.get("count", 0),
        })

    return {"statusCode": 200}


def _handle_bridge_broadcast(body, account_id, bridge_connection_id, endpoint):
    """Bridge sends a result — broadcast to all app connections for this account."""
    for item in _query_connections(account_id, "app"):
        _post_to_connection(endpoint, item["connectionId"], body)
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


def notify_bridge_sync(session_id, account_id, endpoint, device=None):
    """Called by REST API to trigger bridge sync via WS. Sends sync_session only to
    the matching device's bridge (if device given), else all bridges."""
    _init()
    for item in _query_connections(account_id, "bridge"):
        if device and item.get("deviceName", "") != device:
            continue
        _post_to_connection(endpoint, item["connectionId"], {
            "action": "sync_session",
            "sessionId": session_id,
            **_runtime_session_fields(session_id),
        })
