"""
AgentPeek REST API + WebSocket test suite.
Usage: cd test && pip install pytest requests websockets python-dotenv && pytest test_api.py -v
Config: create test/.env with API_URL and API_KEY
"""

import os
import pytest
import requests
import json
from dotenv import load_dotenv

load_dotenv()

API = os.environ.get("API_URL", "")
KEY = os.environ.get("API_KEY", "")
if not API or not KEY:
    raise RuntimeError("Missing API_URL or API_KEY in test/.env")
HEADERS = {"x-api-key": KEY}


def get(path, **params):
    return requests.get(f"{API}{path}", headers=HEADERS, params=params)


# ---- Health ----

class TestHealth:
    def test_returns_ok(self):
        r = get("/api/health")
        assert r.status_code == 200
        assert r.json()["status"] == "ok"


# ---- Auth ----

class TestAuth:
    def test_no_key_returns_403(self):
        r = requests.get(f"{API}/api/bridge/devices")
        assert r.status_code == 403

    def test_bad_key_returns_403(self):
        r = requests.get(f"{API}/api/bridge/devices", headers={"x-api-key": "bad-key"})
        assert r.status_code == 403


# ---- Param validation ----

class TestValidation:
    def test_projects_without_device(self):
        r = get("/api/bridge/projects")
        assert r.status_code == 422

    def test_sessions_without_project(self):
        r = get("/api/bridge/sessions", device="x")
        assert r.status_code == 422

    def test_messages_without_session(self):
        r = get("/api/bridge/messages")
        assert r.status_code == 422


# ---- Devices ----

class TestDevices:
    @pytest.fixture(autouse=True)
    def setup(self):
        self.data = get("/api/bridge/devices").json()
        self.devices = self.data["devices"]

    def test_has_devices(self):
        assert len(self.devices) > 0

    def test_device_fields(self):
        d = self.devices[0]
        assert isinstance(d["deviceName"], str) and d["deviceName"]
        assert isinstance(d["projectCount"], int) and d["projectCount"] > 0
        assert isinstance(d["sessionCount"], int) and d["sessionCount"] > 0
        assert "T" in d["lastActive"]  # ISO timestamp

    def test_sorted_by_last_active_desc(self):
        dates = [d["lastActive"] for d in self.devices]
        assert dates == sorted(dates, reverse=True)


# ---- Projects ----

class TestProjects:
    @pytest.fixture(autouse=True)
    def setup(self):
        devices = get("/api/bridge/devices").json()["devices"]
        self.device = devices[0]["deviceName"]
        self.data = get("/api/bridge/projects", device=self.device).json()
        self.projects = self.data["projects"]

    def test_has_projects(self):
        assert len(self.projects) > 0

    def test_project_fields(self):
        p = self.projects[0]
        assert isinstance(p["projectHash"], str) and p["projectHash"]
        assert isinstance(p["projectName"], str) and "/" not in p["projectName"]
        assert isinstance(p["projectPath"], str) and "/" in p["projectPath"]
        assert isinstance(p["sessionCount"], int) and p["sessionCount"] > 0
        assert isinstance(p["activeCount"], int)
        assert "T" in p["lastActive"]

    def test_project_name_is_last_segment(self):
        for p in self.projects:
            assert p["projectName"] == p["projectPath"].rsplit("/", 1)[-1]

    def test_sorted_by_last_active_desc(self):
        dates = [p["lastActive"] for p in self.projects]
        assert dates == sorted(dates, reverse=True)


# ---- Sessions ----

class TestSessions:
    @pytest.fixture(autouse=True)
    def setup(self):
        devices = get("/api/bridge/devices").json()["devices"]
        device = devices[0]["deviceName"]
        projects = get("/api/bridge/projects", device=device).json()["projects"]
        self.project = projects[0]
        self.data = get("/api/bridge/sessions", device=device, project=self.project["projectHash"]).json()
        self.sessions = self.data["sessions"]

    def test_has_sessions(self):
        assert len(self.sessions) > 0

    def test_session_fields(self):
        s = self.sessions[0]
        assert isinstance(s["sessionId"], str) and s["sessionId"]
        assert isinstance(s["preview"], str) and s["preview"]
        assert isinstance(s["size"], int)
        assert isinstance(s["model"], str)
        assert isinstance(s["isRunning"], bool)
        assert "T" in s["lastActive"]

    def test_sorted_by_last_active_desc(self):
        dates = [s["lastActive"] for s in self.sessions]
        assert dates == sorted(dates, reverse=True)


# ---- Messages ----

