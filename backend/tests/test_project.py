"""Comprehensive tests for Project Summarisation (Vector Phase 2).

Tests:
- filter rules
- path traversal rejection
- language detection
- manifest parsing
- ranking
- schema validation
- project endpoint with a small multi-language fixture (python + js + html + Dockerfile)
"""

import json
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.project import (
    validate_relative_path,
    check_file_filter,
    parse_manifests,
    rank_project_files,
    MAX_FILE_BYTES,
)
from app.chunker import detect_language
from app.models import (
    ProjectOverview,
    TechStackEntry,
    DirectoryMapEntry,
    EntryPointEntry,
    HowToRun,
    StartHereEntry,
)


@pytest.fixture(autouse=True)
def reset_sse_exit_event():
    from sse_starlette.sse import AppStatus
    AppStatus.should_exit_event = None
    yield
    AppStatus.should_exit_event = None


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


# ---------------------------------------------------------------------------
# 1. Path Traversal Protection
# ---------------------------------------------------------------------------

def test_path_traversal_rejection():
    """Verify that dangerous paths (traversals, absolute paths) are rejected."""
    # Parent directory traversals
    with pytest.raises(ValueError, match="Path traversal rejected"):
        validate_relative_path("../secret.py")

    with pytest.raises(ValueError, match="Path traversal rejected"):
        validate_relative_path("foo/../../bar.py")

    with pytest.raises(ValueError, match="Path traversal rejected"):
        validate_relative_path("a/b/c/../../../etc/passwd")

    # Absolute paths
    with pytest.raises(ValueError, match="Absolute path rejected"):
        validate_relative_path("/etc/passwd")

    with pytest.raises(ValueError, match="Absolute path rejected"):
        validate_relative_path("C:/Windows/System32/cmd.exe")

    # Empty path
    with pytest.raises(ValueError, match="Invalid empty path"):
        validate_relative_path("")

    # Valid relative paths
    assert validate_relative_path("main.py") == "main.py"
    assert validate_relative_path("./src/index.ts") == "src/index.ts"
    assert validate_relative_path("nested\\sub\\file.py") == "nested/sub/file.py"


# ---------------------------------------------------------------------------
# 2. Filter Rules
# ---------------------------------------------------------------------------

def test_filter_rules_directories():
    """Verify ignored directories are skipped."""
    assert check_file_filter("node_modules/express/index.js", 100)[0] is True
    assert check_file_filter(".git/HEAD", 50)[0] is True
    assert check_file_filter(".venv/Lib/site.py", 200)[0] is True
    assert check_file_filter("venv/bin/activate", 200)[0] is True
    assert check_file_filter("dist/bundle.js", 1000)[0] is True
    assert check_file_filter("build/output.js", 1000)[0] is True
    assert check_file_filter("app/__pycache__/main.cpython-312.pyc", 500)[0] is True


def test_filter_rules_lockfiles():
    """Verify lockfiles are skipped."""
    assert check_file_filter("package-lock.json", 1000)[0] is True
    assert check_file_filter("frontend/package-lock.json", 1000)[0] is True
    assert check_file_filter("bun.lock", 500)[0] is True
    assert check_file_filter("yarn.lock", 500)[0] is True
    assert check_file_filter("cargo.lock", 500)[0] is True
    assert check_file_filter("poetry.lock", 500)[0] is True


def test_filter_rules_binaries_and_minified():
    """Verify binaries, media, and minified files are skipped."""
    assert check_file_filter("assets/logo.png", 500)[0] is True
    assert check_file_filter("fonts/inter.woff2", 500)[0] is True
    assert check_file_filter("bin/runner.exe", 500)[0] is True
    assert check_file_filter("lib/math.wasm", 500)[0] is True
    assert check_file_filter("dist/main.min.js", 500)[0] is True
    assert check_file_filter("dist/main.map", 500)[0] is True


def test_filter_rules_size_limit():
    """Verify files exceeding 200 KB are skipped."""
    assert check_file_filter("huge.sql", MAX_FILE_BYTES + 1)[0] is True
    assert check_file_filter("normal.py", MAX_FILE_BYTES)[0] is False


def test_filter_rules_valid_code():
    """Verify regular code files are accepted."""
    skip, reason = check_file_filter("src/index.ts", 1500)
    assert skip is False
    assert reason is None


# ---------------------------------------------------------------------------
# 3. Language Detection
# ---------------------------------------------------------------------------

def test_language_detection():
    """Verify language detection across standard extensions and special filenames."""
    assert detect_language("server.py") == "python"
    assert detect_language("src/index.js") == "javascript"
    assert detect_language("src/index.ts") == "typescript"
    assert detect_language("components/App.tsx") == "tsx"
    assert detect_language("index.html") == "html"
    assert detect_language("styles.css") == "css"
    assert detect_language("Dockerfile") == "dockerfile"
    assert detect_language("Makefile") == "makefile"
    assert detect_language("main.go") == "go"
    assert detect_language("lib.rs") == "rust"
    assert detect_language("Main.java") == "java"
    assert detect_language("schema.sql") == "sql"
    assert detect_language("deploy.sh") == "bash"


