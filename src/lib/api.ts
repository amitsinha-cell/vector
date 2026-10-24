/**
 * API client for the Vector backend.
 * Base URL from VITE_API_URL env var (default: http://localhost:8000).
 * Handles SSE streaming for summaries and watcher events.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export function getApiBaseUrl(): string {
  if (import.meta.env["VITE_API_URL"]) {
    return import.meta.env["VITE_API_URL"] as string;
  }
  if (typeof window !== "undefined" && window.location.hostname) {
    const host = window.location.hostname;
    if (host !== "localhost" && host !== "127.0.0.1") {
      return `http://${host}:8000`;
    }
  }
  return "http://127.0.0.1:8000";
}

export const BASE_URL = getApiBaseUrl();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HealthResponse {
  backend: boolean;
  ollama: boolean;
  ollama_error?: string | null;
  models: Array<{ name: string; size?: number; mode?: string | null }>;
  defaults: { default: string; light: string; deep: string; num_ctx: number };
  hosted_enabled: boolean;
}

export interface KeyFunction {
  name: string;
  signature: string;
  summary: string;
  line_start: number | null;
  line_end: number | null;
}

export interface FileSummaryData {
  tldr: string;
  purpose: string;
  language: string;
  key_functions: KeyFunction[];
  dependencies: string[];
  gotchas: string[];
  _warning?: string | undefined;
}

export interface SummaryResult {
  id: number;
  summary: FileSummaryData;
  cached: boolean;
  model: string;
  provider: string;
}

export interface HistoryEntry {
  id: number;
  source_type: string;
  source_ref: string;
  file_path: string | null;
  model: string;
  provider: string;
  cached: boolean;
  created_at: string;
  tldr: string;
  kind?: "file" | "project" | "repo" | "unreadable";
  schema_version?: number;
  status?: "ok" | "unreadable";
  error?: string;
}

export interface SettingsData {
  system_prompt: string;
  default_model: string;
  num_ctx: string;
  hosted_enabled: boolean | string;
  hosted_base_url: string;
  hosted_api_key_set: boolean;
}

export interface WatchInfo {
  id: number;
  path: string;
  active: boolean;
  last_summarised?: string | null;
}

// ---------------------------------------------------------------------------
// Generic fetch helper
// ---------------------------------------------------------------------------

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...opts?.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as {
      error?: string;
      code?: string;
    };
    const err = new Error(body.error || body.code || `HTTP ${res.status}`) as Error & {
      status?: number | undefined;
      code?: string | undefined;
    };
    err.status = res.status;
    err.code = body.code;
    throw err;
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export async function fetchHealth(): Promise<HealthResponse> {
  return apiFetch<HealthResponse>("/health");
}

// ---------------------------------------------------------------------------
// Summarise (SSE streaming)
// ---------------------------------------------------------------------------

export interface SummariseCallbacks {
  onProgress?: (data: { stage: string; detail?: string; token?: string }) => void;
  onResult?: (data: SummaryResult) => void;
  onError?: (data: { error: string; code?: string }) => void;
  onDone?: (data: { cached?: boolean; error?: boolean }) => void;
}

export async function streamSummarise(
  opts: {
    text?: string | undefined;
    filename?: string | undefined;
    file?: File | undefined;
    model?: string | undefined;
    force?: boolean | undefined;
    system_prompt?: string | undefined;
    signal?: AbortSignal | undefined;
  },
  callbacks: SummariseCallbacks,
): Promise<void> {
  let body: BodyInit;
  const headers: Record<string, string> = {};

  if (opts.file) {
    const fd = new FormData();
    fd.append("file", opts.file);
    if (opts.model) fd.append("model", opts.model);
    if (opts.force) fd.append("force", "true");
    if (opts.system_prompt) fd.append("system_prompt", opts.system_prompt);
    body = fd;
  } else {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify({
      text: opts.text,
      filename: opts.filename,
      model: opts.model,
      force: opts.force ?? false,
      system_prompt: opts.system_prompt,
    });
  }

  const res = await fetch(`${BASE_URL}/summarize`, {
    method: "POST",
    headers,
    body,
    signal: opts.signal ?? null,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    const msg =
      err.code && err.error
        ? `[${err.code}] ${err.error}`
        : err.error || err.code || `HTTP ${res.status}`;
    callbacks.onError?.({ error: msg, code: err.code });
    callbacks.onDone?.({ error: true });
    return;
  }

  if (!res.body) {
    callbacks.onError?.({ error: "No response body" });
    callbacks.onDone?.({ error: true });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";

    let currentEvent = "";
    for (const line of parts) {
      if (line.startsWith("event: ")) {
        currentEvent = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        const dataStr = line.slice(6);
        try {
          const data = JSON.parse(dataStr);
          switch (currentEvent) {
            case "progress":
              callbacks.onProgress?.(data);
              break;
            case "result":
              callbacks.onResult?.(data);
              break;
            case "error": {
              const msg =
                data.code && data.error
                  ? `[${data.code}] ${data.error}`
                  : data.error || "Summarisation error";
              callbacks.onError?.({ error: msg, code: data.code });
              break;
            }
            case "done":
              callbacks.onDone?.(data);
              break;
          }
        } catch {
          // non-JSON SSE line — ignore
        }
        currentEvent = "";
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Repo Summarise (SSE streaming)
// ---------------------------------------------------------------------------

export interface RepoOverviewData {
  repo_name: string;
  url: string;
  overview: string;
  start_here: Array<{ path: string; reason: string }>;
  file_count: number;
  files: Array<{ path: string; summary: FileSummaryData; cached: boolean }>;
}

export interface RepoSummariseCallbacks {
  onProgress?: (data: { stage: string; detail?: string }) => void;
  onFileResult?: (data: {
    path: string;
    summary: FileSummaryData;
    cached: boolean;
    index: number;
    total: number;
  }) => void;
  onOverview?: (data: {
    id: number;
    overview: RepoOverviewData;
    model: string;
    provider: string;
  }) => void;
  onError?: (data: { error: string; code?: string }) => void;
  onDone?: (data: { success?: boolean; error?: boolean }) => void;
}

export async function streamRepoSummarise(
  opts: {
    url: string;
    model?: string | undefined;
    force?: boolean | undefined;
    system_prompt?: string | undefined;
    signal?: AbortSignal | undefined;
  },
  callbacks: RepoSummariseCallbacks,
): Promise<void> {
  const res = await fetch(`${BASE_URL}/summarize/repo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: opts.url,
      model: opts.model,
      force: opts.force ?? false,
      system_prompt: opts.system_prompt,
    }),
    signal: opts.signal ?? null,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    const msg =
      err.code && err.error
        ? `[${err.code}] ${err.error}`
        : err.error || err.code || `HTTP ${res.status}`;
    callbacks.onError?.({ error: msg, code: err.code });
    callbacks.onDone?.({ error: true });
    return;
  }

  if (!res.body) {
    callbacks.onError?.({ error: "No response body" });
    callbacks.onDone?.({ error: true });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";

    let currentEvent = "";
    for (const line of parts) {
      if (line.startsWith("event: ")) {
        currentEvent = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        const dataStr = line.slice(6);
        let data: unknown;
        try {
          data = JSON.parse(dataStr);
        } catch {
          currentEvent = "";
          continue;
        }

        try {
          switch (currentEvent) {
            case "progress":
              callbacks.onProgress?.(data as { stage: string; detail?: string });
              break;
            case "file_result":
              callbacks.onFileResult?.(
                data as {
                  path: string;
                  summary: FileSummaryData;
                  cached: boolean;
                  index: number;
                  total: number;
                },
              );
              break;
            case "overview":
              callbacks.onOverview?.(
                data as {
                  id: number;
                  overview: RepoOverviewData;
                  model: string;
                  provider: string;
                },
              );
              break;
            case "error":
              callbacks.onError?.(data as { error: string; code?: string });
              break;
            case "done":
              callbacks.onDone?.(data as { success?: boolean; error?: boolean });
              break;
          }
        } catch (cbErr) {
          console.error("Error executing SSE callback:", cbErr);
        }
        currentEvent = "";
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Project Summarise (SSE streaming)
// ---------------------------------------------------------------------------

export interface TechStackItem {
  language: string;
  file_count: number;
  role: string;
}

export interface DirectoryMapItem {
  path: string;
  role: string;
}

export interface EntryPointItem {
  path: string;
  why: string;
}

export interface HowToRunData {
  commands: string[];
  inferred: boolean;
}

export interface StartHereItem {
  path: string;
  reason: string;
}

export interface ProjectOverviewData {
  name: string;
  tldr: string;
  purpose: string;
  tech_stack: TechStackItem[];
  architecture: string;
  directory_map: DirectoryMapItem[];
  entry_points: EntryPointItem[];
  data_flow: string;
  how_to_run: HowToRunData;
  start_here: StartHereItem[];
  gotchas: string[];
  files_summarised: number;
  files_skipped: number;
  model: string;
  files: Array<{ path: string; summary: FileSummaryData; cached?: boolean | undefined }>;
}

export interface ProjectSummariseCallbacks {
  onProgress?: (data: { stage: string; detail?: string }) => void;
  onFileResult?: (data: {
    path: string;
    summary: FileSummaryData;
    cached: boolean;
    index: number;
    total: number;
  }) => void;
  onOverview?: (data: {
    id: number;
    overview?: ProjectOverviewData | undefined;
    project?: ProjectOverviewData | undefined;
    model: string;
    provider: string;
  }) => void;
  onError?: (data: { error: string; code?: string }) => void;
  onDone?: (data: { success?: boolean; error?: boolean }) => void;
}

export async function streamProjectSummarise(
  opts: {
    name: string;
    files: Array<{ path: string; content: string }>;
    model?: string | undefined;
    force?: boolean | undefined;
    system_prompt?: string | undefined;
    signal?: AbortSignal | undefined;
  },
  callbacks: ProjectSummariseCallbacks,
): Promise<void> {
  const res = await fetch(`${BASE_URL}/summarize/project`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: opts.name,
      files: opts.files,
      model: opts.model,
      force: opts.force ?? false,
      system_prompt: opts.system_prompt,
    }),
    signal: opts.signal ?? null,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    const msg =
      err.code && err.error
        ? `[${err.code}] ${err.error}`
        : err.error || err.code || `HTTP ${res.status}`;
    callbacks.onError?.({ error: msg, code: err.code });
    callbacks.onDone?.({ error: true });
    return;
  }

  if (!res.body) {
    callbacks.onError?.({ error: "No response body" });
    callbacks.onDone?.({ error: true });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";

    let currentEvent = "";
    for (const line of parts) {
      if (line.startsWith("event: ")) {
        currentEvent = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        const dataStr = line.slice(6);
        let data: unknown;
        try {
          data = JSON.parse(dataStr);
        } catch {
          currentEvent = "";
          continue;
        }

        try {
          switch (currentEvent) {
            case "progress":
              callbacks.onProgress?.(data as { stage: string; detail?: string });
              break;
            case "file_result":
              callbacks.onFileResult?.(
                data as {
                  path: string;
                  summary: FileSummaryData;
                  cached: boolean;
                  index: number;
                  total: number;
                },
              );
              break;
            case "overview": {
              const ovPayload = data as {
                id: number;
                overview?: ProjectOverviewData | undefined;
                project?: ProjectOverviewData | undefined;
                model: string;
                provider: string;
              };
              if (ovPayload && !ovPayload.overview && ovPayload.project) {
                ovPayload.overview = ovPayload.project;
              }
              callbacks.onOverview?.(ovPayload);
              break;
            }
            case "error":
              callbacks.onError?.(data as { error: string; code?: string });
              break;
            case "done":
              callbacks.onDone?.(data as { success?: boolean; error?: boolean });
              break;
          }
        } catch (cbErr) {
          console.error("Error executing SSE callback:", cbErr);
        }
        currentEvent = "";
      }
    }
  }
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export async function fetchHistory(limit = 100, offset = 0): Promise<HistoryEntry[]> {
  return apiFetch<HistoryEntry[]>(`/history?limit=${limit}&offset=${offset}`);
}

export async function fetchSummaryById(id: number): Promise<HistoryEntry & { summary?: unknown }> {
  return apiFetch<HistoryEntry & { summary?: unknown }>(`/history/${id}`);
}

export async function deleteUnreadableSummaries(): Promise<{ ok: boolean; deleted: number }> {
  return apiFetch<{ ok: boolean; deleted: number }>("/history/unreadable", { method: "DELETE" });
}

export async function deleteSummary(id: number) {
  return apiFetch<{ ok: boolean }>(`/history/${id}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export async function searchSummaries(query: string): Promise<HistoryEntry[]> {
  return apiFetch<HistoryEntry[]>(`/search?q=${encodeURIComponent(query)}`);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export async function exportSummary(id: number, format = "md") {
  return apiFetch<{ content: string; filename: string }>(
    `/summaries/${id}/export?format=${format}`,
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function fetchSettings(): Promise<SettingsData> {
  return apiFetch<SettingsData>("/settings");
}

export async function updateSettings(data: Record<string, unknown>) {
  return apiFetch<{ ok: boolean }>("/settings", {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

// ---------------------------------------------------------------------------
// Watched folders
// ---------------------------------------------------------------------------

export async function addWatch(path: string): Promise<WatchInfo> {
  return apiFetch<WatchInfo>("/watch", {
    method: "POST",
    body: JSON.stringify({ path }),
  });
}

export async function listWatches(): Promise<WatchInfo[]> {
  return apiFetch<WatchInfo[]>("/watch");
}

export async function removeWatch(id: number) {
  return apiFetch<{ ok: boolean }>(`/watch/${id}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// SSE events (watcher)
// ---------------------------------------------------------------------------

export interface WatchSummarisedEvent {
  id: number;
  watch_id: number;
  path: string;
  file_path: string;
  filename: string;
  summary: FileSummaryData;
  model: string;
  provider: string;
}

export interface WatchErrorEvent {
  watch_id: number;
  path: string;
  file_path: string;
  error: string;
}

export function subscribeEvents(callbacks: {
  onWatchSummarised?: (data: WatchSummarisedEvent) => void;
  onWatchError?: (data: WatchErrorEvent) => void;
  onError?: () => void;
}): () => void {
  const evtSource = new EventSource(`${BASE_URL}/events`);

  evtSource.addEventListener("watch_summarised", (e) => {
    try {
      callbacks.onWatchSummarised?.(JSON.parse(e.data));
    } catch {
      /* ignore */
    }
  });

  evtSource.addEventListener("watch_error", (e) => {
    try {
      callbacks.onWatchError?.(JSON.parse(e.data));
    } catch {
      /* ignore */
    }
  });

  evtSource.onerror = () => {
    callbacks.onError?.();
  };

  return () => evtSource.close();
}
