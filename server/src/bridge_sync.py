"""
Bridge sync routes — receives session metadata and messages from bridge client.
Usage: app.include_router(bridge_router) in main.py
"""

from fastapi import APIRouter, Request
from pydantic import BaseModel
from typing import List, Optional
import boto3
import os
import json
import hashlib
from datetime import datetime

bridge_router = APIRouter(prefix="/api/bridge")

_ddb = None
_sessions_table = None
_messages_table = None


def _tables():
    global _ddb, _sessions_table, _messages_table
    if _ddb is None:
        _ddb = boto3.resource("dynamodb", region_name=os.environ.get("AWS_REGION", "us-east-1"))
        _sessions_table = _ddb.Table(os.environ["BRIDGE_SESSIONS_TABLE"])
        _messages_table = _ddb.Table(os.environ["BRIDGE_MESSAGES_TABLE"])
    return _sessions_table, _messages_table


def _hash_key(api_key: str) -> str:
    """SHA256 hash of API key — never store the raw key in DynamoDB."""
    return hashlib.sha256(api_key.encode()).hexdigest()[:16]


class SessionItem(BaseModel):
    id: str
    project: str
    projectName: str = ""
    lastActive: str
    size: int = 0
    preview: str = ""
    model: str = ""
    status: str = "stopped"  # "running" | "idle" | "stopped"
    isAgent: bool = False
    agentName: str = ""
    agentDetail: str = ""
    agentState: str = ""


class DeviceAggregate(BaseModel):
    sessionCount: int = 0
    projectCount: int = 0
    runningCount: int = 0
    idleCount: int = 0
    lastActive: str = ""


class ProjectAggregate(BaseModel):
    projectHash: str
    projectName: str = ""
    sessionCount: int = 0
    runningCount: int = 0
    idleCount: int = 0
    lastActive: str = ""


class StatusDelta(BaseModel):
    deviceName: str
    projectHash: str
    projectName: str = ""
    # 'from' is reserved in Python, use alias
    from_: str = "stopped"   # populated via Field alias below
    to: str = "stopped"
    lastActive: str = ""

    class Config:
        populate_by_name = True

    def __init__(self, **data):
        # Accept both "from" (from JSON) and "from_" (from Python).
        if "from" in data:
            data["from_"] = data.pop("from")
        super().__init__(**data)


class SyncSessionsRequest(BaseModel):
    deviceName: str
    os: str = ""
    sessions: List[SessionItem]
    # Full-sync path: device + projects aggregates (server PutItem-overwrites DEV#/PROJ# items).
    device: Optional[DeviceAggregate] = None
    projects: Optional[List[ProjectAggregate]] = None
    # Incremental path: counter delta from a single session's status change.
    statusDelta: Optional[StatusDelta] = None
    # Bulk incremental (checkStopped): multiple status changes at once.
    statusDeltas: Optional[List[StatusDelta]] = None


class SyncMessagesRequest(BaseModel):
    sessionId: str
    messages: List[dict]


def _counter_delta(from_: str, to: str):
    """Map a status transition to (running_delta, idle_delta, session_delta).
    'new' from-state means this is a brand-new session (sessionCount += 1)."""
    def w(s):
        return (1 if s == "running" else 0, 1 if s == "idle" else 0)
    f_run, f_idle = (0, 0) if from_ == "new" else w(from_)
    t_run, t_idle = w(to)
    return (t_run - f_run, t_idle - f_idle, 1 if from_ == "new" else 0)


def _apply_status_delta(account_id: str, delta: StatusDelta):
    """ADD counters on PROJ#/DEV# items. DDB ADD auto-creates the item with delta values
    if it doesn't exist yet (zero base + delta)."""
    sessions_table, _ = _tables()
    dr, di, ds = _counter_delta(delta.from_, delta.to)
    if dr == 0 and di == 0 and ds == 0:
        return
    targets = [
        (f"PROJ#{delta.deviceName}#{delta.projectHash}", "project", delta.deviceName),
        (f"DEV#{delta.deviceName}", "device", delta.deviceName),
    ]
    for sk, entity_type, device in targets:
        sessions_table.update_item(
            Key={"accountId": account_id, "sk": sk},
            UpdateExpression=(
                "ADD runningCount :dr, idleCount :di, sessionCount :ds "
                "SET entityType = if_not_exists(entityType, :et), "
                "deviceName = if_not_exists(deviceName, :dn)"
            ),
            ExpressionAttributeValues={
                ":dr": dr, ":di": di, ":ds": ds,
                ":et": entity_type, ":dn": device,
            },
        )
    # PROJ# also needs projectHash/projectName seeded on first write
    if delta.from_ == "new":
        sessions_table.update_item(
            Key={"accountId": account_id, "sk": f"PROJ#{delta.deviceName}#{delta.projectHash}"},
            UpdateExpression="SET projectHash = if_not_exists(projectHash, :ph), projectName = if_not_exists(projectName, :pn)",
            ExpressionAttributeValues={":ph": delta.projectHash, ":pn": delta.projectName or delta.projectHash},
        )


def _bump_last_active(account_id: str, sk: str, ts: str):
    """Conditionally update lastActive only if the incoming ts is newer."""
    if not ts:
        return
    sessions_table, _ = _tables()
    try:
        sessions_table.update_item(
            Key={"accountId": account_id, "sk": sk},
            UpdateExpression="SET lastActive = :ts",
            ConditionExpression="attribute_not_exists(lastActive) OR lastActive < :ts",
            ExpressionAttributeValues={":ts": ts},
        )
    except Exception:
        pass