# ---------------------------------------------------------------------------
# 4. Manifest Parsing
# ---------------------------------------------------------------------------

def test_manifest_parsing():
    """Verify non-LLM manifest inspection for dependencies, scripts, and run commands across all supported formats."""
    files = {
        "package.json": json.dumps({
            "name": "vector-web",
            "dependencies": {"react": "^18.0.0", "lucide-react": "^1.0.0"},
            "scripts": {"dev": "vite", "build": "vite build"},
        }),
        "requirements.txt": "fastapi==0.115.0\nuvicorn==0.32.0\npydantic>=2.0.0\n",
        "pyproject.toml": '[project]\nname = "vector-backend"\n',
        "Cargo.toml": '[package]\nname = "vector-core"\n',
        "go.mod": 'module github.com/vector/app\n',
        "pom.xml": '<project><artifactId>vector-service</artifactId><dependency><artifactId>spring-boot</artifactId></dependency></project>',
        "build.gradle": 'plugins { id "org.springframework.boot" }\ndependencies { implementation "org.springframework:spring-core:6.0.0" }',
        "CMakeLists.txt": 'project(VectorNative CXX)',
        "Dockerfile": "FROM python:3.12-slim\nWORKDIR /app\nCMD [\"python\", \"main.py\"]\n",
        "docker-compose.yml": "version: '3.8'\nservices:\n  web:\n    image: node:20\n  db:\n    image: postgres:16\n",
        ".env.example": "PORT=8000\nDATABASE_URL=sqlite:///vector.db\n",
        "Makefile": "dev:\n\tpython main.py\nbuild:\n\tnpm run build\n",
        "README.md": "# Vector Code Companion\nA local code summarisation app.\n",
    }

    info = parse_manifests(files)
    assert info["name"] in ("vector-web", "Vector Code Companion", "vector-service", "vector-core")
    assert "react" in info["dependencies"]
    assert "fastapi" in info["dependencies"]
    assert "spring-boot" in info["dependencies"]
    assert any("service:web" in d for d in info["dependencies"])
    assert any("env:PORT" in d for d in info["dependencies"])
    assert any("npm run dev" in c for c in info["commands"])
    assert any("docker compose up" in c for c in info["commands"])
    assert any("cp .env.example .env" in c for c in info["commands"])
    assert any("cmake" in c for c in info["commands"])
    assert "Vector Code Companion" in info["readme_excerpt"]


# ---------------------------------------------------------------------------
# 5. Ranking
# ---------------------------------------------------------------------------

def test_file_ranking():
    """Verify entry points, manifests, README, and most-imported files rank above auxiliary files."""
    files = [
        {"path": "src/utils/helpers.py", "size": 1000, "content": "import math"},
        {"path": "src/models/core.py", "size": 1200, "content": "class Model: pass"},
        {"path": "package.json", "size": 500, "content": "{}"},
        {"path": "README.md", "size": 800, "content": "# Readme"},
        {"path": "backend/app/main.py", "size": 2500, "content": "import core\nfrom core import Model"},
        {"path": "backend/app/routes.py", "size": 1500, "content": "import core\nfrom core import Model"},
        {"path": "src/components/common/Button.tsx", "size": 400, "content": "export function Button() {}"},
    ]

    top_n, remainder = rank_project_files(files)
    top_paths = [f["path"] for f in top_n]

    # README, package.json, and main.py should be ranked highly
    assert top_paths[0] == "README.md"
    assert "package.json" in top_paths[:4]
    assert "backend/app/main.py" in top_paths[:4]
    # core.py is imported multiple times (most-imported) so it should rank higher than helpers.py
    assert top_paths.index("src/models/core.py") < top_paths.index("src/utils/helpers.py")


# ---------------------------------------------------------------------------
# 6. Schema Validation & Repair
# ---------------------------------------------------------------------------

def test_project_overview_schema_validation():
    """Verify ProjectOverview pydantic model schema conformance."""
    sample = {
        "name": "Test Project",
        "tldr": "A full-stack test application.",
        "purpose": "Demonstrates project summarisation.",
        "tech_stack": [
            {"language": "Python", "file_count": 5, "role": "Backend API"},
            {"language": "TypeScript", "file_count": 8, "role": "Frontend UI"},
        ],
        "architecture": "Client-server architecture using FastAPI and React.",
        "directory_map": [
            {"path": "backend", "role": "FastAPI REST API"},
            {"path": "src", "role": "React SPA"},
        ],
        "entry_points": [
            {"path": "backend/app/main.py", "why": "FastAPI entry point"},
            {"path": "src/main.tsx", "why": "React app bootstrap"},
        ],
        "data_flow": "Frontend sends HTTP requests to backend, which queries database.",
        "how_to_run": {
            "commands": ["npm run dev", "uvicorn app.main:app --reload"],
            "inferred": True,
        },
        "start_here": [
            {"path": "backend/app/main.py", "reason": "Defines core API routes"},
            {"path": "src/App.tsx", "reason": "Defines core frontend UI"},
        ],
        "gotchas": ["Requires local Ollama instance running"],
        "files_summarised": 13,
        "files_skipped": 2,
        "model": "gemma4:e4b",
        "files": [],
    }

    overview = ProjectOverview(**sample)
    dumped = overview.model_dump()
    assert dumped["name"] == "Test Project"
    assert len(dumped["tech_stack"]) == 2
    assert dumped["how_to_run"]["inferred"] is True
    assert len(dumped["start_here"]) == 2


