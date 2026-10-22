import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Files, Menu, PanelLeft, PanelRight, SquarePen } from "lucide-react";
import { Toaster } from "@/components/ui/sonner";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Splash } from "@/components/vector/Splash";
import { LeftSidebar } from "@/components/vector/LeftSidebar";
import { SourcesPanel } from "@/components/vector/SourcesPanel";
import { Composer } from "@/components/vector/Composer";
import { ChatView } from "@/components/vector/ChatView";
import { SettingsDialog } from "@/components/vector/SettingsDialog";
import { ensureChat, getState, newChat, uid, updateChat, useStore } from "@/lib/store";
import { streamSummary } from "@/lib/models";
import { downloadChat } from "@/lib/download";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Vector — Local code summariser" },
      { name: "description", content: "Summarise code from files, GitHub repos and watched files using local AI models." },
      { property: "og:title", content: "Vector — Local code summariser" },
      { property: "og:description", content: "Summarise code from files, GitHub and watched files with local models." },
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

  useEffect(() => { document.documentElement.classList.toggle("dark", theme === "dark"); }, [theme]);
  const done = useCallback(() => setBooted(true), []);

  const send = async (text: string, sourceIds: string[]) => {
    const chatId = ensureChat();
    const { settings } = getState();
    const userMsg = { id: uid(), role: "user" as const, content: text, sourceIds, createdAt: Date.now() };
    const botId = uid();
    updateChat(chatId, (c) => {
      const firstName = c.sources.find((s) => sourceIds.includes(s.id))?.name;
      const title = c.messages.length === 0 ? (text.split("\n")[0].slice(0, 48) || (firstName ? `Summary of ${firstName}` : "New summary")) : c.title;
      return { ...c, title, messages: [...c.messages, userMsg, { id: botId, role: "assistant", content: "", model: settings.model, createdAt: Date.now() }] };
    });
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy(true);
    const c = getState().chats.find((x) => x.id === chatId)!;
    try {
      await streamSummary({
        endpoint: settings.endpoint, model: settings.model, system: settings.systemPrompt,
        history: c.messages.slice(0, -1), sources: c.sources, signal: ctrl.signal,
        onToken: (t) => updateChat(chatId, (cc) => ({ ...cc, messages: cc.messages.map((m) => (m.id === botId ? { ...m, content: m.content + t } : m)) })),
      });
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        const msg = (e as Error).message.includes("Failed to fetch")
          ? `Couldn't reach the local model server at ${settings.endpoint}. Make sure it's running and allows this site.`
          : (e as Error).message;
        updateChat(chatId, (cc) => ({ ...cc, messages: cc.messages.map((m) => (m.id === botId ? { ...m, content: msg, error: true } : m)) }));
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  const sidebar = <LeftSidebar onOpenSettings={() => { setSettingsOpen(true); setMLeft(false); }} onNavigate={() => setMLeft(false)} />;

  return (
    <>
      {!booted && <Splash onDone={done} />}
      <div className={cn("flex h-dvh overflow-hidden bg-background transition-opacity duration-500", booted ? "opacity-100" : "opacity-0")}>
        <div className={cn("hidden shrink-0 border-r transition-[width] duration-300 md:block", leftOpen ? "w-72" : "w-0 overflow-hidden border-r-0")}>{sidebar}</div>

        <main className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 shrink-0 items-center gap-1 px-2 sm:px-3">
            <button className="rounded-lg p-2 hover:bg-accent md:hidden" onClick={() => setMLeft(true)} aria-label="Open menu"><Menu className="h-5 w-5" /></button>
            <button className="hidden rounded-lg p-2 hover:bg-accent md:block" onClick={() => setLeftOpen((v) => !v)} aria-label="Toggle sidebar"><PanelLeft className="h-5 w-5" /></button>
            <button className="rounded-lg p-2 hover:bg-accent" onClick={() => newChat()} aria-label="New summary"><SquarePen className="h-5 w-5" /></button>
            <p className="min-w-0 flex-1 truncate px-2 text-sm font-medium">{chat?.title ?? "vector"}</p>
            {chat && chat.messages.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="rounded-lg p-2 hover:bg-accent" aria-label="Download summary"><Download className="h-5 w-5" /></button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => downloadChat(chat.id, "md")}>Markdown (.md)</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => downloadChat(chat.id, "txt")}>Plain text (.txt)</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => downloadChat(chat.id, "json")}>JSON (.json)</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <button className="relative rounded-lg p-2 hover:bg-accent lg:hidden" onClick={() => setMRight(true)} aria-label="Show inputs">
              <Files className="h-5 w-5" />
              {!!chat?.sources.length && <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-primary" />}
            </button>
            <button className="hidden rounded-lg p-2 hover:bg-accent lg:block" onClick={() => setRightOpen((v) => !v)} aria-label="Toggle inputs panel"><PanelRight className="h-5 w-5" /></button>
          </header>
          <ChatView chat={chat} busy={busy} />
          <Composer busy={busy} onSend={send} onStop={() => abortRef.current?.abort()} />
        </main>

        <div className={cn("hidden shrink-0 border-l transition-[width] duration-300 lg:block", rightOpen ? "w-80" : "w-0 overflow-hidden border-l-0")}><SourcesPanel /></div>
      </div>

      <Sheet open={mLeft} onOpenChange={setMLeft}>
        <SheetContent side="left" className="w-72 p-0"><SheetTitle className="sr-only">Menu</SheetTitle>{sidebar}</SheetContent>
      </Sheet>
      <Sheet open={mRight} onOpenChange={setMRight}>
        <SheetContent side="right" className="w-80 p-0"><SheetTitle className="sr-only">Inputs</SheetTitle><SourcesPanel /></SheetContent>
      </Sheet>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <Toaster theme={theme} position="top-center" />
    </>
  );
}
