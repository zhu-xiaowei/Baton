"""
Bridge sync routes — receives session metadata and messages from bridge client.
Usage: app.include_router(bridge_router) in main.py
"""

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field
from typing import Dict, List, Optional
from boto3.dynamodb.conditions import Key
import boto3
import os
import json
import hashlib
from datetime import datetime
import time

MESSAGE_TTL_DAYS = 90  # message rows are a rebuildable cache (jsonl is truth); expire after 90d


def _msg_ttl():
    return int(time.time()) + MESSAGE_TTL_DAYS * 86400

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
    nativeSessionId: str = ""
    runtime: str = "claude"
    project: str
    projectName: str = ""
    lastActive: str
    size: int = 0
    preview: str = ""
    model: str = ""
    modelProvider: str = ""
    clientSource: str = ""
    cliVersion: str = ""
    status: str = "completed"  # "running" | "needs_input" | "completed"
    isAgent: bool = False
    agentName: str = ""
    agentRole: str = ""
    agentDetail: str = ""
    threadKind: str = "main"
    parentSessionId: str = ""
    agentPath: str = ""
    agentDepth: int = 0
    canSend: bool = True
    agentCount: Optional[int] = None


class AgentCountUpdate(BaseModel):
    sessionId: str
    project: str
    agentCount: int = 0


class RuntimeCapability(BaseModel):
    installed: bool = False
    historyAvailable: bool = False
    canRead: bool = False
    canCreate: bool = False
    canSend: bool = False
    version: str = ""


class DeviceAggregate(BaseModel):
    sessionCount: int = 0
    projectCount: int = 0
    runningCount: int = 0
    idleCount: int = 0
    lastActive: str = ""
    runtimeCapabilities: Dict[str, RuntimeCapability] = Field(default_factory=dict)


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
    from_: str = "completed"   # populated via Field alias below
    to: str = "completed"
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
    deviceDisplayName: str = ""
    os: str = ""
    sessions: List[SessionItem]
    # Complete catalogs overwrite aggregates. Incomplete catalogs only bootstrap
    # a device that does not have an aggregate yet.
    catalogComplete: bool = True
    device: Optional[DeviceAggregate] = None
    projects: Optional[List[ProjectAggregate]] = None
    # Incremental path: counter delta from a single session's status change.
    statusDelta: Optional[StatusDelta] = None
    # Bulk incremental (checkStopped): multiple status changes at once.
    statusDeltas: Optional[List[StatusDelta]] = None
    agentCountUpdates: Optional[List[AgentCountUpdate]] = None


class SyncMessagesRequest(BaseModel):
    sessionId: str
    runtime: str = "claude"
    nativeSessionId: str = ""
    messages: List[dict]


def _normalize_runtime(runtime: str) -> str:
    return "codex" if runtime == "codex" else "claude"


def _session_ids(runtime: str, session_id: str, native_session_id: str = ""):
    """Normalize old and new payloads to runtime, native id, and storage id."""
    runtime = _normalize_runtime(runtime)
    native_id = native_session_id or session_id
    if runtime == "codex" and native_id.startswith("codex:"):
        native_id = native_id[len("codex:"):]
    storage_id = native_id if runtime == "claude" else f"codex:{native_id}"
    return runtime, native_id, storage_id


def _project_list_pk(account_id: str, device: str) -> str:
    return f"{account_id}#PROJ#{device}"


def _session_list_pk(account_id: str, device: str, project: str) -> str:
    return f"{account_id}#SESS#{device}#{project}"


def _list_sk(last_active: str, stable_id: str) -> str:
    return f"{last_active or '0000'}#{stable_id}"


def _counter_delta(from_: str, to: str):
    """Map a status transition to (running_delta, idle_delta, session_delta).
    'new' from-state means this is a brand-new session (sessionCount += 1).
    idleCount now tracks needs_input; legacy 'idle' still counts inbound so old
    counters drain correctly on a migrating session's next transition."""
    def w(s):
        return (1 if s == "running" else 0, 1 if s in ("needs_input", "idle") else 0)
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


