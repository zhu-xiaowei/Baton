"""Mobile notification registration and the event feed.

Android polls the feed; an iOS push carries only an event ID, which the notification
extension resolves here. Alerts carry no transcript or credential.
"""
import os
import re
import time

import boto3
from boto3.dynamodb.conditions import Key
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

import api_key

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
