#!/usr/bin/env python3
"""
One-shot backfill: add a `ttl` attribute to message rows that lack one.

TTL was enabled on the messages table but rows were historically written without
the `ttl` attribute, so they never expire. This adds ttl to those rows so DynamoDB
TTL can clean them up. New rows already carry ttl (see bridge_sync/bridge_ws).

TTL value = now + TTL_DAYS (default 90) — dated from when the cache row is stamped,
NOT the message's original timestamp. Messages are a rebuildable cache (jsonl is the
source of truth); a cache row's lifetime should start when it's cached, so a freshly
synced old conversation keeps the full window instead of expiring instantly. Expiry
is lossless — a session reopened after expiry re-syncs from jsonl.

Only touches rows missing `ttl`; safe and idempotent to re-run.

Usage:
  python3 backfill-message-ttl.py --table AgentPeekTest-bridge-messages --region ap-northeast-1
  python3 backfill-message-ttl.py ... --days 90 --dry-run
"""

import argparse
import boto3
from datetime import datetime, timezone


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--table", required=True)
    ap.add_argument("--region", default="ap-northeast-1")
    ap.add_argument("--days", type=int, default=90, help="ttl = message timestamp + days")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    ddb = boto3.resource("dynamodb", region_name=args.region)
    table = ddb.Table(args.table)
    now = int(datetime.now(timezone.utc).timestamp())
    ttl = now + args.days * 86400  # dated from now (cache-row lifetime), not message time

    scanned = missing = updated = 0
    kwargs = {"ProjectionExpression": "sessionId, sk, #t", "ExpressionAttributeNames": {"#t": "ttl"}}
    resp = table.scan(**kwargs)

    while True:
        for it in resp.get("Items", []):
            scanned += 1
            if "ttl" in it:
                continue
            missing += 1
            if not args.dry_run:
                table.update_item(
                    Key={"sessionId": it["sessionId"], "sk": it["sk"]},
                    UpdateExpression="SET #t = :ttl",
                    ExpressionAttributeNames={"#t": "ttl"},
                    ExpressionAttributeValues={":ttl": ttl},
                )
                updated += 1
        if "LastEvaluatedKey" not in resp:
            break
        resp = table.scan(ExclusiveStartKey=resp["LastEvaluatedKey"], **kwargs)

    print(f"scanned={scanned} missing_ttl={missing} "
          f"{'would_update' if args.dry_run else 'updated'}={missing if args.dry_run else updated} "
          f"(all expire {args.days}d from now)")
    if args.dry_run:
        print("dry-run — no writes. Re-run without --dry-run to apply.")


if __name__ == "__main__":
    main()