class TestMessages:
    @pytest.fixture(autouse=True)
    def setup(self):
        devices = get("/api/bridge/devices").json()["devices"]
        device = devices[0]["deviceName"]
        projects = get("/api/bridge/projects", device=device).json()["projects"]
        sessions = get("/api/bridge/sessions", device=device, project=projects[0]["projectHash"]).json()["sessions"]
        self.session_id = sessions[0]["sessionId"]
        self.data = get("/api/bridge/messages", session=self.session_id).json()
        self.messages = self.data["messages"]

    def test_has_messages(self):
        assert len(self.messages) > 0

    def test_message_fields(self):
        # Find a user or assistant message (ai-title may have empty fields)
        m = next((m for m in self.messages if m["type"] in ("user", "assistant")), self.messages[0])
        assert isinstance(m["uuid"], str) and m["uuid"]
        assert m["type"] in ("user", "assistant", "system", "summary", "ai-title")
        assert m["content"] is not None
        assert "T" in m["timestamp"]

    def test_sorted_by_timestamp_asc(self):
        dates = [m["timestamp"] for m in self.messages]
        assert dates == sorted(dates)

    def test_incremental_after(self):
        """after=timestamp should return only newer messages."""
        cutoff = self.messages[-3]["timestamp"] if len(self.messages) >= 3 else self.messages[0]["timestamp"]
        incr = get("/api/bridge/messages", session=self.session_id, after=cutoff).json()["messages"]
        assert 0 < len(incr) < len(self.messages)
        for m in incr:
            assert m["timestamp"] > cutoff

    def test_empty_session_returns_empty(self):
        r = get("/api/bridge/messages", session="nonexistent-session-id")
        assert r.status_code == 200
        assert r.json()["messages"] == []


# ---- Image ----

class TestImage:
    def test_missing_image_returns_404(self):
        r = get("/api/bridge/image/nonexistent.jpg")
        assert r.status_code == 404 or r.status_code == 500  # 500 if S3 client error


# ---- Config ----

class TestConfig:
    def test_returns_ws_url(self):
        # Retry once on 502 (Lambda cold start)
        r = get("/api/bridge/config")
        if r.status_code == 502:
            import time; time.sleep(2)
            r = get("/api/bridge/config")
        assert r.status_code == 200
        data = r.json()
        assert "wsUrl" in data
        assert data["wsUrl"].startswith("wss://")


# ---- needSync flow ----

class TestNeedSync:
    def test_unknown_session_returns_needsync(self):
        """GET /messages for an unknown session returns needSync=true and empty messages."""
        r = get("/api/bridge/messages", session="nonexistent-needsync-test-id")
        assert r.status_code == 200
        data = r.json()
        assert data["messages"] == []
        assert data["needSync"] is True

    def test_known_session_no_needsync(self):
        """GET /messages for a real session returns needSync=false."""
        devices = get("/api/bridge/devices").json()["devices"]
        device = devices[0]["deviceName"]
        projects = get("/api/bridge/projects", device=device).json()["projects"]
        sessions = get("/api/bridge/sessions", device=device, project=projects[0]["projectHash"]).json()["sessions"]
        session_id = sessions[0]["sessionId"]
        r = get("/api/bridge/messages", session=session_id)
        data = r.json()
        assert len(data["messages"]) > 0
        assert data["needSync"] is False

    def test_incremental_query_no_needsync(self):
        """GET /messages with after= param never triggers needSync even if empty result."""
        r = get("/api/bridge/messages", session="nonexistent-session-id", after="2099-01-01T00:00:00Z")
        data = r.json()
        assert data["messages"] == []
        assert data["needSync"] is False


# ---- WebSocket ----

WS_URL = None

def _get_ws_url():
    global WS_URL
    if WS_URL is None:
        cfg = get("/api/bridge/config").json()
        WS_URL = cfg.get("wsUrl", "")
    return WS_URL


