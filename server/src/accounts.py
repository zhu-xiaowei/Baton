"""Accounts, device tokens and pairing (docs/v2-accounts-design.md). The server never sees K: it keeps
hash(joinSecret), token hashes, and K sealed under a pairing secret that only the QR code carries."""

import hashlib
import hmac
import os
import secrets
import time
from typing import Optional

from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

import auth

router = APIRouter(prefix="/api")
PAIR_SECONDS = 600
MAX_BRIDGES = 10
MAX_ROTATIONS = 8
HEX16 = r"^[0-9a-f]{16}$"
SECRET = r"^[\w-]{22,64}$"
GONE = "This code is used or expired."


class Rotation(BaseModel):
    joinSecret: str = Field(pattern=SECRET)
    fp: str = Field(pattern=HEX16)    # the K being replaced: must be the account's head
    next: str = Field(pattern=HEX16)  # K'
    sealed: str = Field(pattern=r"^[\w+/=-]{40,200}$")  # K' sealed under K


class Body(BaseModel):
    accountId: str = Field("", pattern=r"^([0-9a-f]{16})?$")
    fp: str = Field("", pattern=r"^([0-9a-f]{16})?$")
    joinSecret: str = Field("", pattern=r"^([\w-]{22,64})?$")
    code: str = Field("", pattern=r"^([\w-]{22,64})?$")
    poll: str = Field("", pattern=r"^([\w-]{22,64})?$")
    sealed: str = Field("", pattern=r"^([\w+/=-]{40,200})?$")
    deviceName: str = ""
    id: str = Field("", pattern=r"^([0-9a-f]{12})?$")
    rotation: Optional[Rotation] = None


def _need(body, *fields):
    if missing := [name for name in fields if not getattr(body, name)]:
        raise HTTPException(422, f"Missing: {', '.join(missing)}")


def _table():
    return auth._system()


def _sha(value):
    return hashlib.sha256(value.encode()).hexdigest()


def _open():
    return os.environ.get("OPEN_REGISTRATION") == "true"


def _conditional(write):
    try:
        return write() or True
    except ClientError as error:
        if error.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
        return False


def _ip(request):
    # API Gateway appends the address it saw; behind CloudFront that is CloudFront, which appended the viewer
    # before it. Only CloudFront knows the origin secret, so a direct caller cannot pose as it.
    hops = [hop.strip() for hop in request.headers.get("x-forwarded-for", "").split(",") if hop.strip()]
    if not hops:
        return request.client.host if request.client else "-"
    secret = os.environ.get("ORIGIN_SECRET", "")
    via_cdn = bool(secret) and hmac.compare_digest(request.headers.get("x-baton-origin", ""), secret)
    return hops[-2] if via_cdn and len(hops) > 1 else hops[-1]


def _rate(scope, limit):
    start = int(time.time()) // 3600 * 3600
    if _conditional(lambda: _table().update_item(
            Key={"pk": f"RATE#{scope}", "sk": str(start)}, UpdateExpression="ADD n :one SET #ttl = :ttl",
            ConditionExpression="attribute_not_exists(n) OR n < :limit", ExpressionAttributeNames={"#ttl": "ttl"},
            ExpressionAttributeValues={":one": 1, ":limit": limit, ":ttl": start + 7200})) is False:
        raise HTTPException(429, "Too many requests, try again later.")


def _meta(account):
    return _table().get_item(Key={"pk": f"ACCOUNT#{account}", "sk": "META"}, ConsistentRead=True).get("Item") or {}


def _token_rows(account):
    return _table().query(KeyConditionExpression=Key("pk").eq(f"ACCOUNT#{account}") & Key("sk").begins_with("TOKEN#"))["Items"]


def _token_keys(account, digest):
    return [{"pk": f"TOKEN#{digest}", "sk": "-"}, {"pk": f"ACCOUNT#{account}", "sk": f"TOKEN#{digest}"}]


def _issue(account, kind, name):
    token, name = "bt_" + secrets.token_urlsafe(32), name[:64]
    index, listed = _token_keys(account, auth.token_hash(token))
    # Listed first: a token whose index write failed is visible and removable, never a hidden credential.
    _table().put_item(Item={**listed, "kind": kind, "deviceName": name, "createdAt": int(time.time())})
    _table().put_item(Item={**index, "kind": kind, "deviceName": name, "accountId": account})
    return token


def list_tokens(account):
    return [{"id": row["sk"][6:18], "deviceName": row.get("deviceName", ""), "kind": row["kind"],
             "lastSeen": int(row.get("lastSeen", row.get("createdAt", 0)))} for row in _token_rows(account)]


