"""Tests for tree-sitter and sliding-window chunker."""

import pytest
from app.chunker import detect_language, chunk_file, _fallback_window_chunk


def test_detect_language():
    assert detect_language("app.py") == "python"
    assert detect_language("index.ts") == "typescript"
    assert detect_language("component.tsx") == "tsx"
    assert detect_language("main.go") == "go"
    assert detect_language("lib.rs") == "rust"
    assert detect_language("unknown.xyz123") == "unknown"
    assert detect_language(None) == "unknown"


def test_fallback_window_chunking():
    # Generate 400 lines of code
    code = "\n".join(f"line_{i} = {i}" for i in range(400))
    chunks = _fallback_window_chunk(code, window_size=150, overlap=20)
    assert len(chunks) >= 3
    assert chunks[0].line_start == 1
    assert chunks[0].line_end == 150
    assert "Window 1" in chunks[0].name


def test_chunk_file_empty():
    assert chunk_file("") == []
    assert chunk_file("   \n\t  ") == []


def test_chunk_file_python_structure():
    code = '''
def add(a, b):
    return a + b

class MathHelper:
    def multiply(self, x, y):
        return x * y

def subtract(a, b):
    return a - b
'''
    chunks = chunk_file(code, "test.py")
    assert len(chunks) > 0
    # Chunks should include definitions or windows
    assert any("add" in c.name or "MathHelper" in c.name or "Window" in c.name for c in chunks)
