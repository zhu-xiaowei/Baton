"""Accounts, device tokens and pairing (docs/v2-accounts-design.md §3–§5, §10). The server never sees K:
it keeps hash(joinSecret), token hashes and K sealed under a pairing secret that stays in the QR code."""

import hashlib
import hmac
import os
import secrets
import time

from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

import auth

router = APIRouter(prefix="/api")
PAIR_SECONDS = 600
MAX_BRIDGES = 10
ACCOUNT = Field(pattern=r"^[0-9a-f]{16}$")
SECRET = Field(pattern=r"^[\w-]{22,64}$")
SEALED = Field(pattern=r"^[\w+/=-]{40,200}$")
NAME = Field(min_length=1, max_length=64)


def _table():
    return auth._system()


def _sha(value):
    return hashlib.sha256(value.encode()).hexdigest()


def _open():
    return os.environ.get("OPEN_REGISTRATION") == "true"


def _conditional(write):
    """The write's reply, or False when its condition failed."""
    try:
        return write() or True
    except ClientError as error:
        if error.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
        return False


def _ip(request):
    # CloudFront appends the viewer to X-Forwarded-For, then API Gateway appends CloudFront.
    hops = [hop.strip() for hop in request.headers.get("x-forwarded-for", "").split(",") if hop.strip()]
    if not hops:
        return request.client.host if request.client else "-"
    return hops[-2] if len(hops) > 1 and "x-amz-cf-id" in request.headers else hops[-1]


def _rate(scope, limit, window=3600):
    start = int(time.time()) // window * window
    if _conditional(lambda: _table().update_item(
            Key={"pk": f"RATE#{scope}", "sk": str(start)},
            UpdateExpression="ADD n :one SET #ttl = :ttl",
            ConditionExpression="attribute_not_exists(n) OR n < :limit",
            ExpressionAttributeNames={"#ttl": "ttl"},
            ExpressionAttributeValues={":one": 1, ":limit": limit, ":ttl": start + window + 3600})) is False:
        raise HTTPException(429, "Too many requests, try again later.")


def _issue(account, kind, name):
    token = "bt_" + secrets.token_urlsafe(32)
    digest = auth.token_hash(token)
    now = int(time.time())
    # Listed first: a token whose index write failed is visible and removable, never a hidden credential.
    _table().put_item(Item={"pk": f"ACCOUNT#{account}", "sk": f"TOKEN#{digest}", "kind": kind,
                            "deviceName": name, "createdAt": now})
    _table().put_item(Item={"pk": f"TOKEN#{digest}", "sk": "-", "accountId": account, "kind": kind, "deviceName": name})
    return token


def _ensure_meta(account):
    # The self-host account (API key) has no joinSecret; tokens it pairs still need the row (auth.resolve).
    _conditional(lambda: _table().put_item(Item={"pk": f"ACCOUNT#{account}", "sk": "META", "createdAt": int(time.time())},
                                           ConditionExpression="attribute_not_exists(pk)"))


def _pair_key(code):
    return {"pk": f"PAIR#{_sha(code)}", "sk": "-"}


def _take(code, condition, values):
    """Deletes and returns a live pairing row, so a code is used at most once."""
    old = _conditional(lambda: _table().delete_item(
        Key=_pair_key(code), ReturnValues="ALL_OLD",
        ConditionExpression=f"attribute_exists(pk) AND #ttl > :now AND {condition}",
        ExpressionAttributeNames={"#ttl": "ttl"}, ExpressionAttributeValues={":now": int(time.time()), **values}))
    if not old:
        raise HTTPException(404, "This code is used or expired.")
    return old["Attributes"]


def list_tokens(account):
    rows = _table().query(KeyConditionExpression=Key("pk").eq(f"ACCOUNT#{account}") & Key("sk").begins_with("TOKEN#"))
    return [{"id": row["sk"][6:18], "deviceName": row.get("deviceName", ""), "kind": row["kind"],
             "lastSeen": int(row.get("lastSeen", row.get("createdAt", 0)))} for row in rows.get("Items", [])]


class Account(BaseModel):
    accountId: str = ACCOUNT
    joinSecret: str = SECRET
    deviceName: str = NAME


@router.post("/account/register")
def register(body: Account, request: Request):
    if not _open():
        raise HTTPException(404, "Registration is closed on this server.")
    _rate(f"register#{_ip(request)}", 5)
    if _conditional(lambda: _table().put_item(Item={
            "pk": f"ACCOUNT#{body.accountId}", "sk": "META", "joinSecretHash": _sha(body.joinSecret),
            "createdAt": int(time.time())}, ConditionExpression="attribute_not_exists(pk)")) is False:
        raise HTTPException(409, "Account exists.")
    return {"token": _issue(body.accountId, "app", body.deviceName)}


