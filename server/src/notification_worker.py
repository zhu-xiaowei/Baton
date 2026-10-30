"""BridgeSessions stream -> the event feed, and an ID-only iOS push through the relay.

Bridge writes every approval as `needs_input` + `agentDetail` on the session row, so
status transitions alone cover finished runs, approvals and questions.
"""
import hashlib
import http.client
import json
import logging
import os
import random
import re
import time
import urllib.parse

import boto3
from boto3.dynamodb.conditions import Key
from boto3.dynamodb.types import TypeDeserializer
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest

from message_history import history_partition

logger = logging.getLogger(__name__)
_decoder = TypeDeserializer()
_ddb = boto3.resource("dynamodb")
# Reused while this instance is warm: a new client or TLS handshake costs tens to hundreds of ms.
_session = boto3.Session()
_ws_api = None
_relay = None


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
        done = False
        for message in result.get("Items", []):
            text = text_summary(message.get("content", ""))
            if message.get("type") == "user":
                if text.startswith("[Request interrupted"):
                    return None
                if text.startswith("<local-command-stdout>"):
                    # A slash command or Skill answers with its output, not an assistant row.
                    return re.sub(r"</?local-command-stdout>", "", text).strip()
                break  # Never show a previous turn's answer.
            if message.get("type") == "assistant":
                summary = summary or text
                # Claude marks its final reply end_turn; Codex appends an empty end_turn row.
                if message.get("stopReason") == "end_turn" and (text or not _blocks(message)):
                    done = True
        if done and summary:
            return summary
    return summary


def _blocks(message):
    content = message.get("content", "")
    try:
        return json.loads(content) if isinstance(content, str) else content
    except ValueError:
        return content


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
    global _ws_api
    _ws_api = _ws_api or boto3.client("apigatewaymanagementapi", endpoint_url=os.environ["WS_API_ENDPOINT"])
    probe = json.dumps({"action": "notify_check", "rootSessionId": event["rootSessionId"],
                        "eventId": event["eventId"]}).encode()
    asked = set()
    for row in rows:
        try:
            _ws_api.post_to_connection(ConnectionId=row["connectionId"], Data=probe)
            asked.add(row["connectionId"])
        except Exception:
            pass  # A gone connection is not viewing.
    if not asked:
        return False
    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(0.25)
        rows = subscriptions.query(KeyConditionExpression=key, ConsistentRead=True)["Items"]
        if any(row.get("seenEvent") == event["eventId"] and row["connectionId"] in asked for row in rows):
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
        action, detail = "Needs input", text_summary(new.get("agentDetail", ""))
    elif after == "completed" and before == "running":
        action, detail = "Finished", completion_summary(new)
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
    # The row's key is also the iOS push ID: the push carries nothing else, and the
    # app's notification extension reads the text here, from the user's own server.
    event_id = f'EVENT#{int(now * 1000):016d}#{event["eventId"]}'
    table.put_item(Item={
        "pk": f'NOTIFICATIONS#{event["accountId"]}', "sk": event_id,
        "event": event, "ttl": int(now) + 86400,
    })
    if not os.environ.get("PUSH_RELAY_URL"):
        return
    # One partition for every account: a token re-registered by another account overwrites its row.
    devices = table.query(KeyConditionExpression=Key("pk").eq("PUSH_DEVICE"), ConsistentRead=True)
    for device in devices.get("Items", []):
        if device.get("accountId") == event["accountId"] and int(device.get("ttl", 0)) > now:
            try:
                send_apns(table, event_id, device)
            except Exception:
                # Never fail the record for iOS: a stream retry would alert Android and the
                # devices already pushed again. The relay is down, so skip the rest.
                logger.exception("Push relay unavailable; iOS alert dropped")
                break


def send_apns(table, event_id, device):
    environment, token = device["sk"].split(":", 1)
    result = relay({"token": token, "environment": environment, "id": event_id})
    if result.get("status") == 200:
        return
    if result.get("reason") in ("BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic", "TopicDisallowed"):
        table.delete_item(Key={"pk": "PUSH_DEVICE", "sk": device["sk"]})
        return
    logger.warning("APNs rejected an alert: %s", result.get("reason", "unknown"))


def _signed_headers(url, body):
    # The relay URL uses AWS_IAM auth: this function's own role signs, nothing to configure.
    host = urllib.parse.urlparse(url).hostname.split(".")
    region = host[2] if len(host) > 2 and host[1] == "lambda-url" else os.environ["AWS_REGION"]
    request = AWSRequest("POST", url, data=body, headers={"content-type": "application/json"})
    SigV4Auth(_session.get_credentials(), "lambda", region).add_auth(request)
    return dict(request.headers)


def _post(url, body):
    """POST on the kept-alive relay connection; one fresh retry if it was dropped while frozen."""
    global _relay
    target = urllib.parse.urlparse(url)
    for fresh in (False, True):
        if _relay is None:
            _relay = http.client.HTTPSConnection(target.hostname, timeout=15)
        try:
            _relay.request("POST", target.path or "/", body=body, headers=_signed_headers(url, body))
            response = _relay.getresponse()
            return response.status, response.read()
        except (OSError, http.client.HTTPException):
            _relay.close()
            _relay = None
            if fresh:
                raise


def relay(request, attempts=4):
    """POST one alert to the shared APNs relay (push-relay/); it returns APNs' status and reason."""
    url = os.environ["PUSH_RELAY_URL"]
    body = json.dumps(request).encode()
    for attempt in range(attempts):
        if attempt:
            # The relay rejects (429) rather than queues past its concurrency; full jitter
            # (0-2, 0-4, 0-8 s) spreads stacks retrying at the same moment.
            time.sleep(random.uniform(0, 2 ** attempt))
        try:
            status, data = _post(url, body)
        except (OSError, http.client.HTTPException):
            continue
        if status == 200:
            return json.loads(data)
        if status != 429 and status < 500:
            raise RuntimeError(f"Push relay rejected the alert ({status})")
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
