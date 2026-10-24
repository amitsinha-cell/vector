# Vector Backend

Local Python backend for the Vector code companion and summariser.

## Quick start

```bash
cd backend
python -m venv .venv

# Windows
.venv\Scripts\activate
# macOS/Linux
# source .venv/bin/activate

pip install -r requirements.txt

# Copy and edit config
cp .env.example .env

# Start the server (binds to 127.0.0.1:8000)
uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

## Prerequisites

- Python 3.11+
- Ollama running (`ollama serve`) with at least one model pulled
- Recommended models:
  - `ollama pull gemma4:e4b` (default)
  - `ollama pull gemma4:e2b` (light/fallback)
  - `ollama pull qwen2.5-coder:7b` (deep mode)

## Configuration

All config is via environment variables (or `.env` file). See `.env.example`.

| Variable          | Default                  | Description                                  |
| ----------------- | ------------------------ | -------------------------------------------- |
| `OLLAMA_URL`      | `http://localhost:11434` | Ollama API base URL                          |
| `DEFAULT_MODEL`   | `gemma4:e4b`             | Default summarisation model                  |
| `LIGHT_MODEL`     | `gemma4:e2b`             | Light/fast model                             |
| `DEEP_MODEL`      | `qwen2.5-coder:7b`       | Deep analysis model                          |
| `NUM_CTX`         | `8192`                   | Context window size (tokens, fits 6 GB VRAM) |
| `GITHUB_TOKEN`    | _(empty)_                | Optional GitHub token for higher rate limits |
| `DB_PATH`         | `vector.db`              | SQLite database path                         |
| `FRONTEND_ORIGIN` | `http://localhost:5173`  | CORS allowed origin                          |
| `PROMPT_VERSION`  | `1`                      | Increment to invalidate cache                |

## API Endpoints

| Method | Path                               | Description                                          |
| ------ | ---------------------------------- | ---------------------------------------------------- |
| GET    | `/health`                          | Ollama status, models list, defaults, hosted flag    |
| POST   | `/summarize`                       | Single-file summarisation (SSE streaming)            |
| POST   | `/summarize/repo`                  | GitHub repository summarisation (SSE streaming)      |
| GET    | `/settings`                        | Get current configuration                            |
| PUT    | `/settings`                        | Update settings (system prompt, num_ctx, hosted)     |
| GET    | `/history`                         | List past summaries with pagination                  |
| GET    | `/history/{id}`                    | Get full summary JSON by ID                          |
| DELETE | `/history/{id}`                    | Delete a summary                                     |
| GET    | `/search?q=`                       | Full-text search over summaries using SQLite FTS5    |
| GET    | `/summaries/{id}/export?format=md` | Export summary as Markdown (.md) or JSON             |
| POST   | `/watch`                           | Add directory to watch (`{"path": "..."}`)           |
| GET    | `/watch`                           | List all watched directories                         |
| DELETE | `/watch/{id}`                      | Remove watched directory                             |
| GET    | `/events`                          | SSE event stream (`watch_summarised`, `watch_error`) |

## Architecture & Features

1. **Async Single Queue**: All LLM calls pass through a single asynchronous queue (`gpu_queue`) to enforce serial inference, preventing GPU Out-Of-Memory errors on 6 GB VRAM targets.
2. **Deterministic SQLite Caching**:
   - Cache key: `sha256(content + model + prompt_version + system_prompt)`
   - Unchanged files return cached results in milliseconds.
3. **Tree-sitter Chunking + Map-Reduce Pipeline**:
   - Uses `tree-sitter-language-pack` to parse structural definitions (functions, classes, interfaces).
   - Small files (<= 300 lines) are processed in a single pass.
   - Larger files (> 300 lines) use a map-reduce pipeline with per-section summaries reduced into a unified file summary.
   - Fallback sliding window for unsupported languages.
4. **Automated Schema Repair**: Output is strictly validated against the Pydantic `FileSummary` schema with a 1-retry repair prompt on schema mismatch.
5. **Folder Watcher**:
   - Real-time directory monitoring with watchdog.
   - 2-second debounce on rapid file modifications.
   - Hash comparison before invoking summarisation.
   - Watched folders persist in SQLite across server restarts.
6. **Privacy First**:
   - Binds to `127.0.0.1` only.
   - Source code contents are never logged.
   - Hosted provider fallback is disabled by default and requires explicit opt-in.

## Benchmarks

A benchmark script is provided to measure performance across configured models:

```bash
python bench.py --models gemma4:e4b gemma4:e2b qwen2.5-coder:7b
```

Measures:

- Cold inference time per file
- Tokens per second
- Peak VRAM (via `nvidia-smi`)
- Cache hit retrieval time

## Tests

Run the test suite using pytest:

```bash
pytest -v
```
