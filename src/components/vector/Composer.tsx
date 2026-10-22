import { useEffect, useRef, useState } from "react";
import { ArrowUp, ChevronDown, FileCode, Github, Image as ImageIcon, Link2, Loader2, Plus, Radio, RefreshCw, Square, X } from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ensureChat, getState, uid, updateChat, updateSettings, useStore, type Source } from "@/lib/store";
import { fetchGitHub, listModels, type LocalModel } from "@/lib/models";
import { cn } from "@/lib/utils";

const watchers = new Map<string, number>();

function addSource(src: Omit<Source, "id" | "addedAt">): string {
  const chatId = ensureChat();
  const id = uid();
  updateChat(chatId, (c) => ({ ...c, sources: [...c.sources, { ...src, id, addedAt: Date.now() }] }));
  return id;
}

const readFile = (f: File, asData: boolean) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = () => rej(r.error);
    if (asData) r.readAsDataURL(f); else r.readAsText(f);
  });

export function Composer({ busy, onSend, onStop }: { busy: boolean; onSend: (text: string, ids: string[]) => void; onStop: () => void }) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState<string[]>([]);
  const [linkMode, setLinkMode] = useState<null | "github" | "link">(null);
  const [linkVal, setLinkVal] = useState("");
  const [linkBusy, setLinkBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const imgRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const chat = useStore((s) => s.chats.find((c) => c.id === s.activeChatId));
  const { endpoint, model } = useStore((s) => s.settings);
  const [models, setModels] = useState<LocalModel[]>([]);
  const [modelErr, setModelErr] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);

  const refreshModels = async () => {
    setLoadingModels(true);
    try {
      const m = await listModels(endpoint);
      setModels(m);
      setModelErr(null);
      if (m.length && !m.some((x) => x.name === getState().settings.model)) updateSettings({ model: m[0].name });
    } catch {
      setModelErr(`Can't reach local model server at ${endpoint}`);
    } finally {
      setLoadingModels(false);
    }
  };
  useEffect(() => { refreshModels(); }, [endpoint]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const ta = taRef.current;
    if (ta) { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 220) + "px"; }
  }, [text]);

  const pendingSources = (chat?.sources ?? []).filter((s) => pending.includes(s.id));

  const onFiles = async (files: FileList | null, image: boolean) => {
    if (!files) return;
    const ids: string[] = [];
    for (const f of Array.from(files)) {
      if (f.size > 2_000_000) { toast.error(`${f.name} is larger than 2 MB`); continue; }
      const content = await readFile(f, image);
      ids.push(addSource({ kind: image ? "image" : "file", name: f.name, size: f.size, content }));
    }
    setPending((p) => [...p, ...ids]);
  };

  const watchFile = async () => {
    const w = window as unknown as { showOpenFilePicker?: () => Promise<FileSystemFileHandle[]> };
    if (!w.showOpenFilePicker) { toast.error("File watching needs a Chromium-based browser"); return; }
    try {
      const [handle] = await w.showOpenFilePicker();
      let file = await handle.getFile();
      const id = addSource({ kind: "watch", name: file.name, size: file.size, content: await file.text() });
      const chatId = getState().activeChatId!;
      let last = file.lastModified;
      const t = window.setInterval(async () => {
        try {
          file = await handle.getFile();
          if (file.lastModified !== last) {
            last = file.lastModified;
            const content = await file.text();
            updateChat(chatId, (c) => ({ ...c, sources: c.sources.map((s) => (s.id === id ? { ...s, content, size: file.size, updatedAt: Date.now() } : s)) }));
            toast(`${file.name} changed`, { description: "Watched input updated" });
          }
        } catch { window.clearInterval(t); watchers.delete(id); }
      }, 2000);
      watchers.set(id, t);
      setPending((p) => [...p, id]);
    } catch { /* cancelled */ }
  };

  const submitLink = async () => {
    const v = linkVal.trim();
    try { new URL(v); } catch { toast.error("Enter a valid URL"); return; }
    setLinkBusy(true);
    try {
      if (linkMode === "github") {
        const { name, content } = await fetchGitHub(v);
        if (!content) throw new Error("No readable code files found");
        setPending((p) => [...p, addSource({ kind: "github", name, url: v, content })]);
      } else {
        let content: string | undefined;
        try { const r = await fetch(v); if (r.ok) content = (await r.text()).slice(0, 200000); } catch { /* CORS — keep as reference */ }
        setPending((p) => [...p, addSource({ kind: "link", name: new URL(v).hostname + new URL(v).pathname, url: v, content })]);
      }
      setLinkMode(null); setLinkVal("");
    } catch (e) {
      toast.error((e as Error).message);
    } finally { setLinkBusy(false); }
  };

  const send = () => {
    if (busy) return;
    if (!text.trim() && pending.length === 0) return;
    if (!model) { toast.error("Select a local model first"); return; }
    onSend(text.trim(), pending);
    setText(""); setPending([]);
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-3 pb-3 sm:px-4 sm:pb-4">
      <div className="rounded-3xl border bg-composer p-2 shadow-composer">
        {pendingSources.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-2 pb-2 pt-1">
            {pendingSources.map((s) => (
              <span key={s.id} className="flex items-center gap-1.5 rounded-lg bg-accent px-2 py-1 font-mono text-[11px]">
                {s.kind === "image" ? <ImageIcon className="h-3 w-3" /> : s.kind === "github" ? <Github className="h-3 w-3" /> : <FileCode className="h-3 w-3" />}
                <span className="max-w-40 truncate">{s.name}</span>
                <button onClick={() => setPending((p) => p.filter((x) => x !== s.id))} aria-label="Detach"><X className="h-3 w-3" /></button>
              </span>
            ))}
          </div>
        )}
        <div className="flex items-end gap-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border transition-colors hover:bg-accent" aria-label="Add input">
                <Plus className="h-4.5 w-4.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top" className="w-56">
              <DropdownMenuLabel className="text-xs text-muted-foreground">Add input</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => fileRef.current?.click()}><FileCode className="h-4 w-4" /> Upload code files</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setLinkMode("github")}><Github className="h-4 w-4" /> GitHub repo or file</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => watchFile()}><Radio className="h-4 w-4" /> Watch a local file</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setLinkMode("link")}><Link2 className="h-4 w-4" /> Add a link</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => imgRef.current?.click()}><ImageIcon className="h-4 w-4" /> Add photos</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <textarea
            ref={taRef}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); onFiles(e.clipboardData.files, e.clipboardData.files[0].type.startsWith("image/")); } }}
            placeholder="Paste code or ask Vector to summarise your inputs…"
            className="max-h-56 min-h-9 flex-1 resize-none bg-transparent px-1 py-2 text-[15px] outline-none placeholder:text-muted-foreground"
          />
          {busy ? (
            <button onClick={onStop} className="mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-foreground text-background" aria-label="Stop">
              <Square className="h-3.5 w-3.5 fill-current" />
            </button>
          ) : (
            <button
              onClick={send}
              disabled={!text.trim() && pending.length === 0}
              className="mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity disabled:opacity-30"
              aria-label="Send"
            ><ArrowUp className="h-4.5 w-4.5" /></button>
          )}
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2 px-2 text-xs text-muted-foreground">
        <DropdownMenu onOpenChange={(o) => o && refreshModels()}>
          <DropdownMenuTrigger asChild>
            <button className={cn("flex items-center gap-1.5 rounded-lg px-2 py-1 font-mono hover:bg-accent", modelErr && "text-destructive")}>
              <span className={cn("h-1.5 w-1.5 rounded-full", modelErr ? "bg-destructive" : "bg-chart-2")} />
              {model || (modelErr ? "Model server offline" : "Select model")}
              <ChevronDown className="h-3 w-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-64">
            <DropdownMenuLabel className="flex items-center justify-between text-xs">
              Local models
              {loadingModels ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            </DropdownMenuLabel>
            {modelErr && <p className="px-2 py-1.5 text-xs text-destructive">{modelErr}. Start Ollama or change the endpoint in Settings.</p>}
            {models.map((m) => (
              <DropdownMenuItem key={m.name} onSelect={() => updateSettings({ model: m.name })} className="font-mono text-xs">
                <span className="flex-1">{m.name}</span>
                {m.size && <span className="text-muted-foreground">{(m.size / 1e9).toFixed(1)} GB</span>}
                {m.name === model && <span className="text-primary">●</span>}
              </DropdownMenuItem>
            ))}
            {!modelErr && models.length === 0 && !loadingModels && <p className="px-2 py-1.5 text-xs">No models installed</p>}
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="hidden sm:inline">Runs locally · nothing leaves your machine</span>
      </div>

      <input ref={fileRef} type="file" multiple hidden onChange={(e) => { onFiles(e.target.files, false); e.target.value = ""; }} />
      <input ref={imgRef} type="file" accept="image/*" multiple hidden onChange={(e) => { onFiles(e.target.files, true); e.target.value = ""; }} />

      <Dialog open={!!linkMode} onOpenChange={(o) => !o && setLinkMode(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{linkMode === "github" ? "Add GitHub repository or file" : "Add a link"}</DialogTitle></DialogHeader>
          <input
            autoFocus
            value={linkVal}
            onChange={(e) => setLinkVal(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitLink()}
            placeholder={linkMode === "github" ? "https://github.com/owner/repo" : "https://…"}
            className="w-full rounded-lg border bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          {linkMode === "github" && <p className="text-xs text-muted-foreground">Public repos, folders (/tree/…) and single files (/blob/…). Up to 25 code files are fetched.</p>}
          <DialogFooter>
            <button onClick={submitLink} disabled={linkBusy} className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
              {linkBusy && <Loader2 className="h-4 w-4 animate-spin" />} Add
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
