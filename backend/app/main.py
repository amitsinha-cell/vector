"""FastAPI application — main entry point."""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager


from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .database import get_db, close_db
from .queue import gpu_queue
from .routes import health, summarize, settings as settings_routes, history, watch, events
from .watcher import restore_all_watches, stop_all_watches

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)
logger = logging.getLogger("vector")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup / shutdown."""
    logger.info("Vector backend starting on %s:%d", settings.host, settings.port)
    await get_db()  # initialise DB + tables
    await gpu_queue.start()
    await restore_all_watches()
    yield
    stop_all_watches()
    await gpu_queue.stop()
    await close_db()
    logger.info("Vector backend stopped")


app = FastAPI(
    title="Vector — Local Code Summariser",
    version="0.1.0",
    lifespan=lifespan,
)

# Parse extra origins from environment variable or settings
extra_origins = [
    origin.strip()
    for origin in os.getenv("CORS_ORIGINS", settings.cors_origins).split(",")
    if origin.strip()
]

# CORS — allow any local port on localhost, 127.0.0.1, or local LAN IP, plus extra origins
app.add_middleware(
    CORSMiddleware,
    allow_origins=extra_origins,
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(:\d+)?$",
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)


# Mount routers
app.include_router(health.router, tags=["health"])
app.include_router(summarize.router, tags=["summarize"])
app.include_router(settings_routes.router, tags=["settings"])
app.include_router(history.router, tags=["history"])
app.include_router(watch.router, tags=["watch"])
app.include_router(events.router, tags=["events"])
