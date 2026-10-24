"""Ollama LLM provider — streams structured JSON via /api/chat."""

from __future__ import annotations

import json
import logging
from typing import Any, AsyncIterator

import httpx

from .base import LLMProvider
from ..config import settings
from ..errors import (
    OllamaDownError,
    ModelNotFoundError,
    OllamaTimeoutError,
    OutOfMemoryError,
)

logger = logging.getLogger("vector.ollama")


class OllamaProvider(LLMProvider):
    name = "ollama"

    def __init__(self, base_url: str | None = None) -> None:
        self.base_url = (base_url or settings.ollama_url).rstrip("/")

    async def is_available(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                r = await client.get(f"{self.base_url}/api/tags")
                return r.status_code == 200
        except Exception:
            return False

    async def list_models(self) -> list[dict]:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                r = await client.get(f"{self.base_url}/api/tags")
                r.raise_for_status()
                data = r.json()
                models = []
                for m in data.get("models", []):
                    name = m.get("name", "")
                    size = m.get("size", 0)
                    # Tag with mode based on config
                    mode = None
                    if name == settings.default_model:
                        mode = "default"
                    elif name == settings.light_model:
                        mode = "light"
                    elif name == settings.deep_model:
                        mode = "deep"
                    models.append({"name": name, "size": size, "mode": mode})
                return models
        except Exception as exc:
            logger.warning("Failed to list Ollama models: %s", exc)
            return []


    async def stream_json(
        self,
        prompt: str,
        schema: dict[str, Any],
        model: str,
        *,
        system: str = "",
        num_ctx: int | None = None,
    ) -> AsyncIterator[str]:
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})

        resolved_ctx = num_ctx if num_ctx is not None else settings.get_num_ctx(model)

        body = {
            "model": model,
            "messages": messages,
            "stream": True,
            "format": schema,
            "options": {"num_ctx": resolved_ctx},
            "keep_alive": "10m",
        }

        # Never log source code contents
        logger.debug("Ollama request: model=%s, prompt_len=%d, num_ctx=%d", model, len(prompt), resolved_ctx)

        timeout = httpx.Timeout(connect=10.0, read=120.0, write=10.0, pool=10.0)
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                async with client.stream("POST", f"{self.base_url}/api/chat", json=body) as response:
                    if response.status_code == 404:
                        error_body = (await response.aread()).decode(errors="replace")
                        raise ModelNotFoundError(f"Model '{model}' not found in Ollama. Pull it with: ollama run {model}")

                    if response.status_code != 200:
                        error_body = (await response.aread()).decode(errors="replace")
                        err_lower = error_body.lower()
                        if any(phrase in err_lower for phrase in ["out of memory", "cuda error", "not enough memory", "vram"]):
                            raise OutOfMemoryError(f"Ollama out of memory with {model}: {error_body}")
                        if "not found" in err_lower:
                            raise ModelNotFoundError(f"Model '{model}' not found in Ollama. Pull it with: ollama run {model}")
                        raise RuntimeError(f"Ollama returned {response.status_code}: {error_body}")

                    async for line in response.aiter_lines():
                        if not line.strip():
                            continue
                        try:
                            chunk = json.loads(line)
                        except json.JSONDecodeError:
                            continue

                        if chunk.get("error"):
                            err_msg = str(chunk["error"])
                            err_lower = err_msg.lower()
                            if any(phrase in err_lower for phrase in ["out of memory", "cuda error", "not enough memory", "vram"]):
                                raise OutOfMemoryError(f"Ollama out of memory with {model}: {err_msg}")
                            if "not found" in err_lower:
                                raise ModelNotFoundError(f"Model '{model}' not found in Ollama. Pull it with: ollama run {model}")
                            raise RuntimeError(f"Ollama error: {err_msg}")

                        token = chunk.get("message", {}).get("content", "")
                        if token:
                            yield token

                        if chunk.get("done"):
                            break
        except httpx.ConnectError as exc:
            raise OllamaDownError("Ollama is not running. Start it with: ollama serve") from exc
        except httpx.TimeoutException as exc:
            raise OllamaTimeoutError("Request to Ollama timed out after 120s.") from exc

