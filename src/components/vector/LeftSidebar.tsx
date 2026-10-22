import { useMemo, useState } from "react";
import { Download, FileDown, MessageSquare, Plus, Search, Settings, Trash2, X } from "lucide-react";
import { Logo } from "./Logo";
import { deleteChat, newChat, setState, useStore } from "@/lib/store";
import { downloadChat } from "@/lib/download";
import { cn } from "@/lib/utils";

type Tab = "history" | "downloads";

export function LeftSidebar({ onOpenSettings, onNavigate }: { onOpenSettings: () => void; onNavigate?: () => void }) {
  const chats = useStore((s) => s.chats);
  const downloads = useStore((s) => s.downloads);
  const active = useStore((s) => s.activeChatId);
  const [tab, setTab] = useState<Tab>("history");
  const [q, setQ] = useState("");

  const results = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return chats.map((c) => ({ chat: c, snippet: "" }));
    return chats.flatMap((c) => {
      if (c.title.toLowerCase().includes(term)) return [{ chat: c, snippet: "" }];
      const hit = c.messages.find((m) => m.content.toLowerCase().includes(term)) ?? null;
      const src = c.sources.find((s) => s.name.toLowerCase().includes(term) || s.content?.toLowerCase().includes(term));
      if (hit) {
        const i = hit.content.toLowerCase().indexOf(term);
        return [{ chat: c, snippet: "…" + hit.content.slice(Math.max(0, i - 25), i + term.length + 35) + "…" }];
      }
      if (src) return [{ chat: c, snippet: `in ${src.name}` }];
      return [];
    });
  }, [chats, q]);

  const open = (id: string) => {
    setState((s) => ({ ...s, activeChatId: id }));
    onNavigate?.();
  };

  return (
    <aside className="flex h-full w-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-2.5 px-4 pb-3 pt-4">
        <Logo className="h-7 w-7" />
        <span className="text-lg font-semibold tracking-tight">vector</span>
      </div>
      <div className="px-3">
        <button
          onClick={() => { newChat(); onNavigate?.(); }}
          className="flex w-full items-center gap-2 rounded-lg border border-sidebar-border px-3 py-2 text-sm font-medium transition-colors hover:bg-sidebar-accent"
        >
          <Plus className="h-4 w-4" /> New summary
        </button>
        <label className="mt-2 flex items-center gap-2 rounded-lg bg-sidebar-accent px-3 py-2 text-sm">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => { setQ(e.target.value); setTab("history"); }}
            placeholder="Search by word…"
            className="w-full bg-transparent outline-none placeholder:text-muted-foreground"
          />
          {q && <button onClick={() => setQ("")} aria-label="Clear search"><X className="h-3.5 w-3.5" /></button>}
        </label>
        <div className="mt-3 grid grid-cols-2 gap-1 rounded-lg bg-sidebar-accent p-1 text-xs font-medium">
          {(["history", "downloads"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn("rounded-md py-1.5 transition-colors", tab === t ? "bg-background text-foreground shadow-sm" : "text-muted-foreground")}
            >
              {t === "history" ? "Past summaries" : `Downloads (${downloads.length})`}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-2 flex-1 overflow-y-auto px-2 pb-2">
        {tab === "history" ? (
          results.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">{q ? "No matches" : "No summaries yet"}</p>
          ) : (
            results.map(({ chat, snippet }) => (
              <div
                key={chat.id}
                className={cn(
                  "group flex cursor-pointer items-start gap-2 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-sidebar-accent",
                  active === chat.id && "bg-sidebar-accent",
                )}
                onClick={() => open(chat.id)}
              >
                <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate">{chat.title}</p>
                  {snippet && <p className="truncate font-mono text-[11px] text-muted-foreground">{snippet}</p>}
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); downloadChat(chat.id, "md"); }}
                  className="opacity-0 transition-opacity group-hover:opacity-100 text-muted-foreground hover:text-foreground"
                  aria-label="Download summary"
                ><Download className="h-3.5 w-3.5" /></button>
                <button
                  onClick={(e) => { e.stopPropagation(); deleteChat(chat.id); }}
                  className="opacity-0 transition-opacity group-hover:opacity-100 text-muted-foreground hover:text-destructive"
                  aria-label="Delete summary"
                ><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            ))
          )
        ) : downloads.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">Downloaded summaries appear here</p>
        ) : (
          downloads.map((d) => (
            <div key={d.id} className="group flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-sidebar-accent">
              <FileDown className="h-4 w-4 shrink-0 text-primary" />
              <button className="min-w-0 flex-1 text-left" onClick={() => open(d.chatId)}>
                <p className="truncate font-mono text-xs">{d.filename}</p>
                <p className="text-[11px] text-muted-foreground">{new Date(d.at).toLocaleString()}</p>
              </button>
              <button onClick={() => downloadChat(d.chatId, d.format, false)} aria-label="Download again" className="text-muted-foreground hover:text-foreground">
                <Download className="h-3.5 w-3.5" />
              </button>
            </div>
          ))
        )}
      </div>

      <div className="border-t border-sidebar-border p-2">
        <button onClick={onOpenSettings} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-sidebar-accent">
          <Settings className="h-4 w-4" /> Settings
        </button>
      </div>
    </aside>
  );
}
