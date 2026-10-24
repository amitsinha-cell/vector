"""Tests for Pydantic schema validation and repair fallback."""

import json
import pytest
from pydantic import ValidationError
from app.models import FileSummary, KeyFunction, RepoOverview


def test_valid_file_summary():
    data = {
        "tldr": "Provides mathematical utilities.",
        "purpose": "A utility module for arithmetic operations.",
        "language": "python",
        "key_functions": [
            {
                "name": "add",
                "signature": "add(a: int, b: int) -> int",
                "summary": "Adds two integers.",
                "line_start": 1,
                "line_end": 3,
            }
        ],
        "dependencies": ["math"],
        "gotchas": ["Does not check integer overflow."],
    }
    summary = FileSummary(**data)
    assert summary.tldr == "Provides mathematical utilities."
    assert len(summary.key_functions) == 1
    assert summary.key_functions[0].name == "add"


def test_invalid_file_summary_missing_fields():
    data = {
        "purpose": "Incomplete data missing tldr and language",
    }
    with pytest.raises(ValidationError):
        FileSummary(**data)


def test_repo_overview_schema():
    data = {
        "overview": "Main backend API service built with FastAPI.",
        "start_here": [{"path": "main.py", "reason": "Application bootstrap entry point"}],
        "files": [],
    }
    repo = RepoOverview(**data)
    assert len(repo.start_here) == 1
    assert repo.start_here[0].path == "main.py"
