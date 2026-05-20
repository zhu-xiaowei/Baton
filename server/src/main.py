import time
import uvicorn
from fastapi import FastAPI, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import os

app = FastAPI()
# GZipMiddleware must come before CORS so it sees the final body before CORS adds headers
app.add_middleware(GZipMiddleware, minimum_size=1000)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

from bridge_sync import bridge_router
from bridge_read import read_router, get_install
app.include_router(bridge_router)
app.include_router(read_router)

# Short alias for install endpoint
app.get("/api/install")(get_install)


@app.get("/api/health")
async def health():
    return {"status": "ok", "version": os.environ.get("APP_VERSION", "dev")}


@app.get("/api/version")
async def version():
    return {"version": os.environ.get("APP_VERSION", "dev")}


# Token exchange — landing page swaps a one-time token for the real API key.
# Path is OUTSIDE /api/ so API Gateway does not require an api key.
class ExchangeTokenBody(BaseModel):
    token: str


@app.post("/auth/exchange-token")
async def exchange_token(body: ExchangeTokenBody, response: Response):
    import boto3
    table_name = os.environ.get("SYSTEM_TABLE", "")
    if not table_name:
        response.status_code = 500
        return {"error": "system table not configured"}

    token = (body.token or "").strip()
    if not token or len(token) > 128:
        response.status_code = 400
        return {"error": "invalid token"}

    ddb = boto3.resource("dynamodb", region_name=os.environ.get("AWS_REGION", "us-east-1"))
    table = ddb.Table(table_name)

    item = table.get_item(Key={"pk": "TOKEN", "sk": token}).get("Item")
    if not item:
        response.status_code = 401
        return {"error": "invalid or expired"}

    ttl = int(item.get("ttl", 0))
    if ttl and ttl < int(time.time()):
        table.delete_item(Key={"pk": "TOKEN", "sk": token})
        response.status_code = 401
        return {"error": "invalid or expired"}

    return {"apiKey": item.get("apiKey", "")}


# Serve web static files (landing, viewer, setup).
# html=True maps "/" to index.html and lets the SPA shortcut script handle
# ?t= / ?key= → landing.html without a server-side redirect (preserves query).
WEB_DIR = os.path.join(os.path.dirname(__file__), "web")
if os.path.isdir(WEB_DIR):
    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")


if __name__ == "__main__":
    print("Starting AgentPeek server...")
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))  # nosec B104
