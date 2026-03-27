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


@read_router.get("/devices")
async def get_devices(request: Request):
    sessions_table, _ = _tables()
    account_id = _account_id(request)

    items = _query_all(sessions_table, KeyConditionExpression=Key("accountId").eq(account_id))

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
                "lastActive": "",
            }
        d = devices[name]
        d["projectCount"].add(item.get("projectHash", ""))
        d["sessionCount"] += 1
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
                "activeCount": 0,
                "lastActive": "",
            }
        p = projects[ph]
        p["sessionCount"] += 1
        if item.get("isRunning"):
            p["activeCount"] += 1
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
            "isRunning": item.get("isRunning", False),
        })
    sessions.sort(key=lambda x: x["lastActive"], reverse=True)

    return {"sessions": sessions}


@read_router.get("/messages")
async def get_messages(request: Request, session: str = Query(...), after: str = Query(None)):
    _, messages_table = _tables()

    if after:
        # Range query: sk > "timestamp#\xff" to skip all messages at the exact cutoff timestamp
        items = _query_all(
            messages_table,
            KeyConditionExpression=Key("sessionId").eq(session) & Key("sk").gt(f"{after}#\xff"),
        )
    else:
        items = _query_all(
            messages_table,
            KeyConditionExpression=Key("sessionId").eq(session),
        )

    messages = []
    for item in items:
        content = item.get("content", "")
        try:
            content = json.loads(content)
        except (json.JSONDecodeError, TypeError):
            pass
        messages.append({
            "uuid": item.get("uuid", ""),
            "type": item.get("type", ""),
            "content": content,
            "timestamp": item.get("timestamp", ""),
        })

    return {"messages": messages}


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
