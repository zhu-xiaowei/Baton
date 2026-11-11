"""Mobile notifications: device registration, the event feed and delivery.

The Bridge decides and words each alert (bridge/notify.mjs) and posts it here. Android polls
the feed; an iOS push carries only an event ID, which the notification extension resolves
here. Alerts carry no transcript or credential.
"""
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
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

import api_key

logger = logging.getLogger(__name__)
# Reused while this instance is warm: a new client or TLS handshake costs tens to hundreds of ms.
_session = boto3.Session()
_relay = None

router = APIRouter(prefix="/api/notifications")


def _table():
    return boto3.resource("dynamodb").Table(os.environ["SYSTEM_TABLE"])


def _account(request):
    return api_key.account_id(request.headers.get("x-api-key", ""))


def _relay_configured():
    return bool(os.environ.get("PUSH_RELAY_URL"))


class PushDevice(BaseModel):
    token: str = Field(pattern=r"^[a-fA-F0-9]{64,200}$")
    environment: str = Field(pattern=r"^(development|production)$")

    def key(self):
        # Keyed by token: a reinstall or another account reusing it replaces the old binding.
        return {"pk": "PUSH_DEVICE", "sk": f"{self.environment}:{self.token.lower()}"}


@router.get("/config")
def config(request: Request):
    return {"accountId": _account(request), "ios": _relay_configured()}


@router.post("/devices")
def register_device(body: PushDevice, request: Request):
    if not _relay_configured():
        raise HTTPException(503, "iOS push is not configured on this server.")
    _table().put_item(Item={
        **body.key(), "accountId": _account(request), "ttl": int(time.time()) + 30 * 86400,
    })
    return {"ok": True}


@router.post("/devices/remove")
def remove_device(body: PushDevice, request: Request):
    from botocore.exceptions import ClientError
    try:
        _table().delete_item(
            Key=body.key(), ConditionExpression="accountId = :account",
            ExpressionAttributeValues={":account": _account(request)},
        )
    except ClientError as error:
        if error.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
    return {"ok": True}


@router.get("/event")
def event(id: str, request: Request):
    """One alert's text for the iOS notification extension; the push carried only this ID."""
    if not re.fullmatch(r"EVENT#\d{16}#[a-f0-9]{64}", id):
        raise HTTPException(400, "Invalid notification ID.")
    row = _table().get_item(Key={"pk": f"NOTIFICATIONS#{_account(request)}", "sk": id}).get("Item")
    if not row or int(row["ttl"]) <= time.time():
        raise HTTPException(404, "Notification expired.")
    return row["event"]


@router.get("/events")
def events(request: Request, cursor: str = ""):
    # Each launch/resume starts a fresh baseline: Android never replays background events.
    if not cursor:
        return {"events": [], "cursor": f"EVENT#{int(time.time() * 1000):016d}#~"}
    if not re.fullmatch(r"EVENT#\d{16}#([a-f0-9]{64}|~)", cursor):
        raise HTTPException(400, "Invalid notification cursor.")
    result = _table().query(
        KeyConditionExpression=Key("pk").eq(f"NOTIFICATIONS#{_account(request)}")
        & Key("sk").gt(cursor),
        ConsistentRead=True, Limit=100,
    )
    rows = result.get("Items", [])
    return {
        "events": [row["event"] for row in rows if int(row["ttl"]) > time.time()],
        "cursor": rows[-1]["sk"] if rows else cursor,
    }


class Alert(BaseModel):
    eventId: str = Field(pattern=r"^[a-f0-9]{64}$")
    device: str = Field(max_length=200)
    projectHash: str = Field(max_length=400)
    projectName: str = Field(max_length=80)
    sessionId: str = Field(max_length=200)
    sessionTitle: str = Field(max_length=120)
    rootSessionId: str = Field(max_length=200)
    title: str = Field(max_length=210)
    body: str = Field(max_length=300)


@router.post("/events")
def post_event(alert: Alert, request: Request):
    """A Bridge's alert: stored for Android and the iOS extension, then pushed to iOS."""
    account = _account(request)
    table = _table()
    now = time.time()
    # Keyed at receipt: Android's cursor only moves forward, so a queued alert must not keep its time.
    # The key is also the iOS push ID: the push carries nothing else.
    event_id = f"EVENT#{int(now * 1000):016d}#{alert.eventId}"
    table.put_item(Item={
        "pk": f"NOTIFICATIONS#{account}", "sk": event_id,
        "event": {**alert.model_dump(), "accountId": account}, "ttl": int(now) + 7 * 86400,
    })
    if not _relay_configured():
        return {"ok": True}
    # One partition for every account: a token re-registered by another account overwrites its row.
    devices = table.query(KeyConditionExpression=Key("pk").eq("PUSH_DEVICE"), ConsistentRead=True)
    for device in devices.get("Items", []):
        if device.get("accountId") == account and int(device.get("ttl", 0)) > now:
            try:
                send_apns(table, event_id, device)
            except Exception:
                # The feed row is written: Android still gets it. The relay is down, so skip the rest.
                logger.exception("Push relay unavailable; iOS alert dropped")
                break
    return {"ok": True}


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
