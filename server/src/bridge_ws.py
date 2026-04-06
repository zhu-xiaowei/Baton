"""
WebSocket handler for AgentPeek — manages connections, subscriptions, and message relay.
Deployed as a standalone Lambda (not in Docker), invoked by WebSocket API Gateway.
"""

import json
import os
import time
import hashlib
import boto3

_ddb = None
_connections_table = None
_subscriptions_table = None
_messages_table = None
_apigw = None


def _init():
    global _ddb, _connections_table, _subscriptions_table, _messages_table
    if _ddb is None:
        _ddb = boto3.resource("dynamodb", region_name=os.environ.get("AWS_REGION", "us-west-2"))
        _connections_table = _ddb.Table(os.environ["CONNECTIONS_TABLE"])
        _subscriptions_table = _ddb.Table(os.environ["SUBSCRIPTIONS_TABLE"])
        _messages_table = _ddb.Table(os.environ.get("BRIDGE_MESSAGES_TABLE", ""))


def _apigw_client(endpoint):
    global _apigw
    if _apigw is None:
        _apigw = boto3.client("apigatewaymanagementapi", endpoint_url=endpoint)
    return _apigw


def _account_id(api_key):
    return hashlib.sha256(api_key.encode()).hexdigest()[:16]


def _post_to_connection(endpoint, connection_id, data):
    """Send data to a WebSocket connection. Returns False if connection is gone."""
    client = _apigw_client(endpoint)
    try:
        client.post_to_connection(ConnectionId=connection_id, Data=json.dumps(data).encode())
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
        return _handle_disconnect(connection_id)
    elif route == "$default":
        return _handle_message(event, connection_id, endpoint)

    return {"statusCode": 400}


def _handle_connect(event, connection_id):
    """Store connection in DDB."""
    qs = event.get("queryStringParameters") or {}
    api_key = qs.get("apiKey", "")
    role = qs.get("role", "app")  # "app" or "bridge"

    if not api_key:
        return {"statusCode": 401}

    account_id = _account_id(api_key)
    ttl = int(time.time()) + 86400  # 24h

    _connections_table.put_item(Item={
        "connectionId": connection_id,
        "accountId": account_id,
        "role": role,
        "connectedAt": int(time.time()),
        "ttl": ttl,
    })

    return {"statusCode": 200}


def _handle_disconnect(connection_id):
    """Remove connection + any subscriptions."""
    try:
        _connections_table.delete_item(Key={"connectionId": connection_id})
    except Exception:
        pass

    # Clean up subscriptions (scan is OK here — low volume, only on disconnect)
    try:
        resp = _subscriptions_table.scan(
            FilterExpression="connectionId = :cid",
            ExpressionAttributeValues={":cid": connection_id},
        )
        for item in resp.get("Items", []):
            _subscriptions_table.delete_item(Key={
                "sessionId": item["sessionId"],
                "connectionId": connection_id,
            })
    except Exception:
        pass

    return {"statusCode": 200}


def _handle_message(event, connection_id, endpoint):
    """Route messages by action."""
    try:
        body = json.loads(event.get("body", "{}"))
    except json.JSONDecodeError:
        return {"statusCode": 400}

    action = body.get("action", "")

    # Get connection info
    conn = _connections_table.get_item(Key={"connectionId": connection_id}).get("Item")
    if not conn:
        return {"statusCode": 401}

    role = conn.get("role", "app")
    account_id = conn.get("accountId", "")

    if action == "subscribe":
        return _handle_subscribe(body, connection_id, account_id, endpoint)
    elif action == "unsubscribe":
        return _handle_unsubscribe(body, connection_id)
    elif action == "messages":
        if role == "bridge":
            return _handle_bridge_messages(body, connection_id, account_id, endpoint)
    elif action == "sync_complete":
        if role == "bridge":
            return _handle_sync_complete(body, account_id, endpoint)
    elif action == "permission_request":
        if role == "bridge":
            return _handle_bridge_relay(body, connection_id, endpoint)
    elif action == "send_message":
        if role == "app":
            return _handle_send_message(body, account_id, endpoint)
    elif action == "new_session":
        if role == "app":
            return _handle_send_to_bridge(body, account_id, endpoint, "new_session")
    elif action == "permission_reply":
        if role == "app":
            return _handle_send_to_bridge(body, account_id, endpoint, "permission_reply")
    elif action == "heartbeat":
        # Update TTL
        _connections_table.update_item(
            Key={"connectionId": connection_id},
            UpdateExpression="SET #t = :ttl",
            ExpressionAttributeNames={"#t": "ttl"},
            ExpressionAttributeValues={":ttl": int(time.time()) + 86400},
        )
        _post_to_connection(endpoint, connection_id, {"action": "heartbeat", "ts": int(time.time())})
        return {"statusCode": 200}

    return {"statusCode": 200}