def _pair_key(code):
    return {"pk": f"PAIR#{_sha(code)}", "sk": "-"}


def _take(code, condition, values):
    # Deleted on use: a code works once. One made or approved by a device that has since left is void.
    old = _conditional(lambda: _table().delete_item(
        Key=_pair_key(code), ReturnValues="ALL_OLD", ConditionExpression=f"attribute_exists(pk) AND #ttl > :now AND {condition}",
        ExpressionAttributeNames={"#ttl": "ttl"}, ExpressionAttributeValues={":now": int(time.time()), **values}))
    by = old and old["Attributes"].get("by")
    if not old or (by and not _table().get_item(Key={"pk": f"TOKEN#{by}", "sk": "-"}).get("Item")):
        raise HTTPException(404, GONE)
    return old["Attributes"]


def _ensure_meta(caller):
    # The self-host account (API key) has no joinSecret; tokens it pairs still need the row (auth.resolve).
    if caller["kind"] == "key":
        _conditional(lambda: _table().put_item(Item={"pk": f"ACCOUNT#{caller['accountId']}", "sk": "META",
                                                     "createdAt": int(time.time())}, ConditionExpression="attribute_not_exists(pk)"))


def _joined(row, kind, name, **extra):
    return {"token": _issue(row["accountId"], kind, name), "accountId": row["accountId"], "sealed": row["sealed"],
            "head": _meta(row["accountId"]).get("head", ""), **extra}


def _room_for(account, name):
    # A name is the computer's identity: a second one with it would take the first one's place.
    computers = [row.get("deviceName") for row in _token_rows(account) if row["kind"] == "bridge"]
    if _open() and len(computers) >= MAX_BRIDGES:
        raise HTTPException(409, f"This account already has {MAX_BRIDGES} computers.")
    if name in computers:
        raise HTTPException(409, f"A computer named {name} is already in this account; reinstall with another name.")


def _self_hosted(account):
    import api_key  # KeyUnavailable propagates: a 503, never a guess
    return account in (os.environ.get("ACCOUNT_ID"), api_key.account_id(api_key.current_key()))


@router.post("/account/register")
def register(body: Body, request: Request):
    _need(body, "accountId", "joinSecret", "fp", "deviceName")
    if not _open():
        raise HTTPException(404, "Registration is closed on this server.")
    _rate(f"register#{_ip(request)}", 5)
    import devices
    if _self_hosted(body.accountId) or devices.list_devices(body.accountId):
        raise HTTPException(409, "Account exists.")
    if _conditional(lambda: _table().put_item(Item={
            "pk": f"ACCOUNT#{body.accountId}", "sk": "META", "joinSecretHash": _sha(body.joinSecret), "head": body.fp,
            "createdAt": int(time.time())}, ConditionExpression="attribute_not_exists(pk)")) is False:
        raise HTTPException(409, "Account exists.")
    # accountId is fixed at registration while K (and joinSecret) rotate: recovery finds it from joinSecret.
    _table().put_item(Item={"pk": f"JOIN#{_sha(body.joinSecret)}", "sk": "-", "accountId": body.accountId})
    return {"token": _issue(body.accountId, "app", body.deviceName)}


@router.post("/account/recover")
def recover(body: Body, request: Request):
    _need(body, "joinSecret", "deviceName")
    _rate(f"recover#{_ip(request)}", 5)
    digest = _sha(body.joinSecret)
    account = (_table().get_item(Key={"pk": f"JOIN#{digest}", "sk": "-"}, ConsistentRead=True).get("Item") or {}).get("accountId")
    if not account or not hmac.compare_digest(_meta(account).get("joinSecretHash", ""), digest):
        raise HTTPException(403, "Recovery phrase does not match an account.")
    _rate(f"recover#{account}", 5)
    return {"token": _issue(account, "app", body.deviceName), "accountId": account}


@router.post("/pair/create")
def pair_create(body: Body, request: Request):
    _need(body, "code", "sealed")
    caller = request.state.auth
    _ensure_meta(caller)
    if _conditional(lambda: _table().put_item(Item={**_pair_key(body.code), "kind": "app", "accountId": caller["accountId"],
            "by": caller.get("tokenHash", ""), "sealed": body.sealed, "ttl": int(time.time()) + PAIR_SECONDS}, ConditionExpression="attribute_not_exists(pk)")) is False:
        raise HTTPException(409, "Code in use.")
    return {"expiresIn": PAIR_SECONDS, "web": os.environ.get("WEB_URL", "")}


