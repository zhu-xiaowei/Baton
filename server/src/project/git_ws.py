import re
import uuid


ALLOWED_OPERATIONS = {
    "status", "stage", "unstage", "discard", "diff",
    "refs", "history", "commit_files", "commit", "push",
}
NO_FIELD_OPERATIONS = {"status", "refs", "push"}
OID_PATTERN = re.compile(r"^[0-9a-f]{40}([0-9a-f]{24})?$")
MAX_HEADS = 256
MAX_SKIP = 2000
MAX_LIMIT = 100
MAX_COMMIT_MESSAGE_BYTES = 16 * 1024
ALLOWED_GROUPS = {"conflicts", "staged", "changes"}
MUTATION_GROUPS = {
    "stage": {"changes", "conflicts"},
    "unstage": {"staged"},
    "discard": {"changes"},
}


def _valid_uuid(value):
    try:
        uuid.UUID(value)
        return True
    except (ValueError, TypeError, AttributeError):
        return False


def _valid_path(value):
    if not isinstance(value, str) or not value or "\0" in value:
        return False
    if value.startswith(("/", "\\")) or re.match(r"^[A-Za-z]:[\\/]", value):
        return False
    return ".." not in value.replace("\\", "/").split("/")


def _valid_oid(value):
    return isinstance(value, str) and bool(OID_PATTERN.match(value))


def _valid_int(value, low, high):
    return isinstance(value, int) and not isinstance(value, bool) and low <= value <= high


def _valid_ref(value):
    return isinstance(value, str) and value.startswith(("refs/heads/", "refs/remotes/")) \
        and len(value) <= 1024 and "\0" not in value and ".." not in value


def _valid_history(body):
    scope = body.get("scope")
    if scope not in {"auto", "all", "ref"}:
        return False
    if (scope == "ref") != ("ref" in body) or ("ref" in body and not _valid_ref(body["ref"])):
        return False
    heads = body.get("heads", [])
    if not isinstance(heads, list) or len(heads) > MAX_HEADS or not all(map(_valid_oid, heads)):
        return False
    if "skip" in body and not _valid_int(body["skip"], 0, MAX_SKIP):
        return False
    return "limit" not in body or _valid_int(body["limit"], 1, MAX_LIMIT)


def _valid_commit(body):
    message = body.get("message")
    if not isinstance(message, str) or not message.strip():
        return False
    if len(message.encode("utf-8")) > MAX_COMMIT_MESSAGE_BYTES:
        return False
    return isinstance(body.get("stagedId"), str) and bool(body["stagedId"])


def _valid_request(body):
    operation = body.get("operation")
    if operation not in ALLOWED_OPERATIONS:
        return False
    if not isinstance(body.get("projectHash"), str) or not body["projectHash"]:
        return False
    if not _valid_uuid(body.get("requestId")):
        return False
    if operation in NO_FIELD_OPERATIONS:
        return True
    if operation == "history":
        return _valid_history(body)
    if operation == "commit_files":
        return _valid_oid(body.get("commitOid"))
    if operation == "commit":
        return _valid_commit(body)
    if operation == "diff":
        if not _valid_path(body.get("path")):
            return False
        if "group" in body:
            if "commitOid" in body or body["group"] not in ALLOWED_GROUPS:
                return False
        elif not _valid_oid(body.get("commitOid")):
            return False
        if body.get("diffToken"):
            cursor = body.get("cursor", "0")
            return isinstance(body["diffToken"], str) and str(cursor).isdigit()
        return not body.get("cursor")
    if body.get("group") not in MUTATION_GROUPS[operation]:
        return False
    has_path = _valid_path(body.get("path"))
    is_all = body.get("all") is True
    if has_path == is_all:
        return False
    return not is_all or (
        isinstance(body.get("snapshotId"), str) and bool(body["snapshotId"])
    )


def _request_payload(body, reply_connection_id):
    payload = {
        "action": "git_status",
        "operation": body["operation"],
        "requestId": body["requestId"],
        "projectHash": body["projectHash"],
        "replyConnectionId": reply_connection_id,
    }
    for field in (
        "group", "path", "all", "snapshotId", "diffToken", "cursor",
        "commitOid", "scope", "ref", "heads", "skip", "limit", "message", "stagedId",
    ):
        if field in body:
            payload[field] = body[field]
    return payload


def handle_git_status(
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
        payload = _request_payload(body, connection_id)
        delivered = 0
        for item in query_connections(account_id, "bridge"):
            if device and item.get("deviceName", "") != device:
                continue
            if post_to_connection(endpoint, item["connectionId"], payload) is not False:
                delivered += 1
        if delivered == 0:
            post_to_connection(endpoint, connection_id, {
                "action": "git_status",
                "operation": body["operation"],
                "requestId": body["requestId"],
                "ok": False,
                "sequence": 0,
                "chunkCount": 1,
                "complete": True,
                "errorCode": "bridge_offline",
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
