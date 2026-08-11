#!/usr/bin/env python3
"""Backfill list pagination index keys on existing project and session rows."""

import argparse

import boto3
from botocore.exceptions import ClientError


def index_fields(item):
    account_id = item.get("accountId", "")
    sk = item.get("sk", "")
    entity_type = item.get("entityType", "")
    if not entity_type:
        if sk.startswith("PROJ#"):
            entity_type = "project"
        elif sk.startswith("SESS#"):
            entity_type = "session"
    device = item.get("deviceName", "")
    last_active = item.get("lastActive", "") or "0000"

    if entity_type == "project":
        stable_id = item.get("projectHash", "")
        list_pk = f"{account_id}#PROJ#{device}"
    elif entity_type == "session":
        project = item.get("projectHash", "")
        stable_id = item.get("sessionId", "")
        list_pk = f"{account_id}#SESS#{device}#{project}"
    else:
        return None

    if not account_id or not device or not stable_id:
        return None
    return {"listPk": list_pk, "listSk": f"{last_active}#{stable_id}"}


def backfill(table, dry_run=False):
    scanned = eligible = updated = malformed = conflicts = 0
    response = table.scan()

    while True:
        for item in response.get("Items", []):
            scanned += 1
            fields = index_fields(item)
            if fields is None:
                if item.get("entityType") in ("project", "session"):
                    malformed += 1
                continue
            eligible += 1
            if item.get("listPk") == fields["listPk"] and item.get("listSk") == fields["listSk"]:
                continue
            if not dry_run:
                values = {":pk": fields["listPk"], ":sk": fields["listSk"]}
                if "lastActive" in item:
                    condition = "attribute_exists(#row_sk) AND #la = :la"
                    values[":la"] = item["lastActive"]
                else:
                    condition = "attribute_exists(#row_sk) AND attribute_not_exists(#la)"
                try:
                    table.update_item(
                        Key={"accountId": item["accountId"], "sk": item["sk"]},
                        UpdateExpression="SET listPk = :pk, listSk = :sk",
                        ConditionExpression=condition,
                        ExpressionAttributeNames={"#la": "lastActive", "#row_sk": "sk"},
                        ExpressionAttributeValues=values,
                    )
                except ClientError as error:
                    if error.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
                        raise
                    conflicts += 1
                    continue
            updated += 1
        if "LastEvaluatedKey" not in response:
            break
        response = table.scan(ExclusiveStartKey=response["LastEvaluatedKey"])

    return {
        "scanned": scanned,
        "eligible": eligible,
        "updated": updated,
        "malformed": malformed,
        "conflicts": conflicts,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--table", required=True)
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    table = boto3.resource("dynamodb", region_name=args.region).Table(args.table)
    result = backfill(table, args.dry_run)
    action = "would_update" if args.dry_run else "updated"
    print(
        f"scanned={result['scanned']} eligible={result['eligible']} "
        f"{action}={result['updated']} malformed={result['malformed']} "
        f"conflicts={result['conflicts']}"
    )


if __name__ == "__main__":
    main()
