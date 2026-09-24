import importlib.util
import json
from decimal import Decimal
from pathlib import Path

import pytest


SPEC = importlib.util.spec_from_file_location(
    "migrate_codex_worktrees",
    Path(__file__).resolve().parents[2] / "server/migrate-codex-worktrees.py",
)
migration = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(migration)


def fixture():
    def session(project, native, parent=None):
        session_id = f"codex:{native}"
        item = {
            "accountId": "account",
            "sk": f"SESS#device#{project}#{session_id}",
            "deviceName": "device",
            "projectHash": project,
            "projectName": project,
            "runtime": "codex",
            "sessionId": session_id,
            "nativeSessionId": native,
            "status": "completed",
            "activeStatus": "done#2026-09-23",
            "lastActive": "2026-09-23",
            "threadRootId": "codex:root" if parent else session_id,
            "threadRootPk": f"account#THREAD#device#{project}#codex:root",
            "threadRootSk": session_id,
            "listPk": f"account#SESS#device#{project}",
            "listSk": f"2026-09-23#{session_id}",
            "preview": "Keep my history",
            "size": Decimal(900),
            "customField": {"preserve": True},
        }
        if parent:
            item["parentSessionId"] = parent
        return item

    sessions = [session("old", "root"), session("old", "child", "codex:root"), session("main", "existing")]
    projects = [{
        "accountId": "account", "sk": f"PROJ#device#{project}",
        "projectHash": project, "projectName": project, "customField": "keep",
    } for project in ["old", "main", "unrelated-empty"]]
    device = {"accountId": "account", "sk": "DEV#device", "runtimeCapabilities": {"codex": {"canRead": True}}}
    return sessions, projects, device


def plan_for(sessions, projects, device):
    return migration.build_plan("account", "device", {"old"}, "main", sessions, projects, device)


def test_migration_preserves_history_and_moves_all_project_indexes():
    sessions, projects, device = fixture()
    plan = plan_for(sessions, projects, device)
    after = {change["key"]["sk"]: change["after"] for change in plan["changes"]}
    root = after["SESS#device#main#codex:root"]
    child = after["SESS#device#main#codex:child"]
    assert root["sessionId"] == sessions[0]["sessionId"]
    assert root["preview"] == sessions[0]["preview"]
    assert root["customField"] == {"preserve": True}
    assert root["listPk"] == "account#SESS#device#main"
    assert root["threadRootPk"] == "account#THREAD#device#main#codex:root"
    assert child["threadRootPk"] == root["threadRootPk"]
    assert child["parentSessionId"] == "codex:root"
    assert "listPk" not in child and "listSk" not in child
    assert after["PROJ#device#old"] is None
    assert "PROJ#device#unrelated-empty" not in after
    assert after["PROJ#device#main"]["customField"] == "keep"
    assert plan["projectCounts"]["sessionCount"] == 2
    assert plan["deviceCounts"]["projectCount"] == 2
    assert after["DEV#device"]["runtimeCapabilities"] == device["runtimeCapabilities"]


def test_migration_is_idempotent_and_rejects_conflicting_destinations():
    sessions, projects, device = fixture()
    plan = plan_for(sessions, projects, device)
    state = {item["sk"]: item for item in [*sessions, *projects, device]}
    for change in plan["changes"]:
        if change["after"] is None:
            state.pop(change["key"]["sk"], None)
        else:
            state[change["key"]["sk"]] = change["after"]
    assert plan_for(
        [item for key, item in state.items() if key.startswith("SESS#")],
        [item for key, item in state.items() if key.startswith("PROJ#")],
        state["DEV#device"],
    )["changes"] == []
    conflict = migration.move_session(sessions[0], "device", "main", "main")
    conflict["preview"] = "Newer content"
    with pytest.raises(ValueError, match="Conflicting target session"):
        plan_for([*sessions, conflict], projects, device)


def test_transaction_is_conditional_and_backup_preserves_dynamodb_types(tmp_path):
    plan = plan_for(*fixture())
    actions = migration.transaction_items("sessions", plan["changes"])
    assert len(actions) == len(plan["changes"])
    assert all("ConditionExpression" in next(iter(action.values())) for action in actions)
    new_root = next(action["Put"] for action in actions if action.get("Put", {}).get("Item", {}).get("sk") == {"S": "SESS#device#main#codex:root"})
    assert new_root["ConditionExpression"] == "attribute_not_exists(#pk)"
    backup = tmp_path / "backup.json"
    migration.write_backup(backup, "sessions", "region", plan["changes"])
    payload = json.loads(backup.read_text())
    saved_root = next(change for change in payload["changes"] if change["after"] and change["after"]["sk"]["S"] == "SESS#device#main#codex:root")
    assert saved_root["after"]["size"] == {"N": "900"}
    with pytest.raises(FileExistsError):
        migration.write_backup(backup, "sessions", "region", plan["changes"])


def test_unrelated_or_unverified_targets_are_not_overwritten():
    sessions, projects, device = fixture()
    with pytest.raises(ValueError, match="Target project must already exist"):
        migration.build_plan("account", "device", {"old"}, "missing", sessions, projects, device)
    projects[0]["userCreated"] = True
    with pytest.raises(ValueError, match="user-created"):
        plan_for(sessions, projects, device)
    projects[0].pop("userCreated")
    sessions[0]["runtime"] = "claude"
    with pytest.raises(ValueError, match="non-Codex"):
        plan_for(sessions, projects, device)
