import re
import uuid


def handle_tool_details(body, role, connection_id, account_id, endpoint, *,
                        query_connections, post_to_connection, connections_table):
    if role == "app":
        try:
            uuid.UUID(body.get("requestId", ""))
            session_id = body.get("sessionId", "")
            parent, separator, agent = session_id.removeprefix("codex:").partition(":subagent:")
            uuid.UUID(parent)
            if separator and (session_id.startswith("codex:")
                              or not re.fullmatch(r"agent-[A-Za-z0-9_-]+", agent)):
                return {"statusCode": 400}
        except (ValueError, TypeError, AttributeError):
            return {"statusCode": 400}
        tool_ids = body.get("toolUseIds")
        device = body.get("device")
        if not isinstance(tool_ids, list) or not 0 < len(tool_ids) <= 128 \
                or any(not isinstance(value, str) or not 0 < len(value) <= 512 for value in tool_ids) \
                or not isinstance(device, str) or not device:
            return {"statusCode": 400}
        payload = {
            "action": "tool_details", "requestId": body["requestId"],
            "sessionId": body["sessionId"], "toolUseIds": tool_ids,
            "replyConnectionId": connection_id,
        }
        for bridge in query_connections(account_id, "bridge"):
            if bridge.get("deviceName") == device:
                if post_to_connection(endpoint, bridge["connectionId"], payload) is not False:
                    return {"statusCode": 200}
        post_to_connection(endpoint, connection_id, {
            "action": "tool_details", "requestId": body["requestId"],
            "ok": False, "error": "Device is offline.",
        })
        return {"statusCode": 200}

    if role != "bridge":
        return {"statusCode": 403}
    reply_id = body.get("replyConnectionId")
    if not reply_id:
        return {"statusCode": 400}
    target = connections_table.get_item(Key={"connectionId": reply_id}).get("Item", {})
    if target.get("role") != "app" or target.get("accountId") != account_id:
        return {"statusCode": 403}
    payload = {key: value for key, value in body.items() if key != "replyConnectionId"}
    post_to_connection(endpoint, reply_id, payload)
    return {"statusCode": 200}
