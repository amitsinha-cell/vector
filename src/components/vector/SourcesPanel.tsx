import { Eye, FileCode, Github, Image as ImageIcon, Link2, Radio, Trash2 } from "lucide-react";
import { useState } from "react";
import { updateChat, useStore, type Source } from "@/lib/store";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const icons = { file: FileCode, github: Github, link: Link2, image: ImageIcon, watch: Radio };
const labels = { file: "File", github: "GitHub", link: "Link", image: "Image", watch: "Watching" };

export function SourcesPanel() {
  const chat = useStore((s) => s.chats.find((c) => c.id === s.activeChatId));
  const [preview, setPreview] = useState<Source | null>(null);
  const sources = chat?.sources ?? [];

  return (
    <aside className="flex h-full w-full flex-col bg-panel">
      <div className="flex items-center justify-between px-4 pb-3 pt-4">
        <h2 className="text-sm font-semibold">Inputs</h2>
        <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground">{sources.length}</span>
      </div>
      <div className="flex-1 space-y-1.5 overflow-y-auto px-3 pb-3">
        {sources.length === 0 && (
          <div className="mt-8 rounded-xl border border-dashed p-6 text-center text-xs text-muted-foreground">
            Files, repositories, links and images you add with <span className="font-mono text-foreground">+</span> will be listed here.
          </div>
        )}
        {sources.map((s) => {
          const Icon = icons[s.kind];
          return (
            <div key={s.id} className="group rounded-xl border bg-card p-3">
              <div className="flex items-start gap-2.5">
                <div className="rounded-lg bg-accent p-1.5"><Icon className="h-4 w-4 text-primary" /></div>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-xs font-medium">{s.name}</p>
                  <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    {s.kind === "watch" && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-chart-2" />}
                    {labels[s.kind]}
                    {s.content && s.kind !== "image" && ` · ${s.content.split("\n").length} lines`}
                    {s.updatedAt && ` · updated ${new Date(s.updatedAt).toLocaleTimeString()}`}
                  </p>
                </div>
                <div className="flex gap-1 opacity-60 transition-opacity group-hover:opacity-100">
                  {s.content && <button onClick={() => setPreview(s)} aria-label="Preview"><Eye className="h-3.5 w-3.5" /></button>}
                  <button
                    aria-label="Remove input"
                    onClick={() => chat && updateChat(chat.id, (c) => ({ ...c, sources: c.sources.filter((x) => x.id !== s.id) }))}
                    className="hover:text-destructive"
                  ><Trash2 className="h-3.5 w-3.5" /></button>
                </div>
              </div>
              {s.kind === "image" && s.content && <img src={s.content} alt={s.name} className="mt-2 max-h-28 w-full rounded-md object-cover" />}
            </div>
          );
        })}
      </div>
      <Dialog open={!!preview} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader><DialogTitle className="font-mono text-sm">{preview?.name}</DialogTitle></DialogHeader>
          {preview?.kind === "image" ? (
            <img src={preview.content} alt={preview.name} className="max-h-[70vh] w-full object-contain" />
          ) : (
            <pre className="max-h-[70vh] overflow-auto rounded-lg bg-code p-4 font-mono text-xs">{preview?.content}</pre>
          )}
        </DialogContent>
      </Dialog>
    </aside>
  );
}
