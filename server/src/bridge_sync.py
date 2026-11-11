"""
Bridge routes for attachments (images, files, videos) and device removal.
Usage: app.include_router(bridge_router) in main.py
"""

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field
import base64
import boto3
import os
from functools import lru_cache
import re
import uuid
from urllib.parse import quote, unquote
from botocore.config import Config
from botocore.exceptions import ClientError
import api_key as deployment_key
import devices

bridge_router = APIRouter(prefix="/api/bridge")


def _hash_key(key: str) -> str:
    """Account ID for the API key — the raw key is never stored."""
    return deployment_key.account_id(key)


class DeleteDeviceRequest(BaseModel):
    deviceName: str = Field(min_length=1)


@bridge_router.post("/delete-device")
async def delete_device(req: DeleteDeviceRequest, raw: Request):
    """Remove a device: its Bridge is told to uninstall itself and disconnected, then its row goes."""
    account_id = _hash_key(raw.headers.get("x-api-key", ""))
    endpoint = os.environ.get("WS_API_ENDPOINT", "")
    if endpoint:
        try:
            from bridge_ws import disconnect_removed_bridge
            disconnect_removed_bridge(account_id, endpoint, req.deviceName)
        except Exception as e:
            print(f"removed bridge disconnect failed: {e}")
    devices.delete_device(account_id, req.deviceName)
    return {"ok": True}


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


