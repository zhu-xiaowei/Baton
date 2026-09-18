import asyncio
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "server" / "src"))
import bridge_read


NOW = datetime.now(timezone.utc)


def session(sid, project="project", device="Mac", minutes=0, status="completed", **extra):
    timestamp = (NOW - timedelta(minutes=minutes)).isoformat()
    return {
        "sessionId": sid,
        "deviceName": device,
        "projectHash": project,
        "projectName": f"/workspace/{project}",
        "preview": f"Preview {sid}",
        "lastActive": timestamp,
        "status": status,
        "activeStatus": status if status != "completed" else f"done#{timestamp}",
        **extra,
    }


class HomeTable:
    def __init__(self, active, done):
        self.active = active
        self.done = done
        self.calls = []

    def query(self, **kwargs):
        self.calls.append(kwargs)
        assert kwargs["IndexName"] == "accountId-activeStatus-index"
        expression = kwargs["KeyConditionExpression"].get_expression()
        assert expression["values"][0].get_expression()["values"][1] == "account"
        status = expression["values"][1].get_expression()
        if status["operator"] == "BETWEEN":
            return {"Items": self.active}
        assert status["values"][1] == "done#"
        assert kwargs["Limit"] == 100
        assert kwargs["ScanIndexForward"] is False
        rows = sorted(self.done, key=lambda s: s["activeStatus"], reverse=True)
        start = kwargs.get("ExclusiveStartKey", {}).get("offset", 0)
        end = start + kwargs["Limit"]
        return {
            "Items": rows[start:end],
            **({"LastEvaluatedKey": {"offset": end}} if end < len(rows) else {}),
        }


@pytest.fixture
def home(monkeypatch):
    def load(active=(), done=(), online=None, all_projects=False):
        table = HomeTable(list(active), list(done))
        monkeypatch.setattr(bridge_read, "_tables", lambda: (table, None))
        monkeypatch.setattr(bridge_read, "_account_id", lambda request: "account")
        monkeypatch.setattr(bridge_read, "_online_bridge_devices", lambda account: online)
        response = asyncio.run(bridge_read.get_active_sessions(None, allProjects=all_projects))
        assert len(table.calls) == 2
        return response
    return load


def test_groups_mix_statuses_and_sort_projects_and_sessions_by_activity(home):
    active = [
        session("running", minutes=15, status="running", isAgent=True, agentName="Reviewer"),
        session("waiting", minutes=1, status="needs_input", agentDetail="Approve the plan"),
    ]
    done = [
        session("older", minutes=30),
        session("other", project="other", minutes=2),
        session("recent", minutes=10),
    ]
    result = home(active, done)
    groups = result["recentProjects"]
    assert [p["projectHash"] for p in groups] == ["project", "other"]
    assert groups[0]["lastActive"] == active[1]["lastActive"]
    rows = groups[0]["sessions"]
    assert [s["sessionId"] for s in rows] == ["waiting", "recent", "running", "older"]
    assert [s["status"] for s in rows] == ["needs_input", "completed", "running", "completed"]
    assert rows[0]["agentDetail"] == "Approve the plan"
    assert rows[2]["agentName"] == "Reviewer"
    assert rows[2]["isAgent"] is True
    assert rows[0]["projectName"] == "project"
    assert rows[0]["preview"] == "Preview waiting"
    assert "status" not in result["recentSessions"][0]


def test_limits_projects_and_each_project_without_changing_legacy_fields(home):
    done = [
        session(f"{p}-{i}", project=f"project-{p}", minutes=i * 10 + p)
        for p in range(7) for i in range(8)
    ]
    result = home(done=done)
    assert result["sessions"] == []
    assert len(result["recentSessions"]) == 20
    assert result["hasMoreProjects"] is True
    groups = result["recentProjects"]
    assert [p["projectHash"] for p in groups] == [f"project-{p}" for p in range(5)]
    for p, group in enumerate(groups):
        assert [s["sessionId"] for s in group["sessions"]] == [f"{p}-{i}" for i in range(5)]


def test_window_is_applied_before_grouping_and_includes_active_sessions(home):
    done = [session(str(i), minutes=i) for i in range(100)]
    result = home(
        active=[session("old-running", project="old", minutes=101, status="running")],
        done=done + [session("older-history", project="history", minutes=102)],
    )
    assert [p["projectHash"] for p in result["recentProjects"]] == ["project"]
    assert len(result["recentProjects"][0]["sessions"]) == 5
    assert result["sessions"][0]["sessionId"] == "old-running"


def test_same_display_name_and_session_id_do_not_merge_distinct_projects(home):
    done = [
        session("same", project="path-one", device="Mac", projectName="/one/repo"),
        session("same", project="path-two", device="Mac", projectName="/two/repo"),
        session("same", project="path-one", device="Linux", projectName="/one/repo"),
    ]
    groups = home(done=done)["recentProjects"]
    assert len(groups) == 3
    assert {p["projectName"] for p in groups} == {"repo"}
    assert {(p["deviceName"], p["projectHash"]) for p in groups} == {
        ("Mac", "path-one"), ("Mac", "path-two"), ("Linux", "path-one"),
    }
    assert all(len(p["sessions"]) == 1 for p in groups)


