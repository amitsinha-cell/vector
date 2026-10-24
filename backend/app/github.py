"""GitHub ingestion: repository and file fetching with smart ranking.

Supports:
- Full repo URLs: https://github.com/owner/repo
- Tree URLs: https://github.com/owner/repo/tree/branch/dir
- Blob URLs: https://github.com/owner/repo/blob/branch/path/file.ext

Limits: max 200 files, max 200 KB per file.
Skips: binaries, lockfiles, node_modules, dist, build, .git, minified files.
Ranks: "start_here" files using entry points, README, and dependency references.
"""

from __future__ import annotations

import base64
import logging
import os
import re
from dataclasses import dataclass
from typing import Any

import httpx

from .config import settings

logger = logging.getLogger("vector.github")

MAX_FILES = 200
MAX_FILE_BYTES = 200 * 1024  # 200 KB

SKIP_DIRS = {
    "node_modules", "dist", "build", ".git", ".github", ".venv", "venv",
    "__pycache__", ".next", ".nuxt", "coverage", "out", "target", "vendor",
    "bin", "obj", ".idea", ".vscode",
}

LOCKFILES = {
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "cargo.lock",
    "poetry.lock", "gemfile.lock", "composer.lock", "pipfile.lock", "bun.lockb",
}

BINARY_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".pdf",
    ".zip", ".tar", ".gz", ".7z", ".exe", ".dll", ".so", ".dylib",
    ".bin", ".pyc", ".wasm", ".woff", ".woff2", ".ttf", ".eot", ".mp4",
}


@dataclass
class RepoFile:
    path: str
    content: str
    size: int


def parse_github_url(url: str) -> dict[str, str | None]:
    """Parse GitHub URL into owner, repo, ref/branch, and subpath."""
    pattern = r"^https?://github\.com/([^/]+)/([^/]+)(?:/(tree|blob)/([^/]+)(?:/(.*))?)?"
    m = re.match(pattern, url.strip())
    if not m:
        raise ValueError(f"Invalid GitHub URL: {url}")
    owner, repo, mode, ref, path = m.groups()
    # Remove trailing .git if present
    if repo.endswith(".git"):
        repo = repo[:-4]
    return {
        "owner": owner,
        "repo": repo,
        "mode": mode,  # "tree", "blob", or None
        "ref": ref or "HEAD",
        "path": path or "",
    }


def _should_skip_file(path: str, size: int | None = None) -> bool:
    """Check if file should be skipped."""
    parts = path.replace("\\", "/").split("/")
    filename = parts[-1].lower()

    # Skip directories in path
    for p in parts[:-1]:
        if p.lower() in SKIP_DIRS:
            return True

    # Lockfiles
    if filename in LOCKFILES:
        return True

    # Minified files
    if filename.endswith(".min.js") or filename.endswith(".min.css"):
        return True

    # Binaries
    for ext in BINARY_EXTENSIONS:
        if filename.endswith(ext):
            return True

    # Size check
    if size is not None and size > MAX_FILE_BYTES:
        return True

    return False


