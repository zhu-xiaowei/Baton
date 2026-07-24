"""
Bridge read routes — app reads session metadata and messages from DDB.
Usage: app.include_router(read_router) in main.py
"""

from fastapi import APIRouter, Request, Query, Response
from boto3.dynamodb.conditions import Key
import json
import os

read_router = APIRouter(prefix="/api/bridge")

_ddb = None
_sessions_table = None
_messages_table = None
_connections_table = None


def _tables():
    global _ddb, _sessions_table, _messages_table, _connections_table
    if _ddb is None:
        import boto3
        _ddb = boto3.resource("dynamodb", region_name=os.environ.get("AWS_REGION", "us-east-1"))
        _sessions_table = _ddb.Table(os.environ["BRIDGE_SESSIONS_TABLE"])
        _messages_table = _ddb.Table(os.environ["BRIDGE_MESSAGES_TABLE"])
        conn_name = os.environ.get("CONNECTIONS_TABLE")
        if conn_name:
            _connections_table = _ddb.Table(conn_name)
    return _sessions_table, _messages_table


def _account_id(request: Request) -> str:
    import hashlib
    api_key = request.headers.get("x-api-key", "")
    return hashlib.sha256(api_key.encode()).hexdigest()[:16]


def _query_all(table, **kwargs):
    """Query DDB with automatic pagination."""
    items = []
    response = table.query(**kwargs)
    items.extend(response.get("Items", []))
    while "LastEvaluatedKey" in response:
        response = table.query(ExclusiveStartKey=response["LastEvaluatedKey"], **kwargs)
        items.extend(response.get("Items", []))
    return items


@read_router.get("/config")
async def get_config():
    """Return server configuration (WS URL etc.) for bridge/app auto-discovery."""
    ws_endpoint = os.environ.get("WS_API_ENDPOINT", "")
    ws_url = ws_endpoint.replace("https://", "wss://") if ws_endpoint else ""
    return {"wsUrl": ws_url}


@read_router.get("/active-sessions")
async def get_active_sessions(request: Request):
    """Return active sessions + recent 20 completed agents.
    Two GSI queries: running/idle (between) + done (begins_with, limit 20 desc)."""
    sessions_table, _ = _tables()
    account_id = _account_id(request)

    import asyncio

    loop = asyncio.get_running_loop()
    active_items, done_items = await asyncio.gather(
        loop.run_in_executor(None, lambda: _query_all(sessions_table, IndexName="accountId-activeStatus-index",
            KeyConditionExpression=Key("accountId").eq(account_id) & Key("activeStatus").between("idle", "running"))),
        loop.run_in_executor(None, lambda: sessions_table.query(IndexName="accountId-activeStatus-index",
            KeyConditionExpression=Key("accountId").eq(account_id) & Key("activeStatus").begins_with("done#"),
            ScanIndexForward=False, Limit=20).get("Items", [])),
    )

    def _to_session(item):
        pn = item.get("projectName", "")
        s = {
            "sessionId": item.get("sessionId", ""),
            "preview": item.get("preview", ""),
            "status": item.get("status", "stopped"),
            "deviceName": item.get("deviceName", ""),
            "projectHash": item.get("projectHash", ""),
            "projectName": pn.rsplit("/", 1)[-1] if "/" in pn else pn,
            "lastActive": item.get("lastActive", ""),
        }
        if item.get("isAgent"):
            s["isAgent"] = True
            s["agentName"] = item.get("agentName", "")
            s["agentDetail"] = item.get("agentDetail", "")
            s["agentState"] = item.get("agentState", "")
        return s

    sessions = [_to_session(i) for i in active_items if i.get("status") in ("running", "idle")]
    sessions.sort(key=lambda x: x["lastActive"], reverse=True)

    recent_agents = [_to_session(i) for i in done_items]

    return {"sessions": sessions, "recentAgents": recent_agents}


