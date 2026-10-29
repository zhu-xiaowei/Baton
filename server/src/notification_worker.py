"""DynamoDB session transitions and asynchronous approval events -> APNs/feed."""
import json
import logging
import os
import re
import time

import boto3
from boto3.dynamodb.conditions import Key
from boto3.dynamodb.types import TypeDeserializer
from botocore.exceptions import ClientError

from notification_store import digest, table
from message_history import history_partition

logger = logging.getLogger(__name__)
decoder = TypeDeserializer()


def effective_status(item):
    active = item.get("activeStatus", "")
    if active:
        return "completed" if active.startswith("done#") else active
    if item.get("status") == "needs_input" or int(item.get("needsInputAgentCount", 0)) > 0:
        return "needs_input"
    if item.get("status") == "running" or int(item.get("runningAgentCount", 0)) > 0:
        return "running"
    return "completed"


def session_event(old, new, event_id):
    if not old or not new or new.get("entityType") != "session" or new.get("parentSessionId"):
        return None
    before, after = effective_status(old), effective_status(new)
    if before == after:
        return None
    if after == "completed" and before == "running":
        kind = "completed"
    elif after == "needs_input":
        kind = "needs_input"
    else:
        return None
    return make_event(new, kind, f"session:{event_id}")


def make_event(session, kind, identity, request_id="", interaction="", detail=""):
    session_title = " ".join(str(session.get("preview") or session.get("agentName") or "").split())
    session_title = session_title[:120] or f'Session {session["sessionId"].removeprefix("codex:")[:8]}'
    project_name = (session.get("projectName") or session["projectHash"])[:80]
    action = "Run finished"
    if kind == "needs_input":
        action = {
            "tool": "Approval needed", "plan": "Plan approval needed",
            "ask": "Your answer is needed",
        }.get(interaction, "Your input is needed")
    return {
        "eventId": digest(identity),
        "kind": kind,
        "accountId": session["accountId"],
        "device": session["deviceName"],
        "projectHash": session["projectHash"],
        "projectName": project_name,
        "sessionTitle": session_title,
        "sessionId": session["sessionId"],
        "rootSessionId": session.get("threadRootId") or session["sessionId"],
        "requestId": request_id,
        "title": f"{project_name} · {session_title}",
        "body": f'{action}' + (f': {detail}' if detail else '') + f' · {session["deviceName"]}',
    }


def find_session(account_id, device, session_id):
    sessions = boto3.resource("dynamodb").Table(os.environ["BRIDGE_SESSIONS_TABLE"])
    kwargs = {
        "KeyConditionExpression": Key("accountId").eq(account_id)
        & Key("sk").begins_with(f"SESS#{device}#"),
        "ConsistentRead": True,
    }
    while True:
        result = sessions.query(**kwargs)
        for session in result.get("Items", []):
            if session.get("sessionId") == session_id:
                return session
        if "LastEvaluatedKey" not in result:
            return None
        kwargs["ExclusiveStartKey"] = result["LastEvaluatedKey"]


def permission_event(event):
    session = find_session(event["accountId"], event["device"], event["sessionId"])
    if not session:
        # Status persistence and the WS request can race; let Lambda retry.
        raise RuntimeError("Approval session is not persisted yet.")
    # A fresh authenticated request is authoritative: its separate REST status
    # write may still be in flight. On retry, suppress requests already resolved.
    if effective_status(session) != "needs_input" and time.time() - event.get("createdAt", 0) > 15:
        return None
    identity = ":".join([event["accountId"], event["device"], event["sessionId"], event["requestId"]])
    return make_event(session, "needs_input", identity, event["requestId"],
                      event.get("interaction", ""), event.get("detail", ""))


def text_summary(content):
    if isinstance(content, str):
        try:
            content = json.loads(content)
        except (ValueError, TypeError):
            pass
    if isinstance(content, list):
        content = " ".join(
            str(block.get("text", "")) for block in content
            if isinstance(block, dict) and block.get("type") == "text"
        )
    if not isinstance(content, str):
        return ""
    # Retain readable text and code; omit Markdown decoration in a compact alert.
    content = re.sub(r"(?m)^#{1,6}\s+|`|\*\*", "", content)
    return re.sub(r"\s+", " ", content).strip()[:240]


