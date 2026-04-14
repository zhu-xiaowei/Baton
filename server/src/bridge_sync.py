"""
Bridge sync routes — receives session metadata and messages from bridge client.
Usage: app.include_router(bridge_router) in main.py
"""

from fastapi import APIRouter, Request
from pydantic import BaseModel
from typing import List
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


class SyncSessionsRequest(BaseModel):
    deviceName: str
    os: str = ""
    sessions: List[SessionItem]


class SyncMessagesRequest(BaseModel):
    sessionId: str
    messages: List[dict]


@bridge_router.post("/sync-sessions")
async def sync_sessions(req: SyncSessionsRequest, raw: Request):
    sessions_table, _ = _tables()
    key_hash = _hash_key(raw.headers.get("x-api-key", ""))

    with sessions_table.batch_writer() as batch:
        for s in req.sessions:
            batch.put_item(Item={
                "accountId": key_hash,
                "sk": f"{req.deviceName}#{s.project}#{s.id}",
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
                "updatedAt": datetime.utcnow().isoformat(),
            })

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