def _bump_last_active(account_id: str, sk: str, ts: str, list_pk: str = "", list_id: str = ""):
    """Conditionally update lastActive only if the incoming ts is newer."""
    if not ts:
        return
    sessions_table, _ = _tables()
    update = "SET lastActive = :ts"
    values = {":ts": ts}
    if list_pk and list_id:
        update += ", listPk = :list_pk, listSk = :list_sk"
        values.update({":list_pk": list_pk, ":list_sk": _list_sk(ts, list_id)})
    try:
        sessions_table.update_item(
            Key={"accountId": account_id, "sk": sk},
            UpdateExpression=update,
            ConditionExpression="attribute_not_exists(lastActive) OR lastActive < :ts",
            ExpressionAttributeValues=values,
        )
    except Exception:
        pass


@bridge_router.post("/sync-sessions")
async def sync_sessions(req: SyncSessionsRequest, raw: Request):
    sessions_table, _ = _tables()
    key_hash = _hash_key(raw.headers.get("x-api-key", ""))
    now = datetime.utcnow().isoformat()

    preserved_agent_counts = {}
    for s in req.sessions:
        if s.parentSessionId or s.agentCount is not None:
            continue
        _, _, storage_id = _session_ids(s.runtime, s.id, s.nativeSessionId)
        existing = sessions_table.get_item(Key={
            "accountId": key_hash,
            "sk": f"SESS#{req.deviceName}#{s.project}#{storage_id}",
        }).get("Item", {})
        if "agentCount" in existing:
            preserved_agent_counts[(s.project, storage_id)] = existing["agentCount"]

    # 1. Write SESS# items (always).
    with sessions_table.batch_writer() as batch:
        for s in req.sessions:
            runtime, native_id, storage_id = _session_ids(s.runtime, s.id, s.nativeSessionId)
            item = {
                "accountId": key_hash,
                "sk": f"SESS#{req.deviceName}#{s.project}#{storage_id}",
                "entityType": "session",
                "deviceName": req.deviceName,
                "os": req.os,
                "projectHash": s.project,
                "projectName": s.projectName or s.project,
                "sessionId": storage_id,
                "nativeSessionId": native_id,
                "runtime": runtime,
                "lastActive": s.lastActive,
                "preview": s.preview,
                "model": s.model,
                "status": s.status,
                "size": s.size,
                "updatedAt": now,
            }
            if s.modelProvider:
                item["modelProvider"] = s.modelProvider
            if s.clientSource:
                item["clientSource"] = s.clientSource
            if s.cliVersion:
                item["cliVersion"] = s.cliVersion
            # Only root sessions belong in outer list/active indexes. Child
            # threads stay queryable through the base-table project prefix.
            if not s.parentSessionId:
                item["listPk"] = _session_list_pk(key_hash, req.deviceName, s.project)
                item["listSk"] = _list_sk(s.lastActive, storage_id)
                if s.status in ("running", "needs_input"):
                    item["activeStatus"] = s.status
                elif s.status == "completed":
                    item["activeStatus"] = f"done#{s.lastActive}"
            # Agent metadata (sparse — only written when isAgent=True)
            if s.isAgent:
                item["isAgent"] = True
                item["agentName"] = s.agentName
                item["agentRole"] = s.agentRole
            if s.agentDetail:
                item["agentDetail"] = s.agentDetail
            if s.parentSessionId:
                item["threadKind"] = s.threadKind or "subagent"
                item["parentSessionId"] = s.parentSessionId
                item["agentPath"] = s.agentPath
                item["agentDepth"] = s.agentDepth
                item["canSend"] = s.canSend
            if not s.parentSessionId and s.agentCount is not None:
                item["agentCount"] = max(0, s.agentCount)
            elif not s.parentSessionId:
                preserved_count = preserved_agent_counts.get((s.project, storage_id))
                if preserved_count is not None:
                    item["agentCount"] = preserved_count
            batch.put_item(Item=item)

    for update in req.agentCountUpdates or []:
        sessions_table.update_item(
            Key={
                "accountId": key_hash,
                "sk": f"SESS#{req.deviceName}#{update.project}#{update.sessionId}",
            },
            UpdateExpression="SET agentCount = :count, updatedAt = :now",
            ExpressionAttributeValues={
                ":count": max(0, update.agentCount),
                ":now": now,
            },
        )

    # 2a. Complete catalogs authoritatively overwrite aggregates. An incomplete
    # first scan may bootstrap a missing device, but never clobbers an existing one.
    write_aggregates = req.device is not None and req.projects is not None
    if write_aggregates and not req.catalogComplete:
        existing = sessions_table.get_item(
            Key={"accountId": key_hash, "sk": f"DEV#{req.deviceName}"},
            ConsistentRead=True,
        ).get("Item")
        write_aggregates = existing is None

    if write_aggregates:
        device_item = {
            "accountId": key_hash,
            "sk": f"DEV#{req.deviceName}",
            "entityType": "device",
            "deviceName": req.deviceName,
            "deviceDisplayName": req.deviceDisplayName or req.deviceName,
            "os": req.os,
            "sessionCount": req.device.sessionCount,
            "projectCount": req.device.projectCount,
            "runningCount": req.device.runningCount,
            "idleCount": req.device.idleCount,
            "lastActive": req.device.lastActive,
            "updatedAt": now,
        }
        if req.device.runtimeCapabilities:
            device_item["runtimeCapabilities"] = {
                runtime: capability.model_dump(exclude_none=True)
                for runtime, capability in req.device.runtimeCapabilities.items()
            }
        sessions_table.put_item(Item=device_item)
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
                    "listPk": _project_list_pk(key_hash, req.deviceName),
                    "listSk": _list_sk(p.lastActive, p.projectHash),
                    "updatedAt": now,
                })
    elif req.deviceDisplayName:
        sessions_table.update_item(
            Key={"accountId": key_hash, "sk": f"DEV#{req.deviceName}"},
            UpdateExpression="SET deviceDisplayName = :name, updatedAt = :now",
            ExpressionAttributeValues={":name": req.deviceDisplayName, ":now": now},
        )

    # 2b. Incremental path: ADD counters delta.
    deltas = []
    if req.statusDelta is not None:
        deltas.append(req.statusDelta)
    if req.statusDeltas:
        deltas.extend(req.statusDeltas)
    for d in deltas:
        try:
            _apply_status_delta(key_hash, d)
            _bump_last_active(
                key_hash,
                f"PROJ#{d.deviceName}#{d.projectHash}",
                d.lastActive,
                _project_list_pk(key_hash, d.deviceName),
                d.projectHash,
            )
            _bump_last_active(key_hash, f"DEV#{d.deviceName}", d.lastActive)
        except Exception as e:
            print(f"statusDelta apply failed: {e}")

    return {"synced": len(req.sessions)}


