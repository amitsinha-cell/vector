import { useSyncExternalStore } from "react";

export type SourceKind = "file" | "github" | "link" | "image" | "watch";
export interface Source {
  id: string;
  kind: SourceKind;
  name: string;
  url?: string;
  content?: string; // text content or data URL for images
  size?: number;
  addedAt: number;
  updatedAt?: number;
}
export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  sourceIds?: string[];
  model?: string;
  error?: boolean;
  createdAt: number;
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
}
export interface State {
  chats: Chat[];
  activeChatId: string | null;
  downloads: Download[];
  settings: Settings;
}

const KEY = "vector-state-v1";
export const DEFAULT_SYSTEM_PROMPT =
  "You are Vector, an expert code summariser. Given source code, produce a concise, well-structured Markdown summary: purpose, key components, data flow, dependencies, and notable risks or TODOs.";

const initial: State = {
  chats: [],
  activeChatId: null,
  downloads: [],
  settings: { theme: "dark", systemPrompt: DEFAULT_SYSTEM_PROMPT, endpoint: "http://localhost:11434", model: "" },
};

let state: State = initial;
let loaded = false;
const listeners = new Set<() => void>();

function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw);
      state = { ...initial, ...p, settings: { ...initial.settings, ...p.settings } };
    }
  } catch {
    /* ignore corrupt state */
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
    chats: [{ id, title: "New summary", createdAt: now, updatedAt: now, messages: [], sources: [] }, ...s.chats],
  }));
  return id;
}

export function ensureChat(): string {
  const s = getState();
  if (s.activeChatId && s.chats.some((c) => c.id === s.activeChatId)) return s.activeChatId;
  return newChat();
}

export function updateChat(id: string, fn: (c: Chat) => Chat) {
  setState((s) => ({ ...s, chats: s.chats.map((c) => (c.id === id ? { ...fn(c), updatedAt: Date.now() } : c)) }));
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