def _handle_subscribe(body, connection_id, account_id, endpoint):
    """App subscribes to a session."""
    session_id = body.get("sessionId", "")
    if not session_id:
        return {"statusCode": 400}

    _subscriptions_table.put_item(Item={
        "sessionId": session_id,
        "connectionId": connection_id,
        "accountId": account_id,
        "subscribedAt": int(time.time()),
        "ttl": int(time.time()) + 86400,
    })

    return {"statusCode": 200}


def _handle_unsubscribe(body, connection_id):
    """App unsubscribes from a session."""
    session_id = body.get("sessionId", "")
    if not session_id:
        return {"statusCode": 400}

    _subscriptions_table.delete_item(Key={
        "sessionId": session_id,
        "connectionId": connection_id,
    })

    return {"statusCode": 200}


def _handle_bridge_messages(body, bridge_connection_id, account_id, endpoint):
    """Bridge pushes new messages — relay to subscribed apps + write DDB."""
    session_id = body.get("sessionId", "")
    messages = body.get("messages", [])
    if not session_id or not messages:
        return {"statusCode": 400}

    # 1. Relay to subscribed apps (priority — low latency)
    subs = _subscriptions_table.query(
        KeyConditionExpression=boto3.dynamodb.conditions.Key("sessionId").eq(session_id),
    ).get("Items", [])

    for sub in subs:
        cid = sub.get("connectionId", "")
        if cid and cid != bridge_connection_id:
            _post_to_connection(endpoint, cid, {
                "action": "messages",
                "sessionId": session_id,
                "messages": messages,
            })

    # 2. Write to DDB (cache)
    if _messages_table:
        try:
            from datetime import datetime
            with _messages_table.batch_writer() as batch:
                for msg in messages:
                    uuid = msg.get("uuid", "")
                    if not uuid:
                        continue
                    timestamp = msg.get("timestamp", datetime.utcnow().isoformat())
                    batch.put_item(Item={
                        "sessionId": session_id,
                        "sk": f"{timestamp}#{uuid}",
                        "uuid": uuid,
                        "type": msg.get("type", ""),
                        "content": json.dumps(msg.get("content", ""), ensure_ascii=False),
                        "timestamp": timestamp,
                    })
        except Exception as e:
            print(f"DDB write error: {e}")

    return {"statusCode": 200}


def _handle_sync_complete(body, account_id, endpoint):
    """Bridge completed on-demand sync — notify subscribed apps."""
    session_id = body.get("sessionId", "")
    if not session_id:
        return {"statusCode": 400}

    subs = _subscriptions_table.query(
        KeyConditionExpression=boto3.dynamodb.conditions.Key("sessionId").eq(session_id),
    ).get("Items", [])

    for sub in subs:
        _post_to_connection(endpoint, sub["connectionId"], {
            "action": "sync_complete",
            "sessionId": session_id,
            "status": body.get("status", "ok"),
            "count": body.get("count", 0),
        })

    return {"statusCode": 200}


def _handle_bridge_relay(body, bridge_connection_id, endpoint):
    """Bridge pushes a notification (e.g. permission_request) — relay to subscribed apps."""
    session_id = body.get("sessionId", "")
    if not session_id:
        return {"statusCode": 400}

    subs = _subscriptions_table.query(
        KeyConditionExpression=boto3.dynamodb.conditions.Key("sessionId").eq(session_id),
    ).get("Items", [])

    for sub in subs:
        cid = sub.get("connectionId", "")
        if cid and cid != bridge_connection_id:
            _post_to_connection(endpoint, cid, body)

    return {"statusCode": 200}


def _handle_send_message(body, account_id, endpoint):
    """App sends a message to Claude Code via bridge — forward to bridge connection."""
    session_id = body.get("sessionId", "")
    text = body.get("text", "")
    if not session_id or not text:
        return {"statusCode": 400}
    return _handle_send_to_bridge(body, account_id, endpoint, "send_message")


def _handle_send_to_bridge(body, account_id, endpoint, action):
    """Forward an action to bridge connection(s) for this account."""
    body["action"] = action
    resp = _connections_table.scan(
        FilterExpression="accountId = :aid AND #r = :role",
        ExpressionAttributeNames={"#r": "role"},
        ExpressionAttributeValues={":aid": account_id, ":role": "bridge"},
    )
    for item in resp.get("Items", []):
        _post_to_connection(endpoint, item["connectionId"], body)
    return {"statusCode": 200}


def notify_bridge_sync(session_id, account_id, endpoint):
    """Called by REST API to trigger bridge sync via WS. Finds bridge connection and sends sync_session."""
    _init()
    # Find bridge connections for this account
    resp = _connections_table.scan(
        FilterExpression="accountId = :aid AND #r = :role",
        ExpressionAttributeNames={"#r": "role"},
        ExpressionAttributeValues={":aid": account_id, ":role": "bridge"},
    )
    for item in resp.get("Items", []):
        _post_to_connection(endpoint, item["connectionId"], {
            "action": "sync_session",
            "sessionId": session_id,
        })
