/**
 * Structured summary card — renders the FileSummary JSON as a rich card.
 * Shows: TL;DR, Purpose, Key functions (collapsible), Dependencies (chips), Gotchas.
 * Buttons: Copy, Download as .md
 * Cache badge when result.cached is true.
 */

import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  RefreshCw,
  AlertTriangle,
  Cloud,
  HardDrive,
} from "lucide-react";
import { toast } from "sonner";
import type { SummaryResult } from "@/lib/api";
import type { FileSummaryData } from "@/lib/api";

interface SummaryCardProps {
  result: SummaryResult;
  onResummarise?: (() => void) | undefined;
}

export function SummaryCard({ result, onResummarise }: SummaryCardProps) {
  const { summary: rawSummary, cached, model, provider } = result;
  // Safely default all arrays to avoid crashes on project-shaped or partial data
  const summary: FileSummaryData = {
    tldr: rawSummary?.tldr ?? "",
    purpose: rawSummary?.purpose ?? "",
    language: rawSummary?.language ?? "unknown",
    key_functions: rawSummary?.key_functions ?? [],
    dependencies: rawSummary?.dependencies ?? [],
    gotchas: rawSummary?.gotchas ?? [],
    _warning: rawSummary?._warning,
  };
  const [expandedFns, setExpandedFns] = useState<Set<number>>(new Set());

  const toggleFn = (i: number) =>
    setExpandedFns((s) => {
      const next = new Set(s);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  const expandAll = () => setExpandedFns(new Set(summary.key_functions.map((_, i) => i)));
  const collapseAll = () => setExpandedFns(new Set());

  const toMarkdown = () => {
    const lines = [
      `## TL;DR\n${summary.tldr}`,
      `\n## Purpose\n${summary.purpose}`,
      `\n**Language:** ${summary.language}`,
    ];
    if (summary.key_functions.length) {
      lines.push("\n## Key Functions");
      for (const f of summary.key_functions) {
        const loc = f.line_start ? ` (L${f.line_start}–L${f.line_end})` : "";
        lines.push(
          `### \`${f.name}\`${f.signature ? ` \`${f.signature}\`` : ""}${loc}\n${f.summary}`,
        );
      }
    }
    if (summary.dependencies.length) {
      lines.push("\n## Dependencies\n" + summary.dependencies.map((d) => `- \`${d}\``).join("\n"));
    }
    if (summary.gotchas.length) {
      lines.push("\n## Gotchas\n" + summary.gotchas.map((g) => `- ${g}`).join("\n"));
    }
    return lines.join("\n");
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(toMarkdown());
    toast("Copied summary to clipboard");
  };

  const downloadMd = () => {
    const blob = new Blob([toMarkdown()], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "summary.md";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="rounded-2xl border bg-card p-5 shadow-sm">
      {/* Header badges */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {cached && (
          <span className="flex items-center gap-1.5 rounded-full bg-accent px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
            <HardDrive className="h-3 w-3" />
            Cached — file unchanged
          </span>
        )}
        {provider === "hosted" && (
          <span className="flex items-center gap-1.5 rounded-full bg-amber-500/15 px-2.5 py-1 text-[11px] font-medium text-amber-600 dark:text-amber-400">
            <Cloud className="h-3 w-3" />
            Hosted
          </span>
        )}
        {summary._warning && (
          <span className="flex items-center gap-1.5 rounded-full bg-destructive/10 px-2.5 py-1 text-[11px] font-medium text-destructive">
            <AlertTriangle className="h-3 w-3" />
            Partial result
          </span>
        )}
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">{model}</span>
      </div>

      {/* TL;DR */}
      <div className="mb-4">
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          TL;DR
        </h3>
        <p className="text-[15px] leading-relaxed">{summary.tldr}</p>
      </div>

      {/* Purpose */}
      <div className="mb-4">
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Purpose
        </h3>
        <p className="text-sm leading-relaxed text-foreground/90">{summary.purpose}</p>
      </div>

      {/* Language */}
      <div className="mb-4 flex items-center gap-2">
        <span className="rounded-md bg-accent px-2 py-0.5 font-mono text-xs">
          {summary.language}
        </span>
      </div>

      {/* Key Functions */}
      {summary.key_functions.length > 0 && (
        <div className="mb-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Key Functions ({summary.key_functions.length})
            </h3>
            <button
              onClick={expandedFns.size === summary.key_functions.length ? collapseAll : expandAll}
              className="text-[11px] text-muted-foreground hover:text-foreground"
            >
              {expandedFns.size === summary.key_functions.length ? "Collapse all" : "Expand all"}
            </button>
          </div>
          <div className="space-y-1">
            {summary.key_functions.map((fn, i) => (
              <div key={i} className="rounded-lg border bg-background">
                <button
                  onClick={() => toggleFn(i)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent/50"
                >
                  {expandedFns.has(i) ? (
                    <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <code className="font-mono text-xs font-medium text-primary">{fn.name}</code>
                  {fn.signature && (
                    <code className="truncate font-mono text-[11px] text-muted-foreground">
                      {fn.signature}
                    </code>
                  )}
                  {fn.line_start != null && (
                    <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
                      L{fn.line_start}–{fn.line_end}
                    </span>
                  )}
                </button>
                {expandedFns.has(i) && (
                  <div className="border-t px-3 py-2 text-sm text-foreground/80">{fn.summary}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Dependencies */}
      {summary.dependencies.length > 0 && (
        <div className="mb-4">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Dependencies
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {summary.dependencies.map((dep, i) => (
              <span key={i} className="rounded-md bg-accent px-2 py-0.5 font-mono text-[11px]">
                {dep}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Gotchas */}
      {summary.gotchas.length > 0 && (
        <div className="mb-4">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Gotchas
          </h3>
          <ul className="list-inside list-disc space-y-1 text-sm text-foreground/80">
            {summary.gotchas.map((g, i) => (
              <li key={i}>{g}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 border-t pt-3">
        <button
          onClick={copyToClipboard}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Copy className="h-3.5 w-3.5" /> Copy
        </button>
        <button
          onClick={downloadMd}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Download className="h-3.5 w-3.5" /> Download .md
        </button>
        {cached && onResummarise && (
          <button
            onClick={onResummarise}
            className="ml-auto flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/10"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Re-summarise
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Streaming progress indicator shown while summarisation is in progress.
 */
export function SummaryProgress({ stage, detail }: { stage: string; detail?: string | undefined }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-primary/20 bg-primary/5 p-3">
      <div className="flex gap-1">
        {[0, 1, 2].map((d) => (
          <span
            key={d}
            className="h-2 w-2 animate-bounce rounded-full bg-primary"
            style={{ animationDelay: `${d * 0.15}s` }}
          />
        ))}
      </div>
      <div className="min-w-0">
        <p className="text-sm font-medium">{stage}</p>
        {detail && <p className="truncate text-xs text-muted-foreground">{detail}</p>}
      </div>
    </div>
  );
}
