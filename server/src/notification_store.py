"""Notification primitives shared by the API and dependency-free Lambda ZIP."""
import hashlib
import json
import os
import time

import boto3


def table():
    return boto3.resource("dynamodb").Table(os.environ["SYSTEM_TABLE"])


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def apns_configured():
    return bool(os.environ.get("APNS_KEY_SECRET_ARN"))


def enqueue_permission(body, account_id, device):
    """Called only for authenticated Bridge events, never for app input."""
    function = os.environ.get("NOTIFICATION_FUNCTION", "")
    if not function or not body.get("requestId") or not device:
        return
    boto3.client("lambda").invoke(
        FunctionName=function, InvocationType="Event",
        Payload=json.dumps({
            "kind": "permission", "accountId": account_id, "device": device,
            "sessionId": body["sessionId"], "requestId": body["requestId"],
            "interaction": body.get("kind", "tool"),
            "detail": permission_detail(body),
            "createdAt": int(time.time()),
        }).encode(),
    )


def permission_detail(body):
    source = body.get("input") or {}
    if not isinstance(source, dict):
        source = {}
    questions = body.get("questions") or source.get("questions") or []
    if questions and isinstance(questions[0], dict):
        detail = questions[0].get("question", "")
    else:
        detail = (source.get("command") or source.get("file_path") or source.get("path")
                  or body.get("plan") or source.get("plan") or body.get("toolName") or "")
    return " ".join(str(detail).split())[:240]
