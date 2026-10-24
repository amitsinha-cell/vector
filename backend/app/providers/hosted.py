"""Hosted (OpenAI-compatible) LLM provider — ONLY usable when explicitly enabled."""

from __future__ import annotations

import json
import logging
from typing import Any, AsyncIterator

import httpx

from .base import LLMProvider

logger = logging.getLogger("vector.hosted")


class HostedProvider(LLMProvider):
    """
    OpenAI-compatible hosted provider.

    NEVER auto-falls-back silently.  Only usable when:
    - settings.hosted_enabled is True
    - An API key is set
    """

    name = "hosted"

    def __init__(self, base_url: str, api_key: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key

    async def is_available(self) -> bool:
        if not self.api_key:
            return False
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                r = await client.get(
                    f"{self.base_url}/models",
                    headers={"Authorization": f"Bearer {self.api_key}"},
                )
                return r.status_code == 200
        except Exception:
            return False

    async def list_models(self) -> list[dict]:
        if not self.api_key:
            return []
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                r = await client.get(
                    f"{self.base_url}/models",
                    headers={"Authorization": f"Bearer {self.api_key}"},
                )
                r.raise_for_status()
                data = r.json()
                return [
                    {"name": m.get("id", ""), "size": 0, "mode": "hosted"}
                    for m in data.get("data", [])
                ]
        except Exception as exc:
            logger.warning("Failed to list hosted models: %s", exc)
            return []

    async def stream_json(
        self,
        prompt: str,
        schema: dict[str, Any],
        model: str,
        *,
        system: str = "",
        num_ctx: int = 8192,
    ) -> AsyncIterator[str]:
        if not self.api_key:
            raise RuntimeError("Hosted provider requires an API key")

        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})

        body: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "stream": True,
            "max_tokens": num_ctx,
            "response_format": {"type": "json_object"},
        }

        logger.debug("Hosted request: model=%s, prompt_len=%d", model, len(prompt))

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

        async with httpx.AsyncClient(timeout=httpx.Timeout(connect=10.0, read=300.0, write=10.0, pool=10.0)) as client:
            async with client.stream("POST", f"{self.base_url}/chat/completions", json=body, headers=headers) as response:
                if response.status_code != 200:
                    error_body = await response.aread()
                    raise RuntimeError(f"Hosted API returned {response.status_code}: {error_body.decode()}")

                async for line in response.aiter_lines():
                    line = line.strip()
                    if not line or not line.startswith("data: "):
                        continue
                    data_str = line[6:]
                    if data_str == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data_str)
                    except json.JSONDecodeError:
                        continue
                    delta = chunk.get("choices", [{}])[0].get("delta", {})
                    token = delta.get("content", "")
                    if token:
                        yield token
