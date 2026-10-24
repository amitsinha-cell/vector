"""SQLite database with FTS5 for full-text search over summaries."""

from __future__ import annotations

import aiosqlite
import json
from pathlib import Path

from .config import settings

_db: aiosqlite.Connection | None = None


async def get_db() -> aiosqlite.Connection:
    """Return the singleton database connection."""
    global _db
    if _db is None:
        _db = await aiosqlite.connect(settings.db_path)
        _db.row_factory = aiosqlite.Row
        await _db.execute("PRAGMA journal_mode=WAL")
        await _db.execute("PRAGMA foreign_keys=ON")
        await _init_tables(_db)
    return _db


async def close_db() -> None:
    global _db
    if _db is not None:
        await _db.close()
        _db = None


async def _init_tables(db: aiosqlite.Connection) -> None:
    await db.executescript("""
        CREATE TABLE IF NOT EXISTS summaries (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            source_type TEXT    NOT NULL DEFAULT 'file',
            source_ref  TEXT    NOT NULL DEFAULT '',
            file_path   TEXT,
            content_hash TEXT   NOT NULL,
            model       TEXT    NOT NULL,
            provider    TEXT    NOT NULL DEFAULT 'ollama',
            system_prompt TEXT  NOT NULL DEFAULT '',
            result_json TEXT    NOT NULL,
            cached      INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
            kind        TEXT    NOT NULL DEFAULT '',
            schema_version INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS watches (
            id     INTEGER PRIMARY KEY AUTOINCREMENT,
            path   TEXT    NOT NULL UNIQUE,
            active INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS summaries_fts USING fts5(
            tldr, purpose, functions, dependencies, gotchas,
            content='summaries',
            content_rowid='id'
        );
    """)

    # Migration for existing database: ensure kind and schema_version columns exist
    table_info = await db.execute_fetchall("PRAGMA table_info(summaries)")
    existing_cols = {col[1] for col in table_info}
    if "kind" not in existing_cols:
        await db.execute("ALTER TABLE summaries ADD COLUMN kind TEXT NOT NULL DEFAULT ''")
    if "schema_version" not in existing_cols:
        await db.execute("ALTER TABLE summaries ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1")

    # Tag existing rows where kind is empty
    await db.execute("""
        UPDATE summaries SET kind = CASE
            WHEN source_type = 'project' THEN 'project'
            WHEN source_type = 'repo' THEN 'repo'
            ELSE 'file'
        END
        WHERE kind = '' OR kind IS NULL
    """)
    await db.commit()


