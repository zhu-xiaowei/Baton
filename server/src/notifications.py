"""Mobile notification registration and the foreground Android event feed.

APNs delivery runs in notification_worker, independently of session writes.
No command, transcript or API credential is placed in a notification.
"""
import re
import time

from boto3.dynamodb.conditions import Key
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

import api_key
from notification_store import table, apns_configured, digest

router = APIRouter(prefix="/api/notifications")


def account(request):
    return api_key.account_id(request.headers.get("x-api-key", ""))


class DeviceRegistration(BaseModel):
    installationId: str = Field(pattern=r"^[a-zA-Z0-9-]{16,80}$")
    token: str = Field(pattern=r"^[a-fA-F0-9]{64,200}$")
    environment: str = Field(pattern=r"^(development|production)$")
    completed: bool = True
    needsInput: bool = True


class DeviceRemoval(BaseModel):
    installationId: str = Field(pattern=r"^[a-zA-Z0-9-]{16,80}$")


@router.get("/config")
def config(request: Request):
    return {
        "accountId": account(request),
        "ios": {
            "development": apns_configured(),
            "production": apns_configured(),
        },
        "androidForeground": True,
    }


@router.post("/devices")
def register_device(body: DeviceRegistration, request: Request):
    if not apns_configured():
        raise HTTPException(503, "iOS push is not configured on this server.")
    token = body.token.lower()
    # One row per installation, so switching accounts replaces the old binding.
    account_id = account(request)
    expires = int(time.time()) + 90 * 86400
    storage = table()
    storage.put_item(Item={
        "pk": "PUSH_DEVICE",
        "sk": body.installationId,
        "accountId": account_id,
        "token": token,
        "environment": body.environment,
        "completed": body.completed,
        "needsInput": body.needsInput,
        "ttl": expires,
    })
    # APNs may reuse a token after reinstall. The current installation owns the
    # endpoint, so a stale registration cannot notify a previous account.
    storage.put_item(Item={
        "pk": "PUSH_ENDPOINT", "sk": digest(f"{body.environment}:{token}"),
        "installationId": body.installationId, "accountId": account_id, "ttl": expires,
    })
    return {"ok": True}


@router.post("/devices/remove")
def remove_device(body: DeviceRemoval, request: Request):
    from botocore.exceptions import ClientError
    try:
        table().delete_item(
            Key={"pk": "PUSH_DEVICE", "sk": body.installationId},
            ConditionExpression="accountId = :account",
            ExpressionAttributeValues={":account": account(request)},
        )
    except ClientError as error:
        if error.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
    return {"ok": True}


@router.get("/events")
def events(request: Request, cursor: str = ""):
    # Establish a fresh baseline on launch/resume; Android never replays alerts
    # generated while it was in the background.
    if not cursor:
        return {"events": [], "cursor": f"EVENT#{int(time.time() * 1000):016d}#~"}
    if not re.fullmatch(r"EVENT#\d{16}#[a-f0-9]{64}|EVENT#\d{16}#~", cursor):
        raise HTTPException(400, "Invalid notification cursor.")
    result = table().query(
        KeyConditionExpression=Key("pk").eq(f"NOTIFICATIONS#{account(request)}")
        & Key("sk").gt(cursor),
        ConsistentRead=True, Limit=100,
    )
    rows = result.get("Items", [])
    return {
        "events": [row["event"] for row in rows if int(row["ttl"]) > time.time()],
        "cursor": rows[-1]["sk"] if rows else cursor,
    }