def test_deduplicates_before_windowing_and_prefers_active_data_on_ties(home):
    duplicate = session("codex:duplicate", minutes=1)
    active = [
        session("codex:duplicate", minutes=1, status="needs_input", agentDetail="Choose"),
        session("old-active", minutes=10, status="running"),
    ]
    done = [duplicate] * 98 + [
        session("old-active", minutes=2),
        session("other", project="other", minutes=3),
    ]
    groups = home(active, done)["recentProjects"]
    rows = groups[0]["sessions"]
    assert [s["sessionId"] for s in rows] == ["codex:duplicate", "old-active"]
    assert rows[0]["status"] == "needs_input"
    assert rows[0]["agentDetail"] == "Choose"
    assert rows[1]["status"] == "completed", "newer activity wins over an older active copy"
    assert groups[1]["projectHash"] == "other"


def test_root_and_active_visibility_rules_are_preserved(home):
    active = [
        session("root", status="running"),
        session("active-child", project="child", status="running", parentSessionId="root"),
        session("offline", project="offline", device="Offline", status="running"),
        session("stale", project="stale", minutes=8 * 24 * 60, status="needs_input"),
    ]
    done = [
        session("done-child", project="child", parentSessionId="root"),
        session("offline-done", project="offline", device="Offline", minutes=10),
    ]
    result = home(active, done, online={"Mac"})
    assert [s["sessionId"] for s in result["sessions"]] == ["root"]
    assert [p["projectHash"] for p in result["recentProjects"]] == ["project", "offline"]
    assert [s["sessionId"] for s in result["recentSessions"]] == ["offline-done"]


@pytest.mark.parametrize("count", [0, 1, 2])
def test_sparse_history_is_not_padded(home, count):
    result = home(done=[session(str(i), minutes=i) for i in range(count)])
    assert result["hasMoreProjects"] is False
    assert len(result["recentProjects"]) == (1 if count else 0)
    if count:
        assert len(result["recentProjects"][0]["sessions"]) == count


def test_ties_have_stable_order_and_invalid_navigation_rows_are_omitted(home):
    rows = [session(sid, project=p) for p in ("a", "b") for sid in ("1", "2")]
    first = home(done=rows)["recentProjects"]
    second = home(done=list(reversed(rows)))["recentProjects"]
    assert first == second
    assert [p["projectHash"] for p in first] == ["b", "a"]
    assert [s["sessionId"] for s in first[0]["sessions"]] == ["2", "1"]
    assert home(done=[
        session("", minutes=1),
        session("missing-device", device=""),
        session("missing-project", project=""),
    ])["recentProjects"] == []


def test_all_projects_returns_a_fresh_complete_window_with_five_sessions_per_group(home):
    done = [
        session(f"{p}-{i}", project=f"project-{p}", minutes=i * 10 + p)
        for p in range(7) for i in range(8)
    ]
    initial = home(done=done)
    expanded = home(done=done, all_projects=True)
    assert initial["hasMoreProjects"] is True
    assert expanded["hasMoreProjects"] is False
    assert len(expanded["recentProjects"]) == 7
    assert all(len(p["sessions"]) == 5 for p in expanded["recentProjects"])
    assert expanded["recentProjects"][:5] == initial["recentProjects"]
    assert expanded["sessions"] == initial["sessions"]
    assert expanded["recentSessions"] == initial["recentSessions"]


def test_expanded_projects_are_capped_at_fifteen_within_the_same_hundred_session_window(home):
    done = [session(str(i), project=str(i), minutes=i) for i in range(101)]
    result = home(done=done, all_projects=True)
    assert len(result["recentProjects"]) == 15
    assert [p["projectHash"] for p in result["recentProjects"]] == [str(i) for i in range(15)]
    assert sum(len(p["sessions"]) for p in result["recentProjects"]) == 15
    assert result["hasMoreProjects"] is False
    assert all(p["projectHash"] != "100" for p in result["recentProjects"])


def test_exactly_five_projects_does_not_offer_more(home):
    result = home(done=[session(str(i), project=str(i), minutes=i) for i in range(5)])
    assert len(result["recentProjects"]) == 5
    assert result["hasMoreProjects"] is False


def test_expanded_projects_keep_the_five_session_limit(home):
    done = [
        session(f"{p}-{i}", project=str(p), minutes=i * 20 + p)
        for p in range(20) for i in range(5)
    ]
    result = home(done=done, all_projects=True)
    assert len(result["recentProjects"]) == 15
    assert all(len(p["sessions"]) == 5 for p in result["recentProjects"])
    assert result["hasMoreProjects"] is False
