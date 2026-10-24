"""GET/PUT /settings — persistent user settings."""

from __future__ import annotations

import json

from fastapi import APIRouter

from ..config import settings as app_settings
from ..database import get_setting, set_setting
from ..models import SettingsUpdate

router = APIRouter()

DEFAULT_SYSTEM_PROMPT = (
    "You are Vector, an expert code summariser. Given source code, produce a concise, "
    "well-structured JSON summary including: tldr (max 2 sentences), purpose, language, "
    "key_functions (name, signature, summary, line_start, line_end), dependencies, and gotchas."
)

SETTING_KEYS = [
    "system_prompt", "default_model", "num_ctx",
    "hosted_enabled", "hosted_base_url", "hosted_api_key",
]


@router.get("/settings")
async def get_settings():
    result = {}
    for key in SETTING_KEYS:
        val = await get_setting(key, "")
        if key == "system_prompt" and not val:
            val = DEFAULT_SYSTEM_PROMPT
        elif key == "default_model" and not val:
            val = app_settings.default_model
        elif key == "num_ctx" and not val:
            val = str(app_settings.num_ctx)
        elif key == "hosted_enabled":
            val = val.lower() == "true" if val else False
        result[key] = val

    # Never return the API key to the frontend for display — only flag whether it's set
    result["hosted_api_key_set"] = bool(result.get("hosted_api_key"))
    result.pop("hosted_api_key", None)

    return result


@router.put("/settings")
async def update_settings(body: SettingsUpdate):
    updates = body.model_dump(exclude_none=True)
    for key, value in updates.items():
        if key in SETTING_KEYS:
            await set_setting(key, str(value))
    return {"ok": True}