class ReconcileRequest(BaseModel):
    deviceName: str
    os: str = ""


def _query_all(sessions_table, **kw):
    resp = sessions_table.query(**kw)
    items = resp.get("Items", [])
    while "LastEvaluatedKey" in resp:
        resp = sessions_table.query(ExclusiveStartKey=resp["LastEvaluatedKey"], **kw)
        items.extend(resp.get("Items", []))
    return items


def _reconcile_device(sessions_table, key_hash, device, os_, prune=True):
    """Recount DEV#/PROJ# aggregates from the device's SESS# rows.
    prune=True (boot/new-project): delete orphan PROJ# rows (stale worktree hashes gone
    from disk). prune=False (session delete): keep an emptied PROJ# so the project stays
    in the list (user can still open it / add sessions); it just shows 0 sessions."""
    now = datetime.utcnow().isoformat()
    sess = _query_all(sessions_table, KeyConditionExpression=Key("accountId").eq(key_hash)
                      & Key("sk").begins_with(f"SESS#{device}#"))
    proj = {}  # projectHash -> {count, name, lastActive}
    device_last = ""
    for s in sess:
        ph = s.get("projectHash", "")
        if not ph:
            continue
        p = proj.setdefault(ph, {"count": 0, "name": s.get("projectName", ph), "lastActive": ""})
        p["count"] += 1
        la = s.get("lastActive", "")
        if la > p["lastActive"]:
            p["lastActive"] = la
        if la > device_last:
            device_last = la

    existing = sessions_table.query(
        KeyConditionExpression=Key("accountId").eq(key_hash) & Key("sk").begins_with(f"PROJ#{device}#"))
    empty = [it for it in existing.get("Items", []) if it["sk"].split("#", 2)[-1] not in proj]
    # prune deletes orphan PROJ# rows (stale worktree hashes with no SESS#), but a
    # user-created empty project (userCreated) must survive — it's intentional, not an orphan.
    to_delete = [it for it in empty if prune and not it.get("userCreated")]
    to_keep = [it for it in empty if not (prune and not it.get("userCreated"))]

    with sessions_table.batch_writer() as batch:
        for ph, p in proj.items():
            batch.put_item(Item={
                "accountId": key_hash, "sk": f"PROJ#{device}#{ph}",
                "entityType": "project", "deviceName": device,
                "projectHash": ph, "projectName": p["name"],
                "sessionCount": p["count"], "lastActive": p["lastActive"], "updatedAt": now,
                "listPk": _project_list_pk(key_hash, device),
                "listSk": _list_sk(p["lastActive"], ph),
            })
        for it in to_delete:
            batch.delete_item(Key={"accountId": key_hash, "sk": it["sk"]})
        for it in to_keep:
            it["sessionCount"] = 0  # keep the project in the list, now empty
            it["updatedAt"] = now
            it["listPk"] = _project_list_pk(key_hash, device)
            it["listSk"] = _list_sk(it.get("lastActive", ""), it["projectHash"])
            batch.put_item(Item=it)

    # projectCount must equal the projects-list length: kept-empty PROJ# rows still show.
    project_count = len(proj) + len(to_keep)
    sessions_table.update_item(
        Key={"accountId": key_hash, "sk": f"DEV#{device}"},
        UpdateExpression=("SET sessionCount = :sc, projectCount = :pc, entityType = :et, "
                          "deviceName = :dn, os = if_not_exists(os, :os), lastActive = :la"),
        ExpressionAttributeValues={
            ":sc": len(sess), ":pc": project_count, ":et": "device",
            ":dn": device, ":os": os_, ":la": device_last,
        },
    )
    return {"sessionCount": len(sess), "projectCount": project_count}


