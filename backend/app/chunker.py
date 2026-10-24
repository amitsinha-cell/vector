"""Code chunking using tree-sitter with sliding-window fallback.

Chunks by structure: top-level functions, classes, methods.
For unsupported languages, parse errors, or flat files, falls back to
~150-line windows with ~20-line overlap.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Sequence

logger = logging.getLogger("vector.chunker")


@dataclass
class CodeChunk:
    name: str
    chunk_type: str  # "function", "class", "window", etc.
    content: str
    line_start: int
    line_end: int


# Language mapping from extension
EXT_TO_LANG: dict[str, str] = {
    ".py": "python",
    ".js": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".jsx": "jsx",
    ".ts": "typescript",
    ".tsx": "tsx",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".c": "c",
    ".h": "c",
    ".cpp": "cpp",
    ".hpp": "cpp",
    ".cc": "cpp",
    ".cs": "c_sharp",
    ".rb": "ruby",
    ".php": "php",
    ".swift": "swift",
    ".kt": "kotlin",
    ".scala": "scala",
    ".lua": "lua",
    ".sh": "bash",
    ".bash": "bash",
    ".html": "html",
    ".css": "css",
    ".json": "json",
    ".sql": "sql",
    ".md": "markdown",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".toml": "toml",
}

# Node types that represent top-level structural definitions
STRUCTURE_NODE_TYPES: dict[str, set[str]] = {
    "python": {"function_definition", "class_definition", "decorated_definition", "async_function_definition"},
    "javascript": {"function_declaration", "class_declaration", "export_statement", "lexical_declaration"},
    "typescript": {"function_declaration", "class_declaration", "interface_declaration", "type_alias_declaration", "export_statement", "lexical_declaration"},
    "tsx": {"function_declaration", "class_declaration", "interface_declaration", "type_alias_declaration", "export_statement", "lexical_declaration"},
    "go": {"function_declaration", "method_declaration", "type_declaration"},
    "rust": {"function_item", "impl_item", "struct_item", "trait_item", "enum_item"},
    "java": {"class_declaration", "interface_declaration", "record_declaration", "enum_declaration"},
    "c": {"function_definition", "struct_specifier"},
    "cpp": {"function_definition", "class_specifier", "struct_specifier", "namespace_definition"},
    "c_sharp": {"class_declaration", "method_declaration", "interface_declaration", "struct_declaration"},
    "ruby": {"method", "class", "module", "singleton_method"},
}


def detect_language(filename: str | None) -> str:
    """Detect language name from filename or extension."""
    if not filename:
        return "unknown"
    base = filename.replace("\\", "/").split("/")[-1].lower()
    if base in ("dockerfile", "dockerfile.dev", "dockerfile.prod") or base.startswith("dockerfile."):
        return "dockerfile"
    if base in ("makefile", "gnumakefile") or base.startswith("makefile."):
        return "makefile"
    for ext, lang in EXT_TO_LANG.items():
        if base.endswith(ext):
            return lang
    return "unknown"



def _fallback_window_chunk(code: str, window_size: int = 150, overlap: int = 20) -> list[CodeChunk]:
    """Chunk code into sliding windows of lines."""
    lines = code.splitlines(keepends=True)
    total_lines = len(lines)
    if total_lines == 0:
        return []

    chunks: list[CodeChunk] = []
    step = max(1, window_size - overlap)
    idx = 0
    chunk_num = 1

    while idx < total_lines:
        end_idx = min(idx + window_size, total_lines)
        chunk_lines = lines[idx:end_idx]
        content = "".join(chunk_lines)
        chunks.append(
            CodeChunk(
                name=f"Window {chunk_num} (L{idx + 1}-L{end_idx})",
                chunk_type="window",
                content=content,
                line_start=idx + 1,
                line_end=end_idx,
            )
        )
        if end_idx == total_lines:
            break
        idx += step
        chunk_num += 1

    return chunks


def _get_node_name(node, source_bytes: bytes) -> str:
    """Extract an identifying name from a syntax node."""
    # Look for name / identifier child node
    for child in node.children:
        if child.type in ("identifier", "name", "type_identifier", "property_identifier"):
            return source_bytes[child.start_byte:child.end_byte].decode("utf-8", errors="replace")
    # For decorated definitions or lexical declarations
    for child in node.children:
        if child.type in ("function_definition", "class_definition", "variable_declarator"):
            return _get_node_name(child, source_bytes)
    return node.type


def chunk_by_tree_sitter(code: str, language: str) -> list[CodeChunk] | None:
    """Attempt to chunk code using tree-sitter AST nodes.
    Returns None if tree-sitter is unavailable or language unsupported.
    """
    try:
        from tree_sitter_language_pack import get_parser
    except ImportError:
        try:
            from tree_sitter import Parser
            # Check if language pack is not available
            return None
        except ImportError:
            return None

    try:
        # tree_sitter_language_pack uses standard names
        parser_lang = language
        if language in ("jsx", "tsx"):
            parser_lang = "tsx"
        elif language == "c_sharp":
            parser_lang = "c-sharp"

        parser = get_parser(parser_lang)
    except Exception as exc:
        logger.debug("Tree-sitter parser not available for %s: %s", language, exc)
        return None

    try:
        source_bytes = code.encode("utf-8")
        tree = parser.parse(source_bytes)
        root = tree.root_node

        target_types = STRUCTURE_NODE_TYPES.get(language, set())
        chunks: list[CodeChunk] = []

        for child in root.children:
            if child.type in target_types:
                name = _get_node_name(child, source_bytes)
                content = source_bytes[child.start_byte:child.end_byte].decode("utf-8", errors="replace")
                start_line = child.start_point[0] + 1
                end_line = child.end_point[0] + 1
                chunks.append(
                    CodeChunk(
                        name=name,
                        chunk_type=child.type,
                        content=content,
                        line_start=start_line,
                        line_end=end_line,
                    )
                )

        if chunks:
            return chunks
        return None
    except Exception as exc:
        logger.warning("Tree-sitter parsing error for %s: %s", language, exc)
        return None


def chunk_file(code: str, filename: str | None = None, language: str | None = None) -> list[CodeChunk]:
    """Top-level chunker:
    1. Detects language
    2. Tries tree-sitter chunking
    3. Falls back to sliding windows if tree-sitter fails or returns no chunks
    """
    if not code or not code.strip():
        return []

    lang = language or detect_language(filename)
    if lang != "unknown":
        chunks = chunk_by_tree_sitter(code, lang)
        if chunks and len(chunks) > 0:
            return chunks

    return _fallback_window_chunk(code, window_size=150, overlap=20)