def completion_summary(session):
    messages = boto3.resource("dynamodb").Table(os.environ["BRIDGE_MESSAGES_TABLE"])
    partition = history_partition(messages, session["sessionId"])
    result = messages.query(
        KeyConditionExpression=Key("sessionId").eq(partition),
        ScanIndexForward=False, Limit=20, ConsistentRead=True,
    )
    for message in result.get("Items", []):
        if message.get("type") == "user":
            break  # Never use a previous turn's answer.
        if message.get("type") == "assistant":
            summary = text_summary(message.get("content", ""))
            if summary:
                return summary
    return ""


def wait_key(event):
    return {
        "pk": f'NOTIFICATIONS#{event["accountId"]}',
        "sk": "WAIT#" + digest(f'{event["device"]}:{event["rootSessionId"]}'),
    }


def claim_attention(event):
    """Coalesce a status transition and its matching request, not later requests."""
    if event["kind"] != "needs_input":
        return True
    storage = table()
    key = wait_key(event)
    previous = storage.get_item(Key=key, ConsistentRead=True).get("Item", {})
    if previous.get("ttl", 0) <= time.time():
        previous = {}
    if previous.get("eventId") == event["eventId"]:
        return True  # A delivery retry for the canonical event.
    request_id = event["requestId"]
    if previous and (not request_id or request_id == previous.get("requestId")):
        return False
    if previous and not previous.get("requestId") and time.time() - previous.get("createdAt", 0) < 10:
        storage.update_item(
            Key=key, UpdateExpression="SET requestId = :request",
            ConditionExpression="eventId = :event AND requestId = :previous",
            ExpressionAttributeValues={
                ":request": request_id, ":event": previous["eventId"],
                ":previous": previous["requestId"],
            },
        )
        return False
    options = {
        "ConditionExpression": "attribute_not_exists(pk) OR #expires < :now",
        "ExpressionAttributeNames": {"#expires": "ttl"},
        "ExpressionAttributeValues": {":now": int(time.time())},
    }
    if previous:
        options = {"ConditionExpression": "eventId = :previous",
                   "ExpressionAttributeValues": {":previous": previous["eventId"]}}
    storage.put_item(
        Item={**key, "eventId": event["eventId"], "requestId": request_id,
              "createdAt": int(time.time()), "ttl": int(time.time()) + 86400},
        **options,
    )
    return True


def store_event(event):
    storage = table()
    key = {"pk": f'NOTIFICATIONS#{event["accountId"]}', "sk": f'NOTICE#{event["eventId"]}'}
    now = int(time.time())
    row = {**key, "event": event, "createdMs": int(time.time() * 1000), "ttl": now + 86400}
    try:
        storage.put_item(Item=row, ConditionExpression="attribute_not_exists(pk)")
    except ClientError as error:
        if error.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
        row = storage.get_item(Key=key, ConsistentRead=True)["Item"]
    storage.put_item(Item={
        **row, "sk": f'EVENT#{int(row["createdMs"]):016d}#{event["eventId"]}',
    })
    return row


def devices(account_id):
    kwargs = {"KeyConditionExpression": Key("pk").eq("PUSH_DEVICE"), "ConsistentRead": True}
    while True:
        result = table().query(**kwargs)
        for device in result.get("Items", []):
            if device.get("accountId") == account_id and int(device.get("ttl", 0)) > time.time():
                yield device
        if "LastEvaluatedKey" not in result:
            break
        kwargs["ExclusiveStartKey"] = result["LastEvaluatedKey"]


def deliver(event):
    if not claim_attention(event):
        return
    row = store_event(event)
    # Old stream retries must not surface as fresh alerts.
    if int(row["ttl"]) <= time.time():
        return
    event = row["event"]
    for device in devices(event["accountId"]):
        preference = "completed" if event["kind"] == "completed" else "needsInput"
        if not device.get(preference, True):
            continue
        send_apns(event, device)