class FilePrepareRequest(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    size: int = Field(ge=0, le=512 * 1024 * 1024)
    contentType: str = Field(default="application/octet-stream", max_length=255)
    # SHA-256 of the file (hex); its first 32 digits name the stored file, so identical content is stored once.
    contentHash: str = Field(default="", pattern=r"^(?:[0-9a-f]{64})?$")


def _attachment_bucket():
    bucket = os.environ.get("BRIDGE_IMAGES_BUCKET", "")
    if not bucket:
        raise HTTPException(status_code=503, detail="File storage is not configured")
    return bucket


def _attachment_key(key: str, request: Request):
    if not re.fullmatch(r"[0-9a-f]{32}(?:\.[a-z0-9]{1,16})?", key):
        raise HTTPException(status_code=400, detail="Invalid file key")
    return f"attachments/{_hash_key(request.headers.get('x-api-key', ''))}/{key}"


@lru_cache(maxsize=2)
def _attachment_client(accelerated=False):
    return boto3.client(
        "s3", region_name=os.environ.get("AWS_REGION", "us-east-1"),
        config=Config(signature_version="s3v4", s3={"use_accelerate_endpoint": accelerated, "addressing_style": "virtual"}),
    )


@bridge_router.post("/file-prepare")
async def file_prepare(req: FilePrepareRequest, request: Request, response: Response):
    bucket = _attachment_bucket()
    name = req.name.replace("\\", "/").rsplit("/", 1)[-1]
    if not name or any(ord(character) < 32 for character in name):
        raise HTTPException(status_code=400, detail="Invalid file name")
    extension = re.search(r"\.[a-z0-9]{1,16}$", name.lower())
    extension = extension.group() if extension else ""
    key = uuid.uuid4().hex + extension
    # S3 rejects an upload whose bytes do not match this SHA-256, so a content key always holds its content.
    checksum = base64.b64encode(bytes.fromhex(req.contentHash)).decode() if req.contentHash else ""
    if checksum:
        hashed = req.contentHash[:32] + extension
        try:
            existing = _attachment_client().head_object(
                Bucket=bucket, Key=_attachment_key(hashed, request), ChecksumMode="ENABLED")
        except ClientError as error:
            if error.response["Error"]["Code"] not in ("404", "NoSuchKey", "NotFound", "403", "AccessDenied"):
                raise
            key = hashed
        else:
            # Reuse only what S3 verified as this content; anything else keeps the random key, never overwriting.
            if existing.get("ChecksumSHA256") == checksum and existing["ContentLength"] == req.size:
                response.headers["Cache-Control"] = "no-store"
                return {"key": hashed, "exists": True}
    params = {
        "Bucket": bucket, "Key": _attachment_key(key, request),
        "ContentType": "application/octet-stream", "ContentLength": req.size,
        "Metadata": {"filename": quote(name, safe=""), "content-type": quote(req.contentType, safe="")},
        **({"ChecksumSHA256": checksum} if checksum else {}),
    }
    headers = {
        "Content-Type": params["ContentType"],
        **{f"x-amz-meta-{key}": value for key, value in params["Metadata"].items()},
        **({"x-amz-checksum-sha256": checksum} if checksum else {}),
    }
    standard = _attachment_client().generate_presigned_url("put_object", Params=params, ExpiresIn=3600)
    url = standard
    if os.environ.get("S3_UPLOAD_ACCELERATE", "false").lower() == "true":
        url = _attachment_client(True).generate_presigned_url("put_object", Params=params, ExpiresIn=3600)
    response.headers["Cache-Control"] = "no-store"
    return {"key": key, "url": url, "fallbackUrl": standard, "headers": headers}


_IMAGE_CONTENT_TYPES = {
    "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
    "gif": "image/gif", "webp": "image/webp", "avif": "image/avif",
    "bmp": "image/bmp", "svg": "image/svg+xml", "ico": "image/x-icon",
}


@bridge_router.get("/image-url/{key}")
async def image_url(key: str, request: Request, response: Response, attachment: bool = False):
    content_type = _IMAGE_CONTENT_TYPES.get(key.rsplit(".", 1)[-1])
    if not re.fullmatch(r"[0-9a-f]{8,64}\.[a-z]+", key) or not content_type:
        raise HTTPException(status_code=400, detail="Invalid image key")
    storage_key = _attachment_key(key, request) if attachment else f"images/{key}"
    url = _attachment_client().generate_presigned_url("get_object", Params={
        "Bucket": _attachment_bucket(), "Key": storage_key,
        "ResponseContentDisposition": "inline", "ResponseContentType": content_type,
    }, ExpiresIn=3600)
    response.headers["Cache-Control"] = "no-store"
    return {"url": url}


@bridge_router.get("/file-url/{key}")
async def attachment_url(key: str, request: Request, response: Response, name: str = ""):
    bucket = _attachment_bucket()
    storage_key = _attachment_key(key, request)
    client = _attachment_client()
    try:
        obj = client.head_object(Bucket=bucket, Key=storage_key)
    except ClientError as error:
        if error.response["Error"]["Code"] in ("404", "NoSuchKey", "NotFound", "403", "AccessDenied"):
            raise HTTPException(status_code=404, detail="File not found") from error
        raise
    # Deduplicated files keep the first uploader's name; the caller's own name wins.
    name = name if name and len(name) <= 255 and not any(ord(c) < 32 or c in "/\\" for c in name) \
        else unquote(obj.get("Metadata", {}).get("filename", key))
    content_type = unquote(obj.get("Metadata", {}).get("content-type", "application/octet-stream"))
    params = {
        "Bucket": bucket, "Key": storage_key,
        "ResponseContentDisposition": f"attachment; filename*=UTF-8''{quote(name, safe='')}",
    }
    url = client.generate_presigned_url("get_object", Params=params, ExpiresIn=3600)
    preview_type = {
        "pdf": "application/pdf", **_IMAGE_CONTENT_TYPES,
        "mp4": "video/mp4", "webm": "video/webm", "mov": "video/quicktime",
        "mp3": "audio/mpeg", "wav": "audio/wav", "m4a": "audio/mp4", "ogg": "audio/ogg",
    }.get(key.rsplit(".", 1)[-1], "application/octet-stream")
    preview_url = client.generate_presigned_url("get_object", Params={
        **params, "ResponseContentDisposition": "inline", "ResponseContentType": preview_type,
    }, ExpiresIn=3600)
    response.headers["Cache-Control"] = "no-store"
    return {"key": key, "name": name, "size": obj["ContentLength"], "contentType": content_type,
            "url": url, "previewUrl": preview_url, "previewType": preview_type}


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
