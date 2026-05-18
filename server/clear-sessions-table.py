#!/usr/bin/env python3
"""
One-shot migration helper: clears the BridgeSessions table after the SK schema change.
Run this BEFORE restarting the bridge so it can re-populate with new SK formats
(DEV# / PROJ# / SESS#).

Usage:
  python3 clear-sessions-table.py --table AgentPeekTest-bridge-sessions --region us-west-2
"""

import argparse
import boto3
from boto3.dynamodb.conditions import Attr


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--table", required=True)
    ap.add_argument("--region", default="us-west-2")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    ddb = boto3.resource("dynamodb", region_name=args.region)
    tbl = ddb.Table(args.table)

    # Scan all items (one-time, table size 912 items so it's fine)
    print(f"Scanning {args.table}...")
    items = []
    resp = tbl.scan(ProjectionExpression="accountId, sk")
    items.extend(resp.get("Items", []))
    while "LastEvaluatedKey" in resp:
        resp = tbl.scan(ProjectionExpression="accountId, sk", ExclusiveStartKey=resp["LastEvaluatedKey"])
        items.extend(resp.get("Items", []))

    print(f"Found {len(items)} items.")

    if args.dry_run:
        for i in items[:5]:
            print(f"  would delete: {i}")
        if len(items) > 5:
            print(f"  ... and {len(items) - 5} more")
        return

    if not items:
        print("Table is already empty.")
        return

    confirm = input(f"Delete all {len(items)} items? Type 'yes' to confirm: ")
    if confirm.strip().lower() != "yes":
        print("Aborted.")
        return

    deleted = 0
    with tbl.batch_writer() as batch:
        for it in items:
            batch.delete_item(Key={"accountId": it["accountId"], "sk": it["sk"]})
            deleted += 1
            if deleted % 100 == 0:
                print(f"  deleted {deleted}...")

    print(f"Done. Deleted {deleted} items.")


if __name__ == "__main__":
    main()