def send_apns(event, device):
    storage = table()
    key = {
        "pk": f'NOTIFICATIONS#{event["accountId"]}',
        "sk": f'DELIVERY#{event["eventId"]}#{device["sk"]}',
    }
    # Recheck binding just before delivery, so logout/account switches retire
    # events still queued in the worker.
    current = storage.get_item(
        Key={"pk": "PUSH_DEVICE", "sk": device["sk"]}, ConsistentRead=True,
    ).get("Item", {})
    if current.get("accountId") != event["accountId"] or current.get("token") != device["token"]:
        return
    owner = storage.get_item(
        Key={"pk": "PUSH_ENDPOINT", "sk": digest(f'{device["environment"]}:{device["token"]}')},
        ConsistentRead=True,
    ).get("Item", {})
    if owner.get("accountId") != event["accountId"] or owner.get("installationId") != device["sk"]:
        return
    previous = storage.get_item(Key=key, ConsistentRead=True).get("Item", {})
    if previous.get("sent"):
        return
    try:
        storage.put_item(
            Item={**key, "leaseUntil": int(time.time()) + 45, "ttl": int(time.time()) + 86400},
            ConditionExpression="attribute_not_exists(pk) OR leaseUntil < :now",
            ExpressionAttributeValues={":now": int(time.time())},
        )
    except ClientError as error:
        if error.response["Error"]["Code"] == "ConditionalCheckFailedException":
            raise RuntimeError("Notification delivery is already in progress.") from error
        raise
    payload = {key: str(value) for key, value in event.items()}
    payload["aps"] = {
        "alert": {"title": event["title"], "body": event["body"]},
        "sound": "default",
        "thread-id": event["rootSessionId"],
    }
    try:
        response = boto3.client("lambda").invoke(
            FunctionName=os.environ["APNS_SENDER_FUNCTION"],
            InvocationType="RequestResponse",
            Payload=json.dumps({
                "token": device["token"], "environment": device["environment"],
                "eventId": event["eventId"], "payload": payload,
            }).encode(),
        )
        result = json.loads(response["Payload"].read())
        if response.get("FunctionError"):
            raise RuntimeError("APNs transport failed")
        if result.get("status") != 200:
            if result.get("reason") in ("BadDeviceToken", "Unregistered"):
                storage.delete_item(
                    Key={"pk": "PUSH_DEVICE", "sk": device["sk"]},
                    ConditionExpression="#token = :token",
                    ExpressionAttributeNames={"#token": "token"},
                    ExpressionAttributeValues={":token": device["token"]},
                )
            else:
                raise RuntimeError(f'APNs rejected notification: {result.get("reason", "unknown")}')
    except Exception as error:
        storage.delete_item(Key=key)
        raise
    storage.put_item(Item={**key, "sent": True, "ttl": int(time.time()) + 86400})


def handler(event, _context):
    if event.get("kind") == "permission":
        notification = permission_event(event)
        if notification:
            deliver(notification)
        return
    failures = []
    for record in event.get("Records", []):
        try:
            if record.get("eventName") != "MODIFY":
                continue
            stream = record["dynamodb"]
            old = {key: decoder.deserialize(value) for key, value in stream["OldImage"].items()}
            new = {key: decoder.deserialize(value) for key, value in stream["NewImage"].items()}
            if (new.get("entityType") == "session" and not new.get("parentSessionId")
                    and effective_status(new) != "needs_input"):
                table().delete_item(Key=wait_key(make_event(new, "completed", "reset")))
            notification = session_event(old, new, record["eventID"])
            if notification:
                detail = completion_summary(new) if notification["kind"] == "completed" else new.get("agentDetail", "")
                if detail:
                    notification["body"] = notification["body"].split(" · ")[0] + f': {text_summary(detail)} · {new["deviceName"]}'
                deliver(notification)
        except Exception:
            logger.exception("Notification delivery failed")
            failures.append({"itemIdentifier": record["dynamodb"]["SequenceNumber"]})
    return {"batchItemFailures": failures}
