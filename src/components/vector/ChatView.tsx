import { useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertTriangle, Copy, FileCode } from "lucide-react";
import { toast } from "sonner";
import type { Chat } from "@/lib/store";
import { Logo } from "./Logo";
import { SummaryCard, SummaryProgress } from "./SummaryCard";
import { RepoOverviewCard } from "./RepoOverviewCard";
import { ProjectOverviewCard } from "./ProjectOverviewCard";
import { UnreadableSummaryCard } from "./UnreadableSummaryCard";
import { LocalErrorBoundary } from "./LocalErrorBoundary";
import {
  inferSummaryKind,
  safeNormalizeFileSummary,
  safeNormalizeProjectOverview,
  safeNormalizeRepoOverview,
} from "@/lib/schemas";
import type { Message } from "@/lib/store";

/**
 * Renders the right card for an assistant message using explicit kind detection.
 * Never crashes on bad data — falls back to UnreadableSummaryCard.
 */
function AssistantMessageContent({
  m,
  streaming,
  busy,
  onResummarise,
}: {
  m: Message;
  streaming: boolean;
  busy: boolean;
  onResummarise?: ((sourceIds: string[]) => void) | undefined;
}) {
  // ── 1. Streaming progress indicator ──────────────────────────────────────
  if (streaming && m.progressStage && !m.summaryResult && !m.repoResult && !m.projectResult) {
    return <SummaryProgress stage={m.progressStage} detail={m.progressDetail} />;
  }

  // ── 2. Explicit projectResult from streaming ──────────────────────────────
  if (m.projectResult) {
    const normalized = safeNormalizeProjectOverview(m.projectResult);
    if (normalized) {
      return <ProjectOverviewCard data={normalized} model={m.model} provider={m.provider} />;
    }
    return (
      <UnreadableSummaryCard
        title={
          typeof m.projectResult === "object" && m.projectResult !== null
            ? String((m.projectResult as unknown as Record<string, unknown>)["name"] ?? "")
            : undefined
        }
        onResummarise={onResummarise ? () => onResummarise(m.sourceIds ?? []) : undefined}
      />
    );
  }

  // ── 3. Explicit repoResult from streaming ─────────────────────────────────
  if (m.repoResult) {
    const normalized = safeNormalizeRepoOverview(m.repoResult);
    if (normalized) {
      return <RepoOverviewCard data={normalized} model={m.model} provider={m.provider} />;
    }
    return (
      <UnreadableSummaryCard
        onResummarise={onResummarise ? () => onResummarise(m.sourceIds ?? []) : undefined}
      />
    );
  }

  // ── 4. Explicit summaryResult — infer what card to show ──────────────────
  if (m.summaryResult) {
    const raw = m.summaryResult as unknown;
    const isWrapped = typeof raw === "object" && raw !== null && "summary" in raw;
    const summaryData = isWrapped ? (raw as Record<string, unknown>)["summary"] : raw;
    const kind = inferSummaryKind(summaryData);

    if (kind === "project") {
      const normalized = safeNormalizeProjectOverview(summaryData);
      if (normalized) {
        return <ProjectOverviewCard data={normalized} model={m.model} provider={m.provider} />;
      }
    }

    if (kind === "repo") {
      const normalized = safeNormalizeRepoOverview(summaryData);
      if (normalized) {
        return <RepoOverviewCard data={normalized} model={m.model} provider={m.provider} />;
      }
    }

    if (kind === "file") {
      const normalized = safeNormalizeFileSummary(summaryData);
      if (normalized) {
        const fullResult = isWrapped
          ? { ...(raw as import("@/lib/api").SummaryResult), summary: normalized }
          : {
              id: 0,
              summary: normalized,
              cached: false,
              model: m.model || "local",
              provider: m.provider || "ollama",
            };
        return (
          <>
            <SummaryCard
              result={fullResult}
              onResummarise={
                fullResult.cached ? () => onResummarise?.(m.sourceIds ?? []) : undefined
              }
            />
            {!streaming && m.model && (
              <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
                <span className="font-mono">{m.model}</span>
                {m.provider === "hosted" && (
                  <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-600 dark:text-amber-400">
                    Hosted
                  </span>
                )}
              </div>
            )}
          </>
        );
      }
    }

    // summaryResult exists but data is unreadable
    if (kind === "unreadable") {
      return (
        <UnreadableSummaryCard
          onResummarise={onResummarise ? () => onResummarise(m.sourceIds ?? []) : undefined}
        />
      );
    }
  }

  // ── 5. Fallback: render as markdown (for plain text or error results) ─────
  if (m.error) {
    return (
      <div className="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        {m.content}
      </div>
    );
  }

  if (m.content) {
    return (
      <>
        <div className="prose-vector">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
        </div>
        {!streaming && !m.error && (
          <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
            <button
              onClick={() => {
                navigator.clipboard.writeText(m.content);
                toast("Copied");
              }}
              className="flex items-center gap-1 hover:text-foreground"
            >
              <Copy className="h-3 w-3" /> Copy
            </button>
            {m.model && <span className="font-mono">{m.model}</span>}
          </div>
        )}
      </>
    );
  }

  if (!streaming && !m.content && !m.summaryResult && !m.projectResult && !m.repoResult) {
    if (m.error) {
      return (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-xs text-destructive">
          Failed to generate summary. Please try again.
        </div>
      );
    }
    return (
      <div className="rounded-xl border border-muted bg-muted/20 p-4 text-xs text-muted-foreground">
        Summary generation completed. No content generated.
      </div>
    );
  }

  // Streaming dots (only when actively streaming)
  return (
    <div className="flex gap-1 py-3">
      {[0, 1, 2].map((d) => (
        <span
          key={d}
          className="h-2 w-2 animate-bounce rounded-full bg-primary"
          style={{ animationDelay: `${d * 0.15}s` }}
        />
      ))}
    </div>
  );
}

