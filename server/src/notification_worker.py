"""BridgeSessions stream -> the Android feed and, through the push relay, APNs.

Bridge writes every approval as `needs_input` + `agentDetail` on the session row, so
status transitions alone cover finished runs, approvals and questions.
"""
import hashlib
import json
import logging
import os
import re
import time
import urllib.error
import urllib.request

import boto3
from boto3.dynamodb.conditions import Key
from boto3.dynamodb.types import TypeDeserializer

from message_history import history_partition

logger = logging.getLogger(__name__)
_decoder = TypeDeserializer()
_ddb = boto3.resource("dynamodb")


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


def completion_summary(session, attempts=3):
    """The finished turn's last reply, or None when the user interrupted it."""
    messages = _ddb.Table(os.environ["BRIDGE_MESSAGES_TABLE"])
    partition = history_partition(messages, session["sessionId"])
    summary = ""
    for attempt in range(attempts):
        if attempt:
            time.sleep(1)  # The final reply is persisted separately from the status.
        summary = ""
        result = messages.query(
            KeyConditionExpression=Key("sessionId").eq(partition),
            ScanIndexForward=False, Limit=20, ConsistentRead=True,
        )
        for message in result.get("Items", []):
            if message.get("type") == "user":
                if text_summary(message.get("content", "")).startswith("[Request interrupted"):
                    return None
                break  # Never show a previous turn's answer.
            if message.get("type") == "assistant":
                text = text_summary(message.get("content", ""))
                if text and message.get("stopReason") == "end_turn":
                    return text
                summary = summary or text
    return summary


def being_viewed(event, timeout=2.0):
    """Ask apps subscribed to the session; any visible, focused viewer suppresses the alert.

    Subscriptions outlive suspended iOS sockets, so only an explicit reply counts.
    """
    subscriptions = _ddb.Table(os.environ["SUBSCRIPTIONS_TABLE"])
    key = Key("sessionId").eq("ROOT#" + event["rootSessionId"])
    rows = [row for row in subscriptions.query(KeyConditionExpression=key)["Items"]
            if row.get("accountId") == event["accountId"]]
    if not rows:
        return False
    api = boto3.client("apigatewaymanagementapi", endpoint_url=os.environ["WS_API_ENDPOINT"])
    probe = json.dumps({"action": "notify_check", "rootSessionId": event["rootSessionId"],
                        "eventId": event["eventId"]}).encode()
    for row in rows:
        try:
            api.post_to_connection(ConnectionId=row["connectionId"], Data=probe)
        except Exception:
            pass  # A gone connection is not viewing.
    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(0.25)
        rows = subscriptions.query(KeyConditionExpression=key, ConsistentRead=True)["Items"]
        if any(row.get("seenEvent") == event["eventId"] for row in rows):
            return True
    return False


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
        if detail is None:
            return None  # The user stopped it, so they already know.
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
    if being_viewed(event):
        return
    table = _ddb.Table(os.environ["SYSTEM_TABLE"])
    now = time.time()
    table.put_item(Item={
        "pk": f'NOTIFICATIONS#{event["accountId"]}',
        "sk": f'EVENT#{int(now * 1000):016d}#{event["eventId"]}',
        "event": event, "ttl": int(now) + 86400,
    })
    if not os.environ.get("PUSH_RELAY_URL"):
        return
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
    result = relay({"token": token, "environment": environment,
                    "eventId": event["eventId"], "payload": payload})
    if result.get("status") == 200:
        return
    if result.get("reason") in ("BadDeviceToken", "Unregistered"):
        table.delete_item(Key={"pk": "PUSH_DEVICE", "sk": device["sk"]})
        return
    raise RuntimeError(f'APNs rejected notification: {result.get("reason", "unknown")}')


def relay(request, attempts=3):
    """POST one alert to the shared APNs relay (relay/); it returns APNs' status and reason."""
    body = json.dumps(request).encode()
    for attempt in range(attempts):
        if attempt:
            time.sleep(1)  # The relay rejects (429) rather than queues past its concurrency.
        try:
            with urllib.request.urlopen(urllib.request.Request(
                os.environ["PUSH_RELAY_URL"], data=body, method="POST",
                headers={"content-type": "application/json"},
            ), timeout=15) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as error:
            if error.code != 429 and error.code < 500:
                raise RuntimeError(f"Push relay rejected the alert ({error.code})") from error
        except urllib.error.URLError:
            pass
    raise RuntimeError("Push relay unavailable")


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
