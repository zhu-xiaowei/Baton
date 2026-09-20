import uuid


ALLOWED_OPERATIONS = {"list", "read", "download"}


def _valid_request(body):
    if body.get("operation") not in ALLOWED_OPERATIONS:
        return False
    if not body.get("projectHash") or not body.get("requestId"):
        return False
    try:
        uuid.UUID(body["requestId"])
    except (ValueError, TypeError, AttributeError):
        return False
    return True


def handle_project_files(
    body,
    role,
    connection_id,
    account_id,
    endpoint,
    *,
    query_connections,
    post_to_connection,
    connections_table,
):
    if role == "app":
        if not _valid_request(body):
            return {"statusCode": 400}
        device = body.get("device", "")
        payload = {
            "action": "project_files",
            "operation": body["operation"],
            "requestId": body["requestId"],
            "projectHash": body["projectHash"],
            "path": body.get("path", ""),
            "replyConnectionId": connection_id,
        }
        if body.get("cursor"):
            payload["cursor"] = body["cursor"]
        delivered = 0
        for item in query_connections(account_id, "bridge"):
            if device and item.get("deviceName", "") != device:
                continue
            if post_to_connection(endpoint, item["connectionId"], payload) is not False:
                delivered += 1
        if delivered == 0:
            post_to_connection(endpoint, connection_id, {
                "action": "project_files",
                "operation": body["operation"],
                "requestId": body["requestId"],
                "ok": False,
                "error": "Bridge offline",
            })
        return {"statusCode": 200}

    if role != "bridge":
        return {"statusCode": 200}
    reply_connection_id = body.get("replyConnectionId", "")
    if not reply_connection_id:
        return {"statusCode": 400}
    connection = connections_table.get_item(
        Key={"connectionId": reply_connection_id},
    ).get("Item")
    if not connection \
            or connection.get("role") != "app" \
            or connection.get("accountId") != account_id:
        return {"statusCode": 200}
    payload = dict(body)
    payload.pop("replyConnectionId", None)
    post_to_connection(endpoint, reply_connection_id, payload)
    return {"statusCode": 200}
