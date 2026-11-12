import asyncio
import os
import sys
from types import SimpleNamespace

sys.path.insert(
    0,
    os.path.join(os.path.dirname(__file__), "..", "..", "server", "src"),
)

import bridge_read
import bridge_ws


class FakeBatch:
    def __init__(self, table):
        self.table = table

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def put_item(self, Item):
        self.table.items.append(Item)

    def delete_item(self, Key):
        self.table.deleted.append(Key)


class FakeTable:
    def __init__(self):
        self.items = []
        self.deleted = []
        self.updates = []

    def batch_writer(self):
        return FakeBatch(self)

    def put_item(self, Item, **_):
        self.items.append(Item)

    def get_item(self, Key, **_):
        item = next((
            item for item in reversed(self.items)
            if item.get("accountId") == Key["accountId"] and item.get("sk") == Key["sk"]
        ), None)
        return {"Item": item} if item else {}

    def update_item(self, **kwargs):
        self.updates.append(kwargs)

    def query(self, **_kwargs):
        return {"Items": []}


class FakeRequest:
    headers = {"x-api-key": "test-key"}


def test_device_name_validation():
    devices = [
        {"deviceName": "Mac", "deviceDisplayName": "Office-Mac"},
        {"deviceName": "Linux"},
    ]
    assert bridge_read._check_device_name(devices, "dev-01", "identity") == ("dev-01", "")
    assert bridge_read._check_device_name(devices, "bad name", "identity")[1] == bridge_read.INVALID_INTERNAL_NAME
    assert bridge_read._check_device_name(devices, "office-mac", "identity")[1] == bridge_read.DUPLICATE_DEVICE_NAME
    assert bridge_read._check_device_name(devices, " 小伟的 Mac ", "display", "Mac") == ("小伟的 Mac", "")
    assert bridge_read._check_device_name(devices, "Linux", "display", "Mac")[1] == bridge_read.DUPLICATE_DEVICE_NAME
    assert bridge_read._check_device_name(devices, "x" * 33, "display")[1] == bridge_read.INVALID_DISPLAY_NAME


def test_windows_installer_prefers_s4u_with_interactive_fallback():
    script = bridge_read._windows_install_script(
        "https://example.com/bridge.tar.gz",
        "https://example.com/v1",
        "test-key",
        "Windows",
    )
    assert "-LogonType S4U" in script
    assert "$env:Path = (Split-Path $nodePath) + ';' + $env:Path" in script
    assert "ci --omit=dev --include=optional --silent --no-audit --no-fund" in script
    assert "verify-dependencies.mjs" in script
    assert "[version]'22.15.0'" in script
    assert "-LogonType ServiceAccount" in script
    assert "Administrator privileges are required" in script
    assert "Run as administrator" in script
    assert ".IsInRole" in script
    assert "-LogonType Interactive" in script
    assert "foreach ($attempt in 1..10)" in script
    assert "$runningChecks -ge 4" in script
    assert "Start-BatonTask" in script
    assert "did not start with S4U" in script
    assert "0x00041303" in script
    assert "Task Scheduler operational event" in script
    assert "failed to start within 10 seconds" in script
    assert "Task state: $taskState" in script
    assert "Start error: $taskError" in script
    assert "AppData\\Local\\Programs\\nodejs\\node.exe" in script
    assert "'C:\\nodejs'" in script
    assert "Node.js 22.15+ was not found or could not run" in script
    assert "Get-CimInstance Win32_UserProfile" in script
    assert "$useSystemTask = $isSystemContext -or ($currentIdentity -match" in script
    assert "bridge.log" in script
    assert "installed and running" in script


def test_windows_installer_prompts_for_device_name():
    script = bridge_read._windows_install_script(
        "https://example.com/bridge.tar.gz",
        "https://example.com/v1",
        "test-key",
        None,
    )
    assert 'Read-Host "Device name [$defaultName]"' in script
    assert "/api/bridge/device-name/validate" in script
    assert "deviceDisplayName = $deviceDisplayName" in script
    assert "Write-Host $result.error" in script


def test_unix_installer_validates_runtime_dependencies(monkeypatch):
    class S3:
        def generate_presigned_url(self, *_args, **_kwargs):
            return "https://example.com/bridge.tar.gz"

    request = FakeRequest()
    request.url = SimpleNamespace(scheme="https")
    monkeypatch.setenv("BRIDGE_IMAGES_BUCKET", "bridge-bucket")
    monkeypatch.setattr("boto3.client", lambda *_args, **_kwargs: S3())

    response = asyncio.run(bridge_read.get_install(request, name=None, platform=""))
    script = response.body.decode()

    assert "if tty -s 2>/dev/null < /dev/tty; then" in script
    assert 'printf "Device name [%s]: " "$DEFAULT_NAME" > /dev/tty' in script
    assert "/api/bridge/device-name/validate" in script
    assert "deviceDisplayName:process.env.BATON_DEVICE_DISPLAY_NAME" in script
    assert "if(existing.bridgeId)config.bridgeId=existing.bridgeId" in script
    assert "Requires >= 22.15" in script
    assert "npm ci --omit=dev --include=optional --silent --no-audit --no-fund" in script
    assert "node verify-dependencies.mjs" in script
    assert 'NODE_DIR=$(dirname "$NODE")' in script
    assert (
        "<key>PATH</key><string>$NODE_DIR:/opt/homebrew/bin:"
        "/usr/local/bin:/opt/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>"
    ) in script
    # The key lives only in config.json, readable by this user alone.
    assert "--key" not in script and "ExecStart=$NODE $DIR/bridge.mjs\n" in script
    assert "fs.chmodSync(p,0o600)" in script


def test_bridge_connection_persists_running_version(monkeypatch):
    connections = FakeTable()
    monkeypatch.setattr(connections, "update_item", lambda **kwargs: connections.updates.append(kwargs) or {})
    monkeypatch.setattr(bridge_ws, "_connections_table", connections)
    response = bridge_ws._handle_connect(
        {
            "queryStringParameters": {
                "apiKey": "test-key",
                "role": "bridge",
                "device": "Mac",
                "version": "0.2.0-test",
                "bridgeId": "a" * 32,
            },
        },
        "connection-1",
    )
    assert response == {"statusCode": 200}
    assert connections.items[0]["deviceName"] == "Mac"
    assert connections.items[0]["bridgeVersion"] == "0.2.0-test"
    assert connections.items[0]["bridgeOwner"].startswith("BRIDGE#")
    assert connections.updates[0]["Key"]["connectionId"] == connections.items[0]["bridgeOwner"]
    assert connections.updates[0]["ExpressionAttributeValues"][":connection"] == "connection-1"


def test_post_to_connection_uses_compact_utf8_json(monkeypatch):
    sent = []

    class Client:
        exceptions = SimpleNamespace(GoneException=RuntimeError)

        def post_to_connection(self, ConnectionId, Data):
            sent.append((ConnectionId, Data))

    monkeypatch.setattr(bridge_ws, "_apigw", Client())

    assert bridge_ws._post_to_connection(
        "https://example.test/v1",
        "app-1",
        {"action": "stream_delta", "chunk": "中文"},
    ) is True
    assert sent == [(
        "app-1",
        '{"action":"stream_delta","chunk":"中文"}'.encode(),
    )]
