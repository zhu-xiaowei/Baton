import uvicorn
from fastapi import FastAPI
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware
import os

import auth

app = FastAPI()


async def authenticate(request, call_next):
    path = request.url.path
    if path.startswith("/api/") and request.method != "OPTIONS":
        secret = request.headers.get("x-api-key", "")
        # get_install consumes Bridge pairing codes itself.
        if not (path == "/api/install" and secret.startswith(auth.PAIRING_PREFIX)):
            credential = await run_in_threadpool(auth.resolve, secret)
            if not credential:
                return JSONResponse({"message": "Forbidden"}, status_code=403)
            request.state.baton_auth = credential
    return await call_next(request)


# Added first so CORS stays outermost and 403 responses still carry CORS headers.
app.add_middleware(BaseHTTPMiddleware, dispatch=authenticate)
# GZipMiddleware must come before CORS so it sees the final body before CORS adds headers
app.add_middleware(GZipMiddleware, minimum_size=1000, compresslevel=6)
# max_age caches the CORS preflight for cross-origin clients (Tauri webviews).
# Engines clamp it: WebKit (iOS/macOS) 600s, Chromium (Android/Windows) 7200s.
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"], max_age=7200)

from bridge_sync import bridge_router
from bridge_read import read_router, get_install
from auth_routes import auth_router
app.include_router(auth_router)
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


# Serve web static files (landing, viewer, setup).
# html=True maps "/" to index.html and lets the SPA shortcut script handle
# ?t= / ?key= → landing.html without a server-side redirect (preserves query).
WEB_DIR = os.path.join(os.path.dirname(__file__), "web")
if os.path.isdir(WEB_DIR):
    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")


if __name__ == "__main__":
    print("Starting Baton server...")
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))  # nosec B104
