"""POST /summarize & POST /summarize/repo — single-file and repository summarisation with SSE streaming."""

from __future__ import annotations

import hashlib
import json
import logging
import uuid
from typing import AsyncIterator

from fastapi import APIRouter, File, Form, UploadFile, Request, HTTPException
from fastapi.responses import JSONResponse
from sse_starlette.sse import EventSourceResponse

from ..config import settings
from ..database import find_cached, insert_summary, get_setting
from ..github import fetch_github_repo
from ..models import (
    FileSummary,
    RepoOverview,
    SummarizeRequest,
    RepoSummarizeRequest,
    ProjectSummarizeRequest,
)
from ..pipeline import run_pipeline_stream
from ..project import validate_relative_path
from ..providers.ollama import OllamaProvider
from ..queue import gpu_queue
from ..errors import (
    VectorError,
    OllamaDownError,
    ModelNotFoundError,
    OllamaTimeoutError,
    OutOfMemoryError,
    ValidationError,
)

logger = logging.getLogger("vector.summarize")
router = APIRouter()

DEFAULT_SYSTEM_PROMPT = (
    "You are Vector, an expert code summariser. Given source code, produce a concise, "
    "well-structured JSON summary including: tldr (max 2 sentences), purpose, language, "
    "key_functions (name, signature, summary, line_start, line_end), dependencies, and gotchas."
)


def _compute_hash(content: str, model: str, system_prompt: str) -> str:
    """Cache key = sha256(content + model + prompt_version + system_prompt)."""
    blob = f"{content}\x00{model}\x00{settings.prompt_version}\x00{system_prompt}"
    return hashlib.sha256(blob.encode()).hexdigest()


async def _get_provider_and_model(requested_model: str | None, system_prompt: str | None):
    """Resolve which provider and model to use. Uses local Ollama only."""
    model = requested_model or settings.default_model
    system = system_prompt or DEFAULT_SYSTEM_PROMPT

    ollama = OllamaProvider()
    if not await ollama.is_available():
        raise OllamaDownError("Ollama is not running. Start it with: ollama serve")

    # Check model is available
    installed = await ollama.list_models()
    installed_names = [m.get("name", "") for m in installed]
    if installed_names:
        if model in installed_names:
            pass
        elif f"{model}:latest" in installed_names:
            model = f"{model}:latest"
        elif any(name.startswith(f"{model}:") for name in installed_names):
            model = next(name for name in installed_names if name.startswith(f"{model}:"))
        elif any(name == model.split(":")[0] for name in installed_names):
            model = next(name for name in installed_names if name == model.split(":")[0])
        else:
            raise ModelNotFoundError(f"Model '{model}' not found in Ollama. Pull it with: ollama run {model}")

    return ollama, model, system, "ollama"


