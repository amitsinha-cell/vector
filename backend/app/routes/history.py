"""History & search routes."""

from __future__ import annotations

import json

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from ..database import (
    get_history,
    get_summary_by_id,
    delete_summary,
    delete_unreadable_summaries,
    search_summaries,
)

router = APIRouter()


@router.get("/history")
async def list_history(limit: int = Query(100, ge=1, le=500), offset: int = Query(0, ge=0)):
    return await get_history(limit=limit, offset=offset)


@router.delete("/history/unreadable")
async def delete_unreadable():
    deleted = await delete_unreadable_summaries()
    return {"ok": True, "deleted": deleted}


@router.get("/history/{summary_id}")
async def get_one(summary_id: int):
    result = await get_summary_by_id(summary_id)
    if not result:
        return JSONResponse({"error": "Not found"}, status_code=404)
    return result


@router.delete("/history/{summary_id}")
async def delete_one(summary_id: int):
    ok = await delete_summary(summary_id)
    if not ok:
        return JSONResponse({"error": "Not found"}, status_code=404)
    return {"ok": True}


@router.get("/search")
async def search(q: str = Query(..., min_length=1)):
    return await search_summaries(q)


@router.get("/summaries/{summary_id}/export")
async def export_summary(summary_id: int, format: str = Query("md")):
    result = await get_summary_by_id(summary_id)
    if not result:
        return JSONResponse({"error": "Not found"}, status_code=404)

    try:
        data = json.loads(result["result_json"])
    except Exception:
        return JSONResponse({"error": "Invalid data"}, status_code=500)

    if format == "json":
        return JSONResponse(data)

    # Render as Markdown
    lines = [
        f"# {result.get('source_ref', 'Summary')}",
        f"*Model: {result['model']} | Provider: {result['provider']} | {result['created_at']}*",
        "",
        "## TL;DR",
        data.get("tldr", ""),
        "",
        "## Purpose",
        data.get("purpose", ""),
        "",
        f"**Language:** {data.get('language', 'unknown')}",
        "",
    ]

    funcs = data.get("key_functions", [])
    if funcs:
        lines.append("## Key Functions")
        for f in funcs:
            sig = f" `{f['signature']}`" if f.get("signature") else ""
            loc = f" (L{f['line_start']}-L{f['line_end']})" if f.get("line_start") else ""
            lines.append(f"### `{f['name']}`{sig}{loc}")
            lines.append(f.get("summary", ""))
            lines.append("")

    deps = data.get("dependencies", [])
    if deps:
        lines.append("## Dependencies")
        for d in deps:
            lines.append(f"- `{d}`")
        lines.append("")

    gotchas = data.get("gotchas", [])
    if gotchas:
        lines.append("## Gotchas")
        for g in gotchas:
            lines.append(f"- {g}")
        lines.append("")

    md_content = "\n".join(lines)
    return JSONResponse({"content": md_content, "filename": f"{result.get('source_ref', 'summary')}.md"})
