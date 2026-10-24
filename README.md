# Vector — Local Code Companion

> **100% local** · AI-powered code summariser that runs entirely on your machine using [Ollama](https://ollama.com). Nothing leaves your device.

![Vector UI](public/og-image.png)

---

## What it does

Vector is a ChatGPT-style web app that summarises code using local language models. You feed it code through any of these inputs and it produces structured summaries with TL;DR, key functions, dependencies, gotchas, and more:

| Input | How |
|---|---|
| **Upload files** | Single or multiple code files |
| **Upload folder** | Entire project folder — smart filtering skips `node_modules`, build artefacts, binaries |
| **GitHub repo / file** | Paste any public GitHub URL — full repos, sub-folders (`/tree/…`), or single files (`/blob/…`) |
| **Watch a file** | Backend auto-re-summarises whenever the file changes on disk |
| **Paste code** | Paste directly into the chat |

---

## Architecture

```
┌─────────────────────────────────┐
│  Vite + React frontend          │  http://localhost:5173
│  TanStack Router · shadcn/ui    │
└────────────┬────────────────────┘
             │ REST + SSE (EventSource)
┌────────────▼────────────────────┐
│  FastAPI backend                │  http://localhost:8000
│  Uvicorn · SQLite (vector.db)   │
│  SSE streaming summarisation    │
└────────────┬────────────────────┘
             │ HTTP
┌────────────▼────────────────────┐
│  Ollama                         │  http://localhost:11434
│  (gemma4, qwen2.5-coder, etc.)  │
└─────────────────────────────────┘
```

---

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| **Node.js** | ≥ 18 | [nvm](https://github.com/nvm-sh/nvm) recommended |
| **Python** | ≥ 3.11 | Used by the FastAPI backend |
| **Ollama** | latest | [ollama.com/download](https://ollama.com/download) |

Pull at least one model before starting:

```bash
ollama pull gemma4:e4b        # recommended default (~4 GB)
ollama pull gemma4:e2b        # lighter option (~2 GB)
ollama pull qwen2.5-coder:7b  # good for code (~4.7 GB)
```

---

## Quick start

### 1 — Clone & install frontend deps

```bash
git clone https://github.com/<you>/vector.git
cd vector
npm install
```

### 2 — Set up the Python backend

```bash
cd backend

# Create virtual environment
python -m venv .venv

# Activate (Windows PowerShell)
.\.venv\Scripts\Activate.ps1

# Activate (macOS / Linux)
source .venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Copy the example env file and edit if needed
copy .env.example .env     # Windows
# cp .env.example .env     # macOS/Linux
```

### 3 — Start all three services

Open **three separate terminals**:

**Terminal 1 — Ollama** (usually already running in the background)
```bash
ollama serve
```

**Terminal 2 — Backend**
```bash
cd backend
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

**Terminal 3 — Frontend**
```bash
npm run dev
```

Open **http://localhost:5173** in your browser.

---

## Running with VS Code tasks (one-click)

Pre-configured tasks are available in `.vscode/tasks.json`:

1. Press `Ctrl + Shift + P` → **Tasks: Run Task**
2. Select **"Run Fullstack (Backend + Frontend)"**

This launches both the FastAPI backend and Vite frontend in separate terminal tabs automatically.

For debugging with breakpoints:
1. Open the **Run and Debug** panel (`Ctrl + Shift + D`)
2. Select **"Debug Backend (FastAPI)"** from the dropdown
3. Set breakpoints in any `backend/app/` file and press `F5`

---

## Configuration

### Backend — `backend/.env`

```env
# Ollama
OLLAMA_URL=http://127.0.0.1:11434
DEFAULT_MODEL=gemma4:e4b
LIGHT_MODEL=gemma4:e2b
DEEP_MODEL=qwen2.5-coder:7b

# Context window (tokens) — keep small for limited VRAM
NUM_CTX=4096

# GitHub (optional — raises rate limit to 5000 req/hr and allows private repos)
GITHUB_TOKEN=

# Database file path
DB_PATH=vector.db

# CORS — add your frontend origin if different from the default
FRONTEND_ORIGIN=http://127.0.0.1:5173
```

### Frontend — root `.env`

```env
VITE_API_URL=http://127.0.0.1:8000
```

> **LAN access** — leave `VITE_API_URL` unset (or blank). The frontend auto-detects the backend host from `window.location.hostname` and connects to port 8000 on the same machine, making the app accessible from other devices on your network.

---

## Deployment on Render (Free Tier)

Vector can be deployed directly to [Render](https://render.com) using the included `render.yaml` Blueprint or via the Render dashboard.

### Architecture on Render

- **Frontend**: Render Static Site (free tier, automated CDN, SSL included)
- **Backend**: Render Python Web Service (FastAPI + Uvicorn)
- **LLM / Ollama**: Since Render's free tier provides 512 MB RAM without GPU, models run either:
  1. On your **local machine with Ollama & GPU**, exposed to Render via a free tunnel (e.g. [ngrok](https://ngrok.com) or [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/))
  2. On any remote Ollama server or hosted OpenAI-compatible provider (Groq, OpenRouter, etc.) configured in Vector's Settings

---

### Option A — 1-Click Blueprint (Recommended)

1. Push your repository to GitHub.
2. In the [Render Dashboard](https://dashboard.render.com), click **New +** → **Blueprint**.
3. Select your `vector` repository.
4. Render detects [`render.yaml`](render.yaml) and automatically creates:
   - `vector-backend` (Python Web Service)
   - `vector-frontend` (Static Site with SPA routing)
5. Click **Apply**. Render will build and deploy both services.

---

### Option B — Manual Dashboard Setup

#### 1. Deploy the Backend (Web Service)
1. In Render Dashboard, click **New +** → **Web Service**.
2. Connect your repository.
3. Configure settings:
   - **Name**: `vector-backend`
   - **Root Directory**: `backend`
   - **Runtime**: `Python 3`
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
4. Under **Environment Variables**, add:
   - `PYTHON_VERSION`: `3.12.0`
   - `CORS_ORIGINS`: `*`
   - `OLLAMA_URL`: URL to your Ollama instance (see below)
5. Click **Create Web Service**. Note the backend URL (e.g. `https://vector-backend.onrender.com`).

#### 2. Deploy the Frontend (Static Site)
1. Click **New +** → **Static Site**.
2. Connect your repository.
3. Configure settings:
   - **Name**: `vector-frontend`
   - **Build Command**: `npm install && npm run build`
   - **Publish Directory**: `.output/public`
4. Under **Environment Variables**, add:
   - `VITE_API_URL`: Your backend URL from step 1 (e.g. `https://vector-backend.onrender.com`)
5. Under **Redirects / Rewrites**, add:
   - **Type**: `Rewrite`
   - **Source**: `/*`
   - **Destination**: `/index.html`
6. Click **Create Static Site**.

---

### Connecting Ollama to Render for Free

To run local Ollama models on your GPU while the web app is hosted on Render:

1. Start Ollama locally:
   ```bash
   ollama serve
   ```
2. In another terminal, start a free tunnel using [ngrok](https://ngrok.com):
   ```bash
   ngrok http 11434
   ```
3. Copy the forwarding URL (e.g. `https://abc1-23.ngrok-free.app`).
4. In your Render backend service, set the environment variable:
   ```
   OLLAMA_URL=https://abc1-23.ngrok-free.app
   ```

---

## Running tests

```bash
# Backend (pytest)
cd backend
.\.venv\Scripts\python.exe -m pytest

# Frontend (vitest)
npm run test

# Type-check
npx tsc --noEmit

# Lint
npm run lint
```

---

## Status banners explained

| Banner | Meaning | Fix |
|---|---|---|
| 🔴 Red — *Vector backend unreachable* | FastAPI is not running or port 8000 is occupied | Start uvicorn (Terminal 2 above) |
| 🟡 Amber — *Ollama isn't running* | Backend is up but Ollama isn't responding | Run `ollama serve` |
| 🟢 No banner + green dot | Everything is connected and ready | — |

---

## Troubleshooting

**Port 8000 already in use (Windows)**
```powershell
Get-Process -Id (Get-NetTCPConnection -LocalPort 8000).OwningProcess | Stop-Process -Force
```

**PowerShell script execution blocked**
```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

**VS Code shows "Cannot find module pydantic_settings"**  
Press `Ctrl + Shift + P` → **Python: Select Interpreter** → choose `./backend/.venv/Scripts/python.exe`, then **Python: Restart Language Server**.

**GitHub repo gives 403 / rate-limit error**  
Create a GitHub personal access token (no special scopes needed for public repos) and add it to `backend/.env`:
```
GITHUB_TOKEN=ghp_...
```

---

## Project structure

```
vector/
├── backend/               # FastAPI + SQLite backend
│   ├── app/
│   │   ├── main.py        # App entry point, CORS, startup
│   │   ├── routes/        # /summarize, /history, /watch, /settings …
│   │   ├── github.py      # GitHub repo ingestion
│   │   ├── project.py     # Multi-file project summarisation
│   │   ├── pipeline.py    # Per-file summarisation pipeline
│   │   ├── watcher.py     # File-change watcher & auto-summarise
│   │   └── db.py          # SQLite helpers
│   ├── tests/             # pytest test suite
│   └── requirements.txt
├── src/                   # Vite + React frontend
│   ├── components/vector/ # App UI components
│   ├── lib/               # API client, store, utilities
│   └── routes/            # TanStack Router routes
├── render.yaml            # Render Blueprint deployment specification
├── public/                # Static assets
└── package.json
```

---

## License

MIT — see [LICENSE](LICENSE) if present, otherwise consider this open source.