@bridge_router.post("/sync-sessions")
async def sync_sessions(req: SyncSessionsRequest, raw: Request):
    sessions_table, _ = _tables()
    key_hash = _hash_key(raw.headers.get("x-api-key", ""))
    now = datetime.utcnow().isoformat()

    # 1. Write SESS# items (always).
    with sessions_table.batch_writer() as batch:
        for s in req.sessions:
            item = {
                "accountId": key_hash,
                "sk": f"SESS#{req.deviceName}#{s.project}#{s.id}",
                "entityType": "session",
                "deviceName": req.deviceName,
                "os": req.os,
                "projectHash": s.project,
                "projectName": s.projectName or s.project,
                "sessionId": s.id,
                "lastActive": s.lastActive,
                "preview": s.preview,
                "model": s.model,
                "status": s.status,
                "size": s.size,
                "updatedAt": now,
            }
            # Sparse GSI: running/idle + done agents appear in accountId-activeStatus-index.
            if s.status in ("running", "idle"):
                item["activeStatus"] = s.status
            elif s.isAgent and s.agentState == "done":
                item["activeStatus"] = f"done#{s.lastActive}"
            # Agent metadata (sparse — only written when isAgent=True)
            if s.isAgent:
                item["isAgent"] = True
                item["agentName"] = s.agentName
                item["agentDetail"] = s.agentDetail
                item["agentState"] = s.agentState
            batch.put_item(Item=item)

    # 2a. Full-sync path: PutItem-overwrite DEV# + PROJ# aggregates (authoritative counters).
    if req.device is not None and req.projects is not None:
        sessions_table.put_item(Item={
            "accountId": key_hash,
            "sk": f"DEV#{req.deviceName}",
            "entityType": "device",
            "deviceName": req.deviceName,
            "os": req.os,
            "sessionCount": req.device.sessionCount,
            "projectCount": req.device.projectCount,
            "runningCount": req.device.runningCount,
            "idleCount": req.device.idleCount,
            "lastActive": req.device.lastActive,
            "updatedAt": now,
        })
        with sessions_table.batch_writer() as batch:
            for p in req.projects:
                batch.put_item(Item={
                    "accountId": key_hash,
                    "sk": f"PROJ#{req.deviceName}#{p.projectHash}",
                    "entityType": "project",
                    "deviceName": req.deviceName,
                    "projectHash": p.projectHash,
                    "projectName": p.projectName or p.projectHash,
                    "sessionCount": p.sessionCount,
                    "runningCount": p.runningCount,
                    "idleCount": p.idleCount,
                    "lastActive": p.lastActive,
                    "updatedAt": now,
                })

    # 2b. Incremental path: ADD counters delta.
    deltas = []
    if req.statusDelta is not None:
        deltas.append(req.statusDelta)
    if req.statusDeltas:
        deltas.extend(req.statusDeltas)
    for d in deltas:
        try:
            _apply_status_delta(key_hash, d)
            _bump_last_active(key_hash, f"PROJ#{d.deviceName}#{d.projectHash}", d.lastActive)
            _bump_last_active(key_hash, f"DEV#{d.deviceName}", d.lastActive)
        except Exception as e:
            print(f"statusDelta apply failed: {e}")

    return {"synced": len(req.sessions)}


@bridge_router.post("/sync-messages")
async def sync_messages(req: SyncMessagesRequest, raw: Request):
    _, messages_table = _tables()
    written = 0

    with messages_table.batch_writer() as batch:
        for msg in req.messages:
            uuid = msg.get("uuid", "")
            if not uuid:
                continue
            content = json.dumps(msg.get("content", ""), ensure_ascii=False)
            timestamp = msg.get("timestamp", datetime.utcnow().isoformat())
            item = {
                "sessionId": req.sessionId,
                "sk": f"{timestamp}#{uuid}",
                "uuid": uuid,
                "type": msg.get("type", ""),
                "content": content,
                "timestamp": timestamp,
            }
            if msg.get("stopReason"):
                item["stopReason"] = msg["stopReason"]
            if msg.get("toolUseResult"):
                item["toolUseResult"] = json.dumps(msg["toolUseResult"], ensure_ascii=False)
            batch.put_item(Item=item)
            written += 1

    return {"written": written}


class UploadImageRequest(BaseModel):
    key: str       # e.g. "903158ab6d09b5657c3529f3e4c9e5f8.jpg"
    data: str      # base64 encoded compressed JPEG


_s3 = None


def _s3_client():
    global _s3
    if _s3 is None:
        _s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION", "us-east-1"))
    return _s3


@bridge_router.post("/upload-image")
async def upload_image(req: UploadImageRequest):
    import base64
    bucket = os.environ.get("BRIDGE_IMAGES_BUCKET", "")
    if not bucket:
        return {"error": "BRIDGE_IMAGES_BUCKET not configured"}
    s3 = _s3_client()
    body = base64.b64decode(req.data)
    s3.put_object(Bucket=bucket, Key=f"images/{req.key}", Body=body, ContentType="image/jpeg")
    return {"key": req.key, "size": len(body)}


class UploadFileRequest(BaseModel):
    key: str
    data: str      # base64 encoded file content


@bridge_router.post("/upload-file")
async def upload_file(req: UploadFileRequest):
    import base64
    bucket = os.environ.get("BRIDGE_IMAGES_BUCKET", "")
    if not bucket:
        return {"error": "BRIDGE_IMAGES_BUCKET not configured"}
    s3 = _s3_client()
    body = base64.b64decode(req.data)
    s3.put_object(Bucket=bucket, Key=f"files/{req.key}", Body=body)
    return {"key": req.key, "size": len(body)}