@router.post("/pair/claim")
def pair_claim(body: Body):
    _need(body, "code", "deviceName")
    return _joined(_take(body.code, "kind = :app", {":app": "app"}), "app", body.deviceName)


@router.post("/pair/start")
def pair_start(body: Body, request: Request):
    _need(body, "deviceName")
    _rate(f"start#{_ip(request)}", 10)
    code, poll = secrets.token_urlsafe(16), secrets.token_urlsafe(16)
    _table().put_item(Item={**_pair_key(code), "kind": "bridge", "pollHash": _sha(poll), "deviceName": body.deviceName,
                            "ttl": int(time.time()) + PAIR_SECONDS})
    return {"code": code, "poll": poll, "expiresIn": PAIR_SECONDS, "web": os.environ.get("WEB_URL", "")}


@router.post("/pair/approve")
def pair_approve(body: Body, request: Request):
    _need(body, "code", "sealed")
    caller = request.state.auth
    _ensure_meta(caller)
    _room_for(caller["accountId"], (_table().get_item(Key=_pair_key(body.code), ConsistentRead=True).get("Item") or {}).get("deviceName"))
    row = _conditional(lambda: _table().update_item(
        Key=_pair_key(body.code), ReturnValues="ALL_NEW", UpdateExpression="SET accountId = :account, sealed = :sealed, approvedBy = :by, #by = :token",
        ConditionExpression="attribute_exists(pk) AND kind = :bridge AND #ttl > :now AND attribute_not_exists(accountId)",
        ExpressionAttributeNames={"#ttl": "ttl", "#by": "by"}, ExpressionAttributeValues={":account": caller["accountId"], ":sealed": body.sealed,
            ":bridge": "bridge", ":by": caller.get("deviceName") or "Baton", ":token": caller.get("tokenHash", ""), ":now": int(time.time())}))
    if not row:
        raise HTTPException(404, GONE)
    return {"deviceName": row["Attributes"]["deviceName"]}


@router.post("/pair/wait")
def pair_wait(body: Body):
    # The computer's token is issued only here, so no row ever holds one.
    _need(body, "code", "poll")
    row = _table().get_item(Key=_pair_key(body.code), ConsistentRead=True).get("Item") or {}
    if row.get("kind") != "bridge" or int(row.get("ttl", 0)) <= time.time() or not hmac.compare_digest(row.get("pollHash", ""), _sha(body.poll)):
        raise HTTPException(404, GONE)
    if "accountId" not in row:
        return {"pending": True}
    row = _take(body.code, "pollHash = :poll AND attribute_exists(accountId)", {":poll": _sha(body.poll)})
    _room_for(row["accountId"], row["deviceName"])  # again: other codes may have been approved meanwhile
    return _joined(row, "bridge", row["deviceName"], approvedBy=row["approvedBy"])


# ---- Removal, rotation, deletion ----

def _ws():
    import bridge_ws
    bridge_ws._init()
    return bridge_ws


def _close(account, token_hash=None, notice=None):
    bridge_ws = _ws()
    for role in ("app", "bridge", "app_data", "bridge_data"):
        endpoint = os.environ.get("TERMINAL_DIRECT_ENDPOINT" if role.endswith("_data") else "WS_API_ENDPOINT", "")
        for item in bridge_ws._query_connections(account, role) if endpoint else []:
            if token_hash and item.get("tokenHash") != token_hash:
                continue
            try:
                if notice and role == "bridge":
                    bridge_ws._post_to_connection(endpoint, item["connectionId"], {"action": notice})
                bridge_ws._delete_connection(endpoint, item["connectionId"])
            except Exception as error:
                print(f"socket not closed: {error}")
            bridge_ws._handle_disconnect(item["connectionId"])


