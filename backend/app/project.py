"""Project summarisation pipeline for multi-file folder uploads and repositories.

Implements:
- Client & Server-side filtering & limits (max 300 files, max 5 MB total, max 200 KB per file).
- Path traversal protection (rejects '..' and absolute paths).
- Manifest parsing without LLM (package.json, pyproject.toml, Cargo.toml, go.mod, Dockerfile, etc.).
- Ranking: top N files get full LLM summaries; remaining get fast tree-sitter signature summaries.
- Hierarchical reduce: file summaries -> directory summaries -> project overview (stays under num_ctx).
- Pydantic validation with 1-shot repair.
- Per-file caching and FTS persistence.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import uuid
from typing import AsyncIterator, Callable, Any
from pathlib import PurePosixPath

from .config import settings
from .chunker import detect_language, chunk_file, _get_node_name
from .database import find_cached, insert_summary
from .errors import OutOfMemoryError, ValidationError
from .models import (
    FileSummary,
    ProjectOverview,
    TechStackEntry,
    DirectoryMapEntry,
    EntryPointEntry,
    HowToRun,
    StartHereEntry,
)
from .pipeline import run_pipeline_stream, _run_with_repair
from .providers.base import LLMProvider
from .queue import gpu_queue

logger = logging.getLogger("vector.project")

MAX_FILES_LIMIT = 300
MAX_TOTAL_BYTES = 5 * 1024 * 1024  # 5 MB
MAX_FILE_BYTES = 200 * 1024        # 200 KB
TOP_N_SUMMARIES = 30

SKIP_DIRS = {
    "node_modules", ".git", "dist", "build", "out", "target", ".venv", "venv",
    "__pycache__", ".next", ".nuxt", ".idea", ".vscode", "vendor", "coverage",
    "bin", "obj", ".turbo", ".cache",
}

LOCKFILES = {
    "package-lock.json", "bun.lock", "bun.lockb", "yarn.lock", "poetry.lock",
    "cargo.lock", "pnpm-lock.yaml", "gemfile.lock", "composer.lock", "pipfile.lock",
}

BINARY_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".pdf",
    ".zip", ".tar", ".gz", ".7z", ".exe", ".dll", ".so", ".dylib",
    ".bin", ".pyc", ".wasm", ".woff", ".woff2", ".ttf", ".eot", ".mp4",
    ".mp3", ".wav", ".mov", ".avi",
}


def validate_relative_path(path: str) -> str:
    """Validate relative path to prevent path traversal. Rejects '..' and absolute paths."""
    if not path or not path.strip():
        raise ValueError(f"Invalid empty path: '{path}'")
    cleaned = path.replace("\\", "/").strip()
    if cleaned.startswith("./"):
        cleaned = cleaned[2:]
    if not cleaned:
        raise ValueError(f"Invalid empty path: '{path}'")
    if cleaned.startswith("/") or re.match(r"^[a-zA-Z]:", cleaned):
        raise ValueError(f"Absolute path rejected: '{path}'")
    parts = cleaned.split("/")
    if ".." in parts:
        raise ValueError(f"Path traversal rejected: '{path}'")
    return cleaned


def check_file_filter(path: str, size: int = 0) -> tuple[bool, str | None]:
    """Check if file should be skipped. Returns (skip, reason)."""
    norm = path.replace("\\", "/").strip()
    if norm.startswith("./"):
        norm = norm[2:]
    parts = norm.split("/")
    filename = parts[-1].lower()

    # Directory check
    for part in parts[:-1]:
        if part.lower() in SKIP_DIRS:
            return True, f"Ignored directory ({part})"

    # Lockfiles
    if filename in LOCKFILES:
        return True, "Lockfile"

    # Minified / source maps
    if filename.endswith(".min.js") or filename.endswith(".min.css") or filename.endswith(".map"):
        return True, "Minified or source map"

    # Binary / media extensions
    for ext in BINARY_EXTENSIONS:
        if filename.endswith(ext):
            return True, "Binary or media file"

    # Size check
    if size > MAX_FILE_BYTES:
        return True, f"File exceeds 200 KB ({size // 1024} KB)"

    return False, None


def parse_manifests(files: dict[str, str]) -> dict[str, Any]:
    """Inspect project manifests and documentation without calling an LLM."""
    info: dict[str, Any] = {
        "name": "",
        "dependencies": [],
        "scripts": {},
        "commands": [],
        "readme_excerpt": "",
    }

    # 1. package.json
    for path, content in files.items():
        base = os.path.basename(path).lower()
        if base == "package.json":
            try:
                data = json.loads(content)
                if not info["name"] and data.get("name"):
                    info["name"] = data["name"]
                all_deps = list(data.get("dependencies", {}).keys()) + list(data.get("devDependencies", {}).keys())
                info["dependencies"].extend(all_deps[:25])
                scripts = data.get("scripts", {})
                info["scripts"].update(scripts)
                if "dev" in scripts:
                    info["commands"].append("npm run dev")
                elif "start" in scripts:
                    info["commands"].append("npm start")
                if "build" in scripts:
                    info["commands"].append("npm run build")
                if "test" in scripts:
                    info["commands"].append("npm test")
            except Exception:
                pass

    # 2. requirements.txt / pyproject.toml
    for path, content in files.items():
        base = os.path.basename(path).lower()
        if base == "requirements.txt":
            reqs = [
                re.split(r"[=><~]", line.strip())[0].strip()
                for line in content.splitlines()
                if line.strip() and not line.strip().startswith("#")
            ]
            info["dependencies"].extend(reqs[:20])
            if "uvicorn" in content:
                info["commands"].append("uvicorn main:app --reload")
            elif "flask" in content:
                info["commands"].append("flask run")
            elif "fastapi" in content:
                info["commands"].append("uvicorn app.main:app --reload")
            else:
                info["commands"].append("python main.py")

        elif base == "pyproject.toml":
            name_m = re.search(r'name\s*=\s*["\']([^"\']+)["\']', content)
            if name_m and not info["name"]:
                info["name"] = name_m.group(1)
            info["commands"].append("python -m venv .venv && pip install .")

    # 3. Cargo.toml
    for path, content in files.items():
        if os.path.basename(path).lower() == "cargo.toml":
            name_m = re.search(r'name\s*=\s*["\']([^"\']+)["\']', content)
            if name_m and not info["name"]:
                info["name"] = name_m.group(1)
            info["commands"].extend(["cargo run", "cargo test", "cargo build"])

    # 4. go.mod
    for path, content in files.items():
        if os.path.basename(path).lower() == "go.mod":
            m = re.search(r'module\s+([^\s]+)', content)
            if m and not info["name"]:
                info["name"] = m.group(1).split("/")[-1]
            info["commands"].extend(["go run .", "go build"])

    # 5. pom.xml (Maven)
    for path, content in files.items():
        if os.path.basename(path).lower() == "pom.xml":
            art_m = re.search(r'<artifactId>([^<]+)</artifactId>', content)
            if art_m and not info["name"]:
                info["name"] = art_m.group(1).strip()
            deps = re.findall(r'<dependency>.*?<artifactId>([^<]+)</artifactId>.*?</dependency>', content, re.DOTALL)
            if deps:
                info["dependencies"].extend(deps[:15])
            if "spring-boot" in content:
                info["commands"].append("./mvnw spring-boot:run")
            else:
                info["commands"].append("mvn clean install")

    # 6. build.gradle / build.gradle.kts (Gradle)
    for path, content in files.items():
        base = os.path.basename(path).lower()
        if base in ("build.gradle", "build.gradle.kts"):
            deps = re.findall(r'implementation\s*[\(\'"]([^:]+:[^\'")\s]+)', content)
            if deps:
                info["dependencies"].extend(deps[:15])
            if "org.springframework.boot" in content:
                info["commands"].append("./gradlew bootRun")
            else:
                info["commands"].append("./gradlew build")

    # 7. CMakeLists.txt
    for path, content in files.items():
        if os.path.basename(path).lower() == "cmakelists.txt":
            cmake_proj = re.search(r'project\s*\(\s*([a-zA-Z0-9_-]+)', content, re.IGNORECASE)
            if cmake_proj and not info["name"]:
                info["name"] = cmake_proj.group(1).strip()
            info["commands"].extend(["cmake -B build", "cmake --build build"])

    # 8. Dockerfile & docker-compose
    for path, content in files.items():
        base = os.path.basename(path).lower()
        if base in ("dockerfile", "dockerfile.dev", "dockerfile.prod"):
            info["commands"].append(f"docker build -t {info['name'] or 'app'} .")
        elif base in ("docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml") or "docker-compose" in base:
            services = re.findall(r'^\s{2}([a-zA-Z0-9_-]+):', content, re.MULTILINE)
            if services:
                info["dependencies"].extend([f"service:{s}" for s in services[:5]])
            info["commands"].append("docker compose up")

    # 9. .env.example
    for path, content in files.items():
        if os.path.basename(path).lower() == ".env.example":
            env_vars = re.findall(r'^([A-Z0-9_]+)=', content, re.MULTILINE)
            if env_vars:
                info["dependencies"].extend([f"env:{v}" for v in env_vars[:10]])
            info["commands"].append("cp .env.example .env")

    # 10. Makefile
    for path, content in files.items():
        if os.path.basename(path).lower() == "makefile":
            targets = re.findall(r"^([a-zA-Z0-9_-]+):", content, re.MULTILINE)
            for t in ["dev", "build", "run", "test", "all"]:
                if t in targets:
                    info["commands"].append(f"make {t}")

    # 11. README excerpt
    for path, content in files.items():
        base = os.path.basename(path).lower()
        if base.startswith("readme"):
            lines = [l for l in content.splitlines() if l.strip()]
            info["readme_excerpt"] = "\n".join(lines[:15])
            if not info["name"] and lines:
                info["name"] = lines[0].lstrip("#").strip()
            break

    # Deduplicate commands
    seen_cmd = set()
    deduped_cmds = []
    for cmd in info["commands"]:
        if cmd not in seen_cmd:
            seen_cmd.add(cmd)
            deduped_cmds.append(cmd)
    info["commands"] = deduped_cmds[:25]

    return info


def extract_ast_signatures(code: str, language: str) -> str:
    """Extract lightweight signatures (functions, classes) without LLM call using tree-sitter or regex."""
    if not code or not code.strip():
        return "Empty file"

    # Attempt tree-sitter AST extraction first
    try:
        from tree_sitter_language_pack import get_parser
        parser_lang = language
        if language in ("jsx", "tsx"):
            parser_lang = "tsx"
        elif language == "c_sharp":
            parser_lang = "c-sharp"
        elif language in ("bash", "sh"):
            parser_lang = "bash"

        parser = get_parser(parser_lang)
        source_bytes = code.encode("utf-8")
        tree = parser.parse(source_bytes)
        defs: list[str] = []

        target_types = (
            "function_definition", "class_definition", "decorated_definition",
            "function_declaration", "class_declaration", "interface_declaration",
            "type_alias_declaration", "method_declaration", "function_item",
            "struct_item", "impl_item"
        )
        for child in tree.root_node.children:
            if child.type in target_types:
                name = _get_node_name(child, source_bytes)
                if name and name not in defs and not name.startswith("def"):
                    defs.append(name)
        if defs:
            return f"{language.capitalize()} module defining {', '.join(defs[:4])}"
    except Exception:
        pass

    # Regex heuristic fallback
    patterns = {
        "python": (r"^\s*(?:def|class|async\s+def)\s+([a-zA-Z0-9_]+)", "Python"),
        "javascript": (r"^\s*(?:function|class|const|let)\s+([a-zA-Z0-9_]+)", "JavaScript"),
        "typescript": (r"^\s*(?:function|class|interface|type|const)\s+([a-zA-Z0-9_]+)", "TypeScript"),
        "tsx": (r"^\s*(?:function|class|interface|type|const)\s+([a-zA-Z0-9_]+)", "TSX"),
        "go": (r"^\s*(?:func|type)\s+(?:\([^)]+\)\s+)?([a-zA-Z0-9_]+)", "Go"),
        "rust": (r"^\s*(?:fn|struct|enum|trait|impl)\s+([a-zA-Z0-9_]+)", "Rust"),
        "java": (r"^\s*(?:public|private|protected)?\s*(?:static)?\s*(?:class|interface|void|int|String)\s+([a-zA-Z0-9_]+)", "Java"),
        "c": (r"^[a-zA-Z0-9_*]+\s+([a-zA-Z0-9_]+)\s*\(", "C"),
        "cpp": (r"^[a-zA-Z0-9_*]+\s+([a-zA-Z0-9_]+)\s*\(", "C++"),
        "c_sharp": (r"^\s*(?:public|private|internal)\s+(?:class|interface|struct|void)\s+([a-zA-Z0-9_]+)", "C#"),
        "html": (r"<(title|h1|h2|form|nav|main)[^>]*>", "HTML"),
        "dockerfile": (r"^(FROM|ENTRYPOINT|CMD)\s+(.+)", "Dockerfile"),
    }

    entry = patterns.get(language)
    if entry:
        pat, lang_name = entry
        matches = re.findall(pat, code, re.MULTILINE)
        if matches:
            first_few = [m[0] if isinstance(m, tuple) else m for m in matches[:4]]
            return f"{lang_name} module defining {', '.join(first_few)}"

    lines = len(code.splitlines())
    return f"{language.capitalize()} module ({lines} lines)"


def rank_project_files(
    files: list[dict[str, Any]],
    top_n: int = TOP_N_SUMMARIES,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Rank files so entry points, README, manifests, and most-imported files are summarised first."""
    # Count references/imports across all files
    import_counts: dict[str, int] = {}
    for f in files:
        content = f.get("content", "")
        imported_names = re.findall(
            r"""(?:import\s+[\w\s{},*]+from\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\)|from\s+([a-zA-Z0-9_.]+)\s+import|import\s+([a-zA-Z0-9_.]+))""",
            content,
        )
        for tup in imported_names:
            ref = next((x for x in tup if x), "")
            if ref:
                base_ref = ref.split("/")[-1].split(".")[0]
                import_counts[base_ref] = import_counts.get(base_ref, 0) + 1

    def score_file(f: dict[str, Any]) -> int:
        path = f["path"].lower()
        base = os.path.basename(path).lower()
        stem = base.rsplit(".", 1)[0] if "." in base else base
        score = 0

        # Readme
        if base.startswith("readme"):
            return 1000

        # Manifests
        if base in (
            "package.json", "pyproject.toml", "cargo.toml", "go.mod", "pom.xml",
            "build.gradle", "build.gradle.kts", "cmakelists.txt", "dockerfile",
            "makefile", "docker-compose.yml", "compose.yaml",
        ):
            return 900

        # Entry points
        if re.search(r"^(index|main|app|server|cli)\.(py|ts|js|go|rs|jsx|tsx)$", base):
            return 800
        if re.search(r"/(index|main|app|server|cli)\.(py|ts|js|go|rs|jsx|tsx)$", path):
            return 750

        # Most imported files
        if stem in import_counts:
            score += min(import_counts[stem] * 50, 400)

        # Core logic / config
        if any(term in path for term in ["routes", "api", "controllers", "models", "components", "lib", "core"]):
            score += 300

        # Moderate size preferred over huge or tiny
        size = f.get("size", 0)
        if 500 < size < 15000:
            score += 100

        return score

    sorted_files = sorted(files, key=score_file, reverse=True)
    return sorted_files[:top_n], sorted_files[top_n:]


