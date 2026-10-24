"""Credential exchange, pairing, revocation and master-key rotation."""

import os
from typing import Optional

import boto3
from boto3.dynamodb.conditions import Key
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

import auth

auth_router = APIRouter()


class ExchangeTokenBody(BaseModel):
    token: str
    name: str = ""


class CredentialBody(BaseModel):
    name: str = ""
    device: str = ""


class RevokeBody(BaseModel):
    id: str


def _caller(request, *kinds):
    credential = auth.request_credential(request)
    if not credential or credential.get("kind") not in kinds:
        raise HTTPException(status_code=403, detail="Forbidden")
    return credential


def _device_reply(secret, item):
    return {"apiKey": secret, "accountId": item["accountId"], "credentialId": item["credId"]}


def disconnect_credentials(account_id, cred_ids):
    """Close live app/Bridge WebSockets authenticated by the given credentials."""
    table_name, endpoint = os.environ.get("CONNECTIONS_TABLE"), os.environ.get("WS_API_ENDPOINT")
    if not table_name or not endpoint or not cred_ids:
        return
    table = boto3.resource("dynamodb", region_name=os.environ.get("AWS_REGION", "us-east-1")).Table(table_name)
    client = boto3.client("apigatewaymanagementapi", endpoint_url=endpoint)
    for role in ("app", "bridge"):
        kwargs = {"IndexName": "accountId-role-index",
            "KeyConditionExpression": Key("accountId").eq(account_id) & Key("role").eq(role)}
        while True:
            response = table.query(**kwargs)
            for row in response.get("Items", []):
                record = table.get_item(Key={"connectionId": row["connectionId"]}).get("Item") or {}
                if record.get("credId") not in cred_ids:
                    continue
                try:
                    client.delete_connection(ConnectionId=row["connectionId"])
                except Exception:
                    pass
            if "LastEvaluatedKey" not in response:
                break
            kwargs["ExclusiveStartKey"] = response["LastEvaluatedKey"]


# Outside /api/, so the auth middleware does not require a credential.
@auth_router.post("/auth/exchange-token")
def exchange_token(body: ExchangeTokenBody):
    account_id = auth.consume_one_time((body.token or "").strip(), "app")
    if not account_id:
        raise HTTPException(status_code=401, detail="invalid or expired")
    return _device_reply(*auth.issue_device_credential(account_id, "app", name=body.name))


@auth_router.post("/api/auth/app-credential")
def app_credential(request: Request, body: Optional[CredentialBody] = None):
    caller = _caller(request, "master")
    body = body or CredentialBody()
    return _device_reply(*auth.issue_device_credential(caller["accountId"], "app", name=body.name))


@auth_router.post("/api/auth/bridge-credential")
def bridge_credential(request: Request, body: Optional[CredentialBody] = None):
    caller = _caller(request, "master")
    body = body or CredentialBody()
    if not body.device:
        raise HTTPException(status_code=400, detail="device required")
    return _device_reply(*auth.issue_device_credential(caller["accountId"], "bridge",
        device=body.device, name=body.name or body.device))


@auth_router.post("/api/auth/start-token")
def start_token(request: Request):
    caller = _caller(request, "master", "app")
    token, lifetime = auth.create_one_time(caller["accountId"], "app")
    return {"token": token, "expiresIn": lifetime}


@auth_router.post("/api/auth/bridge-pairing")
def bridge_pairing(request: Request):
    caller = _caller(request, "master", "app")
    code, lifetime = auth.create_one_time(caller["accountId"], "bridge")
    return {"code": code, "expiresIn": lifetime}


@auth_router.get("/api/auth/credentials")
def list_credentials(request: Request):
    caller = _caller(request, "master", "app")
    items = sorted(auth.list_credentials(caller["accountId"]),
        key=lambda item: int(item.get("lastUsedAt") or 0), reverse=True)
    return {"credentials": [{
        "id": item.get("credId"), "kind": item.get("kind"), "name": item.get("name", ""),
        "device": item.get("device", ""), "createdAt": int(item.get("createdAt") or 0),
        "lastUsedAt": int(item.get("lastUsedAt") or 0), "current": item.get("credId") == caller.get("credId"),
    } for item in items]}


@auth_router.post("/api/auth/revoke")
def revoke(request: Request, body: RevokeBody):
    caller = _caller(request, "master", "app")
    targets = [item for item in auth.list_credentials(caller["accountId"])
        if item.get("credId") == body.id and item.get("kind") != "master"]
    if not targets:
        raise HTTPException(status_code=404, detail="not found")
    auth.delete_credentials(targets)
    disconnect_credentials(caller["accountId"], {body.id})
    return {"ok": True}


@auth_router.post("/api/auth/rotate-master")
def rotate_master(request: Request):
    caller = _caller(request, "master", "app")
    secret, previous = auth.rotate_master(caller["accountId"])
    disconnect_credentials(caller["accountId"], {item.get("credId") for item in previous})
    return {"masterKey": secret}
