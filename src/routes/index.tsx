import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Files, Menu, PanelLeft, PanelRight, Shield, SquarePen, X } from "lucide-react";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Splash } from "@/components/vector/Splash";
import { LeftSidebar } from "@/components/vector/LeftSidebar";
import { SourcesPanel } from "@/components/vector/SourcesPanel";
import { Composer } from "@/components/vector/Composer";
import { ChatView } from "@/components/vector/ChatView";
import { SettingsDialog } from "@/components/vector/SettingsDialog";
import { ensureChat, getState, newChat, setState, uid, updateChat, useStore } from "@/lib/store";
import {
  BASE_URL,
  fetchHealth,
  streamSummarise,
  streamRepoSummarise,
  streamProjectSummarise,
  subscribeEvents,
  type HealthResponse,
} from "@/lib/api";
import { downloadChat } from "@/lib/download";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Vector — Local code summariser" },
      {
        name: "description",
        content: "Summarise code from files, GitHub repos and watched files using local AI models.",
      },
      { property: "og:title", content: "Vector — Local code summariser" },
      {
        property: "og:description",
        content: "Summarise code from files, GitHub and watched files with local models.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  const [booted, setBooted] = useState(false);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [mLeft, setMLeft] = useState(false);
  const [mRight, setMRight] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const theme = useStore((s) => s.settings.theme);
  const chat = useStore((s) => s.chats.find((c) => c.id === s.activeChatId));
  const ollamaConnected = useStore((s) => s.ollamaConnected);
  const hostedEnabled = useStore((s) => s.settings.hostedEnabled);
  const [health, setHealth] = useState<HealthResponse | null>(null);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);
  const done = useCallback(() => setBooted(true), []);

  // Poll /health every 10s
  useEffect(() => {
    let mounted = true;
    const poll = async () => {
      try {
        const h = await fetchHealth();
        if (!mounted) return;
        setHealth(h);
        setState((s) => ({ ...s, ollamaConnected: h.ollama }));
      } catch (err) {
        if (!mounted) return;
        console.error(`Vector backend health check failed at ${BASE_URL}:`, err);
        setHealth(null);
        setState((s) => ({ ...s, ollamaConnected: false }));
      }
    };
    poll();
    const interval = setInterval(poll, 10_000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  // Subscribe to backend watcher events
  useEffect(() => {
    const unsubscribe = subscribeEvents({
      onWatchSummarised: (data) => {
        toast.success(`${data.filename || "Watched file"} updated`, {
          description: `Auto-summarised via ${data.model}`,
        });
        const now = Date.now();
        const id = uid();
        setState((s) => ({
          ...s,
          chats: [
            {
              id,
              title: `Watch: ${data.filename || data.file_path}`,
              createdAt: now,
              updatedAt: now,
              sources: [
                {
                  id: uid(),
                  kind: "watch",
                  name: data.filename || data.file_path,
                  content: "",
                  addedAt: now,
                },
              ],
              messages: [
                {
                  id: uid(),
                  role: "assistant",
                  content: data.summary?.tldr || "Watched file update",
                  summaryResult: {
                    id: data.id,
                    summary: data.summary,
                    cached: false,
                    model: data.model,
                    provider: data.provider,
                  },
                  createdAt: now,
                },
              ],
            },
            ...s.chats,
          ],
        }));
      },
      onWatchError: (data) => {
        toast.error(`Watch error: ${data.path}`, { description: data.error });
      },
    });
    return unsubscribe;
  }, []);

  const send = async (text: string, sourceIds: string[], force = false) => {
    const chatId = ensureChat();
    const { settings } = getState();
    const userMsg = {
      id: uid(),
      role: "user" as const,
      content: text,
      sourceIds,
      createdAt: Date.now(),
    };
    const botId = uid();
    updateChat(chatId, (c) => {
      const firstName = c.sources.find((s) => sourceIds.includes(s.id))?.name;
      const title =
        c.messages.length === 0
          ? text.split("\n")[0]?.slice(0, 48) ||
            (firstName ? `Summary of ${firstName}` : "New summary")
          : c.title;
      return {
        ...c,
        title,
        messages: [
          ...c.messages,
          userMsg,
          {
            id: botId,
            role: "assistant",
            content: "",
            model: settings.model,
            createdAt: Date.now(),
          },
        ],
      };
    });
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy(true);
    const c = getState().chats.find((x) => x.id === chatId)!;

    // Check if input is a GitHub URL
    const isGitUrl = /^https?:\/\/github\.com\/[^/]+\/[^/]+/i.test(text.trim());
    const githubSource = c.sources.find(
      (s) => sourceIds.includes(s.id) && s.kind === "github" && s.url,
    );

    if (isGitUrl || githubSource?.url) {
      const targetUrl = isGitUrl ? text.trim() : githubSource!.url!;
      try {
        await streamRepoSummarise(
          {
            url: targetUrl,
            model: settings.model || undefined,
            force,
            system_prompt: settings.systemPrompt,
            signal: ctrl.signal,
          },
          {
            onProgress: (data) => {
              updateChat(chatId, (cc) => ({
                ...cc,
                messages: cc.messages.map((m) =>
                  m.id === botId
                    ? { ...m, progressStage: data.stage, progressDetail: data.detail }
                    : m,
                ),
              }));
            },
            onOverview: (data) => {
              updateChat(chatId, (cc) => ({
                ...cc,
                messages: cc.messages.map((m) =>
                  m.id === botId
                    ? {
                        ...m,
                        repoResult: data.overview,
                        model: data.model,
                        provider: data.provider,
                        content: data.overview.overview || m.content,
                        progressStage: undefined,
                        progressDetail: undefined,
                      }
                    : m,
                ),
              }));
            },
            onError: (data) => {
              updateChat(chatId, (cc) => ({
                ...cc,
                messages: cc.messages.map((m) =>
                  m.id === botId
                    ? {
                        ...m,
                        content: data.error,
                        error: true,
                        progressStage: undefined,
                        progressDetail: undefined,
                      }
                    : m,
                ),
              }));
            },
            onDone: () => {},
          },
        );
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          updateChat(chatId, (cc) => ({
            ...cc,
            messages: cc.messages.map((m) =>
              m.id === botId ? { ...m, content: (e as Error).message, error: true } : m,
            ),
          }));
        }
      } finally {
        setBusy(false);
        abortRef.current = null;
      }
      return;
    }

    // Check if input is a folder or multi-file project intent
    const usedSources = c.sources.filter((s) => sourceIds.includes(s.id));
    const folderSource = usedSources.find((s) => s.kind === "folder");
    const fileSources = usedSources.filter((s) => s.kind === "file");

    const isProjectIntent =
      Boolean(folderSource) ||
      (fileSources.length >= 2 &&
        (!text.trim() ||
          /(explain|summaris|summariz|describ|overview|architect|structure|break down|analys|analyz|understand|project|codebase)/i.test(
            text,
          )));

    if (isProjectIntent) {
      let filesToSend: Array<{ path: string; content: string }> = [];
      let projectName = "Project";

      if (folderSource && folderSource.folderFiles && folderSource.folderFiles.length > 0) {
        projectName = folderSource.name;
        filesToSend = folderSource.folderFiles.map((f) => ({
          path: f.path,
          content: f.content,
        }));
      } else if (fileSources.length >= 2) {
        projectName = "Multi-file Project";
        filesToSend = fileSources.map((f) => ({
          path: f.name,
          content: f.content || "",
        }));
      }

      if (filesToSend.length > 0) {
        try {
          await streamProjectSummarise(
            {
              name: projectName,
              files: filesToSend,
              model: settings.model || undefined,
              force,
              system_prompt: settings.systemPrompt,
              signal: ctrl.signal,
            },
            {
              onProgress: (data) => {
                updateChat(chatId, (cc) => ({
                  ...cc,
                  messages: cc.messages.map((m) =>
                    m.id === botId
                      ? { ...m, progressStage: data.stage, progressDetail: data.detail }
                      : m,
                  ),
                }));
              },
              onOverview: (data) => {
                const overviewData = data.overview ?? data.project;
                updateChat(chatId, (cc) => ({
                  ...cc,
                  messages: cc.messages.map((m) =>
                    m.id === botId
                      ? {
                          ...m,
                          projectResult: overviewData,
                          model: data.model,
                          provider: data.provider,
                          content:
                            overviewData?.tldr ||
                            overviewData?.purpose ||
                            m.content ||
                            "Project overview generated.",
                          progressStage: undefined,
                          progressDetail: undefined,
                        }
                      : m,
                  ),
                }));
              },
              onError: (data) => {
                updateChat(chatId, (cc) => ({
                  ...cc,
                  messages: cc.messages.map((m) =>
                    m.id === botId
                      ? {
                          ...m,
                          content: data.error,
                          error: true,
                          progressStage: undefined,
                          progressDetail: undefined,
                        }
                      : m,
                  ),
                }));
              },
              onDone: () => {},
            },
          );
        } catch (e) {
          if ((e as Error).name !== "AbortError") {
            updateChat(chatId, (cc) => ({
              ...cc,
              messages: cc.messages.map((m) =>
                m.id === botId ? { ...m, content: (e as Error).message, error: true } : m,
              ),
            }));
          }
        } finally {
          setBusy(false);
          abortRef.current = null;
        }
        return;
      }
    }

    // Standard single-file / pasted code summarisation
    const codeContent = usedSources
      .filter((s) => s.kind !== "image")
      .map((s) => `// FILE: ${s.name}\n${s.content ?? ""}`)
      .join("\n\n");
    const fullText = codeContent
      ? `${codeContent}\n\n${text || "Summarise the provided code."}`
      : text || "Summarise the provided code.";
    const firstFilename = usedSources[0]?.name;

    try {
      await streamSummarise(
        {
          text: fullText,
          filename: firstFilename,
          model: settings.model || undefined,
          force,
          system_prompt: settings.systemPrompt,
          signal: ctrl.signal,
        },
        {
          onProgress: (data) => {
            updateChat(chatId, (cc) => ({
              ...cc,
              messages: cc.messages.map((m) =>
                m.id === botId
                  ? {
                      ...m,
                      progressStage: data.stage,
                      progressDetail: data.detail,
                      content: data.token ? m.content + data.token : m.content,
                    }
                  : m,
              ),
            }));
          },
          onResult: (data) => {
            updateChat(chatId, (cc) => ({
              ...cc,
              messages: cc.messages.map((m) =>
                m.id === botId
                  ? {
                      ...m,
                      summaryResult: data,
                      model: data.model,
                      provider: data.provider,
                      content: data.summary.tldr || m.content,
                      progressStage: undefined,
                      progressDetail: undefined,
                    }
                  : m,
              ),
            }));
          },
          onError: (data) => {
            updateChat(chatId, (cc) => ({
              ...cc,
              messages: cc.messages.map((m) =>
                m.id === botId
                  ? {
                      ...m,
                      content: data.error,
                      error: true,
                      progressStage: undefined,
                      progressDetail: undefined,
                    }
                  : m,
              ),
            }));
          },
          onDone: () => {},
        },
      );
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        const msg = (e as Error).message.includes("Failed to fetch")
          ? "Couldn't reach the Vector backend at the configured URL. Make sure it's running."
          : (e as Error).message;
        updateChat(chatId, (cc) => ({
          ...cc,
          messages: cc.messages.map((m) =>
            m.id === botId ? { ...m, content: msg, error: true } : m,
          ),
        }));
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  const handleResummarise = (sourceIds: string[]) => {
    // Re-send with force=true — re-use the last user message
    if (!chat) return;
    const lastUserMsg = [...chat.messages].reverse().find((m) => m.role === "user");
    if (lastUserMsg) {
      send(lastUserMsg.content, lastUserMsg.sourceIds ?? [], true);
    }
  };

  const sidebar = (
    <LeftSidebar
      onOpenSettings={() => {
        setSettingsOpen(true);
        setMLeft(false);
      }}
      onNavigate={() => setMLeft(false)}
    />
  );

  return (
    <>
      {!booted && <Splash onDone={done} />}
      <div
        className={cn(
          "flex h-dvh overflow-hidden bg-background transition-opacity duration-500",
          booted ? "opacity-100" : "opacity-0",
        )}
      >
        <div
          className={cn(
            "hidden shrink-0 border-r transition-[width] duration-300 md:block",
            leftOpen ? "w-72" : "w-0 overflow-hidden border-r-0",
          )}
        >
          {sidebar}
        </div>

        <main className="flex min-w-0 flex-1 flex-col">
          {/* Backend unreachable banner */}
          {booted && health === null && (
            <div className="flex items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive dark:text-red-400">
              <span className="h-2 w-2 rounded-full bg-destructive" />
              Vector backend unreachable at{" "}
              <code className="rounded bg-destructive/20 px-1.5 py-0.5 font-mono text-xs">
                {BASE_URL}
              </code>
            </div>
          )}

          {/* Ollama not-running banner (only if backend is reachable) */}
          {booted && health !== null && !health.ollama && (
            <div className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
              <span className="h-2 w-2 rounded-full bg-amber-500" />
              Ollama isn't running. Start it with:{" "}
              <code className="rounded bg-amber-500/20 px-1.5 py-0.5 font-mono text-xs">
                ollama serve
              </code>
            </div>
          )}

          <header className="flex h-14 shrink-0 items-center gap-1 px-2 sm:px-3">
            <button
              className="rounded-lg p-2 hover:bg-accent md:hidden"
              onClick={() => setMLeft(true)}
              aria-label="Open menu"
            >
              <Menu className="h-5 w-5" />
            </button>
            <button
              className="hidden rounded-lg p-2 hover:bg-accent md:block"
              onClick={() => setLeftOpen((v) => !v)}
              aria-label="Toggle sidebar"
            >
              <PanelLeft className="h-5 w-5" />
            </button>
            <button
              className="rounded-lg p-2 hover:bg-accent"
              onClick={() => newChat()}
              aria-label="New summary"
            >
              <SquarePen className="h-5 w-5" />
            </button>
            <p className="min-w-0 flex-1 truncate px-2 text-sm font-medium">
              {chat?.title ?? "vector"}
            </p>

            {/* 100% local badge */}
            {!hostedEnabled && (
              <span className="hidden items-center gap-1 rounded-full bg-chart-2/15 px-2.5 py-1 text-[11px] font-medium text-chart-2 sm:flex">
                <Shield className="h-3 w-3" />
                100% local
              </span>
            )}

            {chat && chat.messages.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="rounded-lg p-2 hover:bg-accent" aria-label="Download summary">
                    <Download className="h-5 w-5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => downloadChat(chat.id, "md")}>
                    Markdown (.md)
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => downloadChat(chat.id, "txt")}>
                    Plain text (.txt)
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => downloadChat(chat.id, "json")}>
                    JSON (.json)
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <button
              className="relative rounded-lg p-2 hover:bg-accent lg:hidden"
              onClick={() => setMRight(true)}
              aria-label="Show inputs"
            >
              <Files className="h-5 w-5" />
              {!!chat?.sources.length && (
                <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-primary" />
              )}
            </button>
            <button
              className="hidden rounded-lg p-2 hover:bg-accent lg:block"
              onClick={() => setRightOpen((v) => !v)}
              aria-label="Toggle inputs panel"
            >
              <PanelRight className="h-5 w-5" />
            </button>
          </header>
          <ChatView chat={chat} busy={busy} onResummarise={handleResummarise} />
          <Composer
            busy={busy}
            onSend={send}
            onStop={() => abortRef.current?.abort()}
            health={health}
          />
        </main>

        <div
          className={cn(
            "hidden shrink-0 border-l transition-[width] duration-300 lg:block",
            rightOpen ? "w-80" : "w-0 overflow-hidden border-l-0",
          )}
        >
          <SourcesPanel />
        </div>
      </div>

      <Sheet open={mLeft} onOpenChange={setMLeft}>
        <SheetContent side="left" className="w-72 p-0">
          <SheetTitle className="sr-only">Menu</SheetTitle>
          {sidebar}
        </SheetContent>
      </Sheet>
      <Sheet open={mRight} onOpenChange={setMRight}>
        <SheetContent side="right" className="w-80 p-0">
          <SheetTitle className="sr-only">Inputs</SheetTitle>
          <SourcesPanel />
        </SheetContent>
      </Sheet>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <Toaster theme={theme} position="top-center" />
    </>
  );
}
