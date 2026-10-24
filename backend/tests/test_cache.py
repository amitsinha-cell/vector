"""Tests for deterministic cache key computation and caching behavior."""

import hashlib
import pytest
from app.config import settings
from app.routes.summarize import _compute_hash


def test_cache_key_deterministic():
    content = "def hello(): pass"
    model = "gemma4:e4b"
    system = "You are Vector"

    hash1 = _compute_hash(content, model, system)
    hash2 = _compute_hash(content, model, system)
    assert hash1 == hash2
    assert len(hash1) == 64  # SHA256 hex string


def test_cache_key_changes_on_content_change():
    content1 = "def hello(): pass"
    content2 = "def hello(): return 42"
    model = "gemma4:e4b"
    system = "You are Vector"

    hash1 = _compute_hash(content1, model, system)
    hash2 = _compute_hash(content2, model, system)
    assert hash1 != hash2


def test_cache_key_changes_on_model_or_system_change():
    content = "def hello(): pass"
    hash_base = _compute_hash(content, "gemma4:e4b", "sys1")
    hash_model = _compute_hash(content, "qwen2.5-coder:7b", "sys1")
    hash_sys = _compute_hash(content, "gemma4:e4b", "sys2")

    assert hash_base != hash_model
    assert hash_base != hash_sys
