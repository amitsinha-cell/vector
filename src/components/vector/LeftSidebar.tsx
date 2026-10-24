import { useEffect, useState } from "react";
import {
  Download,
  FileDown,
  Loader2,
  MessageSquare,
  Plus,
  Search,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Logo } from "./Logo";
import { deleteChat, newChat, setState, uid, useStore } from "@/lib/store";
import {
  deleteSummary,
  exportSummary,
  fetchHistory,
  fetchSummaryById,
  searchSummaries,
  type HistoryEntry,
} from "@/lib/api";
import { downloadChat } from "@/lib/download";
import { cn } from "@/lib/utils";

type Tab = "history" | "downloads";

export function LeftSidebar({
  onOpenSettings,
  onNavigate,
}: {
  onOpenSettings: () => void;
  onNavigate?: () => void;
}) {
  const chats = useStore((s) => s.chats);
  const downloads = useStore((s) => s.downloads);
  const active = useStore((s) => s.activeChatId);
  const [tab, setTab] = useState<Tab>("history");
  const [q, setQ] = useState("");

  // Backend history & search state
  const [backendHistory, setBackendHistory] = useState<HistoryEntry[]>([]);
  const [searchResults, setSearchResults] = useState<HistoryEntry[] | null>(null);
  const [loading, setLoading] = useState(false);

  // Load history from backend
  const loadHistory = async () => {
    try {
      const data = await fetchHistory(50, 0);
      setBackendHistory(data);
    } catch {
      // Backend may be offline, local chats still work
    }
  };

  useEffect(() => {
    loadHistory();
  }, [chats.length]);

  // Debounced search via GET /search?q=
  useEffect(() => {
    const term = q.trim();
    if (!term) {
      setSearchResults(null);
      return;
    }

    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const results = await searchSummaries(term);
        setSearchResults(results);
      } catch {
        // Fallback to local search
        const localMatches = chats
          .filter(
            (c) =>
              c.title.toLowerCase().includes(term.toLowerCase()) ||
              c.messages.some((m) => m.content.toLowerCase().includes(term.toLowerCase())),
          )
          .map((c) => ({
            id: 0,
            source_type: "file",
            source_ref: c.title,
            file_path: null,
            model: "local",
            provider: "ollama",
            cached: false,
            created_at: new Date(c.createdAt).toISOString(),
            tldr: c.messages[0]?.content || c.title,
          }));
        setSearchResults(localMatches);
      } finally {
        setLoading(false);
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [q, chats]);

  const openLocal = (id: string) => {
    setState((s) => ({ ...s, activeChatId: id }));
    onNavigate?.();
  };

  const openBackendSummary = async (entry: HistoryEntry) => {
    try {
      const full = await fetchSummaryById(entry.id);
      if (!full) return;

      // If server already knows it's unreadable, show toast and stop
      if (full.status === "unreadable") {
        toast.error(`Summary #${entry.id} is unreadable: ${full.error || "corrupted data"}`);
        return;
      }

      // Check if already in open chats
      const existing = chats.find((c) => c.title === entry.source_ref);
      if (existing) {
        openLocal(existing.id);
        return;
      }

      const summaryData = full.summary;
      const entryKind = full.kind || entry.kind || entry.source_type;

      // Build the message based on kind
      const newId = uid();
      const now = Date.now();

      type MsgType = Parameters<typeof setState>[0] extends (
        s: import("@/lib/store").State,
      ) => import("@/lib/store").State
        ? never
        : never;

      let summaryResult: import("@/lib/api").SummaryResult | null = null;
      let repoResult: import("@/lib/api").RepoOverviewData | null = null;
      let projectResult: import("@/lib/api").ProjectOverviewData | null = null;

      if (entryKind === "project") {
        projectResult = summaryData as import("@/lib/api").ProjectOverviewData;
      } else if (entryKind === "repo") {
        repoResult = summaryData as import("@/lib/api").RepoOverviewData;
      } else {
        // file or project_file — treat as file summary
        summaryResult = summaryData
          ? {
              id: full.id,
              summary: summaryData as import("@/lib/api").FileSummaryData,
              cached: full.cached,
              model: full.model,
              provider: full.provider,
            }
          : null;
      }

      setState((s) => ({
        ...s,
        activeChatId: newId,
        chats: [
          {
            id: newId,
            title: entry.source_ref || "Summary",
            createdAt: now,
            updatedAt: now,
            sources: [
              {
                id: uid(),
                kind: entryKind === "project" ? "folder" : entryKind === "repo" ? "github" : "file",
                name: entry.source_ref || "file",
                content: "",
                addedAt: now,
              },
            ],
            messages: [
              {
                id: uid(),
                role: "assistant",
                content: entry.tldr || "",
                model: full.model,
                provider: full.provider,
                summaryResult,
                repoResult,
                projectResult,
                createdAt: now,
              },
            ],
          },
          ...s.chats,
        ],
      }));
      onNavigate?.();
    } catch (err: unknown) {
      toast.error(`Could not load summary: ${(err as Error).message}`);
    }
  };

  const handleDelete = async (e: React.MouseEvent, id: number, localChatId?: string) => {
    e.stopPropagation();
    try {
      if (id > 0) {
        await deleteSummary(id);
        setBackendHistory((prev) => prev.filter((item) => item.id !== id));
      }
      if (localChatId) {
        deleteChat(localChatId);
      }
      toast.success("Summary deleted");
    } catch {
      toast.error("Failed to delete summary");
    }
  };

  const handleExport = async (
    e: React.MouseEvent,
    id: number,
    localChatId?: string,
    title?: string,
  ) => {
    e.stopPropagation();
    if (id > 0) {
      try {
        const { content, filename } = await exportSummary(id, "md");
        const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename || "summary.md";
        a.click();
        URL.revokeObjectURL(url);
        toast.success("Summary exported (.md)");
        return;
      } catch {
        // Fall back to local export
      }
    }
    if (localChatId) {
      downloadChat(localChatId, "md");
    }
  };

  // Determine items to display
  const displayItems =
    searchResults !== null
      ? searchResults
      : backendHistory.length > 0
        ? backendHistory
        : chats.map((c) => ({
            id: 0,
            source_type: "file",
            source_ref: c.title,
            file_path: null,
            model: c.messages[0]?.model || "local",
            provider: "ollama",
            cached: false,
            created_at: new Date(c.createdAt).toLocaleDateString(),
            tldr: c.messages[0]?.content || "",
            _localChatId: c.id,
          }));

  return (
    <aside className="flex h-full w-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-2.5 px-4 pb-3 pt-4">
        <Logo className="h-7 w-7" />
        <span className="text-lg font-semibold tracking-tight">vector</span>
      </div>
      <div className="px-3">
        <button
          onClick={() => {
            newChat();
            onNavigate?.();
          }}
          className="flex w-full items-center gap-2 rounded-lg border border-sidebar-border px-3 py-2 text-sm font-medium transition-colors hover:bg-sidebar-accent"
        >
          <Plus className="h-4 w-4" /> New summary
        </button>
        <label className="mt-2 flex items-center gap-2 rounded-lg bg-sidebar-accent px-3 py-2 text-sm">
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : (
            <Search className="h-4 w-4 text-muted-foreground" />
          )}
          <input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setTab("history");
            }}
            placeholder="Search summaries (FTS5)…"
            className="w-full bg-transparent outline-none placeholder:text-muted-foreground text-xs"
          />
          {q && (
            <button onClick={() => setQ("")} aria-label="Clear search">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </label>
        <div className="mt-3 grid grid-cols-2 gap-1 rounded-lg bg-sidebar-accent p-1 text-xs font-medium">
          {(["history", "downloads"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                "rounded-md py-1.5 transition-colors",
                tab === t ? "bg-background text-foreground shadow-sm" : "text-muted-foreground",
              )}
            >
              {t === "history" ? "Past summaries" : `Downloads (${downloads.length})`}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-2 flex-1 overflow-y-auto px-2 pb-2">
        {tab === "history" ? (
          displayItems.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              {q ? `No summaries matching "${q}"` : "No summaries yet"}
            </p>
          ) : (
            displayItems.map((item: HistoryEntry & { _localChatId?: string }) => {
              const localChat = chats.find(
                (c) => c.title === item.source_ref || c.id === item._localChatId,
              );
              const isActive = active && localChat && active === localChat.id;
              return (
                <div
                  key={item.id ? `b-${item.id}` : `l-${item._localChatId}`}
                  className={cn(
                    "group flex cursor-pointer items-start gap-2 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-sidebar-accent",
                    isActive && "bg-sidebar-accent",
                  )}
                  onClick={() => {
                    if (localChat) openLocal(localChat.id);
                    else openBackendSummary(item);
                  }}
                >
                  <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium">
                      {item.source_ref || "Untitled summary"}
                    </p>
                    {item.tldr && (
                      <p className="truncate font-mono text-[11px] text-muted-foreground">
                        {item.tldr}
                      </p>
                    )}
                  </div>
                  <button
                    onClick={(e) => handleExport(e, item.id, localChat?.id, item.source_ref)}
                    className="opacity-0 transition-opacity group-hover:opacity-100 text-muted-foreground hover:text-foreground"
                    aria-label="Download summary (.md)"
                    title="Export as Markdown"
                  >
                    <Download className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={(e) => handleDelete(e, item.id, localChat?.id)}
                    className="opacity-0 transition-opacity group-hover:opacity-100 text-muted-foreground hover:text-destructive"
                    aria-label="Delete summary"
                    title="Delete summary"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })
          )
        ) : downloads.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            Downloaded summaries appear here
          </p>
        ) : (
          downloads.map((d) => (
            <div
              key={d.id}
              className="group flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-sidebar-accent"
            >
              <FileDown className="h-4 w-4 shrink-0 text-primary" />
              <button className="min-w-0 flex-1 text-left" onClick={() => openLocal(d.chatId)}>
                <p className="truncate font-mono text-xs">{d.filename}</p>
                <p className="text-[11px] text-muted-foreground">
                  {new Date(d.at).toLocaleString()}
                </p>
              </button>
              <button
                onClick={() => downloadChat(d.chatId, d.format, false)}
                aria-label="Download again"
                className="text-muted-foreground hover:text-foreground"
              >
                <Download className="h-3.5 w-3.5" />
              </button>
            </div>
          ))
        )}
      </div>

      <div className="border-t border-sidebar-border p-2">
        <button
          onClick={onOpenSettings}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-sidebar-accent"
        >
          <Settings className="h-4 w-4" /> Settings
        </button>
      </div>
    </aside>
  );
}
