"""Summarisation pipeline implementing map-reduce for large files and single-pass for small files.

Handles:
- Language detection
- Tree-sitter / sliding window chunking
- Map step for >300 lines, Reduce step to assemble FileSummary
- Single pass for <=300 lines
- Pydantic schema validation & single-retry repair
"""

from __future__ import annotations

import json
import logging
import uuid
from typing import AsyncIterator, Callable, Any

from .config import settings
from .chunker import chunk_file, detect_language, CodeChunk
from .models import FileSummary
from .providers.base import LLMProvider
from .queue import gpu_queue
from .errors import OutOfMemoryError, ValidationError

logger = logging.getLogger("vector.pipeline")

CHUNK_SUMMARY_SCHEMA = {
    "type": "object",
    "properties": {
        "name": {"type": "string"},
        "purpose": {"type": "string"},
        "key_functions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "signature": {"type": "string"},
                    "summary": {"type": "string"},
                    "line_start": {"type": ["integer", "null"]},
                    "line_end": {"type": ["integer", "null"]},
                },
                "required": ["name", "summary"],
            },
        },
        "dependencies": {"type": "array", "items": {"type": "string"}},
        "gotchas": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["name", "purpose"],
}


async def _run_with_repair(
    job_id: str,
    provider: LLMProvider,
    prompt: str,
    schema: dict,
    model: str,
    system: str,
    on_token: Callable[[str], None] | None = None,
) -> tuple[dict, str | None]:
    """Execute model call through queue with 1 repair attempt on schema failure."""
    collected = ""
    async for token in gpu_queue.submit(
        job_id,
        lambda: provider.stream_json(prompt, schema, model, system=system, num_ctx=settings.get_num_ctx(model)),
    ):
        collected += token
        if on_token:
            on_token(token)

    if not collected.strip():
        raise ValidationError("Model returned an empty response")

    # Validate output
    try:
        raw = json.loads(collected)
        validated = FileSummary(**raw).model_dump()
        return validated, None
    except Exception as exc:
        logger.warning("[%s] Schema validation failed: %s. Attempting repair...", job_id, exc)

    # Repair attempt
    repair_prompt = (
        f"The following JSON response was generated but does not conform to the schema:\n\n"
        f"```json\n{collected[:4000]}\n```\n\n"
        f"Fix the JSON so it strictly matches this JSON schema and return ONLY valid JSON:\n"
        f"{json.dumps(schema, indent=2)}"
    )

    repaired = ""
    try:
        async for token in gpu_queue.submit(
            f"{job_id}-repair",
            lambda: provider.stream_json(repair_prompt, schema, model, system=system, num_ctx=settings.get_num_ctx(model)),
        ):
            repaired += token
        raw = json.loads(repaired)
        validated = FileSummary(**raw).model_dump()
        return validated, None
    except Exception as exc2:
        logger.warning("[%s] Repair failed: %s. Checking fallback partial.", job_id, exc2)

    # Fallback partial
    try:
        raw = json.loads(collected)
        if isinstance(raw, dict) and any(k in raw for k in ["tldr", "purpose", "summary"]):
            raw["_warning"] = "Output did not fully match schema"
            return raw, "Output did not fully match schema"
    except Exception:
        pass

    raise ValidationError("Model output failed schema validation even after repair attempt")