@bridge_router.post("/reconcile")
async def reconcile(req: ReconcileRequest, raw: Request):
    """Recount a device's DEV#/PROJ# aggregates so stored counts stay DDB-self-consistent.
    Called by the bridge on first boot, after a version upgrade, and on a new project."""
    sessions_table, _ = _tables()
    key_hash = _hash_key(raw.headers.get("x-api-key", ""))
    return _reconcile_device(sessions_table, key_hash, req.deviceName, req.os)


class CreateProjectRequest(BaseModel):
    deviceName: str
    projectHash: str
    projectName: str = ""
    os: str = ""


@bridge_router.post("/create-project")
async def create_project(req: CreateProjectRequest, raw: Request):
    """Seed an empty PROJ# row so a just-created project shows in the list immediately,
    before its first session exists. userCreated=True marks it intentional so reconcile's
    prune never treats it as a stale orphan. Idempotent — never clobbers an existing row."""
    sessions_table, _ = _tables()
    key_hash = _hash_key(raw.headers.get("x-api-key", ""))
    now = datetime.utcnow().isoformat()
    try:
        sessions_table.put_item(
            Item={
                "accountId": key_hash, "sk": f"PROJ#{req.deviceName}#{req.projectHash}",
                "entityType": "project", "deviceName": req.deviceName,
                "projectHash": req.projectHash, "projectName": req.projectName or req.projectHash,
                "sessionCount": 0, "userCreated": True, "lastActive": now, "updatedAt": now,
                "listPk": _project_list_pk(key_hash, req.deviceName),
                "listSk": _list_sk(now, req.projectHash),
            },
            ConditionExpression="attribute_not_exists(sk)",
        )
    except sessions_table.meta.client.exceptions.ConditionalCheckFailedException:
        pass  # already exists (real sessions or a prior create) — leave it
    # Recount so DEV#.projectCount includes this row (prune keeps userCreated rows).
    return _reconcile_device(sessions_table, key_hash, req.deviceName, req.os)


class DeleteRequest(BaseModel):
    deviceName: str
    sessionIds: List[str] = []
    projectHashes: List[str] = []  # delete a project = its PROJ# + all its SESS# rows