@router.post("/summarize")
async def summarize(request: Request):
    """Handle both multipart file upload and JSON body with SSE streaming."""
    content_type = request.headers.get("content-type", "")

    text: str | None = None
    filename: str | None = None
    model: str | None = None
    force: bool = False
    system_prompt: str | None = None

    if "multipart" in content_type:
        form = await request.form()
        file_field = form.get("file")
        if file_field and hasattr(file_field, "read"):
            raw = await file_field.read()
            text = raw.decode("utf-8", errors="replace")
            filename = getattr(file_field, "filename", None)
        else:
            text = str(form.get("text", ""))
            filename = str(form.get("filename", "")) or None
        model = str(form.get("model", "")) or None
        force = str(form.get("force", "")).lower() == "true"
        system_prompt = str(form.get("system_prompt", "")) or None
    else:
        body = await request.json()
        req = SummarizeRequest(**body)
        text = req.text
        filename = req.filename
        model = req.model
        force = req.force
        system_prompt = req.system_prompt

    if not text or not text.strip():
        return JSONResponse({"code": "VALIDATION_ERROR", "error": "No content provided"}, status_code=400)

    try:
        provider, resolved_model, system, provider_name = await _get_provider_and_model(model, system_prompt)
    except OllamaDownError as exc:
        return JSONResponse({"code": "OLLAMA_DOWN", "error": str(exc)}, status_code=503)
    except ModelNotFoundError as exc:
        return JSONResponse({"code": "MODEL_NOT_FOUND", "error": str(exc)}, status_code=404)
    except Exception as exc:
        return JSONResponse({"code": "GENERAL_ERROR", "error": str(exc)}, status_code=500)

    content_hash = _compute_hash(text, resolved_model, system)

    # Check cache
    if not force:
        cached = await find_cached(content_hash)
        if cached:
            async def cached_stream():
                data = json.loads(cached["result_json"])
                yield dict(
                    event="result",
                    data=json.dumps({
                        "id": cached["id"],
                        "summary": data,
                        "cached": True,
                        "model": cached["model"],
                        "provider": cached["provider"],
                    }),
                )
                yield dict(event="done", data=json.dumps({"cached": True}))

            return EventSourceResponse(cached_stream())

    # Stream through pipeline
    async def stream_events() -> AsyncIterator[dict]:
        final_summary = None
        actual_model = resolved_model
        try:
            async for evt in run_pipeline_stream(text, filename, provider, resolved_model, system):
                if evt.get("type") == "final":
                    final_summary = evt.get("summary")
                    if evt.get("model"):
                        actual_model = evt.get("model")
                else:
                    yield dict(event="progress", data=json.dumps(evt))
        except VectorError as exc:
            logger.error("Summarisation vector error: %s (%s)", exc.code, exc)
            yield dict(event="error", data=json.dumps({"code": exc.code, "error": str(exc)}))
            yield dict(event="done", data=json.dumps({"error": True, "code": exc.code}))
            return
        except Exception as exc:
            logger.error("Summarisation pipeline error: %s", exc)
            code = "TIMEOUT" if "timeout" in str(exc).lower() else "GENERAL_ERROR"
            yield dict(event="error", data=json.dumps({"code": code, "error": str(exc)}))
            yield dict(event="done", data=json.dumps({"error": True, "code": code}))
            return

        if not final_summary:
            yield dict(event="error", data=json.dumps({"code": "VALIDATION_ERROR", "error": "Failed to generate summary"}))
            yield dict(event="done", data=json.dumps({"error": True, "code": "VALIDATION_ERROR"}))
            return

        # Persist to DB
        result_json = json.dumps(final_summary)
        row_id = await insert_summary(
            source_type="file",
            source_ref=filename or "snippet",
            file_path=filename,
            content_hash=content_hash,
            model=actual_model,
            provider=provider_name,
            system_prompt=system,
            result_json=result_json,
        )

        yield dict(
            event="result",
            data=json.dumps({
                "id": row_id,
                "summary": final_summary,
                "cached": False,
                "model": actual_model,
                "provider": provider_name,
            }),
        )
        yield dict(event="done", data=json.dumps({"cached": False}))

    return EventSourceResponse(stream_events())


