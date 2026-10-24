import { useSyncExternalStore } from "react";

export type SourceKind = "file" | "github" | "link" | "image" | "watch" | "folder";
export interface FolderFile {
  path: string;
  size: number;
  content: string;
  language: string;
}
export interface Source {
  id: string;
  kind: SourceKind;
  name: string;
  url?: string | undefined;
  content?: string | undefined; // text content or data URL for images
  size?: number | undefined;
  addedAt: number;
  updatedAt?: number | undefined;
  folderFiles?: FolderFile[] | undefined;
}
export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  sourceIds?: string[] | undefined;
  model?: string | undefined;
  provider?: string | undefined;
  error?: boolean | undefined;
  createdAt: number;
  /** Structured summary result from the backend */
  summaryResult?: import("@/lib/api").SummaryResult | null | undefined;
  /** Repo overview result from the backend */
  repoResult?: import("@/lib/api").RepoOverviewData | null | undefined;
  /** Project overview result from the backend */
  projectResult?: import("@/lib/api").ProjectOverviewData | null | undefined;
  /** Streaming progress stage */
  progressStage?: string | undefined;
  progressDetail?: string | undefined;
}
export interface Chat {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
  sources: Source[];
}
export interface Download {
  id: string;
  chatId: string;
  filename: string;
  format: "md" | "txt" | "json";
  at: number;
}
export interface Settings {
  theme: "dark" | "light";
  systemPrompt: string;
  endpoint: string;
  model: string;
  numCtx: number;
  hostedEnabled: boolean;
  hostedBaseUrl: string;
  hostedApiKey: string;
}
export interface WatchedFolder {
  id: number;
  path: string;
  active: boolean;
  lastSummarised?: string | null;
}

export interface State {
  chats: Chat[];
  activeChatId: string | null;
  downloads: Download[];
  settings: Settings;
  ollamaConnected: boolean;
  watchedFolders: WatchedFolder[];
}

const KEY = "vector-state-v2";
// Legacy key from before versioned persistence
const LEGACY_KEY = "vector-state-v1";

export const DEFAULT_SYSTEM_PROMPT =
  "You are Vector, an expert code summariser. Given source code, produce a concise, well-structured Markdown summary: purpose, key components, data flow, dependencies, and notable risks or TODOs.";

const initial: State = {
  chats: [],
  activeChatId: null,
  downloads: [],
  settings: {
    theme: "dark",
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    endpoint: "http://127.0.0.1:11434",
    model: "",
    numCtx: 4096,
    hostedEnabled: false,
    hostedBaseUrl: "",
    hostedApiKey: "",
  },
  ollamaConnected: false,
  watchedFolders: [],
};

let state: State = initial;
let loaded = false;
const listeners = new Set<() => void>();

/**
 * Clears only the app's own browser storage keys. Does NOT touch backend history (vector.db).
 */
export function clearAppState() {
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem(LEGACY_KEY);
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;

  // Try current v2 key first
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (p && typeof p === "object") {
        state = { ...initial, ...p, settings: { ...initial.settings, ...p.settings } };
        if (state.settings.endpoint && state.settings.endpoint.includes("localhost")) {
          state.settings.endpoint = state.settings.endpoint.replace("localhost", "127.0.0.1");
        }
        return;
      }
    }
  } catch {
    // v2 key is corrupt — clear it and continue with defaults
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
  }

  // Migrate from v1 key if it exists
  try {
    const rawLegacy = localStorage.getItem(LEGACY_KEY);
    if (rawLegacy) {
      const p = JSON.parse(rawLegacy);
      if (p && typeof p === "object") {
        // Migrate: keep chats and settings but re-save under the new key
        state = { ...initial, ...p, settings: { ...initial.settings, ...p.settings } };
        if (state.settings.endpoint && state.settings.endpoint.includes("localhost")) {
          state.settings.endpoint = state.settings.endpoint.replace("localhost", "127.0.0.1");
        }
        // Remove the legacy key — we'll persist under v2 on next setState
        localStorage.removeItem(LEGACY_KEY);
        return;
      }
    }
  } catch {
    // legacy key is also corrupt — remove it and fall back to defaults
    try {
      localStorage.removeItem(LEGACY_KEY);
    } catch {
      /* ignore */
    }
  }
}

export function setState(fn: (s: State) => State) {
  load();
  state = fn(state);
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* quota exceeded */
  }
  listeners.forEach((l) => l());
}

export function getState() {
  load();
  return state;
}

export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => sel(getState()),
    () => sel(initial),
  );
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export function newChat(): string {
  const id = uid();
  const now = Date.now();
  setState((s) => ({
    ...s,
    activeChatId: id,
    chats: [
      { id, title: "New summary", createdAt: now, updatedAt: now, messages: [], sources: [] },
      ...s.chats,
    ],
  }));
  return id;
}

export function ensureChat(): string {
  const s = getState();
  if (s.activeChatId && s.chats.some((c) => c.id === s.activeChatId)) return s.activeChatId;
  return newChat();
}

export function updateChat(id: string, fn: (c: Chat) => Chat) {
  setState((s) => ({
    ...s,
    chats: s.chats.map((c) => (c.id === id ? { ...fn(c), updatedAt: Date.now() } : c)),
  }));
}

export function deleteChat(id: string) {
  setState((s) => ({
    ...s,
    chats: s.chats.filter((c) => c.id !== id),
    downloads: s.downloads.filter((d) => d.chatId !== id),
    activeChatId: s.activeChatId === id ? null : s.activeChatId,
  }));
}

export function updateSettings(p: Partial<Settings>) {
  setState((s) => ({ ...s, settings: { ...s.settings, ...p } }));
}
