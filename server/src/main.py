import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import RedirectResponse
import os

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

from bridge_sync import bridge_router
from bridge_read import read_router
app.include_router(bridge_router)
app.include_router(read_router)


@app.get("/api/health")
async def health():
    return {"status": "ok"}


# Redirect bare / to landing page
@app.get("/")
async def root_redirect():
    return RedirectResponse(url="landing.html")


# Serve web static files (landing, viewer, setup)
WEB_DIR = os.path.join(os.path.dirname(__file__), "web")
if os.path.isdir(WEB_DIR):
    app.mount("/", StaticFiles(directory=WEB_DIR), name="web")


if __name__ == "__main__":
    print("Starting AgentPeek server...")
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))  # nosec B104
