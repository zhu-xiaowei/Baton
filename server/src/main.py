import secrets
import time
import uvicorn
from fastapi import FastAPI, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import os

import api_key as deployment_key

app = FastAPI()


@app.exception_handler(deployment_key.KeyUnavailable)
async def key_unavailable(_request, _error):
    return JSONResponse({"error": "temporarily unavailable"}, status_code=503)


# GZipMiddleware must come before CORS so it sees the final body before CORS adds headers
app.add_middleware(GZipMiddleware, minimum_size=1000, compresslevel=6)
# max_age caches the CORS preflight for cross-origin clients (Tauri webviews).
# Engines clamp it: WebKit (iOS/macOS) 600s, Chromium (Android/Windows) 7200s.
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"], max_age=7200)

from bridge_sync import bridge_router
from bridge_read import read_router, get_install, install_script
app.include_router(bridge_router)
app.include_router(read_router)

# Short alias for install endpoint
app.get("/api/install")(get_install)


@app.get("/api/health")
async def health():
    return {"status": "ok", "version": os.environ.get("APP_VERSION", "dev")}


@app.get("/api/version")
async def version():
    app_version = os.environ.get("APP_VERSION", "dev")
    return {
        "version": app_version,
        "bridgeVersion": os.environ.get("BRIDGE_VERSION", app_version),
    }


# Sign-in / install tokens. A token stays valid until its ttl and is tied to the key's name, so
# rotating the key also retires every outstanding token.
TOKEN_SECONDS = 600


def _system_table():
    import boto3
    ddb = boto3.resource("dynamodb", region_name=os.environ.get("AWS_REGION", "us-east-1"))
    return ddb.Table(os.environ["SYSTEM_TABLE"])


def _redeem_token(token):
    """Return the API key for an unexpired token, else None."""
    token = (token or "").strip()
    if not token or len(token) > 128:
        return None
    item = _system_table().get_item(Key={"pk": "TOKEN", "sk": token}, ConsistentRead=True).get("Item")
    # DynamoDB TTL deletes lazily, so expiry is checked here.
    if not item or int(item.get("ttl", 0) or 0) < time.time() or item.get("keyName") != deployment_key.key_name():
        return None
    return deployment_key.current_key()


@app.post("/api/auth/start-token")
async def start_token():
    """Token for Setup's Start URL, QR code and install command."""
    token = secrets.token_hex(16)
    _system_table().put_item(Item={"pk": "TOKEN", "sk": token, "keyName": deployment_key.key_name(),
        "ttl": int(time.time()) + TOKEN_SECONDS})
    return {"token": token, "expiresIn": TOKEN_SECONDS}


# Outside /api/, so API Gateway does not require the key; the token stands in for it.
class ExchangeTokenBody(BaseModel):
    token: str


@app.post("/auth/exchange-token")
async def exchange_token(body: ExchangeTokenBody, response: Response):
    key = _redeem_token(body.token)
    if not key:
        response.status_code = 401
        return {"error": "invalid or expired"}
    return {"apiKey": key}


@app.get("/auth/install")
async def install_with_token(request: Request, t: str = "", name: str = Query(None), platform: str = ""):
    key = _redeem_token(t)
    if not key:
        message = "Install command expired. Copy a new one from Baton Setup."
        return Response(content=f"echo '{message}' >&2\nexit 1\n", media_type="text/plain", status_code=403)
    script = install_script(request, key, name, platform)
    if isinstance(script, Response):
        script.headers["Cache-Control"] = "no-store"
    return script


# Serve web static files (landing, viewer, setup).
# html=True maps "/" to index.html and lets the SPA shortcut script handle
# ?t= / ?key= → landing.html without a server-side redirect (preserves query).
WEB_DIR = os.path.join(os.path.dirname(__file__), "web")
if os.path.isdir(WEB_DIR):
    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")


if __name__ == "__main__":
    print("Starting Baton server...")
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))  # nosec B104
