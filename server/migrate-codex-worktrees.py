"""Move verified Codex worktree session metadata; dry-run unless --apply is given."""

import argparse
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path

import boto3
from boto3.dynamodb.conditions import Key
from boto3.dynamodb.types import TypeSerializer


def query_all(table, account_id, prefix):
    arguments = {
        "KeyConditionExpression": Key("accountId").eq(account_id)
        & Key("sk").begins_with(prefix),
        "ConsistentRead": True,
    }
    items = []
    while True:
        result = table.query(**arguments)
        items.extend(result.get("Items", []))
        if not result.get("LastEvaluatedKey"):
            return items
        arguments["ExclusiveStartKey"] = result["LastEvaluatedKey"]


def active_status(item):
    if item.get("activeStatus"):
        return item["activeStatus"]
    if item.get("status") == "needs_input" or item.get("needsInputAgentCount", 0):
        return "needs_input"
    if item.get("status") == "running" or item.get("runningAgentCount", 0):
        return "running"
    return "completed"


def counts(sessions):
    roots = [item for item in sessions if not item.get("parentSessionId")]
    return {
        "sessionCount": len(roots),
        "runningCount": sum(active_status(item) == "running" for item in roots),
        "idleCount": sum(active_status(item) == "needs_input" for item in roots),
        "lastActive": max((item.get("lastActive", "") for item in roots), default=""),
    }


def move_session(item, device, target, project_name):
    session_id = item.get("sessionId", "")
    if item.get("runtime") != "codex" or not session_id.startswith("codex:"):
        raise ValueError(f"Source contains a non-Codex session: {item.get('sk')}")
    expected_key = f"SESS#{device}#{item['projectHash']}#{session_id}"
    if item.get("sk") != expected_key or item.get("deviceName") != device:
        raise ValueError(f"Invalid session identity: {item.get('sk')}")
    migrated = dict(item)
    migrated.update(
        sk=f"SESS#{device}#{target}#{session_id}",
        projectHash=target,
        projectName=project_name,
    )
    account_id = item["accountId"]
    if item.get("parentSessionId"):
        migrated.pop("listPk", None)
        migrated.pop("listSk", None)
    else:
        migrated["listPk"] = f"{account_id}#SESS#{device}#{target}"
        migrated["listSk"] = f"{item.get('lastActive') or '0000'}#{session_id}"
    root_id = item.get("threadRootId")
    if item.get("threadRootPk") and not root_id:
        raise ValueError(f"Missing threadRootId: {item['sk']}")
    if root_id:
        migrated["threadRootPk"] = f"{account_id}#THREAD#{device}#{target}#{root_id}"
        migrated["threadRootSk"] = session_id
    return migrated


def build_plan(account_id, device, sources, target, sessions, projects, device_item):
    if not sources or target in sources or any(not value or "#" in value for value in [device, target, *sources]):
        raise ValueError("Supply distinct source and target project hashes without '#'")
    if not device_item:
        raise ValueError(f"Device does not exist: {device}")
    before = {item["sk"]: item for item in [*sessions, *projects, device_item]}
    if any(item.get("accountId") != account_id for item in before.values()):
        raise ValueError("Account mismatch")
    target_key = f"PROJ#{device}#{target}"
    target_project = before.get(target_key)
    if not target_project or target_project.get("projectHash") != target:
        raise ValueError("Target project must already exist")
    for source in sources:
        if before.get(f"PROJ#{device}#{source}", {}).get("userCreated"):
            raise ValueError(f"Refusing to remove a user-created project: {source}")
    after = dict(before)
    moves = []
    for item in sessions:
        if item.get("projectHash") not in sources:
            continue
        migrated = move_session(item, device, target, target_project.get("projectName") or target)
        existing = after.get(migrated["sk"])
        if existing is not None and existing != migrated:
            raise ValueError(f"Conflicting target session; nothing written: {migrated['sk']}")
        after[migrated["sk"]] = migrated
        del after[item["sk"]]
        moves.append({"sessionId": item["sessionId"], "from": item["projectHash"], "to": target})
    removed_projects = []
    for source in sources:
        source_key = f"PROJ#{device}#{source}"
        if source_key in after:
            del after[source_key]
            removed_projects.append(source)
    if not moves and not removed_projects:
        return {"moves": [], "removedProjects": [], "changes": []}
    now = datetime.now(timezone.utc).isoformat()
    final_sessions = [item for key, item in after.items() if key.startswith(f"SESS#{device}#")]
    project_counts = counts([item for item in final_sessions if item.get("projectHash") == target])
    after[target_key] = {
        **target_project,
        **project_counts,
        "updatedAt": now,
        "listPk": f"{account_id}#PROJ#{device}",
        "listSk": f"{project_counts['lastActive'] or '0000'}#{target}",
    }
    device_counts = {
        **counts(final_sessions),
        "projectCount": sum(key.startswith(f"PROJ#{device}#") for key in after),
    }
    after[device_item["sk"]] = {**device_item, **device_counts, "updatedAt": now}
    changes = [
        {
            "key": {"accountId": account_id, "sk": key},
            "before": before.get(key),
            "after": after.get(key),
        }
        for key in sorted(before.keys() | after.keys())
        if before.get(key) != after.get(key)
    ]
    return {
        "moves": moves,
        "removedProjects": removed_projects,
        "projectCounts": project_counts,
        "deviceCounts": device_counts,
        "changes": changes,
    }


