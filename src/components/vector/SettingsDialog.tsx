import { useEffect, useState } from "react";
import { AlertTriangle, Cloud, Moon, Sun } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import {
  DEFAULT_SYSTEM_PROMPT,
  setState,
  updateSettings as updateStoreSettings,
  useStore,
} from "@/lib/store";
import { fetchSettings, updateSettings as updateBackendSettings } from "@/lib/api";

export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const settings = useStore((s) => s.settings);
  const [prompt, setPrompt] = useState(settings.systemPrompt);
  const [defaultModel, setDefaultModel] = useState(settings.model);
  const [numCtx, setNumCtx] = useState(settings.numCtx || 8192);

  // Hosted settings
  const [hostedEnabled, setHostedEnabled] = useState(settings.hostedEnabled);
  const [hostedBaseUrl, setHostedBaseUrl] = useState(settings.hostedBaseUrl || "");
  const [hostedApiKey, setHostedApiKey] = useState("");
  const [hostedKeySet, setHostedKeySet] = useState(false);

  // Confirmation dialog for enabling hosted model
  const [showConfirmHosted, setShowConfirmHosted] = useState(false);

  useEffect(() => {
    if (open) {
      setPrompt(settings.systemPrompt);
      setDefaultModel(settings.model);
      setNumCtx(settings.numCtx || 8192);
      setHostedEnabled(settings.hostedEnabled);
      setHostedBaseUrl(settings.hostedBaseUrl);

      // Load settings from backend
      fetchSettings()
        .then((data) => {
          if (data.system_prompt) setPrompt(data.system_prompt);
          if (data.default_model) setDefaultModel(data.default_model);
          if (data.num_ctx) setNumCtx(parseInt(data.num_ctx, 10) || 8192);
          setHostedEnabled(Boolean(data.hosted_enabled));
          setHostedBaseUrl(data.hosted_base_url || "");
          setHostedKeySet(Boolean(data.hosted_api_key_set));
        })
        .catch(() => {
          // backend offline or unreachable
        });
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleToggleHosted = (checked: boolean) => {
    if (checked) {
      // Require explicit confirmation before turning ON
      setShowConfirmHosted(true);
    } else {
      setHostedEnabled(false);
    }
  };

  const handleConfirmHosted = () => {
    setHostedEnabled(true);
    setShowConfirmHosted(false);
  };

  const save = async () => {
    const finalPrompt = prompt.trim() || DEFAULT_SYSTEM_PROMPT;
    const finalNumCtx = Number(numCtx) || 8192;

    // 1. Update store
    updateStoreSettings({
      systemPrompt: finalPrompt,
      model: defaultModel.trim(),
      numCtx: finalNumCtx,
      hostedEnabled,
      hostedBaseUrl: hostedBaseUrl.trim(),
    });

    // 2. Persist to backend
    try {
      const payload: Record<string, string | number | boolean> = {
        system_prompt: finalPrompt,
        default_model: defaultModel.trim(),
        num_ctx: finalNumCtx,
        hosted_enabled: hostedEnabled,
        hosted_base_url: hostedBaseUrl.trim(),
      };
      if (hostedApiKey.trim()) {
        payload["hosted_api_key"] = hostedApiKey.trim();
      }
      await updateBackendSettings(payload);
    } catch {
      // Ignore if backend not running
    }

    toast.success("Settings saved");
    onOpenChange(false);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Settings</DialogTitle>
          </DialogHeader>
          <div className="space-y-5">
            {/* Theme */}
            <div className="flex items-center justify-between rounded-xl border p-3">
              <div className="flex items-center gap-2.5 text-sm">
                {settings.theme === "dark" ? (
                  <Moon className="h-4 w-4" />
                ) : (
                  <Sun className="h-4 w-4" />
                )}
                Dark mode
              </div>
              <Switch
                checked={settings.theme === "dark"}
                onCheckedChange={(c) => updateStoreSettings({ theme: c ? "dark" : "light" })}
              />
            </div>

            {/* System prompt */}
            <div>
              <label className="text-sm font-medium">System prompt</label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={4}
                className="mt-1.5 w-full resize-y rounded-lg border bg-background p-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
              <button
                onClick={() => setPrompt(DEFAULT_SYSTEM_PROMPT)}
                className="mt-1 text-xs text-muted-foreground hover:text-foreground"
              >
                Reset to default
              </button>
            </div>

            {/* Default Model */}
            <div>
              <label className="text-sm font-medium">Default model</label>
              <input
                value={defaultModel}
                onChange={(e) => setDefaultModel(e.target.value)}
                placeholder="e.g. gemma4:e4b"
                className="mt-1.5 w-full rounded-lg border bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Default model used for code summarisation.
              </p>
            </div>

            {/* Context Size (num_ctx) */}
            <div>
              <label className="text-sm font-medium">Context window (tokens)</label>
              <input
                type="number"
                value={numCtx}
                onChange={(e) => setNumCtx(parseInt(e.target.value, 10) || 8192)}
                className="mt-1.5 w-full rounded-lg border bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Default 8192 for laptop GPU target (RTX 4050 6GB).
              </p>
            </div>

            {/* Hosted Fallback Toggle */}
            <div className="rounded-xl border p-3 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Cloud className="h-4 w-4 text-primary" />
                    Hosted model fallback
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {hostedEnabled
                      ? "Cloud fallback enabled when Ollama is unavailable."
                      : "100% offline. Code never leaves your machine."}
                  </p>
                </div>
                <Switch checked={hostedEnabled} onCheckedChange={handleToggleHosted} />
              </div>

              {hostedEnabled && (
                <div className="border-t pt-3 space-y-3">
                  <div>
                    <label className="text-xs font-medium">Base URL</label>
                    <input
                      value={hostedBaseUrl}
                      onChange={(e) => setHostedBaseUrl(e.target.value)}
                      placeholder="https://api.openai.com/v1"
                      className="mt-1 w-full rounded-lg border bg-background px-3 py-1.5 font-mono text-xs outline-none focus:ring-1 focus:ring-ring"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium">API key</label>
                    <input
                      type="password"
                      value={hostedApiKey}
                      onChange={(e) => setHostedApiKey(e.target.value)}
                      placeholder={hostedKeySet ? "•••••••• (Key saved on backend)" : "sk-..."}
                      className="mt-1 w-full rounded-lg border bg-background px-3 py-1.5 font-mono text-xs outline-none focus:ring-1 focus:ring-ring"
                    />
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Stored securely on your local backend, never in browser localStorage.
                    </p>
                  </div>
                </div>
              )}
            </div>

            <button
              onClick={() => {
                if (confirm("Delete all summaries and downloads?")) {
                  setState((s) => ({ ...s, chats: [], downloads: [], activeChatId: null }));
                  toast("History cleared");
                }
              }}
              className="text-xs text-destructive hover:underline"
            >
              Clear all history
            </button>
          </div>
          <DialogFooter>
            <button
              onClick={save}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            >
              Save
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirmation Dialog for Hosted Fallback */}
      <Dialog open={showConfirmHosted} onOpenChange={setShowConfirmHosted}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
              <AlertTriangle className="h-5 w-5" />
              <DialogTitle>Enable Hosted Model Fallback?</DialogTitle>
            </div>
          </DialogHeader>
          <div className="text-sm text-muted-foreground space-y-2">
            <p className="font-semibold text-foreground">
              Code will be sent to a third-party server.
            </p>
            <p>
              When enabled, if your local Ollama instance is not running, requests will be routed to
              your configured hosted provider. Any summaries produced by a hosted model will be
              clearly labeled with a{" "}
              <span className="rounded bg-amber-500/15 px-1 py-0.5 text-xs text-amber-600 dark:text-amber-400 font-semibold">
                Hosted
              </span>{" "}
              badge.
            </p>
          </div>
          <DialogFooter className="mt-2 flex gap-2">
            <button
              onClick={() => setShowConfirmHosted(false)}
              className="rounded-lg border px-3 py-1.5 text-sm font-medium hover:bg-accent"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirmHosted}
              className="rounded-lg bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground hover:bg-destructive/90"
            >
              I understand, enable
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