@read_router.get("/devices")
async def get_devices(request: Request):
    """Read pre-aggregated DEV# items (one per device). O(K) where K = device count."""
    sessions_table, _ = _tables()
    account_id = _account_id(request)

    items = _query_all(
        sessions_table,
        KeyConditionExpression=Key("accountId").eq(account_id) & Key("sk").begins_with("DEV#"),
    )

    # Check which devices have active bridge WS connections.
    online_devices = set()
    if _connections_table is not None:
        try:
            resp = _connections_table.query(
                IndexName="accountId-role-index",
                KeyConditionExpression=Key("accountId").eq(account_id) & Key("role").eq("bridge"),
                ProjectionExpression="deviceName",
            )
            for c in resp.get("Items", []):
                dn = c.get("deviceName", "")
                if dn:
                    online_devices.add(dn)
        except Exception:
            pass

    devices = []
    for item in items:
        name = item.get("deviceName", "")
        if not name:
            continue
        devices.append({
            "deviceName": name,
            "os": item.get("os", ""),
            "projectCount": int(item.get("projectCount", 0)),
            "sessionCount": int(item.get("sessionCount", 0)),
            "runningCount": int(item.get("runningCount", 0)),
            "idleCount": int(item.get("idleCount", 0)),
            "lastActive": item.get("lastActive", ""),
            "online": name in online_devices,
        })
    devices.sort(key=lambda x: x["lastActive"], reverse=True)
    return {"devices": devices}


@read_router.get("/projects")
async def get_projects(request: Request, device: str = Query(...)):
    """Read pre-aggregated PROJ# items for the device. O(K) where K = project count."""
    sessions_table, _ = _tables()
    account_id = _account_id(request)

    items = _query_all(
        sessions_table,
        KeyConditionExpression=Key("accountId").eq(account_id) & Key("sk").begins_with(f"PROJ#{device}#"),
    )

    projects = []
    for item in items:
        ph = item.get("projectHash", "")
        if not ph:
            continue
        pn = item.get("projectName", ph)
        projects.append({
            "projectHash": ph,
            "projectName": pn.rsplit("/", 1)[-1] if "/" in pn else pn,
            "projectPath": pn,
            "sessionCount": int(item.get("sessionCount", 0)),
            "runningCount": int(item.get("runningCount", 0)),
            "idleCount": int(item.get("idleCount", 0)),
            "lastActive": item.get("lastActive", ""),
        })
    projects.sort(key=lambda x: x["lastActive"], reverse=True)
    return {"projects": projects}


@read_router.get("/sessions")
async def get_sessions(request: Request, device: str = Query(...), project: str = Query(...)):
    sessions_table, _ = _tables()
    account_id = _account_id(request)

    items = _query_all(
        sessions_table,
        KeyConditionExpression=Key("accountId").eq(account_id) & Key("sk").begins_with(f"SESS#{device}#{project}#"),
    )

    sessions = []
    for item in items:
        s = {
            "sessionId": item.get("sessionId", ""),
            "preview": item.get("preview", ""),
            "lastActive": item.get("lastActive", ""),
            "size": item.get("size", 0),
            "model": item.get("model", ""),
            "status": item.get("status", "stopped"),
        }
        if item.get("isAgent"):
            s["isAgent"] = True
            s["agentName"] = item.get("agentName", "")
            s["agentDetail"] = item.get("agentDetail", "")
            s["agentState"] = item.get("agentState", "")
        sessions.append(s)
    sessions.sort(key=lambda x: x["lastActive"], reverse=True)

    return {"sessions": sessions}


def _parse_messages(items):
    """Convert DDB items to message dicts."""
    messages = []
    for item in items:
        content = item.get("content", "")
        try:
            content = json.loads(content)
        except (json.JSONDecodeError, TypeError):
            pass
        msg = {
            "uuid": item.get("uuid", ""),
            "type": item.get("type", ""),
            "content": content,
            "timestamp": item.get("timestamp", ""),
        }
        if item.get("stopReason"):
            msg["stopReason"] = item["stopReason"]
        tur = item.get("toolUseResult", "")
        if tur:
            try:
                msg["toolUseResult"] = json.loads(tur)
            except (json.JSONDecodeError, TypeError):
                pass
        messages.append(msg)
    return messages