def _rotate_and_revoke(account, meta, rotation, digests):
    """K' sealed under the K the leaving device also holds, its tokens deleted and the recovery index moved, in ONE
    transaction: it can never read the chain, the old joinSecret never outlives the removal, and `head = fp` makes a
    second rotation from the same K fail instead of forking the chain. Plain values: the resource's client
    (table.meta.client) serializes them itself."""
    table = _table()
    chain = [entry for entry in meta.get("rotations", []) if entry["fp"] != rotation.fp][-(MAX_ROTATIONS - 1):]
    if rotation.next == rotation.fp or any(entry["fp"] == rotation.next for entry in chain):
        raise HTTPException(409, "A new account key is required.")
    update = {"TableName": table.name, "Key": {"pk": f"ACCOUNT#{account}", "sk": "META"}, "ConditionExpression": "head = :fp",
              "UpdateExpression": "SET joinSecretHash = :hash, head = :next, rotations = :chain",
              "ExpressionAttributeValues": {":hash": _sha(rotation.joinSecret), ":next": rotation.next, ":fp": rotation.fp,
                                            ":chain": chain + [{"fp": rotation.fp, "sealed": rotation.sealed}]}}
    join = {"TableName": table.name, "Item": {"pk": f"JOIN#{_sha(rotation.joinSecret)}", "sk": "-", "accountId": account}}
    keys = [key for digest in digests for key in _token_keys(account, digest)] + [{"pk": f"JOIN#{meta['joinSecretHash']}", "sk": "-"}]
    try:
        table.meta.client.transact_write_items(TransactItems=[{"Update": update}, {"Put": join}]
                                               + [{"Delete": {"TableName": table.name, "Key": key}} for key in keys])
    except ClientError as error:
        if error.response["Error"]["Code"] != "TransactionCanceledException":
            raise
        raise HTTPException(409, "The account key changed meanwhile; try again.")


def remove(caller, rotation, digests, notice=None):
    """A device leaves: a hosted account replaces K at that moment, a self-hosted one (API key) only revokes. Its
    sockets close (a Bridge told `notice` first), and only then do the remaining Bridges hear of the rotation."""
    if caller["kind"] == "bridge":
        raise HTTPException(403, "Remove devices from an App.")
    account, meta = caller["accountId"], _meta(caller["accountId"])
    hosted = bool(meta.get("joinSecretHash"))
    if hosted and not rotation:
        raise HTTPException(400, "Removing a device needs a new account key.")
    if hosted:
        _rotate_and_revoke(account, meta, rotation, digests)
    _drop(account, digests, notice, rows=not hosted)
    bridge_ws = _ws()
    for item in bridge_ws._query_connections(account, "bridge") if hosted else []:
        try:
            bridge_ws._post_to_connection(os.environ.get("WS_API_ENDPOINT", ""), item["connectionId"], {"action": "account_rotated"})
        except Exception:
            pass


def _drop(account, digests, notice=None, rows=True):
    """Tokens (unless already gone in the rotation), the push registrations made with them, their sockets."""
    pushes = _table().query(KeyConditionExpression=Key("pk").eq(f"PUSH_DEVICE#{account}"))["Items"]
    for digest in digests:
        for key in (_token_keys(account, digest) if rows else []) + [p for p in pushes if p.get("tokenHash") == digest]:
            _table().delete_item(Key={"pk": key["pk"], "sk": key["sk"]})
        _close(account, token_hash=digest, notice=notice)


def computer_tokens(account, name):
    return [row["sk"][6:] for row in _token_rows(account) if row["kind"] == "bridge" and row.get("deviceName") == name]


@router.post("/tokens/revoke")
def revoke(body: Body, request: Request):
    # No id: log out. An id: remove another App of the account (a lost phone).
    caller = request.state.auth
    if not body.id:
        _drop(caller["accountId"], [caller["tokenHash"]] if caller.get("tokenHash") else [])
        return {"ok": True}
    digest = next((row["sk"][6:] for row in _token_rows(caller["accountId"]) if row["sk"][6:18] == body.id and row["kind"] == "app"), None)
    if not digest or digest == caller.get("tokenHash"):
        raise HTTPException(404, "No such App in this account.")
    remove(caller, body.rotation, [digest])
    return {"ok": True}


@router.post("/account/delete")
def delete_account(request: Request):
    caller = request.state.auth
    account = caller["accountId"]
    if caller["kind"] != "app" or not _meta(account).get("joinSecretHash"):
        raise HTTPException(403, "Only an App of an account made by pairing can delete it.")
    _close(account, notice="account_deleted")
    import devices
    for item in devices.list_devices(account):
        devices.delete_device(account, item["deviceName"])
    table = _table()
    for pk in (f"ACCOUNT#{account}", f"PUSH_DEVICE#{account}", f"NOTIFICATIONS#{account}"):
        while rows := table.query(KeyConditionExpression=Key("pk").eq(pk))["Items"]:
            for row in rows:
                if row["sk"] == "META":
                    table.delete_item(Key={"pk": f"JOIN#{row['joinSecretHash']}", "sk": "-"})
                if row["sk"].startswith("TOKEN#"):
                    table.delete_item(Key={"pk": row["sk"], "sk": "-"})
                table.delete_item(Key={"pk": row["pk"], "sk": row["sk"]})
    return {"ok": True}
