"""Tests for watcher path security validation and debounce logic."""

import asyncio
import os
import tempfile
from pathlib import Path
import pytest

from app.watcher import validate_watch_path, is_system_root, DebouncedEventHandler


def test_validate_watch_path_rejects_nonexistent():
    with pytest.raises(ValueError, match="does not exist"):
        validate_watch_path("C:\\nonexistent_folder_abc_123_xyz")


def test_validate_watch_path_rejects_file():
    with tempfile.NamedTemporaryFile(delete=False) as tf:
        tf.write(b"hello")
        tf_path = tf.name
    try:
        with pytest.raises(ValueError, match="not a directory"):
            validate_watch_path(tf_path)
    finally:
        os.remove(tf_path)


def test_validate_watch_path_accepts_valid_directory():
    with tempfile.TemporaryDirectory() as td:
        p = validate_watch_path(td)
        assert p.is_dir()


def test_system_root_detection():
    if os.name == "nt":
        assert is_system_root(Path("C:\\")) is True
        win_dir = os.environ.get("WINDIR", "C:\\Windows")
        assert is_system_root(Path(win_dir)) is True
    else:
        assert is_system_root(Path("/")) is True
        assert is_system_root(Path("/etc")) is True


@pytest.mark.asyncio
async def test_watcher_debounce_collapses_events():
    """Verify that multiple triggers within 2 seconds collapse to a single scheduled call."""
    loop = asyncio.get_running_loop()
    with tempfile.TemporaryDirectory() as td:
        handler = DebouncedEventHandler(watch_id=1, base_path=td, loop=loop)
        test_file = os.path.join(td, "main.py")

        # Simulate 5 rapid modifications
        for _ in range(5):
            handler._schedule_check(test_file)

        # There should only be 1 pending timer handle
        assert len(handler.pending_timers) == 1
        timer = handler.pending_timers[test_file]
        assert not timer.cancelled()

        # Cancel to clean up
        timer.cancel()