async def insert_summary(
    source_type: str,
    source_ref: str,
    file_path: str | None,
    content_hash: str,
    model: str,
    provider: str,
    system_prompt: str,
    result_json: str,
    kind: str | None = None,
    schema_version: int = 1,
) -> int:
    if kind is None:
        if source_type == "project":
            kind = "project"
        elif source_type == "repo":
            kind = "repo"
        else:
            kind = "file"

    db = await get_db()
    cursor = await db.execute(
        """INSERT INTO summaries (source_type, source_ref, file_path, content_hash, model, provider, system_prompt, result_json, kind, schema_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (source_type, source_ref, file_path, content_hash, model, provider, system_prompt, result_json, kind, schema_version),
    )
    row_id = cursor.lastrowid

    # Index into FTS
    try:
        data = json.loads(result_json)
        funcs = " ".join(f.get("name", "") + " " + f.get("summary", "") for f in data.get("key_functions", []))
        deps = " ".join(data.get("dependencies", []))
        gotchas = " ".join(data.get("gotchas", []))
        await db.execute(
            "INSERT INTO summaries_fts (rowid, tldr, purpose, functions, dependencies, gotchas) VALUES (?, ?, ?, ?, ?, ?)",
            (row_id, data.get("tldr", "") or data.get("overview", ""), data.get("purpose", ""), funcs, deps, gotchas),
        )
    except Exception:
        pass  # FTS indexing is best-effort

    await db.commit()
    return row_id


async def find_cached(content_hash: str) -> dict | None:
    db = await get_db()
    row = await db.execute_fetchall(
        "SELECT id, result_json, model, provider, created_at FROM summaries WHERE content_hash = ? ORDER BY id DESC LIMIT 1",
        (content_hash,),
    )
    if row:
        r = row[0]
        return {"id": r[0], "result_json": r[1], "model": r[2], "provider": r[3], "created_at": r[4]}
    return None


async def get_history(limit: int = 100, offset: int = 0) -> list[dict]:
    db = await get_db()
    rows = await db.execute_fetchall(
        """SELECT id, source_type, source_ref, file_path, model, provider, cached, created_at, result_json, kind, schema_version
           FROM summaries ORDER BY id DESC LIMIT ? OFFSET ?""",
        (limit, offset),
    )
    results = []
    for r in rows:
        rid, stype, sref, fpath, model, provider, cached, created_at, rjson, kind, s_ver = (
            r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10]
        )
        inferred_kind = kind or ("project" if stype == "project" else ("repo" if stype == "repo" else "file"))
        try:
            parsed = json.loads(rjson)
            if not isinstance(parsed, dict):
                raise ValueError("result_json is not an object")
            tldr = parsed.get("tldr", "") or parsed.get("overview", "") or parsed.get("purpose", "")
            results.append({
                "id": rid,
                "source_type": stype,
                "source_ref": sref,
                "file_path": fpath,
                "model": model,
                "provider": provider,
                "cached": bool(cached),
                "created_at": created_at,
                "tldr": tldr,
                "kind": inferred_kind,
                "schema_version": s_ver or 1,
                "status": "ok",
            })
        except Exception as e:
            results.append({
                "id": rid,
                "source_type": stype,
                "source_ref": sref or f"Summary #{rid}",
                "file_path": fpath,
                "model": model,
                "provider": provider,
                "cached": bool(cached),
                "created_at": created_at,
                "tldr": "Unreadable summary (corrupted or unrecognized format)",
                "kind": inferred_kind,
                "schema_version": s_ver or 1,
                "status": "unreadable",
                "error": str(e),
            })
    return results


async def get_summary_by_id(summary_id: int) -> dict | None:
    db = await get_db()
    rows = await db.execute_fetchall(
        """SELECT id, source_type, source_ref, file_path, content_hash, model, provider, result_json, cached, created_at, kind, schema_version
           FROM summaries WHERE id = ?""",
        (summary_id,),
    )
    if not rows:
        return None
    r = rows[0]
    rid, stype, sref, fpath, chash, model, provider, rjson, cached, created_at, kind, s_ver = (
        r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10], r[11]
    )
    inferred_kind = kind or ("project" if stype == "project" else ("repo" if stype == "repo" else "file"))
    try:
        parsed = json.loads(rjson)
        if not isinstance(parsed, dict):
            raise ValueError("result_json is not an object")
        return {
            "id": rid,
            "source_type": stype,
            "source_ref": sref,
            "file_path": fpath,
            "content_hash": chash,
            "model": model,
            "provider": provider,
            "cached": bool(cached),
            "created_at": created_at,
            "kind": inferred_kind,
            "schema_version": s_ver or 1,
            "status": "ok",
            "summary": parsed,
        }
    except Exception as e:
        return {
            "id": rid,
            "source_type": stype,
            "source_ref": sref or f"Summary #{rid}",
            "file_path": fpath,
            "content_hash": chash,
            "model": model,
            "provider": provider,
            "cached": bool(cached),
            "created_at": created_at,
            "kind": inferred_kind,
            "schema_version": s_ver or 1,
            "status": "unreadable",
            "summary": None,
            "error": str(e),
        }


async def delete_unreadable_summaries() -> int:
    db = await get_db()
    rows = await db.execute_fetchall("SELECT id, result_json FROM summaries")
    to_delete = []
    for rid, rjson in rows:
        try:
            parsed = json.loads(rjson)
            if not isinstance(parsed, dict):
                to_delete.append(rid)
        except Exception:
            to_delete.append(rid)

    deleted_count = 0
    for rid in to_delete:
        await db.execute("DELETE FROM summaries WHERE id = ?", (rid,))
        try:
            await db.execute("DELETE FROM summaries_fts WHERE rowid = ?", (rid,))
        except Exception:
            pass
        deleted_count += 1

    if deleted_count > 0:
        await db.commit()
    return deleted_count


async def delete_summary(summary_id: int) -> bool:
    db = await get_db()
    cursor = await db.execute("DELETE FROM summaries WHERE id = ?", (summary_id,))
    # Clean FTS
    try:
        await db.execute("DELETE FROM summaries_fts WHERE rowid = ?", (summary_id,))
    except Exception:
        pass
    await db.commit()
    return cursor.rowcount > 0


async def search_summaries(query: str, limit: int = 50) -> list[dict]:
    db = await get_db()
    rows = await db.execute_fetchall(
        """SELECT s.id, s.source_type, s.source_ref, s.file_path, s.model, s.provider, s.cached, s.created_at, s.result_json, s.kind, s.schema_version
           FROM summaries_fts f
           JOIN summaries s ON f.rowid = s.id
           WHERE summaries_fts MATCH ?
           ORDER BY rank
           LIMIT ?""",
        (query, limit),
    )
    results = []
    for r in rows:
        rid, stype, sref, fpath, model, provider, cached, created_at, rjson, kind, s_ver = (
            r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10]
        )
        inferred_kind = kind or ("project" if stype == "project" else ("repo" if stype == "repo" else "file"))
        tldr = ""
        status = "ok"
        try:
            parsed = json.loads(rjson)
            tldr = parsed.get("tldr", "") or parsed.get("overview", "")
        except Exception:
            status = "unreadable"
            tldr = "Unreadable summary"
        results.append({
            "id": rid,
            "source_type": stype,
            "source_ref": sref,
            "file_path": fpath,
            "model": model,
            "provider": provider,
            "cached": bool(cached),
            "created_at": created_at,
            "tldr": tldr,
            "kind": inferred_kind,
            "schema_version": s_ver or 1,
            "status": status,
        })
    return results


async def get_setting(key: str, default: str = "") -> str:
    db = await get_db()
    rows = await db.execute_fetchall("SELECT value FROM settings WHERE key = ?", (key,))
    return rows[0][0] if rows else default


async def set_setting(key: str, value: str) -> None:
    db = await get_db()
    await db.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )
    await db.commit()


# Watch helpers
async def add_watch(path: str) -> int:
    db = await get_db()
    cursor = await db.execute(
        "INSERT INTO watches (path) VALUES (?) ON CONFLICT(path) DO UPDATE SET active = 1",
        (path,),
    )
    await db.commit()
    return cursor.lastrowid


async def get_watches() -> list[dict]:
    db = await get_db()
    rows = await db.execute_fetchall("SELECT id, path, active FROM watches ORDER BY id")
    return [{"id": r[0], "path": r[1], "active": bool(r[2])} for r in rows]


async def remove_watch(watch_id: int) -> bool:
    db = await get_db()
    cursor = await db.execute("DELETE FROM watches WHERE id = ?", (watch_id,))
    await db.commit()
    return cursor.rowcount > 0