@router.post("/account/recover")
def recover(body: Account, request: Request):
    _rate(f"recover#{_ip(request)}", 5)
    _rate(f"recover#{body.accountId}", 5)
    meta = _table().get_item(Key={"pk": f"ACCOUNT#{body.accountId}", "sk": "META"}, ConsistentRead=True).get("Item")
    if not meta or not hmac.compare_digest(meta.get("joinSecretHash", ""), _sha(body.joinSecret)):
        raise HTTPException(403, "Recovery phrase does not match an account.")
    return {"token": _issue(body.accountId, "app", body.deviceName)}


class Create(BaseModel):
    code: str = SECRET
    sealed: str = SEALED


@router.post("/pair/create")
def pair_create(body: Create, request: Request):
    """A device holding K offers it to one new App, sealed under the QR code's secret. The device picks the
    code, which the seal is bound to."""
    caller = request.state.auth
    if caller["kind"] == "key":
        _ensure_meta(caller["accountId"])
    if _conditional(lambda: _table().put_item(Item={
            **_pair_key(body.code), "kind": "app", "accountId": caller["accountId"], "sealed": body.sealed,
            "ttl": int(time.time()) + PAIR_SECONDS}, ConditionExpression="attribute_not_exists(pk)")) is False:
        raise HTTPException(409, "Code in use.")
    return {"expiresIn": PAIR_SECONDS}


class Claim(BaseModel):
    code: str = SECRET
    deviceName: str = NAME


@router.post("/pair/claim")
def pair_claim(body: Claim):
    row = _take(body.code, "kind = :app", {":app": "app"})
    return {"token": _issue(row["accountId"], "app", body.deviceName), "accountId": row["accountId"],
            "sealed": row["sealed"]}


class Start(BaseModel):
    deviceName: str = NAME


@router.post("/pair/start")
def pair_start(body: Start, request: Request):
    """A computer without an account waits for an App to approve it (§5 item 1)."""
    _rate(f"start#{_ip(request)}", 10)
    code, poll = secrets.token_urlsafe(16), secrets.token_urlsafe(16)
    _table().put_item(Item={**_pair_key(code), "kind": "bridge", "pollHash": _sha(poll), "deviceName": body.deviceName,
                            "ttl": int(time.time()) + PAIR_SECONDS})
    return {"code": code, "poll": poll, "expiresIn": PAIR_SECONDS}


class Approve(BaseModel):
    code: str = SECRET
    sealed: str = SEALED


@router.post("/pair/approve")
def pair_approve(body: Approve, request: Request):
    caller = request.state.auth
    if caller["kind"] == "bridge":
        raise HTTPException(403, "Only an App can add a computer.")
    if caller["kind"] == "key":
        _ensure_meta(caller["accountId"])
    computers = [token["deviceName"] for token in list_tokens(caller["accountId"]) if token["kind"] == "bridge"]
    if _open() and len(computers) >= MAX_BRIDGES:
        raise HTTPException(409, f"This account already has {MAX_BRIDGES} computers.")
    pending = _table().get_item(Key=_pair_key(body.code), ConsistentRead=True).get("Item") or {}
    # The name is the computer's identity: a second one with it would take the first one's place.
    if pending.get("deviceName") in computers:
        raise HTTPException(409, f"A computer named {pending['deviceName']} is already in this account; reinstall with another name.")
    row = _conditional(lambda: _table().update_item(
        Key=_pair_key(body.code), ReturnValues="ALL_NEW",
        UpdateExpression="SET accountId = :account, sealed = :sealed, approvedBy = :by",
        ConditionExpression="attribute_exists(pk) AND kind = :bridge AND #ttl > :now AND attribute_not_exists(accountId)",
        ExpressionAttributeNames={"#ttl": "ttl"},
        ExpressionAttributeValues={":account": caller["accountId"], ":sealed": body.sealed, ":bridge": "bridge",
                                   ":by": caller.get("deviceName") or "Baton", ":now": int(time.time())}))
    if not row:
        raise HTTPException(404, "This code is used or expired.")
    return {"deviceName": row["Attributes"]["deviceName"]}


class Wait(BaseModel):
    code: str = SECRET
    poll: str = SECRET


@router.post("/pair/wait")
def pair_wait(body: Wait):
    """Polled by the waiting computer; the token is issued only here, so no row ever holds one."""
    row = _table().get_item(Key=_pair_key(body.code), ConsistentRead=True).get("Item")
    if not row or row.get("kind") != "bridge" or int(row.get("ttl", 0)) <= time.time() \
            or not hmac.compare_digest(row.get("pollHash", ""), _sha(body.poll)):
        raise HTTPException(404, "This code is used or expired.")
    if "accountId" not in row:
        return {"pending": True}
    row = _take(body.code, "pollHash = :poll AND attribute_exists(accountId)", {":poll": _sha(body.poll)})
    return {"token": _issue(row["accountId"], "bridge", row["deviceName"]), "accountId": row["accountId"],
            "sealed": row["sealed"], "approvedBy": row["approvedBy"]}