async def _run_pipeline_internal(
    code: str,
    filename: str | None,
    provider: LLMProvider,
    model: str,
    system_prompt: str,
) -> AsyncIterator[dict]:
    language = detect_language(filename)
    lines = code.splitlines()
    line_count = len(lines)
    job_id = str(uuid.uuid4())[:8]

    yield {
        "stage": "Parsing...",
        "detail": f"{language.upper()} · {line_count} lines",
    }

    schema = FileSummary.model_json_schema()

    if line_count <= 300:
        # Single-pass
        prompt = (
            f"File: {filename or 'unnamed'} (language: {language}, {line_count} lines)\n\n"
            f"```{language}\n{code[:50000]}\n```\n\n"
            "Analyse this source code and generate a complete, structured JSON summary matching the schema:\n"
            "- tldr: max 2 sentences\n"
            "- purpose: overall purpose and role of this file\n"
            "- language: language name\n"
            "- key_functions: list of functions/methods/classes with name, signature, summary, line_start, line_end\n"
            "- dependencies: list of imported libraries or modules\n"
            "- gotchas: list of risks, warnings, concurrency considerations, or TODOs"
        )

        tokens_buffer = ""
        def handle_token(t: str):
            nonlocal tokens_buffer
            tokens_buffer += t

        summary_dict, warning = await _run_with_repair(
            job_id=job_id,
            provider=provider,
            prompt=prompt,
            schema=schema,
            model=model,
            system=system_prompt,
            on_token=handle_token,
        )
        if summary_dict.get("language") in (None, "", "unknown") and language != "unknown":
            summary_dict["language"] = language

        yield {
            "type": "final",
            "summary": summary_dict,
            "model": model,
        }
        return

    # Multi-pass Map-Reduce (> 300 lines)
    chunks = chunk_file(code, filename=filename, language=language)
    total_chunks = len(chunks)

    yield {
        "stage": f"Chunking ({total_chunks} sections)...",
        "detail": f"File has {line_count} lines, split into {total_chunks} parts",
    }

    chunk_summaries: list[dict] = []

    # Map step
    for idx, ch in enumerate(chunks, 1):
        yield {
            "stage": f"Summarising {idx}/{total_chunks}...",
            "detail": f"{ch.chunk_type.capitalize()}: {ch.name} (L{ch.line_start}-L{ch.line_end})",
        }

        chunk_prompt = (
            f"Summarise this section of {filename or 'source file'} ({language}):\n"
            f"Section: {ch.name} ({ch.chunk_type}, lines {ch.line_start}-{ch.line_end})\n\n"
            f"```{language}\n{ch.content}\n```\n\n"
            "Produce a JSON summary with: name, purpose, key_functions ([{name, signature, summary, line_start, line_end}]), dependencies, gotchas."
        )

        collected = ""
        async for token in gpu_queue.submit(
            f"{job_id}-m{idx}",
            lambda p=chunk_prompt: provider.stream_json(p, CHUNK_SUMMARY_SCHEMA, model, system=system_prompt, num_ctx=settings.get_num_ctx(model)),
        ):
            collected += token

        try:
            parsed = json.loads(collected)
            chunk_summaries.append(parsed)
        except Exception:
            chunk_summaries.append({
                "name": ch.name,
                "purpose": f"Section spanning lines {ch.line_start}-{ch.line_end}",
                "key_functions": [],
                "dependencies": [],
                "gotchas": [],
            })

    # Reduce step
    yield {
        "stage": "Synthesising final summary...",
        "detail": f"Consolidating {total_chunks} section summaries",
    }

    reduce_prompt = (
        f"File: {filename or 'unnamed'} ({language}, {line_count} lines total).\n"
        f"Here are the summaries of all {total_chunks} sections in this file:\n\n"
        f"```json\n{json.dumps(chunk_summaries, indent=2)}\n```\n\n"
        "Synthesise these section summaries into one final file-level summary matching the schema:\n"
        "- tldr: max 2 sentences summarizing the entire file\n"
        "- purpose: core responsibility of the module/file\n"
        "- language: programming language\n"
        "- key_functions: consolidated list of the most important functions/methods/classes\n"
        "- dependencies: unified list of external dependencies\n"
        "- gotchas: unified list of risks, edge cases, gotchas"
    )

    tokens_buffer = ""
    def handle_token_reduce(t: str):
        nonlocal tokens_buffer
        tokens_buffer += t

    summary_dict, warning = await _run_with_repair(
        job_id=f"{job_id}-reduce",
        provider=provider,
        prompt=reduce_prompt,
        schema=schema,
        model=model,
        system=system_prompt,
        on_token=handle_token_reduce,
    )
    if summary_dict.get("language") in (None, "", "unknown") and language != "unknown":
        summary_dict["language"] = language

    yield {
        "type": "final",
        "summary": summary_dict,
        "model": model,
    }


async def run_pipeline_stream(
    code: str,
    filename: str | None,
    provider: LLMProvider,
    model: str,
    system_prompt: str,
) -> AsyncIterator[dict]:
    """Execute summarisation pipeline with automatic OOM retry using LIGHT_MODEL."""
    try:
        async for evt in _run_pipeline_internal(code, filename, provider, model, system_prompt):
            yield evt
    except OutOfMemoryError as oom_err:
        if model != settings.light_model:
            logger.warning(
                "OOM with %s. Retrying with light model %s: %s",
                model,
                settings.light_model,
                oom_err,
            )
            yield {
                "stage": f"Model '{model}' ran out of GPU memory. Retrying with lighter model '{settings.light_model}'...",
                "detail": f"Retrying with {settings.light_model}",
                "model": settings.light_model,
            }
            async for evt in _run_pipeline_internal(code, filename, provider, settings.light_model, system_prompt):
                if evt.get("type") == "final":
                    evt["model"] = settings.light_model
                yield evt
        else:
            raise