export function ChatView({
  chat,
  busy,
  onResummarise,
}: {
  chat?: Chat | undefined;
  busy: boolean;
  onResummarise?: ((sourceIds: string[]) => void) | undefined;
}) {
  const end = useRef<HTMLDivElement>(null);
  const messages = chat?.messages ?? [];
  const last = messages[messages.length - 1]?.content;
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end" });
  }, [messages.length, last]);

  if (!chat || messages.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        <Logo className="h-12 w-12" />
        <h1 className="mt-5 text-2xl font-semibold tracking-tight sm:text-3xl">
          What code should we summarise?
        </h1>
        <p className="mt-2 max-w-md text-sm text-muted-foreground">
          Drop in files, a GitHub repo, or a watched file with{" "}
          <span className="font-mono text-foreground">+</span> — or just paste code below.
        </p>
      </div>
    );
  }

  const sources = chat.sources ?? [];

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
        {messages.map((m, i) => {
          const srcs = sources.filter((s) => m.sourceIds?.includes(s.id));
          if (m.role === "user") {
            return (
              <div key={m.id} className="flex flex-col items-end gap-1.5">
                {srcs.length > 0 && (
                  <div className="flex flex-wrap justify-end gap-1.5">
                    {srcs.map((s) => (
                      <span
                        key={s.id}
                        className="flex items-center gap-1 rounded-lg border px-2 py-1 font-mono text-[11px] text-muted-foreground"
                      >
                        <FileCode className="h-3 w-3" />
                        {s.name}
                      </span>
                    ))}
                  </div>
                )}
                {m.content && (
                  <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-secondary px-4 py-2.5 text-[15px]">
                    {m.content}
                  </div>
                )}
              </div>
            );
          }

          const streaming = busy && i === messages.length - 1;

          return (
            <div key={m.id} className="group flex gap-3">
              <Logo className="mt-1 h-6 w-6 shrink-0" />
              <div className="min-w-0 flex-1">
                <LocalErrorBoundary
                  name="message-card"
                  fallbackTitle="Couldn't render this summary"
                  fallbackMessage="The summary data could not be displayed. It may be in an old or unsupported format."
                >
                  <AssistantMessageContent
                    m={m}
                    streaming={streaming}
                    busy={busy}
                    onResummarise={onResummarise}
                  />
                </LocalErrorBoundary>
              </div>
            </div>
          );
        })}
        <div ref={end} />
      </div>
    </div>
  );
}