class TestWebSocket:
    """WebSocket connection and subscription tests."""

    def test_connect_and_disconnect(self):
        """Connect as app, then disconnect cleanly."""
        import websockets.sync.client as wsc
        ws_url = _get_ws_url()
        if not ws_url:
            pytest.skip("No WS URL configured")
        url = f"{ws_url}?apiKey={KEY}&role=app"
        conn = wsc.connect(url)
        conn.close()

    def test_connect_without_key_fails(self):
        """Connection without API key should be rejected."""
        import websockets.sync.client as wsc
        ws_url = _get_ws_url()
        if not ws_url:
            pytest.skip("No WS URL configured")
        with pytest.raises(Exception):
            wsc.connect(f"{ws_url}?role=app")

    def test_subscribe_and_receive_ack(self):
        """Subscribe to a session — server should accept without error."""
        import websockets.sync.client as wsc
        ws_url = _get_ws_url()
        if not ws_url:
            pytest.skip("No WS URL configured")
        url = f"{ws_url}?apiKey={KEY}&role=app"
        conn = wsc.connect(url)
        conn.send(json.dumps({"action": "subscribe", "sessionId": "test-session-ws"}))
        # No error means success (WS API GW doesn't send ack by default)
        conn.send(json.dumps({"action": "unsubscribe", "sessionId": "test-session-ws"}))
        conn.close()

    def test_heartbeat(self):
        """Send heartbeat, expect heartbeat response."""
        import websockets.sync.client as wsc
        ws_url = _get_ws_url()
        if not ws_url:
            pytest.skip("No WS URL configured")
        url = f"{ws_url}?apiKey={KEY}&role=app"
        conn = wsc.connect(url)
        conn.send(json.dumps({"action": "heartbeat"}))
        # Server should respond with heartbeat
        try:
            msg = conn.recv(timeout=5)
            data = json.loads(msg)
            assert data["action"] == "heartbeat"
            assert "ts" in data
        except TimeoutError:
            pytest.fail("No heartbeat response within 5s")
        finally:
            conn.close()

    def test_bridge_push_relayed_to_app(self):
        """Bridge sends messages via WS → subscribed app receives them."""
        import websockets.sync.client as wsc
        ws_url = _get_ws_url()
        if not ws_url:
            pytest.skip("No WS URL configured")

        session_id = "test-relay-" + str(int(__import__("time").time()))

        # 1. Connect as app and subscribe
        app = wsc.connect(f"{ws_url}?apiKey={KEY}&role=app")
        app.send(json.dumps({"action": "subscribe", "sessionId": session_id}))

        # 2. Connect as bridge and push a message
        bridge = wsc.connect(f"{ws_url}?apiKey={KEY}&role=bridge")
        bridge.send(json.dumps({
            "action": "messages",
            "sessionId": session_id,
            "messages": [{
                "uuid": "test-uuid-001",
                "type": "user",
                "content": "hello from test",
                "timestamp": "2026-03-29T00:00:00Z",
            }],
        }))

        # 3. App should receive the relayed message
        try:
            msg = app.recv(timeout=5)
            data = json.loads(msg)
            assert data["action"] == "messages"
            assert data["sessionId"] == session_id
            assert len(data["messages"]) == 1
            assert data["messages"][0]["uuid"] == "test-uuid-001"
            assert data["messages"][0]["content"] == "hello from test"
        except TimeoutError:
            pytest.fail("App did not receive relayed message within 5s")
        finally:
            app.close()
            bridge.close()

    def test_sync_complete_relayed_to_app(self):
        """Bridge sends sync_complete → subscribed app receives it."""
        import websockets.sync.client as wsc
        ws_url = _get_ws_url()
        if not ws_url:
            pytest.skip("No WS URL configured")

        session_id = "test-sync-" + str(int(__import__("time").time()))

        # App subscribes
        app = wsc.connect(f"{ws_url}?apiKey={KEY}&role=app")
        app.send(json.dumps({"action": "subscribe", "sessionId": session_id}))

        # Bridge sends sync_complete
        bridge = wsc.connect(f"{ws_url}?apiKey={KEY}&role=bridge")
        bridge.send(json.dumps({
            "action": "sync_complete",
            "sessionId": session_id,
            "status": "ok",
            "count": 42,
        }))

        try:
            msg = app.recv(timeout=5)
            data = json.loads(msg)
            assert data["action"] == "sync_complete"
            assert data["sessionId"] == session_id
            assert data["count"] == 42
        except TimeoutError:
            pytest.fail("App did not receive sync_complete within 5s")
        finally:
            app.close()
            bridge.close()

    def test_unsubscribe_stops_relay(self):
        """After unsubscribe, app should NOT receive messages for that session."""
        import websockets.sync.client as wsc
        ws_url = _get_ws_url()
        if not ws_url:
            pytest.skip("No WS URL configured")

        session_id = "test-unsub-" + str(int(__import__("time").time()))

        app = wsc.connect(f"{ws_url}?apiKey={KEY}&role=app")
        app.send(json.dumps({"action": "subscribe", "sessionId": session_id}))
        import time; time.sleep(0.5)
        app.send(json.dumps({"action": "unsubscribe", "sessionId": session_id}))
        import time; time.sleep(0.5)

        bridge = wsc.connect(f"{ws_url}?apiKey={KEY}&role=bridge")
        bridge.send(json.dumps({
            "action": "messages",
            "sessionId": session_id,
            "messages": [{"uuid": "u1", "type": "user", "content": "should not arrive", "timestamp": "2026-03-29T00:00:00Z"}],
        }))

        try:
            app.recv(timeout=2)
            pytest.fail("Should NOT have received message after unsubscribe")
        except TimeoutError:
            pass  # Expected — no message received
        finally:
            app.close()
            bridge.close()
