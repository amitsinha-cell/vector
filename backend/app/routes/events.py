"""SSE event stream for watcher notifications."""

from __future__ import annotations

import asyncio
from typing import AsyncIterator
from fastapi import APIRouter, Request
from sse_starlette.sse import EventSourceResponse

from ..watcher import register_subscriber

router = APIRouter()


@router.get("/events")
async def sse_events(request: Request):
    """Subscribe to real-time events (watch_summarised, watch_error)."""
    q, unsubscribe = register_subscriber()

    async def event_generator() -> AsyncIterator[dict]:
        try:
            # Send initial connected heartbeat
            yield {"event": "connected", "data": "{}"}
            while True:
                if await request.is_disconnected():
                    break
                try:
                    # Wait for next event or 15s keepalive
                    item = await asyncio.wait_for(q.get(), timeout=15.0)
                    yield item
                except asyncio.TimeoutError:
                    yield {"event": "ping", "data": "{}"}
        finally:
            unsubscribe()

    return EventSourceResponse(event_generator())
