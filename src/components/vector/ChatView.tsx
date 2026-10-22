import { useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertTriangle, Copy, FileCode } from "lucide-react";
import { toast } from "sonner";
import type { Chat } from "@/lib/store";
import { Logo } from "./Logo";

export function ChatView({ chat, busy }: { chat?: Chat; busy: boolean }) {
  const end = useRef<HTMLDivElement>(null);
  const last = chat?.messages[chat.messages.length - 1]?.content;
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [chat?.messages.length, last]);

  if (!chat || chat.messages.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        <Logo className="h-12 w-12" />
        <h1 className="mt-5 text-2xl font-semibold tracking-tight sm:text-3xl">What code should we summarise?</h1>
        <p className="mt-2 max-w-md text-sm text-muted-foreground">
          Drop in files, a GitHub repo, or a watched file with <span className="font-mono text-foreground">+</span> — or just paste code below.
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
        {chat.messages.map((m, i) => {
          const srcs = chat.sources.filter((s) => m.sourceIds?.includes(s.id));
          if (m.role === "user") {
            return (
              <div key={m.id} className="flex flex-col items-end gap-1.5">
                {srcs.length > 0 && (
                  <div className="flex flex-wrap justify-end gap-1.5">
                    {srcs.map((s) => (
                      <span key={s.id} className="flex items-center gap-1 rounded-lg border px-2 py-1 font-mono text-[11px] text-muted-foreground">
                        <FileCode className="h-3 w-3" />{s.name}
                      </span>
                    ))}
                  </div>
                )}
                {m.content && <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-secondary px-4 py-2.5 text-[15px]">{m.content}</div>}
              </div>
            );
          }
          const streaming = busy && i === chat.messages.length - 1;
          return (
            <div key={m.id} className="group flex gap-3">
              <Logo className="mt-1 h-6 w-6 shrink-0" />
              <div className="min-w-0 flex-1">
                {m.error ? (
                  <div className="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{m.content}
                  </div>
                ) : m.content ? (
                  <div className="prose-vector"><ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown></div>
                ) : (
                  <div className="flex gap-1 py-3">
                    {[0, 1, 2].map((d) => <span key={d} className="h-2 w-2 animate-bounce rounded-full bg-primary" style={{ animationDelay: `${d * 0.15}s` }} />)}
                  </div>
                )}
                {!streaming && m.content && !m.error && (
                  <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
                    <button onClick={() => { navigator.clipboard.writeText(m.content); toast("Copied"); }} className="flex items-center gap-1 hover:text-foreground"><Copy className="h-3 w-3" /> Copy</button>
                    {m.model && <span className="font-mono">{m.model}</span>}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        <div ref={end} />
      </div>
    </div>
  );
}
