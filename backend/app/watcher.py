"""File watcher using watchdog with 2s debounce, hash comparison, and queue integration.

Security:
- Must be an existing directory
- Resolves symlinks
- Rejects system roots and dangerous paths
- Ignores build/vendor directories and binary files
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import sys
from pathlib import Path
from typing import AsyncIterator, Callable, Any

from watchdog.events import FileSystemEventHandler, FileModifiedEvent, FileCreatedEvent
from watchdog.observers import Observer

from .config import settings
from .database import add_watch, get_watches, remove_watch, insert_summary, get_setting
from .models import FileSummary
from .pipeline import run_pipeline_stream
from .providers.ollama import OllamaProvider
from .providers.hosted import HostedProvider
from .queue import gpu_queue

logger = logging.getLogger("vector.watcher")

# Broadcast broker for /events SSE
_subscribers: set[asyncio.Queue] = set()

# Global map of watch_id -> WatchState
_active_watchers: dict[int, "FolderWatcher"] = {}

SUPPORTED_EXTENSIONS = {
    ".py", ".js", ".mjs", ".jsx", ".ts", ".tsx", ".go", ".rs", ".java",
    ".c", ".h", ".cpp", ".hpp", ".cs", ".rb", ".php", ".swift", ".kt",
    ".scala", ".lua", ".sh", ".sql", ".html", ".css", ".json", ".md",
}

IGNORE_DIR_NAMES = {
    "node_modules", "dist", "build", ".git", ".github", ".venv", "venv",
    "__pycache__", ".next", ".nuxt", "coverage", "out", "target", "vendor",
    "bin", "obj", ".idea", ".vscode",
}


def is_system_root(p: Path) -> bool:
    """Detect if path is a system root or dangerous system directory."""
    resolved = p.resolve()
    # Check drive root on Windows (e.g. C:\)
    if os.name == "nt":
        if str(resolved) == f"{resolved.drive}\\" or str(resolved) == f"{resolved.drive}/" or str(resolved) == resolved.drive:
            return True
        win_dir = os.environ.get("WINDIR", "C:\\Windows").lower()
        if str(resolved).lower() == win_dir or str(resolved).lower().startswith(win_dir + "\\"):
            return True
    else:
        if str(resolved) in ("/", "/root", "/bin", "/sbin", "/etc", "/usr", "/System", "/var"):
            return True
    return False


def validate_watch_path(path_str: str) -> Path:
    """Validate watch path: existing dir, resolved symlinks, not system root."""
    p = Path(path_str).resolve()
    if not p.exists():
        raise ValueError(f"Path does not exist: {path_str}")
    if not p.is_dir():
        raise ValueError(f"Path is not a directory: {path_str}")
    if is_system_root(p):
        raise ValueError(f"Cannot watch system root directory: {path_str}")
    return p


async def broadcast_event(event_type: str, data: dict):
    """Send SSE event to all connected /events clients."""
    for q in list(_subscribers):
        try:
            await q.put({"event": event_type, "data": json.dumps(data)})
        except Exception:
            _subscribers.discard(q)


class DebouncedEventHandler(FileSystemEventHandler):
    def __init__(self, watch_id: int, base_path: str, loop: asyncio.AbstractEventLoop):
        super().__init__()
        self.watch_id = watch_id
        self.base_path = base_path
        self.loop = loop
        self.file_hashes: dict[str, str] = {}
        self.pending_timers: dict[str, asyncio.TimerHandle] = {}

    def _should_ignore(self, path_str: str) -> bool:
        p = Path(path_str)
        if any(part in IGNORE_DIR_NAMES for part in p.parts):
            return True
        if p.suffix.lower() not in SUPPORTED_EXTENSIONS:
            return True
        if p.name.endswith(".min.js") or p.name.endswith(".min.css"):
            return True
        return False

    def on_modified(self, event):
        if event.is_directory or self._should_ignore(event.src_path):
            return
        self._schedule_check(event.src_path)

    def on_created(self, event):
        if event.is_directory or self._should_ignore(event.src_path):
            return
        self._schedule_check(event.src_path)

    def _schedule_check(self, file_path: str):
        # Cancel any pending timer for this file (2s debounce)
        if file_path in self.pending_timers:
            self.pending_timers[file_path].cancel()

        handle = self.loop.call_later(2.0, lambda: asyncio.run_coroutine_threadsafe(self._process_file(file_path), self.loop))
        self.pending_timers[file_path] = handle

    async def _process_file(self, file_path: str):
        self.pending_timers.pop(file_path, None)
        try:
            p = Path(file_path)
            if not p.is_file():
                return
            # Check size (< 500 KB for auto-watch)
            if p.stat().st_size > 500_000:
                return

            with open(p, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()

            content_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
            last_hash = self.file_hashes.get(file_path)

            if last_hash == content_hash:
                return  # Unchanged

            self.file_hashes[file_path] = content_hash
            logger.info("Watched file changed: %s", file_path)

            # Trigger summarisation through single GPU queue
            await self._summarise_watched_file(file_path, content, content_hash)
        except Exception as exc:
            logger.error("Error processing watched file %s: %s", file_path, exc)
            await broadcast_event("watch_error", {
                "watch_id": self.watch_id,
                "path": self.base_path,
                "file_path": file_path,
                "error": str(exc),
            })

    async def _summarise_watched_file(self, file_path: str, content: str, content_hash: str):
        # Resolve provider
        ollama = OllamaProvider()
        provider = ollama
        provider_name = "ollama"
        if not await ollama.is_available():
            hosted_enabled = (await get_setting("hosted_enabled", "false")).lower() == "true"
            if hosted_enabled:
                h_url = await get_setting("hosted_base_url", "")
                h_key = await get_setting("hosted_api_key", "")
                if h_url and h_key:
                    hosted = HostedProvider(h_url, h_key)
                    if await hosted.is_available():
                        provider = hosted
                        provider_name = "hosted"
                    else:
                        return
                else:
                    return
            else:
                return

        model = settings.default_model
        system = "You are Vector, an expert code summariser. Produce a concise, well-structured JSON summary."
        filename = Path(file_path).name

        final_summary = None
        async for evt in run_pipeline_stream(content, filename, provider, model, system):
            if evt.get("type") == "final":
                final_summary = evt.get("summary")

        if final_summary:
            row_id = await insert_summary(
                source_type="watch",
                source_ref=filename,
                file_path=file_path,
                content_hash=content_hash,
                model=model,
                provider=provider_name,
                system_prompt=system,
                result_json=json.dumps(final_summary),
            )

            await broadcast_event("watch_summarised", {
                "id": row_id,
                "watch_id": self.watch_id,
                "path": self.base_path,
                "file_path": file_path,
                "filename": filename,
                "summary": final_summary,
                "model": model,
                "provider": provider_name,
            })


class FolderWatcher:
    def __init__(self, watch_id: int, path: str):
        self.watch_id = watch_id
        self.path = path
        self.observer = Observer()
        self.handler: DebouncedEventHandler | None = None

    def start(self, loop: asyncio.AbstractEventLoop):
        self.handler = DebouncedEventHandler(self.watch_id, self.path, loop)
        self.observer.schedule(self.handler, self.path, recursive=True)
        self.observer.start()

    def stop(self):
        try:
            self.observer.stop()
            self.observer.join(timeout=2.0)
        except Exception:
            pass


async def start_watcher_for_path(watch_id: int, path: str):
    """Start watcher for a specific path."""
    loop = asyncio.get_running_loop()
    if watch_id in _active_watchers:
        _active_watchers[watch_id].stop()

    fw = FolderWatcher(watch_id, path)
    fw.start(loop)
    _active_watchers[watch_id] = fw
    logger.info("Started watcher [%d] for path: %s", watch_id, path)


def stop_watcher(watch_id: int):
    """Stop watcher by ID."""
    fw = _active_watchers.pop(watch_id, None)
    if fw:
        fw.stop()
        logger.info("Stopped watcher [%d]", watch_id)


async def restore_all_watches():
    """Restore all active watches from SQLite on server startup."""
    watches = await get_watches()
    for w in watches:
        if w["active"]:
            try:
                p = validate_watch_path(w["path"])
                await start_watcher_for_path(w["id"], str(p))
            except Exception as exc:
                logger.warning("Failed to restore watch [%d] for %s: %s", w["id"], w["path"], exc)


def stop_all_watches():
    """Stop all running watchers on shutdown."""
    for wid in list(_active_watchers.keys()):
        stop_watcher(wid)


def register_subscriber() -> tuple[asyncio.Queue, Callable[[], None]]:
    """Register an SSE listener queue for /events."""
    q = asyncio.Queue()
    _subscribers.add(q)

    def unsubscribe():
        _subscribers.discard(q)

    return q, unsubscribe
