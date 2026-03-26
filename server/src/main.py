import uvicorn
from fastapi import FastAPI
import os

app = FastAPI()

from bridge_sync import bridge_router
app.include_router(bridge_router)


@app.get("/api/health")
async def health():
    return {"status": "ok"}


if __name__ == "__main__":
    print("Starting AgentPeek server...")
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))  # nosec B104