def serialize_item(item):
    serializer = TypeSerializer()
    return {name: serializer.serialize(value) for name, value in item.items()}


def transaction_items(table_name, changes):
    if len(changes) > 100:
        raise ValueError("Migration exceeds 100 transactional writes; migrate fewer source projects at once")
    actions = []
    for change in changes:
        previous = change["before"]
        arguments = {"TableName": table_name}
        if previous is None:
            arguments.update(
                ConditionExpression="attribute_not_exists(#pk)",
                ExpressionAttributeNames={"#pk": "accountId"},
            )
        else:
            names = {f"#field{index}": name for index, name in enumerate(previous)}
            values = {f":value{index}": value for index, value in enumerate(previous.values())}
            arguments.update(
                ConditionExpression=" AND ".join(
                    f"#field{index} = :value{index}" for index in range(len(previous))
                ),
                ExpressionAttributeNames=names,
                ExpressionAttributeValues=serialize_item(values),
            )
        if change["after"] is None:
            arguments["Key"] = serialize_item(change["key"])
            actions.append({"Delete": arguments})
        else:
            arguments["Item"] = serialize_item(change["after"])
            actions.append({"Put": arguments})
    if len(json.dumps(actions).encode()) > 4 * 1024 * 1024:
        raise ValueError("Migration exceeds the transaction size budget")
    return actions


def write_backup(filename, table_name, region, changes):
    payload = {
        "table": table_name,
        "region": region,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "changes": [
            {
                "key": serialize_item(change["key"]),
                "before": serialize_item(change["before"]) if change["before"] is not None else None,
                "after": serialize_item(change["after"]) if change["after"] is not None else None,
            }
            for change in changes
        ],
    }
    descriptor = os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as output:
        json.dump(payload, output, ensure_ascii=False, indent=2)
        output.flush()
        os.fsync(output.fileno())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--table", required=True)
    parser.add_argument("--region", required=True)
    parser.add_argument("--profile")
    parser.add_argument("--config", type=Path, default=Path.home() / ".baton-bridge/config.json")
    parser.add_argument("--device", required=True)
    parser.add_argument("--from-project", action="append", required=True)
    parser.add_argument("--to-project", required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--bridges-stopped", action="store_true")
    parser.add_argument("--backup", type=Path)
    args = parser.parse_args()
    if args.apply and (not args.bridges_stopped or args.backup is None):
        parser.error("--apply requires --bridges-stopped and a new --backup file")
    config = json.loads(args.config.read_text())
    account_id = hashlib.sha256(config["apiKey"].encode()).hexdigest()[:16]
    session = boto3.Session(profile_name=args.profile, region_name=args.region)
    table = session.resource("dynamodb").Table(args.table)
    device_key = {"accountId": account_id, "sk": f"DEV#{args.device}"}
    plan = build_plan(
        account_id, args.device, set(args.from_project), args.to_project,
        query_all(table, account_id, f"SESS#{args.device}#"),
        query_all(table, account_id, f"PROJ#{args.device}#"),
        table.get_item(Key=device_key, ConsistentRead=True).get("Item"),
    )
    actions = transaction_items(args.table, plan["changes"])
    print(json.dumps({
        "mode": "apply" if args.apply else "dry-run",
        "device": args.device,
        **{key: value for key, value in plan.items() if key != "changes"},
        "transactionWrites": len(actions),
    }, ensure_ascii=False, indent=2))
    if not args.apply or not actions:
        return
    write_backup(args.backup, args.table, args.region, plan["changes"])
    session.client("dynamodb").transact_write_items(TransactItems=actions)
    print(f"Migration committed atomically. Backup: {args.backup}. Run again without --apply to verify.")


if __name__ == "__main__":
    main()