@router.post("/summarize/repo")
async def summarize_repo(req: RepoSummarizeRequest):
    """Summarise a GitHub repository or subpath with per-file progress and RepoOverview."""
    url = req.url.strip()
    if not url:
        return JSONResponse({"code": "VALIDATION_ERROR", "error": "No URL provided"}, status_code=400)

    try:
        provider, resolved_model, system, provider_name = await _get_provider_and_model(req.model, req.system_prompt)
    except OllamaDownError as exc:
        return JSONResponse({"code": "OLLAMA_DOWN", "error": str(exc)}, status_code=503)
    except ModelNotFoundError as exc:
        return JSONResponse({"code": "MODEL_NOT_FOUND", "error": str(exc)}, status_code=404)
    except Exception as exc:
        return JSONResponse({"code": "GENERAL_ERROR", "error": str(exc)}, status_code=500)


    async def repo_stream() -> AsyncIterator[dict]:
        yield dict(event="progress", data=json.dumps({"stage": "Fetching repository...", "detail": url}))

        try:
            repo_name, files, start_here = await fetch_github_repo(url)
        except Exception as exc:
            logger.error("GitHub fetch failed for %s: %s", url, exc)
            yield dict(event="error", data=json.dumps({"error": f"GitHub fetch error: {exc}"}))
            yield dict(event="done", data=json.dumps({"error": True}))
            return

        total_files = len(files)
        yield dict(
            event="progress",
            data=json.dumps({
                "stage": f"Ingested {total_files} files from {repo_name}",
                "detail": "Beginning file-by-file analysis",
            }),
        )

        file_summaries: list[dict] = []

        for idx, f in enumerate(files, 1):
            yield dict(
                event="progress",
                data=json.dumps({
                    "stage": f"Analysing file {idx}/{total_files}...",
                    "detail": f.path,
                }),
            )

            file_hash = _compute_hash(f.content, resolved_model, system)
            summary_dict = None
            cached_flag = False

            if not req.force:
                cached = await find_cached(file_hash)
                if cached:
                    try:
                        summary_dict = json.loads(cached["result_json"])
                        cached_flag = True
                    except Exception:
                        pass

            if not summary_dict:
                try:
                    async for evt in run_pipeline_stream(f.content, f.path, provider, resolved_model, system):
                        if evt.get("type") == "final":
                            summary_dict = evt.get("summary")
                except Exception as exc:
                    logger.warning("Failed summarizing file %s: %s", f.path, exc)
                    summary_dict = {
                        "tldr": f"File {f.path} could not be summarised.",
                        "purpose": "Source file",
                        "language": "unknown",
                        "key_functions": [],
                        "dependencies": [],
                        "gotchas": [str(exc)],
                    }

                # Save file summary to DB
                await insert_summary(
                    source_type="github_file",
                    source_ref=f"{repo_name}:{f.path}",
                    file_path=f.path,
                    content_hash=file_hash,
                    model=resolved_model,
                    provider=provider_name,
                    system_prompt=system,
                    result_json=json.dumps(summary_dict),
                )

            file_summaries.append({
                "path": f.path,
                "summary": summary_dict,
                "cached": cached_flag,
            })

            # Emit per-file result
            yield dict(
                event="file_result",
                data=json.dumps({
                    "path": f.path,
                    "summary": summary_dict,
                    "cached": cached_flag,
                    "index": idx,
                    "total": total_files,
                }),
            )

        # Generate repository overview
        yield dict(
            event="progress",
            data=json.dumps({
                "stage": "Generating repository overview...",
                "detail": f"Synthesising overview for {repo_name}",
            }),
        )

        overview_prompt = (
            f"Repository: {repo_name}\n"
            f"Files analysed: {total_files}\n"
            f"Here are the summaries of key files in the repository:\n\n"
            + json.dumps([{"path": fs["path"], "tldr": fs["summary"].get("tldr", ""), "purpose": fs["summary"].get("purpose", "")} for fs in file_summaries[:30]], indent=2)
            + "\n\nProvide an overarching architectural overview of the repository and project purpose (2-3 paragraphs)."
        )

        overview_schema = {
            "type": "object",
            "properties": {
                "overview": {"type": "string"},
            },
            "required": ["overview"],
        }

        overview_text = ""
        try:
            job_id = f"repo-{uuid.uuid4().hex[:6]}"
            async for token in gpu_queue.submit(
                job_id,
                lambda: provider.stream_json(overview_prompt, overview_schema, resolved_model, system=system, num_ctx=settings.num_ctx),
            ):
                overview_text += token
            overview_obj = json.loads(overview_text)
            overview_str = overview_obj.get("overview", "")
        except Exception:
            overview_str = f"Repository {repo_name} contains {total_files} source files."

        repo_overview_data = {
            "repo_name": repo_name,
            "url": url,
            "overview": overview_str,
            "start_here": start_here,
            "file_count": total_files,
            "files": file_summaries,
        }

        # Persist repo summary
        repo_hash = hashlib.sha256(f"{url}\x00{resolved_model}".encode()).hexdigest()
        row_id = await insert_summary(
            source_type="repo",
            source_ref=repo_name,
            file_path=url,
            content_hash=repo_hash,
            model=resolved_model,
            provider=provider_name,
            system_prompt=system,
            result_json=json.dumps(repo_overview_data),
        )

        yield dict(
            event="overview",
            data=json.dumps({
                "id": row_id,
                "overview": repo_overview_data,
                "model": resolved_model,
                "provider": provider_name,
            }),
        )
        yield dict(event="done", data=json.dumps({"success": True}))

    return EventSourceResponse(repo_stream())