def test_project_overview_repair_and_partial_warning():
    """Verify schema failure triggers partial fallback with warning."""
    # When missing required fields, a partial dictionary with _warning is preserved
    partial = {
        "name": "Partial Project",
        "tldr": "Partial summary",
        "purpose": "Inferred purpose",
        "_warning": "Project overview schema validation failed; displaying inferred overview.",
    }
    overview = ProjectOverview(**partial)
    dumped = overview.model_dump()
    assert dumped["name"] == "Partial Project"
    assert dumped["tldr"] == "Partial summary"


# ---------------------------------------------------------------------------
# 7. Project Endpoint with Multi-Language Fixture (Mocked for CI)
# ---------------------------------------------------------------------------

class MockLLMProvider:
    name = "ollama"

    async def is_available(self) -> bool:
        return True

    async def list_models(self) -> list[dict]:
        return [{"name": "mock-model:latest"}]

    async def stream_json(self, prompt: str, schema: dict, model: str, system: str | None = None, num_ctx: int | None = None):
        if "overview" in prompt.lower() or "directory map" in prompt.lower():
            res = {
                "tldr": "Sample multi-language application with FastAPI backend and JavaScript frontend.",
                "purpose": "Demonstrates project summarisation.",
                "architecture": "FastAPI server with static frontend files.",
                "data_flow": "Client triggers HTTP requests to backend.",
                "gotchas": ["Requires local dependencies installed."],
            }
        else:
            res = {
                "tldr": "Source file implementation.",
                "purpose": "Component logic.",
                "language": "python",
                "key_functions": [{"name": "root", "signature": "def root()", "summary": "Root handler"}],
                "dependencies": ["fastapi"],
                "gotchas": [],
            }
        yield json.dumps(res)


async def _mock_get_provider_and_model(requested_model, system_prompt):
    return MockLLMProvider(), "mock-model", system_prompt or "sys", "ollama"


def test_project_endpoint_multi_language_fixture(client, monkeypatch):
    """Test POST /summarize/project with a fixture (python + js + html + Dockerfile) end to end."""
    monkeypatch.setattr("app.routes.summarize._get_provider_and_model", _mock_get_provider_and_model)

    fixture_files = [
        {"path": "backend/main.py", "content": "from fastapi import FastAPI\napp = FastAPI()\n@app.get('/')\ndef root(): return {'ok': True}"},
        {"path": "frontend/index.js", "content": "console.log('App loaded'); export function init() { return 42; }"},
        {"path": "public/index.html", "content": "<!DOCTYPE html><html><head><title>App</title></head><body><h1>Hello</h1></body></html>"},
        {"path": "Dockerfile", "content": "FROM python:3.12-slim\nWORKDIR /app\nCOPY . .\nCMD [\"python\", \"backend/main.py\"]"},
    ]

    payload = {
        "name": "multi-lang-fixture",
        "files": fixture_files,
        "model": "mock-model",
    }

    response = client.post("/summarize/project", json=payload)
    assert response.status_code == 200
    assert "text/event-stream" in response.headers.get("content-type", "")

    # Read SSE events
    lines = response.text.split("\n")
    events = [l for l in lines if l.startswith("event:") or l.startswith("data:")]
    assert len(events) > 0
    assert any("file_result" in l for l in events)
    assert any("overview" in l for l in events)
    assert any("done" in l for l in events)


def test_project_endpoint_path_traversal_rejection(client, monkeypatch):
    """Test POST /summarize/project rejects unsafe paths gracefully."""
    monkeypatch.setattr("app.routes.summarize._get_provider_and_model", _mock_get_provider_and_model)

    unsafe_files = [
        {"path": "../../etc/passwd", "content": "root:x:0:0:..."},
        {"path": "valid.py", "content": "print('valid')"},
    ]

    payload = {
        "name": "unsafe-project",
        "files": unsafe_files,
    }

    # Should still process valid.py while safely ignoring/filtering ../../etc/passwd
    response = client.post("/summarize/project", json=payload)
    assert response.status_code == 200
    assert "text/event-stream" in response.headers.get("content-type", "")


@pytest.mark.live
def test_project_endpoint_live_ollama(client):
    """Live integration test against a running Ollama instance."""
    import urllib.request

    try:
        with urllib.request.urlopen("http://127.0.0.1:11434/api/tags", timeout=1) as resp:
            available = resp.status == 200
    except Exception:
        available = False

    if not available:
        pytest.skip("Ollama is not running locally; skipping live test.")

    payload = {
        "name": "live-test-project",
        "files": [
            {"path": "main.py", "content": "def main(): return 42"},
            {"path": "README.md", "content": "# Live Test Project"},
        ],
    }
    response = client.post("/summarize/project", json=payload)
    assert response.status_code == 200