PROJECT_SCHEMA = ProjectOverview.model_json_schema()


async def summarize_project_stream(
    files: list[dict[str, Any]],
    project_name: str,
    provider: LLMProvider,
    model: str,
    system_prompt: str,
    force: bool = False,
) -> AsyncIterator[dict]:
    """Execute project summarisation with hierarchical reduce and streaming progress."""
    total_input_files = len(files)
    yield {
        "stage": f"Scanning {total_input_files} project files...",
        "detail": "Analyzing project structure and detecting languages",
    }

    # 1. Server-side validation and filtering
    accepted_files: list[dict[str, Any]] = []
    skipped_count = 0
    total_bytes = 0

    files_content_map: dict[str, str] = {}

    for item in files:
        raw_path = item.get("path", "")
        content = item.get("content", "")
        size = item.get("size", len(content.encode("utf-8")))

        try:
            valid_path = validate_relative_path(raw_path)
        except ValueError as val_err:
            logger.warning("Rejected invalid path: %s", val_err)
            skipped_count += 1
            continue

        skip, reason = check_file_filter(valid_path, size)
        if skip:
            skipped_count += 1
            continue

        if len(accepted_files) >= MAX_FILES_LIMIT:
            skipped_count += 1
            continue

        if total_bytes + size > MAX_TOTAL_BYTES:
            skipped_count += 1
            continue

        total_bytes += size
        lang = detect_language(valid_path)
        accepted_files.append({
            "path": valid_path,
            "content": content,
            "size": size,
            "language": lang,
        })
        files_content_map[valid_path] = content

    total_valid = len(accepted_files)
    if total_valid == 0:
        raise ValueError("No eligible code files found in upload after filtering")

    yield {
        "stage": f"Filtered {total_valid} eligible files ({skipped_count} skipped)",
        "detail": f"Total payload size: {total_bytes // 1024} KB",
    }

    # 2. Manifest and tech stack extraction
    manifest_info = parse_manifests(files_content_map)
    final_project_name = manifest_info["name"] or project_name or "Project"

    # Check project-level cache before executing LLM calls
    files_hash_parts = [
        f"{f['path']}:{hashlib.sha256(f['content'].encode('utf-8')).hexdigest()}"
        for f in sorted(accepted_files, key=lambda x: x["path"])
    ]
    proj_cache_hash = hashlib.sha256(
        f"{final_project_name}\x00{model}\x00{settings.prompt_version}\x00{system_prompt}\x00{';'.join(files_hash_parts)}".encode("utf-8")
    ).hexdigest()

    if not force:
        cached_proj = await find_cached(proj_cache_hash)
        if cached_proj:
            try:
                cached_data = json.loads(cached_proj["result_json"])
                yield {
                    "stage": "Cached project overview found",
                    "detail": f"Returning cached overview for {final_project_name}",
                }
                for idx, cf in enumerate(cached_data.get("files", []), 1):
                    yield {
                        "type": "file_result",
                        "path": cf["path"],
                        "summary": cf["summary"],
                        "cached": True,
                        "index": idx,
                        "total": len(cached_data.get("files", [])),
                    }
                yield {
                    "type": "project_result",
                    "id": cached_proj["id"],
                    "project": cached_data,
                    "overview": cached_data,
                    "model": cached_proj["model"],
                    "provider": cached_proj["provider"],
                    "cached": True,
                }
                return
            except Exception as cache_err:
                logger.warning("Failed loading cached project JSON: %s", cache_err)

    # Language breakdown
    lang_counts: dict[str, int] = {}
    for f in accepted_files:
        l = f["language"]
        lang_counts[l] = lang_counts.get(l, 0) + 1

    tech_stack = [
        {"language": l.capitalize(), "file_count": count, "role": f"{count} files"}
        for l, count in sorted(lang_counts.items(), key=lambda x: x[1], reverse=True)
        if l != "unknown"
    ]

    # 3. Ranking files
    top_files, remaining_files = rank_project_files(accepted_files)

    file_summaries: list[dict[str, Any]] = []
    actual_model = model

    # Summarise top files with LLM & cache
    total_to_summarise = len(top_files)
    for idx, f in enumerate(top_files, 1):
        yield {
            "stage": f"Summarising {idx}/{total_to_summarise}...",
            "detail": f.get("path"),
        }

        f_path = f["path"]
        f_content = f["content"]
        file_hash = hashlib.sha256(
            f"{f_content}\x00{actual_model}\x00{settings.prompt_version}\x00{system_prompt}".encode()
        ).hexdigest()

        summary_dict = None
        is_cached = False

        if not force:
            cached = await find_cached(file_hash)
            if cached:
                try:
                    summary_dict = json.loads(cached["result_json"])
                    is_cached = True
                except Exception:
                    pass

        if not summary_dict:
            try:
                async for evt in run_pipeline_stream(f_content, f_path, provider, actual_model, system_prompt):
                    if evt.get("type") == "final":
                        summary_dict = evt.get("summary")
                        if evt.get("model"):
                            actual_model = evt.get("model")
            except Exception as exc:
                logger.warning("Failed summarizing file %s: %s", f_path, exc)
                summary_dict = {
                    "tldr": f"{f_path} could not be summarised.",
                    "purpose": "Source file",
                    "language": f["language"],
                    "key_functions": [],
                    "dependencies": [],
                    "gotchas": [str(exc)],
                }

            await insert_summary(
                source_type="project_file",
                source_ref=f"{final_project_name}:{f_path}",
                file_path=f_path,
                content_hash=file_hash,
                model=actual_model,
                provider=provider.name,
                system_prompt=system_prompt,
                result_json=json.dumps(summary_dict),
            )

        file_summaries.append({
            "path": f_path,
            "summary": summary_dict,
            "cached": is_cached,
        })

        yield {
            "type": "file_result",
            "path": f_path,
            "summary": summary_dict,
            "cached": is_cached,
            "index": idx,
            "total": total_to_summarise,
        }

    # 4. AST signatures for remaining files (no LLM call)
    if remaining_files:
        yield {
            "stage": f"Indexing {len(remaining_files)} remaining files with AST...",
            "detail": "Extracting module declarations without LLM",
        }
        for f in remaining_files:
            f_path = f["path"]
            sig_desc = extract_ast_signatures(f["content"], f["language"])
            ast_summary = {
                "tldr": sig_desc,
                "purpose": f"{f['language'].capitalize()} source module",
                "language": f["language"],
                "key_functions": [],
                "dependencies": [],
                "gotchas": [],
            }
            file_summaries.append({
                "path": f_path,
                "summary": ast_summary,
                "cached": True,
            })

    # 5. Hierarchical reduce: Directory map
    yield {
        "stage": "Synthesising directory architecture...",
        "detail": "Building directory map and module roles",
    }

    dir_to_files: dict[str, list[dict]] = {}
    for fs in file_summaries:
        p = fs["path"]
        parts = p.split("/")
        dir_name = "/".join(parts[:-1]) if len(parts) > 1 else "."
        dir_to_files.setdefault(dir_name, []).append(fs)

    directory_map = []
    for d, d_files in sorted(dir_to_files.items()):
        roles = [df["summary"].get("purpose", "") for df in d_files[:3] if df["summary"].get("purpose")]
        role_desc = "; ".join(roles[:2]) if roles else f"Contains {len(d_files)} source files"
        directory_map.append({"path": d, "role": role_desc[:120]})

    # Entry points
    entry_points = []
    for fs in file_summaries:
        p = fs["path"].lower()
        if any(term in p for term in ["main", "index", "app", "server", "cli", "entry"]):
            entry_points.append({
                "path": fs["path"],
                "why": fs["summary"].get("purpose", "Core entry point and bootstrap logic")[:100],
            })
    if not entry_points and file_summaries:
        entry_points.append({
            "path": file_summaries[0]["path"],
            "why": "Primary source file",
        })

    # Start here
    start_here = [
        {"path": ep["path"], "reason": ep["why"]}
        for ep in entry_points[:5]
    ]

    # 6. Final Project Overview LLM synthesis
    yield {
        "stage": "Writing project overview...",
        "detail": f"Synthesising overview for {final_project_name}",
    }

    key_summaries_brief = [
        {"path": fs["path"], "tldr": fs["summary"].get("tldr", "")[:120]}
        for fs in file_summaries[:15]
    ]

    overview_prompt = (
        f"Project Name: {final_project_name}\n"
        f"Total files: {total_valid} (summarised {len(top_files)} top files)\n"
        f"Manifest dependencies: {', '.join(manifest_info['dependencies'][:15])}\n"
        f"Detected run commands: {', '.join(manifest_info['commands'])}\n"
        f"Key file summaries:\n{json.dumps(key_summaries_brief, indent=1)}\n\n"
        f"Directory map:\n{json.dumps(directory_map[:10], indent=1)}\n\n"
        "Generate a structured JSON overview of this project conforming to the schema:\n"
        "- tldr: 1-2 sentence executive summary of the project\n"
        "- purpose: core objective and functionality\n"
        "- architecture: high-level component breakdown and interactions (2 paragraphs)\n"
        "- data_flow: how data moves through the application\n"
        "- gotchas: key technical risks, limitations, or setup hurdles"
    )

    overview_schema = {
        "type": "object",
        "properties": {
            "tldr": {"type": "string"},
            "purpose": {"type": "string"},
            "architecture": {"type": "string"},
            "data_flow": {"type": "string"},
            "gotchas": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["tldr", "purpose", "architecture"],
    }

    job_id = f"proj-{uuid.uuid4().hex[:6]}"
    collected = ""
    try:
        async for token in gpu_queue.submit(
            job_id,
            lambda: provider.stream_json(
                overview_prompt,
                overview_schema,
                actual_model,
                system=system_prompt,
                num_ctx=settings.get_num_ctx(actual_model),
            ),
        ):
            collected += token
    except OutOfMemoryError as oom_err:
        if actual_model != settings.light_model:
            logger.warning("Project overview OOM with %s. Retrying with light model %s: %s", actual_model, settings.light_model, oom_err)
            actual_model = settings.light_model
            yield {
                "stage": f"Model ran out of GPU memory. Retrying overview with '{settings.light_model}'...",
                "detail": f"Switched to {settings.light_model}",
            }
            collected = ""
            try:
                async for token in gpu_queue.submit(
                    f"{job_id}-oom",
                    lambda: provider.stream_json(
                        overview_prompt,
                        overview_schema,
                        actual_model,
                        system=system_prompt,
                        num_ctx=settings.get_num_ctx(actual_model),
                    ),
                ):
                    collected += token
            except Exception as exc2:
                logger.warning("Overview retry with light model failed: %s", exc2)
        else:
            raise
    except Exception as exc:
        logger.warning("Project overview generation stream failed: %s", exc)

    # Validate output with 1 repair retry
    parsed_ov = None
    warning_note = None

    if collected.strip():
        try:
            raw_obj = json.loads(collected)
            if isinstance(raw_obj, dict) and raw_obj.get("tldr") and raw_obj.get("purpose"):
                parsed_ov = raw_obj
        except Exception:
            pass

    if not parsed_ov and collected.strip():
        logger.info("Project overview output invalid JSON or missing fields. Attempting 1 repair retry...")
        repair_prompt = (
            f"The following JSON response was generated for the project overview but does not conform to the schema:\n\n"
            f"```json\n{collected[:4000]}\n```\n\n"
            f"Fix the JSON so it strictly matches this JSON schema and return ONLY valid JSON:\n"
            f"{json.dumps(overview_schema, indent=2)}"
        )
        try:
            repaired = ""
            async for token in gpu_queue.submit(
                f"{job_id}-repair",
                lambda: provider.stream_json(
                    repair_prompt,
                    overview_schema,
                    actual_model,
                    system=system_prompt,
                    num_ctx=settings.get_num_ctx(actual_model),
                ),
            ):
                repaired += token
            raw_repaired = json.loads(repaired)
            if isinstance(raw_repaired, dict) and raw_repaired.get("tldr"):
                parsed_ov = raw_repaired
        except Exception as repair_err:
            logger.warning("Repair retry failed: %s", repair_err)

    if not parsed_ov:
        warning_note = "Project overview schema validation failed; displaying inferred overview."
        parsed_ov = {
            "tldr": manifest_info.get("readme_excerpt")[:200] or f"{final_project_name} codebase containing {total_valid} files.",
            "purpose": f"Application codebase built with {', '.join([ts['language'] for ts in tech_stack[:3]])}.",
            "architecture": f"The codebase consists of {len(directory_map)} main directories coordinating application logic.",
            "data_flow": "Data flows from entry points through internal module handlers.",
            "gotchas": ["Generated via automated structural analysis."],
        }

    # Assemble complete ProjectOverview
    project_result = {
        "name": final_project_name,
        "tldr": parsed_ov.get("tldr", ""),
        "purpose": parsed_ov.get("purpose", ""),
        "tech_stack": tech_stack,
        "architecture": parsed_ov.get("architecture", ""),
        "directory_map": directory_map,
        "entry_points": entry_points,
        "data_flow": parsed_ov.get("data_flow", ""),
        "how_to_run": {
            "commands": manifest_info["commands"] or ["npm start", "python main.py"],
            "inferred": True,
        },
        "start_here": start_here,
        "gotchas": parsed_ov.get("gotchas", []),
        "files_summarised": total_valid,
        "files_skipped": skipped_count,
        "model": actual_model,
        "files": file_summaries,
    }

    # Validate against ProjectOverview schema
    validated_model = ProjectOverview(**project_result).model_dump()
    if warning_note:
        validated_model["_warning"] = warning_note

    # Persist in DB and FTS
    row_id = await insert_summary(
        source_type="project",
        source_ref=final_project_name,
        file_path=final_project_name,
        content_hash=proj_cache_hash,
        model=actual_model,
        provider=provider.name,
        system_prompt=system_prompt,
        result_json=json.dumps(validated_model),
    )

    yield {
        "type": "project_result",
        "id": row_id,
        "project": validated_model,
        "overview": validated_model,
        "model": actual_model,
        "provider": provider.name,
    }
