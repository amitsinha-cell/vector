import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { DEFAULT_SYSTEM_PROMPT, setState, updateSettings, useStore } from "@/lib/store";
import { toast } from "sonner";

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const settings = useStore((s) => s.settings);
  const [prompt, setPrompt] = useState(settings.systemPrompt);
  const [endpoint, setEndpoint] = useState(settings.endpoint);
  useEffect(() => { if (open) { setPrompt(settings.systemPrompt); setEndpoint(settings.endpoint); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = () => {
    updateSettings({ systemPrompt: prompt.trim() || DEFAULT_SYSTEM_PROMPT, endpoint: endpoint.trim() || "http://localhost:11434" });
    toast.success("Settings saved");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Settings</DialogTitle></DialogHeader>
        <div className="space-y-5">
          <div className="flex items-center justify-between rounded-xl border p-3">
            <div className="flex items-center gap-2.5 text-sm">
              {settings.theme === "dark" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
              Dark mode
            </div>
            <Switch checked={settings.theme === "dark"} onCheckedChange={(c) => updateSettings({ theme: c ? "dark" : "light" })} />
          </div>
          <div>
            <label className="text-sm font-medium">System prompt</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={6}
              className="mt-1.5 w-full resize-y rounded-lg border bg-background p-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <button onClick={() => setPrompt(DEFAULT_SYSTEM_PROMPT)} className="mt-1 text-xs text-muted-foreground hover:text-foreground">Reset to default</button>
          </div>
          <div>
            <label className="text-sm font-medium">Local model server</label>
            <input
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              className="mt-1.5 w-full rounded-lg border bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <p className="mt-1 text-xs text-muted-foreground">Ollama-compatible API. Allow this site with OLLAMA_ORIGINS if requests are blocked.</p>
          </div>
          <button
            onClick={() => { if (confirm("Delete all summaries and downloads?")) { setState((s) => ({ ...s, chats: [], downloads: [], activeChatId: null })); toast("History cleared"); } }}
            className="text-xs text-destructive hover:underline"
          >Clear all history</button>
        </div>
        <DialogFooter>
          <button onClick={save} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">Save</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
