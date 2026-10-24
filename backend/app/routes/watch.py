"""Watched folder management endpoints."""

from __future__ import annotations

import logging
from pathlib import Path
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from ..database import add_watch, get_watches, remove_watch
from ..models import WatchRequest, WatchInfo
from ..watcher import validate_watch_path, start_watcher_for_path, stop_watcher

logger = logging.getLogger("vector.watch_route")
router = APIRouter()


@router.post("/watch")
async def create_watch(req: WatchRequest):
    """Add a folder to watch."""
    try:
        validated_path = validate_watch_path(req.path)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    path_str = str(validated_path)
    watch_id = await add_watch(path_str)
    await start_watcher_for_path(watch_id, path_str)

    return {
        "id": watch_id,
        "path": path_str,
        "active": True,
    }


@router.get("/watch")
async def list_watches_endpoint():
    """List all watched folders."""
    return await get_watches()


@router.delete("/watch/{watch_id}")
async def delete_watch_endpoint(watch_id: int):
    """Remove a watched folder."""
    stop_watcher(watch_id)
    ok = await remove_watch(watch_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Watch not found")
    return {"ok": True}