@router.post("/summarize/project")
async def summarize_project(request: Request):
    """Summarise an uploaded folder or multi-file project with SSE streaming."""
    content_type = request.headers.get("content-type", "")

    files_list: list[dict[str, Any]] = []
    project_name: str = "project"
    model: str | None = None
    force: bool = False
    system_prompt: str | None = None

    if "multipart" in content_type:
        form = await request.form()
        uploaded_files = form.getlist("files")
        manifest_raw = form.get("manifest")
        manifest_paths: list[str] = []
        if manifest_raw:
            try:
                manifest_paths = json.loads(str(manifest_raw))
            except Exception:
                pass

        project_name = str(form.get("name", "")) or "project"
        model = str(form.get("model", "")) or None
        force = str(form.get("force", "")).lower() == "true"
        system_prompt = str(form.get("system_prompt", "")) or None

        for idx, u_file in enumerate(uploaded_files):
            if hasattr(u_file, "read"):
                # Determine relative path from manifest or filename
                rel_path = manifest_paths[idx] if idx < len(manifest_paths) else getattr(u_file, "filename", f"file_{idx}")
                try:
                    safe_path = validate_relative_path(rel_path)
                except ValueError as err:
                    logger.warning("Skipping unsafe path: %s", err)
                    continue

                raw_bytes = await u_file.read()
                content = raw_bytes.decode("utf-8", errors="replace")
                files_list.append({
                    "path": safe_path,
                    "content": content,
                    "size": len(raw_bytes),
                })
    else:
        body = await request.json()
        req = ProjectSummarizeRequest(**body)
        project_name = req.name or "project"
        model = req.model
        force = req.force
        system_prompt = req.system_prompt
        for f in req.files:
            try:
                safe_path = validate_relative_path(f.path)
                files_list.append({
                    "path": safe_path,
                    "content": f.content,
                    "size": len(f.content.encode("utf-8")),
                })
            except ValueError as err:
                logger.warning("Skipping unsafe path: %s", err)

    if not files_list:
        return JSONResponse({"code": "VALIDATION_ERROR", "error": "No valid project files provided"}, status_code=400)

    try:
        provider, resolved_model, system, provider_name = await _get_provider_and_model(model, system_prompt)
    except OllamaDownError as exc:
        return JSONResponse({"code": "OLLAMA_DOWN", "error": str(exc)}, status_code=503)
    except ModelNotFoundError as exc:
        return JSONResponse({"code": "MODEL_NOT_FOUND", "error": str(exc)}, status_code=404)
    except Exception as exc:
        return JSONResponse({"code": "GENERAL_ERROR", "error": str(exc)}, status_code=500)

    async def project_stream() -> AsyncIterator[dict]:
        try:
            from ..project import summarize_project_stream
            async for evt in summarize_project_stream(
                files=files_list,
                project_name=project_name,
                provider=provider,
                model=resolved_model,
                system_prompt=system,
                force=force,
            ):
                evt_type = evt.get("type", "progress")
                if evt_type == "file_result":
                    yield dict(event="file_result", data=json.dumps(evt))
                elif evt_type == "project_result":
                    payload = dict(evt)
                    if "project" in payload and "overview" not in payload:
                        payload["overview"] = payload["project"]
                    yield dict(event="overview", data=json.dumps(payload))
                else:
                    yield dict(event="progress", data=json.dumps(evt))

            yield dict(event="done", data=json.dumps({"success": True}))
        except VectorError as exc:
            logger.error("Project summarisation vector error: %s (%s)", exc.code, exc)
            yield dict(event="error", data=json.dumps({"code": exc.code, "error": str(exc)}))
            yield dict(event="done", data=json.dumps({"error": True, "code": exc.code}))
        except Exception as exc:
            logger.error("Project summarisation error: %s", exc)
            yield dict(event="error", data=json.dumps({"code": "PROJECT_ERROR", "error": str(exc)}))
            yield dict(event="done", data=json.dumps({"error": True}))

    return EventSourceResponse(project_stream())