@bridge_router.post("/delete")
async def delete_sessions(req: DeleteRequest, raw: Request):
    """Delete sessions/projects from DDB (SESS#/PROJ# rows only), then reconcile the
    device aggregates. Message rows are left to expire via their TTL — deleting them
    inline would loop per-session and risk the API GW 29s timeout on big projects, and
    they're unreachable once the SESS# row is gone. Disk jsonl is deleted separately by
    the bridge (WS delete_files) only when the user opts in."""
    sessions_table, _ = _tables()
    key_hash = _hash_key(raw.headers.get("x-api-key", ""))
    dev = req.deviceName

    sess_sks = set()   # SESS# sks to delete

    # Expand each project → all its SESS# rows.
    for ph in req.projectHashes:
        for it in _query_all(sessions_table, KeyConditionExpression=Key("accountId").eq(key_hash)
                             & Key("sk").begins_with(f"SESS#{dev}#{ph}#"), ProjectionExpression="sk"):
            sess_sks.add(it["sk"])

    # Resolve explicit sessionIds to their SESS# sk (query by device; filter by id).
    if req.sessionIds:
        want = set(req.sessionIds)
        for it in _query_all(sessions_table, KeyConditionExpression=Key("accountId").eq(key_hash)
                             & Key("sk").begins_with(f"SESS#{dev}#"), ProjectionExpression="sk, sessionId"):
            if it.get("sessionId") in want:
                sess_sks.add(it["sk"])

    with sessions_table.batch_writer() as batch:
        for sk in sess_sks:
            batch.delete_item(Key={"accountId": key_hash, "sk": sk})
        for ph in req.projectHashes:
            batch.delete_item(Key={"accountId": key_hash, "sk": f"PROJ#{dev}#{ph}"})

    # prune=False: keep a project that just lost its last session (user can still open it).
    counts = _reconcile_device(sessions_table, key_hash, dev, "", prune=False)
    return {"deletedSessions": len(sess_sks), "deletedProjects": len(req.projectHashes), **counts}


@bridge_router.post("/sync-messages")
async def sync_messages(req: SyncMessagesRequest, raw: Request):
    _, messages_table = _tables()
    written = 0
    runtime, _, storage_id = _session_ids(req.runtime, req.sessionId, req.nativeSessionId)

    with messages_table.batch_writer() as batch:
        for msg in req.messages:
            uuid = msg.get("uuid", "")
            if not uuid:
                continue
            content = json.dumps(msg.get("content", ""), ensure_ascii=False)
            timestamp = msg.get("timestamp", datetime.utcnow().isoformat())
            item = {
                "sessionId": storage_id,
                "sk": f"{timestamp}#{uuid}",
                "uuid": uuid,
                "type": msg.get("type", ""),
                "content": content,
                "timestamp": timestamp,
                "ttl": _msg_ttl(),
            }
            if runtime != "claude":
                item["runtime"] = runtime
            if msg.get("nativeId"):
                item["nativeId"] = msg["nativeId"]
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


# Videos are too large to base64 through Lambda (API GW 6MB limit), so the bridge
# streams them straight to S3 via a presigned PUT URL. Deterministic content-hash
# keys mean an already-uploaded video is detected via HEAD and never re-sent.
_VIDEO_CONTENT_TYPES = {
    "mp4": "video/mp4", "m4v": "video/mp4", "mov": "video/quicktime",
    "webm": "video/webm", "mkv": "video/x-matroska", "avi": "video/x-msvideo",
}


def _video_content_type(key: str) -> str:
    ext = key.rsplit(".", 1)[-1].lower() if "." in key else ""
    return _VIDEO_CONTENT_TYPES.get(ext, "video/mp4")


class VideoPrepareRequest(BaseModel):
    key: str       # content-hash key, e.g. "1a2b3c4d5e6f7a8b.mp4"


@bridge_router.post("/video-prepare")
async def video_prepare(req: VideoPrepareRequest):
    """If videos/{key} already exists in S3, tell the bridge to skip the upload.
    Otherwise return a short-lived presigned PUT URL for a direct S3 stream."""
    bucket = os.environ.get("BRIDGE_IMAGES_BUCKET", "")
    if not bucket:
        return {"error": "BRIDGE_IMAGES_BUCKET not configured"}
    s3 = _s3_client()
    s3_key = f"videos/{req.key}"
    try:
        s3.head_object(Bucket=bucket, Key=s3_key)
        return {"exists": True, "key": req.key}
    except Exception:
        pass  # not found (or transient) — issue a fresh upload URL
    content_type = _video_content_type(req.key)
    url = s3.generate_presigned_url(
        "put_object",
        Params={"Bucket": bucket, "Key": s3_key, "ContentType": content_type},
        ExpiresIn=900,
    )
    return {"exists": False, "key": req.key, "url": url, "contentType": content_type}
