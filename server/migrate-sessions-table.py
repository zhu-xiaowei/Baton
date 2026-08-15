#!/usr/bin/env python3
"""
One-shot migration: convert old SK format -> new single-table SK schema.

Old format:
  sk = "{deviceName}#{projectHash}#{sessionId}"   (session)

New format:
  sk = "DEV#{deviceName}"                         (device aggregate)
  sk = "PROJ#{deviceName}#{projectHash}"          (project aggregate)
  sk = "SESS#{deviceName}#{projectHash}#{sessionId}"  (session)

What it does:
  1. Scan all items
  2. For each old session item: write SESS# version + queue old for deletion
  3. Aggregate counters and write DEV# / PROJ# items
  4. Delete old items

Safe to re-run: idempotent (already-migrated items are skipped).

Usage:
  python3 migrate-sessions-table.py --table BatonTest-bridge-sessions --region us-west-2
  python3 migrate-sessions-table.py ... --dry-run
"""

import argparse
import boto3
from collections import defaultdict
from datetime import datetime


def scan_all(table):
    items = []
    resp = table.scan()
    items.extend(resp.get("Items", []))
    while "LastEvaluatedKey" in resp:
        resp = table.scan(ExclusiveStartKey=resp["LastEvaluatedKey"])
        items.extend(resp.get("Items", []))
    return items


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--table", required=True)
    ap.add_argument("--region", default="us-west-2")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    ddb = boto3.resource("dynamodb", region_name=args.region)
    tbl = ddb.Table(args.table)

    print(f"Scanning {args.table}...")
    items = scan_all(tbl)
    print(f"Found {len(items)} items.")

    sess_writes = []  # new SESS# items
    old_deletes = []  # delete old items (no DEV#/PROJ#/SESS# prefix)
    device_agg = defaultdict(lambda: {
        "os": "", "sessionCount": 0, "runningCount": 0, "idleCount": 0,
        "lastActive": "", "projects": set(),
    })
    project_agg = defaultdict(lambda: {
        "projectName": "", "sessionCount": 0, "runningCount": 0, "idleCount": 0,
        "lastActive": "",
    })

    skipped_already_migrated = 0
    for it in items:
        sk = it.get("sk", "")
        if sk.startswith("DEV#") or sk.startswith("PROJ#") or sk.startswith("SESS#"):
            skipped_already_migrated += 1
            continue

        # Treat as old-format session item.
        account_id = it["accountId"]
        device = it.get("deviceName", "")
        project = it.get("projectHash", "")
        session_id = it.get("sessionId", "")
        if not device or not project or not session_id:
            print(f"  ! skipping malformed item: {sk}")
            continue

        # Build new SESS# item (keep all attributes, swap sk + add entityType)
        new_item = dict(it)
        new_item["sk"] = f"SESS#{device}#{project}#{session_id}"
        new_item["entityType"] = "session"
        new_item["listPk"] = f"{account_id}#SESS#{device}#{project}"
        new_item["listSk"] = f"{it.get('lastActive', '') or '0000'}#{session_id}"
        sess_writes.append(new_item)
        old_deletes.append({"accountId": account_id, "sk": sk})

        status = it.get("status", "completed")
        last_active = it.get("lastActive", "")

        # Device aggregate (idleCount now tracks needs_input; legacy idle counted too).
        d = device_agg[(account_id, device)]
        d["os"] = it.get("os", d["os"])
        d["sessionCount"] += 1
        if status == "running": d["runningCount"] += 1
        elif status in ("needs_input", "idle"): d["idleCount"] += 1
        if last_active > d["lastActive"]: d["lastActive"] = last_active
        d["projects"].add(project)

        # Project aggregate
        p = project_agg[(account_id, device, project)]
        p["projectName"] = it.get("projectName", project)
        p["sessionCount"] += 1
        if status == "running": p["runningCount"] += 1
        elif status in ("needs_input", "idle"): p["idleCount"] += 1
        if last_active > p["lastActive"]: p["lastActive"] = last_active

    print()
    print(f"  already migrated: {skipped_already_migrated}")
    print(f"  to convert:       {len(sess_writes)} sessions")
    print(f"  device aggregates: {len(device_agg)}")
    print(f"  project aggregates: {len(project_agg)}")

    if args.dry_run:
        print()
        print("Sample new SESS# item:")
        if sess_writes:
            print(f"  {sess_writes[0]['sk']}")
        print()
        print("DEV# items to write:")
        for (acc, dev), d in device_agg.items():
            print(f"  DEV#{dev}: sessions={d['sessionCount']}, projects={len(d['projects'])}, running={d['runningCount']}, idle={d['idleCount']}")
        print()
        print("Sample PROJ# items (first 5):")
        for i, ((acc, dev, proj), p) in enumerate(project_agg.items()):
            if i >= 5: break
            print(f"  PROJ#{dev}#{proj[:20]}...: sessions={p['sessionCount']}, running={p['runningCount']}, idle={p['idleCount']}")
        return

    if not sess_writes and skipped_already_migrated == len(items):
        print("Nothing to migrate (already done).")
        return

    confirm = input(f"\nProceed? Type 'yes' to apply migration: ")
    if confirm.strip().lower() != "yes":
        print("Aborted.")
        return

    now = datetime.utcnow().isoformat()

    # 1. Write new SESS# items
    print(f"\nWriting {len(sess_writes)} SESS# items...")
    written = 0
    with tbl.batch_writer() as batch:
        for item in sess_writes:
            batch.put_item(Item=item)
            written += 1
            if written % 100 == 0:
                print(f"  {written}...")
    print(f"  done ({written}).")

    # 2. Write DEV# aggregates
    print(f"Writing {len(device_agg)} DEV# items...")
    with tbl.batch_writer() as batch:
        for (acc, dev), d in device_agg.items():
            batch.put_item(Item={
                "accountId": acc,
                "sk": f"DEV#{dev}",
                "entityType": "device",
                "deviceName": dev,
                "os": d["os"],
                "sessionCount": d["sessionCount"],
                "projectCount": len(d["projects"]),
                "runningCount": d["runningCount"],
                "idleCount": d["idleCount"],
                "lastActive": d["lastActive"],
                "updatedAt": now,
            })

    # 3. Write PROJ# aggregates
    print(f"Writing {len(project_agg)} PROJ# items...")
    with tbl.batch_writer() as batch:
        for (acc, dev, proj), p in project_agg.items():
            batch.put_item(Item={
                "accountId": acc,
                "sk": f"PROJ#{dev}#{proj}",
                "entityType": "project",
                "deviceName": dev,
                "projectHash": proj,
                "projectName": p["projectName"],
                "sessionCount": p["sessionCount"],
                "runningCount": p["runningCount"],
                "idleCount": p["idleCount"],
                "lastActive": p["lastActive"],
                "listPk": f"{acc}#PROJ#{dev}",
                "listSk": f"{p['lastActive'] or '0000'}#{proj}",
                "updatedAt": now,
            })

    # 4. Delete old items
    print(f"Deleting {len(old_deletes)} old items...")
    deleted = 0
    with tbl.batch_writer() as batch:
        for k in old_deletes:
            batch.delete_item(Key=k)
            deleted += 1
            if deleted % 100 == 0:
                print(f"  {deleted}...")
    print(f"  done ({deleted}).")

    print("\nMigration complete.")


if __name__ == "__main__":
    main()
