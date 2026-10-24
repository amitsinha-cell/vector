"""Pydantic v2 schemas for API requests, responses, and the summarisation output."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Structured summary schemas — these double as the JSON-schema sent to Ollama
# ---------------------------------------------------------------------------

class KeyFunction(BaseModel):
    name: str
    signature: str = ""
    summary: str
    line_start: int | None = None
    line_end: int | None = None


class FileSummary(BaseModel):
    tldr: str = Field(..., description="Max 2 sentences")
    purpose: str
    language: str
    key_functions: list[KeyFunction] = []
    dependencies: list[str] = []
    gotchas: list[str] = []


class StartHereEntry(BaseModel):
    path: str
    reason: str


class TechStackEntry(BaseModel):
    language: str
    file_count: int = 0
    role: str = ""


class DirectoryMapEntry(BaseModel):
    path: str
    role: str = ""


class EntryPointEntry(BaseModel):
    path: str
    why: str = ""


class HowToRun(BaseModel):
    commands: list[str] = []
    inferred: bool = True


class ProjectOverview(BaseModel):
    name: str = ""
    tldr: str = ""
    purpose: str = ""
    tech_stack: list[TechStackEntry] = []
    architecture: str = ""
    directory_map: list[DirectoryMapEntry] = []
    entry_points: list[EntryPointEntry] = []
    data_flow: str = ""
    how_to_run: HowToRun = Field(default_factory=HowToRun)
    start_here: list[StartHereEntry] = []
    gotchas: list[str] = []
    files_summarised: int = 0
    files_skipped: int = 0
    model: str = ""
    files: list[dict] = []  # Detailed / collapsible per-file summaries


class RepoOverview(BaseModel):
    overview: str
    start_here: list[StartHereEntry] = []
    files: list[FileSummary] = []


# ---------------------------------------------------------------------------
# API request / response schemas
# ---------------------------------------------------------------------------

class SummarizeRequest(BaseModel):
    text: str | None = None
    filename: str | None = None
    model: str | None = None
    force: bool = False
    system_prompt: str | None = None


class RepoSummarizeRequest(BaseModel):
    url: str
    model: str | None = None
    force: bool = False
    system_prompt: str | None = None


class ProjectFilePayload(BaseModel):
    path: str
    content: str


class ProjectSummarizeRequest(BaseModel):
    name: str = "project"
    files: list[ProjectFilePayload] = []
    model: str | None = None
    force: bool = False
    system_prompt: str | None = None


class WatchRequest(BaseModel):
    path: str


class SettingsResponse(BaseModel):
    system_prompt: str
    default_model: str
    num_ctx: int
    hosted_enabled: bool = False
    hosted_base_url: str = ""
    hosted_api_key: str = ""


class SettingsUpdate(BaseModel):
    system_prompt: str | None = None
    default_model: str | None = None
    num_ctx: int | None = None
    hosted_enabled: bool | None = None
    hosted_base_url: str | None = None
    hosted_api_key: str | None = None


class HealthResponse(BaseModel):
    backend: bool = True
    ollama: bool
    ollama_error: str | None = None
    models: list[dict] = []
    defaults: dict = {}
    hosted_enabled: bool = False


class WatchInfo(BaseModel):
    id: int
    path: str
    active: bool
    last_summarised: str | None = None


class HistoryEntry(BaseModel):
    id: int
    source_type: str
    source_ref: str
    file_path: str | None = None
    model: str
    provider: str
    cached: bool
    created_at: str
    tldr: str = ""


class SSEEvent(BaseModel):
    """Wrapper for SSE events sent to the frontend."""
    event: str
    data: dict | str
