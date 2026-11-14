"""Resolves a request's credential (deployment API key or device token) to its account, once per request."""

import hashlib
import os
import time

import boto3

import api_key

SEEN_SECONDS = 3600

_seen = {}
_table = None


def _system():
    global _table
    if _table is None:
        _table = boto3.resource("dynamodb", region_name=os.environ.get("AWS_REGION", "us-east-1")) \
            .Table(os.environ["SYSTEM_TABLE"])
    return _table


def token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def resolve(credential):
    """{accountId, kind, deviceName, tokenHash} or None. KeyUnavailable propagates (503)."""
    if not credential:
        return None
    if not credential.startswith("bt_"):
        return {"accountId": api_key.account_id(credential), "kind": "key"} if api_key.is_current(credential) else None
    # Read on every request, not cached: a revoked token must stop on every Lambda instance at once.
    digest = token_hash(credential)
    now = time.time()
    table = _system()
    # Consistent reads: a token issued a moment ago must resolve (a refused paired Bridge uninstalls itself).
    row = table.get_item(Key={"pk": f"TOKEN#{digest}", "sk": "-"}, ConsistentRead=True).get("Item")
    if not row or not table.get_item(Key={"pk": f"ACCOUNT#{row['accountId']}", "sk": "META"}, ConsistentRead=True).get("Item"):
        return None
    result = {"accountId": row["accountId"], "kind": row["kind"], "deviceName": row.get("deviceName", ""),
              "tokenHash": digest}
    if _seen.get(digest, 0) < now - SEEN_SECONDS:  # per process: at most hourly per warm instance
        _seen[digest] = now
        try:
            table.update_item(Key={"pk": f"ACCOUNT#{row['accountId']}", "sk": f"TOKEN#{digest}"},
                UpdateExpression="SET lastSeen = :now", ConditionExpression="attribute_exists(pk)",
                ExpressionAttributeValues={":now": int(now)})
        except Exception as error:
            print(f"lastSeen not written: {error}")
    return result
