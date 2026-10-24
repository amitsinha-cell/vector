"""Single-worker async queue for GPU-bound model calls.

Only one model request runs at a time to avoid OOM on 6 GB VRAM.
Both user requests and watcher jobs go through this queue.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, AsyncIterator, Callable, Awaitable

logger = logging.getLogger("vector.queue")


class _Job:
    """Wraps an async generator factory so we can await its completion."""

    def __init__(self, job_id: str, factory: Callable[[], AsyncIterator[str]]) -> None:
        self.job_id = job_id
        self.factory = factory
        self.tokens: asyncio.Queue[str | None] = asyncio.Queue()
        self.error: Exception | None = None
        self.done = asyncio.Event()
        self.cancelled = False


class GPUQueue:
    """FIFO queue that runs one model call at a time."""

    def __init__(self) -> None:
        self._queue: asyncio.Queue[_Job] | None = None
        self._worker_task: asyncio.Task | None = None

    def _get_queue(self) -> asyncio.Queue[_Job]:
        try:
            if self._queue is not None:
                self._queue.qsize()
                return self._queue
        except RuntimeError:
            pass
        self._queue = asyncio.Queue()
        return self._queue

    async def start(self) -> None:
        self._get_queue()
        if self._worker_task is None or self._worker_task.done():
            self._worker_task = asyncio.create_task(self._worker())
            logger.info("GPU queue worker started")

    async def stop(self) -> None:
        if self._worker_task:
            self._worker_task.cancel()
            try:
                await self._worker_task
            except (asyncio.CancelledError, Exception):
                pass
            self._worker_task = None
            self._queue = None
            logger.info("GPU queue worker stopped")

    async def _worker(self) -> None:
        queue = self._get_queue()
        while True:
            try:
                job = await queue.get()
            except (asyncio.CancelledError, Exception):
                break

            try:
                if job.cancelled:
                    logger.debug("Skipping cancelled job %s", job.job_id)
                else:
                    logger.debug("Processing job %s", job.job_id)
                    async for token in job.factory():
                        if job.cancelled:
                            logger.debug("Aborting cancelled job %s", job.job_id)
                            break
                        await job.tokens.put(token)
            except Exception as exc:
                job.error = exc
                logger.error("Job %s failed: %s", job.job_id, exc)
            finally:
                await job.tokens.put(None)  # sentinel
                job.done.set()
                queue.task_done()

    async def submit(self, job_id: str, factory: Callable[[], AsyncIterator[str]]) -> AsyncIterator[str]:
        """Submit a job and yield tokens as they're produced."""
        await self.start()
        queue = self._get_queue()
        job = _Job(job_id, factory)
        await queue.put(job)
        logger.debug("Job %s queued (queue size: %d)", job_id, queue.qsize())

        try:
            while True:
                token = await job.tokens.get()
                if token is None:
                    break
                yield token

            if job.error:
                raise job.error
        finally:
            job.cancelled = True

    @property
    def pending_count(self) -> int:
        return self._get_queue().qsize()


# Singleton
gpu_queue = GPUQueue()