# Lambda invoke-response hard limit is 6MB (measured on the base64-encoded body
# the Lambda Web Adapter produces). base64 inflates ~33% and gzip barely helps
# image-heavy pages, so we cap the *uncompressed* JSON well under that: 4MB of
# JSON → ~5.3MB after base64, safely below 6MB even if gzip does nothing.
MAX_RESPONSE_BYTES = 4 * 1024 * 1024


def _trim_to_budget(messages):
    """Trim a newest-first message list to fit MAX_RESPONSE_BYTES, keeping the
    newest prefix and dropping older messages that overflow the budget.
    Returns (kept, trimmed). Always keeps at least one message (single items are
    capped at DDB_ITEM_LIMIT on the bridge side). Size is approximated from the
    already-parsed content/toolUseResult string length (base64 image data
    dominates, so this is accurate enough) to avoid re-serializing each message."""
    total, kept = 0, []
    for m in messages:
        size = len(str(m.get("content", ""))) + len(str(m.get("toolUseResult", "")))
        if kept and total + size > MAX_RESPONSE_BYTES:
            # The `before` cursor is timestamp-only, so a dropped message sharing
            # the oldest kept timestamp could never be re-fetched (`sk < ts`
            # excludes both) — a gap. Never split a same-timestamp run across the
            # page boundary: drop the whole trailing run so min(kept) is strictly
            # newer than every dropped message.
            boundary_ts = m.get("timestamp")
            while len(kept) > 1 and kept[-1].get("timestamp") == boundary_ts:
                kept.pop()
            return kept, True
        kept.append(m)
        total += size
    return kept, False


def _query_page(table, limit, **kwargs):
    """Query DDB with a limit, returning (items, has_more)."""
    items = []
    response = table.query(Limit=limit, **kwargs)
    items.extend(response.get("Items", []))
    has_more = "LastEvaluatedKey" in response
    if len(items) >= limit:
        return items[:limit], True
    while "LastEvaluatedKey" in response and len(items) < limit:
        remaining = limit - len(items)
        response = table.query(Limit=remaining, ExclusiveStartKey=response["LastEvaluatedKey"], **kwargs)
        items.extend(response.get("Items", []))
    return items[:limit], "LastEvaluatedKey" in response or len(items) > limit


@read_router.get("/messages")
async def get_messages(
    request: Request,
    session: str = Query(...),
    after: str = Query(None),
    before: str = Query(None),
    device: str = Query(None),
    limit: int = Query(None),
):
    _, messages_table = _tables()

    if after:
        # Forward query: used by WS reconnect recovery
        items = _query_all(
            messages_table,
            KeyConditionExpression=Key("sessionId").eq(session) & Key("sk").gt(f"{after}#\xff"),
        )
        messages = _parse_messages(items)
        return {"messages": messages, "hasMore": False, "needSync": False}

    page_limit = min(limit, 500) if limit else 100

    if before:
        # Reverse query: fetch messages BEFORE a timestamp (older messages)
        items, has_more = _query_page(
            messages_table,
            page_limit,
            KeyConditionExpression=Key("sessionId").eq(session) & Key("sk").lt(f"{before}"),
            ScanIndexForward=False,
        )
        # items are newest-first; trim the older tail that overflows the 6MB
        # response cap, keeping the newest messages closest to `before`.
        messages = _parse_messages(items)
        messages, trimmed = _trim_to_budget(messages)
        messages.reverse()
        oldest_ts = messages[0]["timestamp"] if messages else ""
        return {"messages": messages, "hasMore": has_more or trimmed, "oldestTimestamp": oldest_ts, "needSync": False}

    # Default: fetch latest N messages (reverse scan, then flip).
    # ConsistentRead=True closes the eventual-consistency window after a bridge
    # sync write — without it, the second /messages call after sync_complete
    # can briefly miss rows that the bridge just wrote.
    items, has_more = _query_page(
        messages_table,
        page_limit,
        KeyConditionExpression=Key("sessionId").eq(session),
        ScanIndexForward=False,
        ConsistentRead=True,
    )
    # items are newest-first; trim the older tail that overflows the 6MB cap.
    messages = _parse_messages(items)
    messages, trimmed = _trim_to_budget(messages)
    has_more = has_more or trimmed
    messages.reverse()

    need_sync = len(messages) == 0
    if need_sync:
        try:
            account_id = _account_id(request)
            ws_endpoint = os.environ.get("WS_API_ENDPOINT", "")
            if ws_endpoint:
                from bridge_ws import notify_bridge_sync
                notify_bridge_sync(session, account_id, ws_endpoint, device)
        except Exception as e:
            print(f"needSync trigger error: {e}")

    oldest_ts = messages[0]["timestamp"] if messages else ""
    return {"messages": messages, "hasMore": has_more, "oldestTimestamp": oldest_ts, "needSync": need_sync}


