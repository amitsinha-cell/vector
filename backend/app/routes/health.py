"""GET /health — Backend status, Ollama status, installed models, defaults."""

from __future__ import annotations

import httpx
from fastapi import APIRouter

from ..config import settings
from ..database import get_setting

router = APIRouter()


@router.get("/health")
async def health():
    ollama_ok = False
    ollama_error: str | None = None
    models: list[dict] = []

    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            r = await client.get(f"{settings.ollama_url.rstrip('/')}/api/tags")
            if r.status_code == 200:
                ollama_ok = True
                data = r.json()
                for m in data.get("models", []):
                    name = m.get("name", "")
                    size = m.get("size", 0)
                    mode = None
                    if name == settings.default_model:
                        mode = "default"
                    elif name == settings.light_model:
                        mode = "light"
                    elif name == settings.deep_model:
                        mode = "deep"
                    models.append({"name": name, "size": size, "mode": mode})
            else:
                ollama_error = f"Ollama returned HTTP {r.status_code}"
    except Exception as exc:
        ollama_error = str(exc)

    hosted_enabled = (await get_setting("hosted_enabled", "false")).lower() == "true"

    return {
        "backend": True,
        "ollama": ollama_ok,
        "ollama_error": ollama_error,
        "models": models,
        "defaults": {
            "default": settings.default_model,
            "light": settings.light_model,
            "deep": settings.deep_model,
            "num_ctx": settings.num_ctx,
        },
        "hosted_enabled": hosted_enabled,
    }

