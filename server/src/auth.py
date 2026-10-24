"""
Credential resolution shared by the REST and WebSocket Lambdas.

SystemTable rows (pk, sk):
  CRED,  sha256(secret)  — kind master|app|bridge, accountId, credId, device?, name, createdAt, lastUsedAt
  TOKEN, <token>         — one-time Start URL token (kind app) or Bridge pairing code (kind bridge), ttl
The accountId is stored on each row, so rotating or revoking a secret never moves data.
"""

import hashlib
import os
import secrets
import time
import uuid

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

DEVICE_PREFIX = "bt_"
MASTER_PREFIX = "bk_"
PAIRING_PREFIX = "bp_"
CACHE_SECONDS = 60
LAST_USED_INTERVAL = 3600
START_TOKEN_SECONDS = 600
PAIRING_SECONDS = 600
BRIDGE_ROLES = ("bridge", "terminal_data", "realtime_data", "preview_data")

_table = None
_cache = {}


def _system_table():
    global _table
    if _table is None:
        ddb = boto3.resource("dynamodb", region_name=os.environ.get("AWS_REGION", "us-east-1"))
        _table = ddb.Table(os.environ["SYSTEM_TABLE"])
    return _table


def secret_hash(secret):
    return hashlib.sha256(secret.encode()).hexdigest()


def legacy_account_id(api_key):
    return secret_hash(api_key)[:16]


def forget(secret_hashes=None):
    if secret_hashes is None:
        _cache.clear()
    for digest in secret_hashes or ():
        _cache.pop(digest, None)


def resolve(secret, table=None):
    """Return the credential row for a secret, or None."""
    if not isinstance(secret, str) or not secret or len(secret) > 256 or secret.startswith(PAIRING_PREFIX):
        return None
    digest = secret_hash(secret)
    now = time.time()
    cached = _cache.get(digest)
    if cached and cached[0] > now:
        return cached[1]
    table = table or _system_table()
    item = table.get_item(Key={"pk": "CRED", "sk": digest}).get("Item")
    if not item or not item.get("accountId"):
        _cache.pop(digest, None)
        return None
    credential = {key: item.get(key) for key in ("accountId", "kind", "credId", "device", "name")}
    credential["hash"] = digest
    _cache[digest] = (now + CACHE_SECONDS, credential)
    if now - int(item.get("lastUsedAt") or 0) > LAST_USED_INTERVAL:
        try:
            table.update_item(Key={"pk": "CRED", "sk": digest}, UpdateExpression="SET lastUsedAt = :now",
                ConditionExpression="attribute_exists(sk)", ExpressionAttributeValues={":now": int(now)})
        except ClientError:
            pass
    return credential


def request_credential(request):
    state = getattr(request, "state", None)
    return getattr(state, "baton_auth", None) if state is not None else None


def request_account_id(request):
    credential = request_credential(request)
    if credential:
        return credential["accountId"]
    # Direct calls without the middleware (tests) keep the original key derivation.
    return legacy_account_id(request.headers.get("x-api-key", ""))


def _put_credential(table, account_id, kind, secret, device="", name=""):
    now = int(time.time())
    item = {"pk": "CRED", "sk": secret_hash(secret), "accountId": account_id, "kind": kind,
        "credId": uuid.uuid4().hex, "createdAt": now, "lastUsedAt": now}
    if device:
        item["device"] = device
    if name:
        item["name"] = name[:64]
    table.put_item(Item=item, ConditionExpression="attribute_not_exists(sk)")
    return item


def issue_device_credential(account_id, kind, device="", name="", table=None):
    secret = DEVICE_PREFIX + secrets.token_urlsafe(32)
    item = _put_credential(table or _system_table(), account_id, kind, secret, device, name)
    return secret, item


def ensure_master(api_key, table=None):
    """Register the deployment's original API key as the master credential (idempotent)."""
    table = table or _system_table()
    try:
        _put_credential(table, legacy_account_id(api_key), "master", api_key, name="Master key")
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
            raise


def list_credentials(account_id, table=None):
    table = table or _system_table()
    kwargs = {"KeyConditionExpression": Key("pk").eq("CRED")}
    items = []
    while True:
        response = table.query(**kwargs)
        items.extend(item for item in response.get("Items", []) if item.get("accountId") == account_id)
        if "LastEvaluatedKey" not in response:
            return items
        kwargs["ExclusiveStartKey"] = response["LastEvaluatedKey"]


def delete_credentials(items, table=None):
    table = table or _system_table()
    for item in items:
        table.delete_item(Key={"pk": "CRED", "sk": item["sk"]})
    forget([item["sk"] for item in items])


def rotate_master(account_id, table=None):
    table = table or _system_table()
    previous = [item for item in list_credentials(account_id, table) if item.get("kind") == "master"]
    secret = MASTER_PREFIX + secrets.token_urlsafe(32)
    _put_credential(table, account_id, "master", secret, name="Master key")
    delete_credentials(previous, table)
    return secret, previous


def bind_bridge_device(credential, device, table=None):
    """Bind an unbound Bridge credential to its first device; returns whether device is allowed."""
    if not device:
        return False
    if credential.get("device"):
        return credential["device"] == device
    table = table or _system_table()
    try:
        table.update_item(Key={"pk": "CRED", "sk": credential["hash"]}, UpdateExpression="SET device = :device",
            ConditionExpression="attribute_exists(sk) AND attribute_not_exists(device)",
            ExpressionAttributeValues={":device": device})
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
            raise
        forget([credential["hash"]])
        current = resolve_by_hash(credential["hash"], table)
        return bool(current) and current.get("device") == device
    forget([credential["hash"]])
    credential["device"] = device
    return True


def resolve_by_hash(digest, table=None):
    item = (table or _system_table()).get_item(Key={"pk": "CRED", "sk": digest}, ConsistentRead=True).get("Item")
    return item


def role_allowed(credential, role):
    return credential.get("kind") != "bridge" or role in BRIDGE_ROLES


def create_one_time(account_id, kind, table=None):
    """Create a Start URL token (kind app) or Bridge pairing code (kind bridge)."""
    if kind == "bridge":
        token, lifetime = PAIRING_PREFIX + secrets.token_urlsafe(24), PAIRING_SECONDS
    else:
        token, lifetime = secrets.token_hex(16), START_TOKEN_SECONDS
    (table or _system_table()).put_item(Item={"pk": "TOKEN", "sk": token, "accountId": account_id,
        "kind": kind, "ttl": int(time.time()) + lifetime})
    return token, lifetime


def consume_one_time(token, kind, table=None):
    """Atomically delete a one-time token; returns its accountId when valid for this kind."""
    if not isinstance(token, str) or not token or len(token) > 128:
        return None
    table = table or _system_table()
    try:
        item = table.delete_item(Key={"pk": "TOKEN", "sk": token}, ReturnValues="ALL_OLD",
            ConditionExpression="attribute_exists(sk)").get("Attributes")
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            return None
        raise
    if not item or int(item.get("ttl", 0) or 0) < time.time() or item.get("kind", "app") != kind:
        return None
    if item.get("accountId"):
        return item["accountId"]
    # Tokens written by install.sh before this release carry the raw key instead.
    legacy = resolve(item.get("apiKey", ""), table)
    return legacy["accountId"] if legacy else None