@read_router.get("/install")
async def get_install(request: Request, name: str = Query(None)):
    """Return a shell script that downloads and runs bridge."""
    import boto3
    bucket = os.environ.get("BRIDGE_IMAGES_BUCKET", "")
    if not bucket:
        return {"error": "bucket not configured"}
    s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION", "us-east-1"))
    url = s3.generate_presigned_url("get_object",
        Params={"Bucket": bucket, "Key": "install/bridge.tar.gz"}, ExpiresIn=3600)
    api_key = request.headers.get("x-api-key", "")
    ws_endpoint = os.environ.get("WS_API_ENDPOINT", "")
    ws_url = ws_endpoint.replace("https://", "wss://") if ws_endpoint else ""
    # Use x-forwarded headers from API GW if available
    proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    host = request.headers.get("host", "")
    server = f"{proto}://{host}/v1" if host else request.url.scheme + "://" + request.headers.get("host", "") + "/v1"
    if name:
        name_block = f'NAME="{name}"'
    else:
        name_block = (
            '# Read existing name from config, fall back to hostname\n'
            'EXISTING_NAME=""\n'
            'if [ -f "$DIR/config.json" ]; then\n'
            '  EXISTING_NAME=$(python3 -c "import json; print(json.load(open(\'$DIR/config.json\')).get(\'deviceName\',\'\'))" 2>/dev/null || true)\n'
            'fi\n'
            'DEFAULT_NAME="${EXISTING_NAME:-$(hostname)}"\n'
            'if [ -t 0 ] && [ -e /dev/tty ]; then\n'
            '  printf "Device name [$DEFAULT_NAME]: " > /dev/tty\n'
            '  read -r NAME < /dev/tty\n'
            '  NAME="${NAME:-$DEFAULT_NAME}"\n'
            'else\n'
            '  NAME="$DEFAULT_NAME"\n'
            'fi'
        )
    script = (
        '#!/bin/bash\n'
        'set -e\n'
        '\n'
        '# Require Node.js >= 20\n'
        'if ! command -v node &>/dev/null; then\n'
        '  echo "\\033[0;31mError: Node.js is not installed.\\033[0m" >&2\n'
        '  echo "Install Node.js 20+ from https://nodejs.org/ and try again." >&2\n'
        '  exit 1\n'
        'fi\n'
        'NODE_VER=$(node -e "process.stdout.write(process.versions.node.split(\\".\\")[0])")\n'
        'if [ "$NODE_VER" -lt 20 ] 2>/dev/null; then\n'
        '  echo "\\033[0;31mError: Node.js $NODE_VER is too old. Requires >= 20.\\033[0m" >&2\n'
        '  echo "Current: $(node --version)  —  upgrade from https://nodejs.org/" >&2\n'
        '  exit 1\n'
        'fi\n'
        '\n'
        'DIR="$HOME/.claude-bridge"\n'
        f'{name_block}\n'
        'NODE=$(which node)\n'
        'mkdir -p "$DIR" && cd "$DIR"\n'
        f'curl -sL "{url}" | tar xz 2>/dev/null\n'
        'npm install --production --silent 2>/dev/null\n'
        '\n'
        '# WSL: symlink Windows .claude directory so bridge can monitor Windows CC sessions\n'
        'if [ -n "$WSL_DISTRO_NAME" ]; then\n'
        '  WIN_USER=$(cmd.exe /c "echo %USERNAME%" 2>/dev/null | tr -d "\\r\\n")\n'
        '  if [ -n "$WIN_USER" ]; then\n'
        '    WIN_CLAUDE="/mnt/c/Users/${WIN_USER}/.claude"\n'
        '    if [ -d "$WIN_CLAUDE" ] && [ ! -e "$HOME/.claude" ]; then\n'
        '      ln -sf "$WIN_CLAUDE" "$HOME/.claude"\n'
        '      printf "  Linked Windows .claude → %s\\n" "$WIN_CLAUDE"\n'
        '    elif [ -d "$WIN_CLAUDE" ] && [ -L "$HOME/.claude" ]; then\n'
        '      printf "  Symlink already exists: %s\\n" "$(readlink $HOME/.claude)"\n'
        '    fi\n'
        '  fi\n'
        'fi\n'
        '\n'
        '# Setup auto-start service\n'
        'if [ "$(uname)" = "Darwin" ]; then\n'
        '  # macOS: launchd\n'
        '  PLIST="$HOME/Library/LaunchAgents/com.agentpeek.bridge.plist"\n'
        '  mkdir -p "$HOME/Library/LaunchAgents"\n'
        '  cat > "$PLIST" << PLIST_EOF\n'
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
        '<plist version="1.0"><dict>\n'
        '  <key>Label</key><string>com.agentpeek.bridge</string>\n'
        '  <key>ProgramArguments</key><array>\n'
        '    <string>$NODE</string>\n'
        '    <string>$DIR/bridge.mjs</string>\n'
        f'    <string>--server</string><string>{server}</string>\n'
        f'    <string>--key</string><string>{api_key}</string>\n'
        '    <string>--name</string><string>$NAME</string>\n'
        '  </array>\n'
        '  <key>EnvironmentVariables</key>\n'
        '  <dict>\n'
        '    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>\n'
        '  </dict>\n'
        '  <key>RunAtLoad</key><true/>\n'
        '  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n'
        '  <key>StandardOutPath</key><string>$DIR/bridge.log</string>\n'
        '  <key>StandardErrorPath</key><string>$DIR/bridge.log</string>\n'
        '</dict></plist>\n'
        'PLIST_EOF\n'
        '  launchctl unload "$PLIST" 2>/dev/null || true\n'
        '  launchctl load "$PLIST"\n'
        '  echo ""\n'
        '  echo "================================================================"\n'
        '  printf "  \\033[0;32mBridge installed and running successfully! (launchd)\\033[0m\\n"\n'
        '  echo "  Device: $NAME"\n'
        '  echo "  Logs:   $DIR/bridge.log"\n'
        '  echo "================================================================"\n'
        '  echo ""\n'
        '  echo "  Stop:    launchctl unload $PLIST"\n'
        '  echo "  Start:   launchctl load $PLIST"\n'
        '  echo "  Logs:    tail -f $DIR/bridge.log"\n'
        'else\n'
        '  # Linux: systemd\n'
        '  SERVICE_DIR="$HOME/.config/systemd/user"\n'
        '  mkdir -p "$SERVICE_DIR"\n'
        '  cat > "$SERVICE_DIR/claude-bridge.service" << SVC_EOF\n'
        '[Unit]\n'
        'Description=AgentPeek Bridge\n'
        'After=network.target\n'
        '[Service]\n'
        'ExecStart=$NODE $DIR/bridge.mjs --server '
        f'{server} --key {api_key} --name $NAME\n'
        'Restart=on-failure\n'
        'RestartSec=5\n'
        'KillMode=process\n'
        '[Install]\n'
        'WantedBy=default.target\n'
        'SVC_EOF\n'
        '  sudo loginctl enable-linger $(whoami) 2>/dev/null || loginctl enable-linger $(whoami) 2>/dev/null || true\n'
        '  export XDG_RUNTIME_DIR=/run/user/$(id -u)\n'
        '  systemctl --user daemon-reload\n'
        '  systemctl --user enable claude-bridge\n'
        '  systemctl --user restart claude-bridge\n'
        '  echo ""\n'
        '  echo "================================================================"\n'
        '  printf "  \\033[0;32mBridge installed and running successfully! (systemd)\\033[0m\\n"\n'
        '  echo "  Device: $NAME"\n'
        '  echo "================================================================"\n'
        '  echo ""\n'
        '  echo "  Stop:    systemctl --user stop claude-bridge"\n'
        '  echo "  Start:   systemctl --user start claude-bridge"\n'
        '  echo "  Logs:    journalctl --user -u claude-bridge -f"\n'
        'fi\n'
    )
    return Response(content=script, media_type="text/plain")


