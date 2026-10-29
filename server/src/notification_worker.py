"""BridgeSessions stream -> APNs and the foreground Android feed.

Bridge writes every approval as `needs_input` + `agentDetail` on the session row, so
status transitions alone cover finished runs, approvals and questions.
"""
import hashlib
import json
import logging
import os
import re
import time

import boto3
from boto3.dynamodb.conditions import Key
from boto3.dynamodb.types import TypeDeserializer

from message_history import history_partition

logger = logging.getLogger(__name__)
_decoder = TypeDeserializer()
_ddb = boto3.resource("dynamodb")
_lambda = boto3.client("lambda")


def status(item):
    value = item.get("activeStatus") or item.get("status", "")
    return value if value in ("running", "needs_input") else "completed"


def text_summary(content):
    if isinstance(content, str):
        try:
            content = json.loads(content)
        except ValueError:
            pass
    if isinstance(content, list):
        content = " ".join(
            str(block.get("text", "")) for block in content
            if isinstance(block, dict) and block.get("type") == "text"
        )
    if not isinstance(content, str):
        return ""
    content = re.sub(r"(?m)^#{1,6}\s+|`|\*\*", "", content)
    return re.sub(r"\s+", " ", content).strip()[:240]


def completion_summary(session):
    messages = _ddb.Table(os.environ["BRIDGE_MESSAGES_TABLE"])
    result = messages.query(
        KeyConditionExpression=Key("sessionId").eq(history_partition(messages, session["sessionId"])),
        ScanIndexForward=False, Limit=20, ConsistentRead=True,
    )
    for message in result.get("Items", []):
        if message.get("type") == "user":
            break  # Never show a previous turn's answer.
        if message.get("type") == "assistant":
            summary = text_summary(message.get("content", ""))
            if summary:
                return summary
    return ""


def notification(old, new, event_id):
    if not old or new.get("parentSessionId"):
        return None  # Subagent threads surface through their root row.
    before, after = status(old), status(new)
    if after == "needs_input":
        # A queued next approval changes the detail without leaving needs_input.
        if before == after and old.get("agentDetail", "") == new.get("agentDetail", ""):
            return None
        kind, action, detail = "needs_input", "Needs input", text_summary(new.get("agentDetail", ""))
    elif after == "completed" and before == "running":
        kind, action, detail = "completed", "Finished", completion_summary(new)
    else:
        return None
    session_id = new["sessionId"]
    # Alerts are narrow: the folder name, not the whole path.
    folder = (new.get("projectName") or "").replace("\\", "/").rstrip("/").rsplit("/", 1)[-1]
    project = (folder or new["projectHash"])[:80]
    title = " ".join(str(new.get("preview") or new.get("agentName") or "").split())[:120]
    title = title or f'Session {session_id.removeprefix("codex:")[:8]}'
    return {
        "eventId": hashlib.sha256(event_id.encode()).hexdigest(),
        "kind": kind,
        "accountId": new["accountId"],
        "device": new["deviceName"],
        "projectHash": new["projectHash"],
        "projectName": project,
        "sessionId": session_id,
        "sessionTitle": title,
        "rootSessionId": new.get("threadRootId") or session_id,
        "title": f"{project} · {title}",
        "body": action + (f": {detail}" if detail else ""),
    }


def deliver(event):
    table = _ddb.Table(os.environ["SYSTEM_TABLE"])
    now = time.time()
    table.put_item(Item={
        "pk": f'NOTIFICATIONS#{event["accountId"]}',
        "sk": f'EVENT#{int(now * 1000):016d}#{event["eventId"]}',
        "event": event, "ttl": int(now) + 86400,
    })
    devices = table.query(KeyConditionExpression=Key("pk").eq("PUSH_DEVICE"), ConsistentRead=True)
    for device in devices.get("Items", []):
        if device.get("accountId") == event["accountId"] and int(device.get("ttl", 0)) > now:
            send_apns(table, event, device)


def send_apns(table, event, device):
    environment, token = device["sk"].split(":", 1)
    payload = {key: str(value) for key, value in event.items() if key not in ("title", "body")}
    payload["aps"] = {
        "alert": {"title": event["title"], "body": event["body"]},
        "sound": "default",
        "thread-id": event["rootSessionId"],
    }
    response = _lambda.invoke(
        FunctionName=os.environ["APNS_SENDER_FUNCTION"],
        Payload=json.dumps({
            "token": token, "environment": environment,
            "eventId": event["eventId"], "payload": payload,
        }).encode(),
    )
    if response.get("FunctionError"):
        raise RuntimeError("APNs transport failed")
    result = json.loads(response["Payload"].read())
    if result.get("status") == 200:
        return
    if result.get("reason") in ("BadDeviceToken", "Unregistered"):
        table.delete_item(Key={"pk": "PUSH_DEVICE", "sk": device["sk"]})
        return
    raise RuntimeError(f'APNs rejected notification: {result.get("reason", "unknown")}')


def _image(record, name):
    return {key: _decoder.deserialize(value) for key, value in record["dynamodb"].get(name, {}).items()}


def handler(event, _context):
    failures = []
    for record in event.get("Records", []):
        try:
            notice = notification(_image(record, "OldImage"), _image(record, "NewImage"), record["eventID"])
            if notice:
                deliver(notice)
        except Exception:
            # A retry may repeat an alert; apns-collapse-id makes the device replace it.
            logger.exception("Notification delivery failed")
            failures.append({"itemIdentifier": record["dynamodb"]["SequenceNumber"]})
    return {"batchItemFailures": failures}
