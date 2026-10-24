import { useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Eye,
  FileCode,
  Folder,
  FolderSync,
  Github,
  Image as ImageIcon,
  Link2,
  Loader2,
  Plus,
  Radio,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { updateChat, useStore, type Source } from "@/lib/store";
import { addWatch, listWatches, removeWatch, type WatchInfo } from "@/lib/api";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const icons = {
  file: FileCode,
  github: Github,
  link: Link2,
  image: ImageIcon,
  watch: Radio,
  folder: Folder,
};
const labels = {
  file: "File",
  github: "GitHub",
  link: "Link",
  image: "Image",
  watch: "Watching",
  folder: "Folder",
};

export function SourcesPanel() {
  const chat = useStore((s) => s.chats.find((c) => c.id === s.activeChatId));
  const [preview, setPreview] = useState<Source | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});
  const sources = chat?.sources ?? [];

  // Watched folders state
  const [watches, setWatches] = useState<WatchInfo[]>([]);
  const [loadingWatches, setLoadingWatches] = useState(false);
  const [showAddWatch, setShowAddWatch] = useState(false);
  const [watchInput, setWatchInput] = useState("");
  const [addingWatch, setAddingWatch] = useState(false);

  const loadWatches = async () => {
    setLoadingWatches(true);
    try {
      const data = await listWatches();
      setWatches(data);
    } catch {
      // Backend might be offline
    } finally {
      setLoadingWatches(false);
    }
  };

  useEffect(() => {
    loadWatches();
  }, []);

  const handleAddWatch = async () => {
    const p = watchInput.trim();
    if (!p) return;
    setAddingWatch(true);
    try {
      const created = await addWatch(p);
      setWatches((prev) => [...prev.filter((w) => w.id !== created.id), created]);
      setWatchInput("");
      setShowAddWatch(false);
      toast.success("Folder added to watch list");
    } catch (err: unknown) {
      toast.error((err as Error).message || "Failed to watch folder");
    } finally {
      setAddingWatch(false);
    }
  };

  const handleRemoveWatch = async (id: number) => {
    try {
      await removeWatch(id);
      setWatches((prev) => prev.filter((w) => w.id !== id));
      toast.success("Watch removed");
    } catch (err: unknown) {
      toast.error((err as Error).message || "Failed to remove watch");
    }
  };

  return (
    <aside className="flex h-full w-full flex-col bg-panel">
      {/* Inputs header */}
      <div className="flex items-center justify-between px-4 pb-3 pt-4">
        <h2 className="text-sm font-semibold">Inputs</h2>
        <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
          {sources.length}
        </span>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-3 pb-3">
        {/* Active chat sources */}
        <div className="space-y-1.5">
          {sources.length === 0 && (
            <div className="rounded-xl border border-dashed p-4 text-center text-xs text-muted-foreground">
              Files, repositories, links and images you add with{" "}
              <span className="font-mono text-foreground">+</span> will be listed here.
            </div>
          )}
          {sources.map((s) => {
            const Icon = icons[s.kind];

            if (s.kind === "folder") {
              const isExpanded = !!expandedFolders[s.id];
              const fileCount = s.folderFiles?.length ?? 0;
              const formattedKb = s.size ? `${Math.round(s.size / 1024)} KB` : "";
              return (
                <div key={s.id} className="group rounded-xl border bg-card p-3 shadow-sm">
                  <div className="flex items-start gap-2.5">
                    <button
                      onClick={() =>
                        setExpandedFolders((prev) => ({ ...prev, [s.id]: !prev[s.id] }))
                      }
                      className="rounded-lg bg-accent p-1.5 hover:bg-accent/80 transition-colors"
                      title={isExpanded ? "Collapse folder tree" : "Expand folder tree"}
                    >
                      <Folder className="h-4 w-4 text-primary" />
                    </button>
                    <div
                      className="min-w-0 flex-1 cursor-pointer"
                      onClick={() =>
                        setExpandedFolders((prev) => ({ ...prev, [s.id]: !prev[s.id] }))
                      }
                    >
                      <div className="flex items-center gap-1.5">
                        <p className="truncate font-mono text-xs font-medium">{s.name}</p>
                        {isExpanded ? (
                          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        )}
                      </div>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        Folder · {fileCount} files {formattedKb ? `(${formattedKb})` : ""}
                      </p>
                    </div>
                    <div className="flex gap-1 opacity-60 transition-opacity group-hover:opacity-100">
                      <button
                        aria-label="Remove folder"
                        onClick={() =>
                          chat &&
                          updateChat(chat.id, (c) => ({
                            ...c,
                            sources: c.sources.filter((x) => x.id !== s.id),
                          }))
                        }
                        className="hover:text-destructive p-1 rounded"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* Collapsible tree view / files list */}
                  {isExpanded && s.folderFiles && s.folderFiles.length > 0 && (
                    <div className="mt-2.5 border-t pt-2 max-h-48 overflow-y-auto space-y-1 pr-1 font-mono text-[11px]">
                      {s.folderFiles.map((f) => (
                        <div
                          key={f.path}
                          className="flex items-center justify-between rounded px-1.5 py-0.5 hover:bg-accent/50 text-muted-foreground hover:text-foreground"
                        >
                          <span className="truncate pr-2">{f.path}</span>
                          <span className="shrink-0 text-[10px] opacity-75">{f.language}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            }
            return (
              <div key={s.id} className="group rounded-xl border bg-card p-3 shadow-sm">
                <div className="flex items-start gap-2.5">
                  <div className="rounded-lg bg-accent p-1.5">
                    <Icon className="h-4 w-4 text-primary" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-xs font-medium">{s.name}</p>
                    <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      {s.kind === "watch" && (
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-chart-2" />
                      )}
                      {labels[s.kind]}
                      {s.content &&
                        s.kind !== "image" &&
                        ` · ${s.content.split("\n").length} lines`}
                      {s.updatedAt && ` · updated ${new Date(s.updatedAt).toLocaleTimeString()}`}
                    </p>
                  </div>
                  <div className="flex gap-1 opacity-60 transition-opacity group-hover:opacity-100">
                    {s.content && (
                      <button onClick={() => setPreview(s)} aria-label="Preview">
                        <Eye className="h-3.5 w-3.5" />
                      </button>
                    )}
                    <button
                      aria-label="Remove input"
                      onClick={() =>
                        chat &&
                        updateChat(chat.id, (c) => ({
                          ...c,
                          sources: c.sources.filter((x) => x.id !== s.id),
                        }))
                      }
                      className="hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                {s.kind === "image" && s.content && (
                  <img
                    src={s.content}
                    alt={s.name}
                    className="mt-2 max-h-28 w-full rounded-md object-cover"
                  />
                )}
              </div>
            );
          })}
        </div>

        {/* Watched folders section */}
        <div className="border-t pt-4">
          <div className="flex items-center justify-between pb-2">
            <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <FolderSync className="h-3.5 w-3.5 text-primary" />
              Watched Folders
            </div>
            <button
              onClick={() => setShowAddWatch((v) => !v)}
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-primary hover:bg-accent"
              title="Add folder by absolute path"
            >
              <Plus className="h-3.5 w-3.5" />
              Add
            </button>
          </div>

          {showAddWatch && (
            <div className="mb-2 rounded-xl border bg-background p-2.5 shadow-sm space-y-2">
              <label className="text-[11px] text-muted-foreground block">
                Type absolute folder path on your machine:
              </label>
              <input
                value={watchInput}
                onChange={(e) => setWatchInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddWatch()}
                placeholder="e.g. C:\projects\my-app"
                className="w-full rounded-lg border bg-background px-2.5 py-1.5 font-mono text-xs outline-none focus:ring-1 focus:ring-ring"
              />
              <div className="flex justify-end gap-1.5">
                <button
                  onClick={() => setShowAddWatch(false)}
                  className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
                >
                  Cancel
                </button>
                <button
                  onClick={handleAddWatch}
                  disabled={addingWatch || !watchInput.trim()}
                  className="flex items-center gap-1 rounded bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
                >
                  {addingWatch && <Loader2 className="h-3 w-3 animate-spin" />}
                  Watch
                </button>
              </div>
            </div>
          )}

          {watches.length === 0 ? (
            <div className="rounded-xl border border-dashed p-3 text-center text-xs text-muted-foreground">
              No watched folders yet. Watch folders to automatically summarise modified code.
            </div>
          ) : (
            <div className="space-y-1.5">
              {watches.map((w) => (
                <div key={w.id} className="group rounded-xl border bg-card p-2.5 shadow-sm">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p
                        className="truncate font-mono text-xs font-medium text-foreground"
                        title={w.path}
                      >
                        {w.path}
                      </p>
                      <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <span className="flex items-center gap-1 text-chart-2">
                          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-chart-2" />
                          {w.active ? "watching" : "paused"}
                        </span>
                        {w.last_summarised && (
                          <span>· {new Date(w.last_summarised).toLocaleTimeString()}</span>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={() => handleRemoveWatch(w.id)}
                      className="opacity-60 transition-opacity group-hover:opacity-100 hover:text-destructive"
                      aria-label="Remove watch"
                      title="Stop watching folder"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <Dialog open={!!preview} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">{preview?.name}</DialogTitle>
          </DialogHeader>
          {preview?.kind === "image" ? (
            <img
              src={preview.content}
              alt={preview.name}
              className="max-h-[70vh] w-full object-contain"
            />
          ) : (
            <pre className="max-h-[70vh] overflow-auto rounded-lg bg-code p-4 font-mono text-xs">
              {preview?.content}
            </pre>
          )}
        </DialogContent>
      </Dialog>
    </aside>
  );
}