@read_router.get("/image/{key}")
async def get_image(key: str):
    """Return JPEG as base64-encoded text (text/plain).
    The frontend (loadOneImage) reads it via res.text() and assembles a data: URL.
    Returning text avoids API Gateway binary-encoding pitfalls and is compatible with GZip middleware.
    """
    import base64
    import boto3
    bucket = os.environ.get("BRIDGE_IMAGES_BUCKET", "")
    if not bucket:
        return Response(status_code=500, content="BRIDGE_IMAGES_BUCKET not configured")
    s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION", "us-east-1"))
    try:
        obj = s3.get_object(Bucket=bucket, Key=f"images/{key}")
        body = obj["Body"].read()
        return Response(content=base64.b64encode(body).decode("ascii"), media_type="text/plain")
    except s3.exceptions.NoSuchKey:
        return Response(status_code=404, content="Not found")
    except Exception as e:
        return Response(status_code=404, content=f"Not found: {e}")


@read_router.get("/file/{key}")
async def get_file(key: str):
    import boto3
    bucket = os.environ.get("BRIDGE_IMAGES_BUCKET", "")
    if not bucket:
        return Response(status_code=500, content="BRIDGE_IMAGES_BUCKET not configured")
    s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION", "us-east-1"))
    try:
        obj = s3.get_object(Bucket=bucket, Key=f"files/{key}")
        body = obj["Body"].read()
        return Response(content=body, media_type="text/plain; charset=utf-8")
    except s3.exceptions.NoSuchKey:
        return Response(status_code=404, content="Not found")
    except Exception as e:
        return Response(status_code=404, content=f"Not found: {e}")


@read_router.get("/video-url/{key}")
async def get_video_url(key: str):
    """Return a short-lived presigned GET URL so the browser <video> element streams
    videos/{key} directly from S3 (with Range/seek), bypassing the Lambda 6MB limit."""
    import boto3
    bucket = os.environ.get("BRIDGE_IMAGES_BUCKET", "")
    if not bucket:
        return Response(status_code=500, content="BRIDGE_IMAGES_BUCKET not configured")
    s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION", "us-east-1"))
    try:
        s3.head_object(Bucket=bucket, Key=f"videos/{key}")
    except Exception:
        return Response(status_code=404, content="Not found")
    url = s3.generate_presigned_url(
        "get_object",
        Params={"Bucket": bucket, "Key": f"videos/{key}"},
        ExpiresIn=3600,
    )
    # Must NOT be cached by CloudFront — the presigned URL expires in 1h, but the
    # CDN's default GET cache is 1 day, which would serve a stale/expired signature.
    return Response(content=json.dumps({"url": url}), media_type="application/json",
                    headers={"Cache-Control": "no-store"})