async def fetch_github_repo(url: str) -> tuple[str, list[RepoFile], list[dict[str, str]]]:
    """Fetch repo files and generate start_here ranking.
    Returns: (repo_name, list_of_files, start_here_ranked)
    """
    parsed = parse_github_url(url)
    owner = parsed["owner"]
    repo = parsed["repo"]
    mode = parsed["mode"]
    ref = parsed["ref"]
    target_path = parsed["path"]

    token = os.environ.get("GITHUB_TOKEN") or getattr(settings, "github_token", None)
    headers = {
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "Vector-Code-Companion/1.0",
    }
    if token:
        headers["Authorization"] = f"token {token}"

    async with httpx.AsyncClient(headers=headers, timeout=30.0, follow_redirects=True) as client:
        # If single blob
        if mode == "blob" and target_path:
            api_url = f"https://api.github.com/repos/{owner}/{repo}/contents/{target_path}?ref={ref}"
            resp = await client.get(api_url)
            if resp.status_code == 404:
                raise RuntimeError(f"Repository or file not found: {owner}/{repo} (is it private?)")
            if resp.status_code == 403:
                raise RuntimeError("GitHub API rate limit exceeded. Set GITHUB_TOKEN env var to get 5000 req/hr.")
            if resp.status_code != 200:
                raise RuntimeError(f"Failed to fetch file from GitHub: HTTP {resp.status_code}")
            data = resp.json()
            raw_content = ""
            if data.get("encoding") == "base64":
                raw_content = base64.b64decode(data.get("content", "")).decode("utf-8", errors="replace")
            else:
                raw_content = data.get("content", "")
            file_obj = RepoFile(path=target_path, content=raw_content, size=len(raw_content))
            start_here = [{"path": target_path, "reason": "Target file requested"}]
            return f"{owner}/{repo}/{target_path}", [file_obj], start_here

        # For plain repo URLs, ref defaults to "HEAD" which is invalid for the git/trees API.
        # Always resolve the actual default branch first.
        if ref == "HEAD" or not ref:
            meta_resp = await client.get(f"https://api.github.com/repos/{owner}/{repo}")
            if meta_resp.status_code == 404:
                raise RuntimeError(
                    f"Repository '{owner}/{repo}' not found. "
                    "Check the URL and make sure it's a public repository."
                )
            if meta_resp.status_code == 403:
                raise RuntimeError(
                    "GitHub API rate limit exceeded. "
                    "Set the GITHUB_TOKEN environment variable to increase limits."
                )
            if meta_resp.status_code != 200:
                raise RuntimeError(f"Failed to fetch repository info: HTTP {meta_resp.status_code}")
            ref = meta_resp.json().get("default_branch", "main")
            logger.info("Resolved default branch for %s/%s: %s", owner, repo, ref)

        # Full repository tree
        tree_url = f"https://api.github.com/repos/{owner}/{repo}/git/trees/{ref}?recursive=1"
        resp = await client.get(tree_url)
        if resp.status_code != 200:
            # Try main/master as fallbacks
            for alt_ref in ("main", "master"):
                if alt_ref == ref:
                    continue
                alt_url = f"https://api.github.com/repos/{owner}/{repo}/git/trees/{alt_ref}?recursive=1"
                resp = await client.get(alt_url)
                if resp.status_code == 200:
                    ref = alt_ref
                    break
        if resp.status_code == 404:
            raise RuntimeError(f"Branch '{ref}' not found in {owner}/{repo}.")
        if resp.status_code == 403:
            raise RuntimeError("GitHub API rate limit exceeded. Set GITHUB_TOKEN env var.")
        if resp.status_code != 200:
            raise RuntimeError(f"Failed to fetch repo tree from GitHub: HTTP {resp.status_code}")

        tree_data = resp.json()
        tree_items = tree_data.get("tree", [])

        # Filter items
        eligible_items = []
        for item in tree_items:
            if item.get("type") != "blob":
                continue
            item_path = item.get("path", "")
            if target_path and not item_path.startswith(target_path):
                continue
            item_size = item.get("size", 0)
            if not _should_skip_file(item_path, item_size):
                eligible_items.append(item)

        # Cap at MAX_FILES
        eligible_items = eligible_items[:MAX_FILES]

        # Fetch contents in batches
        files: list[RepoFile] = []
        for item in eligible_items:
            path = item["path"]
            # Fetch raw content
            raw_url = f"https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}"
            r = await client.get(raw_url)
            if r.status_code == 200:
                text = r.text
                if len(text.encode("utf-8")) <= MAX_FILE_BYTES:
                    files.append(RepoFile(path=path, content=text, size=len(text)))

        # Rank files for "start_here"
        start_here = rank_start_here(files)

        return f"{owner}/{repo}", files, start_here


def rank_start_here(files: list[RepoFile]) -> list[dict[str, str]]:
    """Rank files for 'Start reading here' recommendations:
    1. README files (high priority)
    2. Entry point files: main.*, index.*, app.*, server.*
    3. Files with high import / usage counts
    """
    ranked: list[dict[str, str]] = []
    seen: set[str] = set()

    # 1. README
    for f in files:
        base = os.path.basename(f.path).lower()
        if base.startswith("readme"):
            ranked.append({"path": f.path, "reason": "Project overview and entry documentation"})
            seen.add(f.path)
            break

    # 2. Entry points
    entry_patterns = [
        (r"^(index|main|app|server)\.(ts|js|py|go|rs|jsx|tsx)$", "Core entry point and bootstrap logic"),
        (r"^(src|lib)/(index|main|app|server)\.(ts|js|py|go|rs|jsx|tsx)$", "Main application entry point"),
        (r"^(core|config|router)\.(ts|js|py|go|rs)$", "Core architectural definitions and configuration"),
    ]

    for f in files:
        if f.path in seen:
            continue
        for pat, reason in entry_patterns:
            if re.search(pat, f.path, re.IGNORECASE):
                ranked.append({"path": f.path, "reason": reason})
                seen.add(f.path)
                break

    # 3. Fill up to 5 files from remaining top code files
    for f in files:
        if len(ranked) >= 5:
            break
        if f.path not in seen and not f.path.endswith(".json") and not f.path.endswith(".md"):
            ranked.append({"path": f.path, "reason": "Key implementation module"})
            seen.add(f.path)

    return ranked[:5]
