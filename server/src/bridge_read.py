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


def _tables():
    global _ddb, _sessions_table, _messages_table
    if _ddb is None:
        import boto3
        _ddb = boto3.resource("dynamodb", region_name=os.environ.get("AWS_REGION", "us-east-1"))
        _sessions_table = _ddb.Table(os.environ["BRIDGE_SESSIONS_TABLE"])
        _messages_table = _ddb.Table(os.environ["BRIDGE_MESSAGES_TABLE"])
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
    """Return all running/idle sessions across all devices for dashboard."""
    sessions_table, _ = _tables()
    account_id = _account_id(request)

    items = _query_all(sessions_table, KeyConditionExpression=Key("accountId").eq(account_id))

    sessions = []
    for item in items:
        status = item.get("status", "stopped")
        if status not in ("running", "idle"):
            continue
        pn = item.get("projectName", "")
        sessions.append({
            "sessionId": item.get("sessionId", ""),
            "preview": item.get("preview", ""),
            "status": status,
            "deviceName": item.get("deviceName", ""),
            "projectHash": item.get("projectHash", ""),
            "projectName": pn.rsplit("/", 1)[-1] if "/" in pn else pn,
            "lastActive": item.get("lastActive", ""),
        })
    sessions.sort(key=lambda x: x["lastActive"], reverse=True)
    return {"sessions": sessions}


@read_router.get("/devices")
async def get_devices(request: Request):
    sessions_table, _ = _tables()
    account_id = _account_id(request)

    items = _query_all(sessions_table, KeyConditionExpression=Key("accountId").eq(account_id))

    # Check which devices have active bridge WS connections
    online_devices = set()
    try:
        import boto3
        ddb = boto3.resource("dynamodb", region_name=os.environ.get("AWS_REGION", "us-east-1"))
        conn_table = ddb.Table(os.environ["CONNECTIONS_TABLE"])
        resp = conn_table.scan(
            FilterExpression="accountId = :aid AND #r = :role",
            ExpressionAttributeNames={"#r": "role"},
            ExpressionAttributeValues={":aid": account_id, ":role": "bridge"},
            ProjectionExpression="deviceName",
        )
        for c in resp.get("Items", []):
            dn = c.get("deviceName", "")
            if dn:
                online_devices.add(dn)
    except Exception:
        pass

    # Aggregate by deviceName
    devices = {}
    for item in items:
        name = item.get("deviceName", "")
        if not name:
            continue
        if name not in devices:
            devices[name] = {
                "deviceName": name,
                "os": item.get("os", ""),
                "projectCount": set(),
                "sessionCount": 0,
                "runningCount": 0,
                "idleCount": 0,
                "lastActive": "",
                "online": name in online_devices,
            }
        d = devices[name]
        d["projectCount"].add(item.get("projectHash", ""))
        d["sessionCount"] += 1
        status = item.get("status", "stopped")
        if status == "running":
            d["runningCount"] += 1
        elif status == "idle":
            d["idleCount"] += 1
        la = item.get("lastActive", "")
        if la > d["lastActive"]:
            d["lastActive"] = la

    result = []
    for d in devices.values():
        d["projectCount"] = len(d["projectCount"])
        result.append(d)
    result.sort(key=lambda x: x["lastActive"], reverse=True)

    return {"devices": result}


@read_router.get("/projects")
async def get_projects(request: Request, device: str = Query(...)):
    sessions_table, _ = _tables()
    account_id = _account_id(request)

    items = _query_all(
        sessions_table,
        KeyConditionExpression=Key("accountId").eq(account_id) & Key("sk").begins_with(f"{device}#"),
    )

    # Aggregate by projectHash
    projects = {}
    for item in items:
        ph = item.get("projectHash", "")
        if not ph:
            continue
        if ph not in projects:
            pn = item.get("projectName", ph)
            projects[ph] = {
                "projectHash": ph,
                "projectName": pn.rsplit("/", 1)[-1] if "/" in pn else pn,
                "projectPath": pn,
                "sessionCount": 0,
                "runningCount": 0,
                "idleCount": 0,
                "lastActive": "",
            }
        p = projects[ph]
        p["sessionCount"] += 1
        status = item.get("status", "stopped")
        if status == "running":
            p["runningCount"] += 1
        elif status == "idle":
            p["idleCount"] += 1
        la = item.get("lastActive", "")
        if la > p["lastActive"]:
            p["lastActive"] = la

    result = sorted(projects.values(), key=lambda x: x["lastActive"], reverse=True)
    return {"projects": result}


@read_router.get("/sessions")
async def get_sessions(request: Request, device: str = Query(...), project: str = Query(...)):
    sessions_table, _ = _tables()
    account_id = _account_id(request)

    items = _query_all(
        sessions_table,
        KeyConditionExpression=Key("accountId").eq(account_id) & Key("sk").begins_with(f"{device}#{project}#"),
    )

    sessions = []
    for item in items:
        sessions.append({
            "sessionId": item.get("sessionId", ""),
            "preview": item.get("preview", ""),
            "lastActive": item.get("lastActive", ""),
            "size": item.get("size", 0),
            "model": item.get("model", ""),
            "status": item.get("status", "stopped"),
        })
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
        items.reverse()
        messages = _parse_messages(items)
        oldest_ts = messages[0]["timestamp"] if messages else ""
        return {"messages": messages, "hasMore": has_more, "oldestTimestamp": oldest_ts, "needSync": False}

    # Default: fetch latest N messages (reverse scan, then flip)
    items, has_more = _query_page(
        messages_table,
        page_limit,
        KeyConditionExpression=Key("sessionId").eq(session),
        ScanIndexForward=False,
    )
    items.reverse()
    messages = _parse_messages(items)

    need_sync = len(messages) == 0
    if need_sync:
        try:
            account_id = _account_id(request)
            ws_endpoint = os.environ.get("WS_API_ENDPOINT", "")
            if ws_endpoint:
                from bridge_ws import notify_bridge_sync
                notify_bridge_sync(session, account_id, ws_endpoint)
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
            'printf "Device name [$DEFAULT_NAME]: " > /dev/tty\n'
            'read -r NAME < /dev/tty\n'
            'NAME="${NAME:-$DEFAULT_NAME}"'
        )
    script = (
        '#!/bin/bash\n'
        'set -e\n'
        'DIR="$HOME/.claude-bridge"\n'
        f'{name_block}\n'
        'NODE=$(which node)\n'
        'mkdir -p "$DIR" && cd "$DIR"\n'
        f'curl -sL "{url}" | tar xz 2>/dev/null\n'
        'npm install --production --silent 2>/dev/null\n'
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
    import boto3
    bucket = os.environ.get("BRIDGE_IMAGES_BUCKET", "")
    if not bucket:
        return {"error": "BRIDGE_IMAGES_BUCKET not configured"}
    s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION", "us-east-1"))
    try:
        obj = s3.get_object(Bucket=bucket, Key=f"images/{key}")
        body = obj["Body"].read()
        return Response(content=body, media_type="image/jpeg")
    except s3.exceptions.NoSuchKey:
        return Response(status_code=404, content="Not found")
    except Exception as e:
        return Response(status_code=404, content=f"Not found: {e}")
