"""Slide previews: an attachment is converted to PDF once by the converter Lambda and cached in S3.

previews/<account>/<converter>/<etag>-<size>.pdf is the result, .error a cached failure, and
.pending a claim that lets only one polling request start a conversion.
"""
from functools import lru_cache
import json
import os
import time

import boto3
from botocore.exceptions import ClientError
from fastapi import APIRouter, HTTPException, Request, Response

from bridge_sync import _attachment_bucket, _attachment_client, _attachment_key, _hash_key

preview_router = APIRouter(prefix="/api/bridge")
SLIDE_EXTENSIONS = {"ppt", "pptx", "pps", "ppsx", "odp"}
PENDING_STALE_SECONDS = 180
# Without s3:ListBucket a missing object reads as 403 instead of 404.
_MISSING = ("404", "NoSuchKey", "NotFound", "403", "AccessDenied")
_CLAIM_LOST = ("PreconditionFailed", "ConditionalRequestConflict")


@lru_cache(maxsize=1)
def _lambda_client():
    return boto3.client("lambda", region_name=os.environ.get("AWS_REGION", "us-east-1"))


def _or_none(call):
    try:
        return call()
    except ClientError as error:
        if error.response["Error"]["Code"] in _MISSING:
            return None
        raise


def _head(client, bucket, key):
    return _or_none(lambda: client.head_object(Bucket=bucket, Key=key))


def _cached_error(client, bucket, key):
    return _or_none(lambda: client.get_object(Bucket=bucket, Key=key)["Body"].read().decode()[:300])


@preview_router.post("/file-preview/{key}")
async def file_preview(key: str, request: Request, response: Response):
    response.headers["Cache-Control"] = "no-store"
    source = _attachment_key(key, request)
    if key.rsplit(".", 1)[-1] not in SLIDE_EXTENSIONS:
        raise HTTPException(status_code=400, detail="No converted preview for this file type")
    function = os.environ.get("PREVIEW_CONVERTER_FUNCTION", "")
    if not function:
        raise HTTPException(status_code=503, detail="Preview conversion is not configured")
    bucket, client = _attachment_bucket(), _attachment_client()
    stored = _head(client, bucket, source)
    if not stored:
        raise HTTPException(status_code=404, detail="File not found")
    # Uploads are single-part SSE-S3 PUTs, so the ETag is the MD5 of the whole file: re-uploads of
    # the same content share one preview. The converter image digest invalidates old renderings.
    version = os.environ.get("PREVIEW_CONVERTER_IMAGE", "").rsplit(":", 1)[-1][:12] or "dev"
    etag = stored["ETag"].strip('"')
    preview = (f"previews/{_hash_key(request.headers.get('x-api-key', ''))}/{version}/"
               f"{etag}-{stored['ContentLength']}")

    pdf = _head(client, bucket, preview + ".pdf")
    if pdf:
        url = client.generate_presigned_url("get_object", Params={
            "Bucket": bucket, "Key": preview + ".pdf",
            "ResponseContentType": "application/pdf", "ResponseContentDisposition": "inline",
        }, ExpiresIn=3600)
        return {"status": "ready", "previewUrl": url, "size": pdf["ContentLength"]}
    error = _cached_error(client, bucket, preview + ".error")
    if error is not None:
        return {"status": "failed", "error": error}

    pending = _head(client, bucket, preview + ".pending")
    if pending and time.time() - pending["LastModified"].timestamp() < PENDING_STALE_SECONDS:
        return {"status": "converting"}
    condition = {"IfMatch": pending["ETag"]} if pending else {"IfNoneMatch": "*"}
    try:
        client.put_object(Bucket=bucket, Key=preview + ".pending", Body=b"", **condition)
    except ClientError as error:
        if error.response["Error"]["Code"] in _CLAIM_LOST:
            return {"status": "converting"}
        raise
    _lambda_client().invoke(FunctionName=function, InvocationType="Event",
                            Payload=json.dumps({"source": source, "preview": preview}).encode())
    return {"status": "converting"}
